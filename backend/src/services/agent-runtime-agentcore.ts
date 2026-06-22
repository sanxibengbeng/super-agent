/**
 * AgentCore Agent Runtime — runs Claude Agent SDK inside Bedrock AgentCore
 * containers with S3 Files filesystem mounts.
 *
 * S3 Files mounts the workspace directory directly into the container at /mnt/ws,
 * so no S3 upload/download is needed. The container reads and writes directly
 * to the mounted filesystem.
 *
 * Required env vars:
 *   AGENTCORE_RUNTIME_ARN — the runtime ARN to invoke
 *   AGENTCORE_S3FILES_FILESYSTEM_ID — the S3 Files filesystem ID
 */

import { config } from '../config/index.js';
import type { AgentRuntime, AgentRuntimeOptions } from './agent-runtime.js';
import type {
  ConversationEvent,
  AgentConfig,
  ContentBlock,
  MCPServerSDKConfig,
  AnyMCPServerConfig,
} from './claude-agent.service.js';
import type { SkillForWorkspace } from './workspace-manager.js';
import { trace, context, propagation, SpanKind, SpanStatusCode } from '@opentelemetry/api';

interface AgentCoreEvent {
  type: 'session_start' | 'assistant' | 'result' | 'error' | 'trace';
  session_id?: string;
  content?: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
    tool_use_id?: string;
    content?: string;
    is_error?: boolean;
  }>;
  code?: string;
  message?: string;
  duration_ms?: number;
  num_turns?: number;
  is_error?: boolean;
  result?: string;
  spans?: Array<{
    name: string;
    traceId: string;
    spanId: string;
    parentSpanId: string;
    startTimeMs: number;
    endTimeMs: number;
    attributes: Record<string, string | number | boolean>;
    status: 'OK' | 'ERROR';
  }>;
}

export class AgentCoreAgentRuntime implements AgentRuntime {
  readonly name = 'agentcore';

  private runtimeClient: any;
  private InvokeCommand: any;
  private StopSessionCommand: any;
  private sdkLoaded = false;

  constructor() {
    // No S3 client needed — S3 Files handles filesystem mounting
  }

  private async ensureSDK(): Promise<void> {
    if (this.sdkLoaded) return;
    try {
      const mod = await import('@aws-sdk/client-bedrock-agentcore' as string);
      // Extract region from the runtime ARN (arn:aws:bedrock-agentcore:{region}:...)
      // to ensure the client targets the correct region regardless of AWS_REGION.
      const arnRegion = config.agentcore.runtimeArn?.split(':')[3];
      const region = arnRegion || config.agentcore.region;
      console.log(
        `[agentcore-runtime] SDK region=${region} (from ARN: ${arnRegion}, config: ${config.agentcore.region})`
      );
      this.runtimeClient = new mod.BedrockAgentCoreClient({ region });
      this.InvokeCommand = mod.InvokeAgentRuntimeCommand;
      this.StopSessionCommand = mod.StopRuntimeSessionCommand;
      this.sdkLoaded = true;
    } catch (err) {
      throw new Error(
        `AgentCore SDK not available. Install @aws-sdk/client-bedrock-agentcore. Error: ${err}`
      );
    }
  }

  private get runtimeArn(): string {
    const arn = config.agentcore.runtimeArn;
    if (!arn) throw new Error('AGENTCORE_RUNTIME_ARN is not configured');
    return arn;
  }

  async *runConversation(
    options: AgentRuntimeOptions,
    agentConfig: AgentConfig,
    _skills: SkillForWorkspace[],
    _pluginPaths?: string[],
    mcpServers?: Record<string, AnyMCPServerConfig>
  ): AsyncGenerator<ConversationEvent> {
    await this.ensureSDK();

    const chatSessionId = options.sessionId;
    const scopeId = options.scopeId ?? 'default';

    // Workspace filesystem mounting is handled by the AgentCore runtime itself:
    // it mounts a single shared S3 Files access point (rootDirectory=/workspaces)
    // at /mnt/ws. The container isolates this scope under /mnt/ws/{org}/{scope}
    // (see agent-runner.resolveScopeDir). No per-invocation access point is
    // created or passed here — AgentCore does not honor a payload-supplied ARN.

    // Load chat history
    const history = await this.loadChatHistory(options.organizationId, options.sessionId);

    // Filter out in-process SDK MCP servers — they can't be serialized or
    // forwarded to a remote AgentCore container. Only keep config-based servers.
    let serializableMcpServers: Record<string, MCPServerSDKConfig> | undefined;
    if (mcpServers) {
      const filtered: Record<string, MCPServerSDKConfig> = {};
      for (const [name, cfg] of Object.entries(mcpServers)) {
        if ((cfg as AnyMCPServerConfig).type !== 'sdk') {
          filtered[name] = cfg as MCPServerSDKConfig;
        }
      }
      if (Object.keys(filtered).length > 0) {
        serializableMcpServers = filtered;
      }
    }

    const traceCarrier: Record<string, string> = {};
    propagation.inject(context.active(), traceCarrier);

    const payload = JSON.stringify({
      prompt: options.message,
      session_id: options.providerSessionId ?? undefined,
      chat_session_id: chatSessionId ?? undefined,
      history: history.length > 0 ? history : undefined,
      scope_id: scopeId,
      org_id: options.organizationId,
      agent_id: options.agentId,
      system_prompt: agentConfig.systemPrompt ?? undefined,
      model: agentConfig.model ?? undefined,
      mcp_servers: serializableMcpServers,
      execution_task_id: options.executionTaskId ?? undefined,
      traceparent: traceCarrier.traceparent,
      tracestate: traceCarrier.tracestate,
    });

    console.log(`[agentcore-runtime] scope workspace: ${options.organizationId}/${scopeId}`);
    console.log(`[agentcore-runtime] History count: ${history.length}`);

    // Use the chat session ID as runtimeSessionId so the same conversation
    // always routes to the same AgentCore microVM. This keeps Claude Code's
    // session data (~/.claude/projects/) alive between invocations.
    // Falls back to org_user if no chat session ID is available.
    const rawSessionId = options.sessionId ?? `${options.organizationId}_${options.userId}`;
    const sessionId = rawSessionId.length >= 33 ? rawSessionId : rawSessionId.padEnd(33, '_');

    console.log(`[agentcore-runtime] Invoking session=${sessionId} agent=${agentConfig.id}`);
    console.log(`[agentcore-runtime] runtimeArn=${this.runtimeArn}`);
    console.log(`[agentcore-runtime] client class=${this.runtimeClient?.constructor?.name}`);
    console.log(`[agentcore-runtime] command class=${this.InvokeCommand?.name}`);

    const commandInput = {
      agentRuntimeArn: this.runtimeArn,
      runtimeSessionId: sessionId,
      payload,
      qualifier: 'DEFAULT',
    };
    console.log(
      `[agentcore-runtime] command input:`,
      JSON.stringify({ ...commandInput, payload: '(omitted)' })
    );

    const MAX_RETRIES = 2;
    let response: any;
    let lastError: any;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        response = await this.runtimeClient.send(new this.InvokeCommand(commandInput));
        console.log(`[agentcore-runtime] response status=${response.$metadata?.httpStatusCode}`);
        lastError = null;
        break;
      } catch (err: any) {
        lastError = err;
        const isHealthCheckError =
          err?.name === 'RuntimeClientError' &&
          typeof err?.message === 'string' &&
          err.message.includes('health check');

        console.error(
          `[agentcore-runtime] INVOKE ERROR (attempt ${attempt + 1}/${MAX_RETRIES + 1}):`
        );
        console.error(`[agentcore-runtime]   name=${err?.name}`);
        console.error(`[agentcore-runtime]   message=${err?.message}`);
        console.error(`[agentcore-runtime]   code=${err?.$metadata?.httpStatusCode}`);
        console.error(`[agentcore-runtime]   requestId=${err?.$metadata?.requestId}`);

        if (isHealthCheckError && attempt < MAX_RETRIES) {
          try {
            await this.runtimeClient.send(
              new this.StopSessionCommand({
                agentRuntimeArn: this.runtimeArn,
                runtimeSessionId: sessionId,
              })
            );
            console.log(
              `[agentcore-runtime] Stopped stale session ${sessionId}, retrying in 3s...`
            );
          } catch (stopErr: any) {
            console.warn(`[agentcore-runtime] Failed to stop session: ${stopErr?.message}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 3000));
          continue;
        }

        console.error(
          `[agentcore-runtime]   stack=${err?.stack?.split('\n').slice(0, 5).join('\n')}`
        );
        break;
      }
    }

    if (lastError) {
      yield {
        type: 'error',
        code: 'AGENTCORE_INVOKE_ERROR',
        message: `Failed to invoke AgentCore: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        suggestedAction: 'Check AGENTCORE_RUNTIME_ARN and IAM permissions',
      };
      return;
    }

    const contentType: string = response.contentType ?? '';
    console.log(`[agentcore-runtime] Response contentType: ${contentType}`);
    if (contentType.includes('text/event-stream')) {
      let eventCount = 0;
      for await (const event of this.parseSSEStream(response.response)) {
        eventCount++;
        if (eventCount <= 3 || event.type === 'error') {
          console.log(`[agentcore-runtime] Event ${eventCount}: type=${event.type}`);
        }
        yield event;
      }
      console.log(`[agentcore-runtime] Total events received: ${eventCount}`);
    } else {
      const body = await this.readBody(response.response);
      console.log(
        `[agentcore-runtime] Non-SSE response body (first 500 chars): ${body.slice(0, 500)}`
      );
      try {
        yield this.mapEvent(JSON.parse(body));
      } catch {
        yield {
          type: 'error',
          code: 'PARSE_ERROR',
          message: `Failed to parse response: ${body.slice(0, 200)}`,
        };
      }
    }
  }

  async disconnectSession(_sessionId: string): Promise<void> {
    /* managed by AgentCore */
  }
  async disconnectAll(): Promise<number> {
    return 0;
  }
  get activeSessionCount(): number {
    return 0;
  }
  hasSession(_sessionId: string): boolean {
    return false;
  }

  // ---------------------------------------------------------------------------
  // Chat history loading
  // ---------------------------------------------------------------------------

  private async loadChatHistory(
    organizationId: string,
    sessionId?: string
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    if (!sessionId) return [];
    // Only query DB if sessionId is a valid UUID (system tasks like scope-gen use non-UUID IDs)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(sessionId)) return [];
    try {
      const { prisma } = await import('../config/database.js');
      // Load recent messages, excluding the very latest user message
      // (which is the current prompt — already passed separately in payload.prompt).
      const messages = await prisma.chat_messages.findMany({
        where: { session_id: sessionId, organization_id: organizationId },
        orderBy: { created_at: 'desc' },
        take: 21, // one extra so we can drop the latest user message
        select: { type: true, content: true },
      });
      const reversed = messages.reverse();
      // Drop the last user message (it's the current prompt being sent)
      let lastUserIdx = -1;
      for (let i = reversed.length - 1; i >= 0; i--) {
        if (reversed[i]!.type === 'user') {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx >= 0) {
        reversed.splice(lastUserIdx, 1);
      }
      return reversed.map((m: { type: string; content: string }) => ({
        role: m.type === 'ai' ? ('assistant' as const) : ('user' as const),
        content: this.extractTextFromContent(m.content),
      }));
    } catch (err) {
      console.warn('[agentcore-runtime] Failed to load chat history:', err);
      return [];
    }
  }

  private extractTextFromContent(content: string): string {
    // AI messages are stored as JSON array of content blocks
    try {
      const blocks = JSON.parse(content);
      if (Array.isArray(blocks)) {
        return blocks
          .filter((b: any) => b.type === 'text' && b.text)
          .map((b: any) => b.text)
          .join('\n');
      }
    } catch {
      // Not JSON — return as-is (user messages are plain text)
    }
    return content;
  }

  private async *parseSSEStream(stream: any): AsyncGenerator<ConversationEvent> {
    let buffer = '';
    const iterable = stream[Symbol.asyncIterator]
      ? stream
      : stream.transformToByteArray
        ? [await stream.transformToByteArray()]
        : [stream];

    for await (const chunk of iterable) {
      buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        for (const line of part.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data || data === '[DONE]') continue;
          try {
            yield this.mapEvent(JSON.parse(data));
          } catch {
            /* skip */
          }
        }
      }
    }
    if (buffer.trim()) {
      for (const line of buffer.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        try {
          yield this.mapEvent(JSON.parse(data));
        } catch {
          /* skip */
        }
      }
    }
  }

  private mapEvent(event: AgentCoreEvent): ConversationEvent {
    switch (event.type) {
      case 'session_start':
        return { type: 'session_start', sessionId: event.session_id };
      case 'assistant':
        return {
          type: 'assistant',
          sessionId: event.session_id,
          content: (event.content ?? []) as ContentBlock[],
        };
      case 'result': {
        // Map token_usage from AgentCore container format to backend format
        const tu = (event as any).token_usage;
        const tokenUsage = tu
          ? {
              inputTokens: tu.input_tokens ?? 0,
              outputTokens: tu.output_tokens ?? 0,
              cacheReadInputTokens: tu.cache_read_input_tokens ?? 0,
              cacheCreationInputTokens: tu.cache_creation_input_tokens ?? 0,
              totalCostUsd: tu.total_cost_usd ?? 0,
            }
          : undefined;
        return {
          type: 'result',
          sessionId: event.session_id,
          durationMs: event.duration_ms,
          numTurns: event.num_turns,
          tokenUsage,
        };
      }
      case 'error':
        return {
          type: 'error',
          sessionId: event.session_id,
          code: event.code ?? 'AGENTCORE_ERROR',
          message: event.message ?? 'Unknown error',
        };
      case 'trace':
        this.rehydrateContainerSpans(event.spans);
        return { type: 'assistant', content: [] };
      default:
        return {
          type: 'error',
          code: 'UNKNOWN_EVENT',
          message: `Unknown event type: ${(event as any).type}`,
        };
    }
  }

  private async readBody(stream: any): Promise<string> {
    if (typeof stream.transformToString === 'function') return stream.transformToString();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf-8');
  }

  private rehydrateContainerSpans(spans: AgentCoreEvent['spans']): void {
    if (!spans || spans.length === 0) return;
    const rehydrator = trace.getTracer('agentcore-rehydrator');

    for (const cs of spans) {
      const span = rehydrator.startSpan(cs.name, {
        kind: SpanKind.INTERNAL,
        attributes: Object.fromEntries(
          Object.entries(cs.attributes).map(([k, v]) => [`agentcore.${k}`, v])
        ),
      });

      if (cs.status === 'ERROR') {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }

      span.end();
    }
  }
}
