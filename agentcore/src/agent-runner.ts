/**
 * Agent Runner — wraps Claude Agent SDK query() for AgentCore invocations.
 *
 * S3 Files mounts the workspace directly at /mnt/ws (via WORKSPACE_DIR env var).
 * No S3 sync needed — all file operations happen on the mounted filesystem.
 *
 * Yields AgentEvent objects that get serialized as SSE `data:` lines.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentPayload, AgentEvent, ContentBlock } from './types.js';
import { ContainerTracer } from './tracing.js';

const DEFAULT_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch', 'Task', 'Skill',
  'TodoWrite', 'ToolSearch', 'NotebookEdit',
];

const WORKSPACE_DIR = process.env.WORKSPACE_DIR ?? '/mnt/ws';

// ---------------------------------------------------------------------------
// Agent execution
// ---------------------------------------------------------------------------

export async function* runAgent(payload: AgentPayload): AsyncGenerator<AgentEvent> {
  const model = payload.model || process.env.ANTHROPIC_MODEL;
  const tracer = payload.traceparent ? new ContainerTracer(payload.traceparent) : null;

  const baseOptions: Record<string, unknown> = {
    systemPrompt: payload.system_prompt ?? undefined,
    allowedTools: payload.allowed_tools ?? DEFAULT_TOOLS,
    cwd: WORKSPACE_DIR,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['project'],
    ...(model ? { model } : {}),
  };

  if (payload.mcp_servers && Object.keys(payload.mcp_servers).length > 0) {
    baseOptions.mcpServers = payload.mcp_servers;
  }

  console.log(`[agent-runner] Working directory: ${WORKSPACE_DIR}`);
  console.log(`[agent-runner] Access point: ${payload.workspace_access_point_arn?.slice(0, 60)}...`);

  // Strategy: try Claude Code session resume first (fast, native history).
  // If resume fails (microVM was recycled), fallback to history-injected prompt.
  const coldStartSpan = tracer?.startSpan('agentcore:cold_start');
  coldStartSpan?.setAttribute('session_resume_attempted', !!payload.session_id);

  if (payload.session_id) {
    try {
      yield* runWithOptions(payload.prompt, { ...baseOptions, resume: payload.session_id }, tracer);
      coldStartSpan?.setAttribute('resume_success', true);
      coldStartSpan?.end();

      // Emit trace before returning (resume path)
      if (tracer && tracer.getSpans().length > 0) {
        yield { type: 'trace', spans: tracer.getSpans() };
      }
      return;
    } catch (err) {
      console.log(`[agent-runner] Session resume failed (${err}), falling back to history injection`);
      coldStartSpan?.setAttribute('resume_success', false);
    }
  }

  const prompt = buildContextualPrompt(payload);
  yield* runWithOptions(prompt, baseOptions, tracer);
  coldStartSpan?.end();

  // Emit trace at the end (fallback path)
  if (tracer && tracer.getSpans().length > 0) {
    yield { type: 'trace', spans: tracer.getSpans() };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function* runWithOptions(
  prompt: string,
  options: Record<string, unknown>,
  tracer?: ContainerTracer | null,
): AsyncGenerator<AgentEvent> {
  const turnSpan = tracer?.startSpan('agentcore:agent_turn');
  for await (const message of query({ prompt, options })) {
    const msg = message as Record<string, unknown>;

    if (msg.type === 'system' && msg.subtype === 'init') {
      yield {
        type: 'session_start',
        session_id: msg.session_id as string,
      };
      continue;
    }

    if (msg.type === 'system' && msg.subtype === 'local_command_output') {
      yield {
        type: 'assistant',
        content: [{ type: 'text', text: msg.content as string }],
        session_id: msg.session_id as string | undefined,
      };
      continue;
    }

    if (msg.type === 'assistant') {
      const rawContent = (msg.message as Record<string, unknown>)?.content;
      const blocks = Array.isArray(rawContent)
        ? rawContent.map(mapContentBlock)
        : [];

      if (tracer && turnSpan) {
        for (const block of blocks) {
          if (block.type === 'tool_use' && block.name) {
            const toolSpan = tracer.startSpan(`agentcore:tool_use:${block.name}`, turnSpan.spanId);
            toolSpan.end();
          }
        }
      }

      yield {
        type: 'assistant',
        content: blocks,
        session_id: msg.session_id as string | undefined,
      };
      continue;
    }

    if (msg.type === 'result') {
      if (turnSpan) {
        turnSpan.setAttribute('model', options.model as string ?? 'unknown');
        turnSpan.setAttribute('num_turns', (msg.num_turns as number) ?? 0);
        turnSpan.end((msg.is_error as boolean) ? 'ERROR' : 'OK');
      }

      const resultMsg = msg as Record<string, unknown>;
      // Extract token usage from SDK result message
      const usage = resultMsg.usage as Record<string, number> | undefined;
      const modelUsage = resultMsg.modelUsage as Record<string, Record<string, number>> | undefined;
      let tokenUsage: import('./types.js').TokenUsage | undefined;

      if (usage) {
        tokenUsage = {
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
          total_cost_usd: (resultMsg.total_cost_usd as number) ?? 0,
        };
      } else if (modelUsage) {
        // Aggregate from per-model usage
        let inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheCreation = 0, cost = 0;
        for (const mu of Object.values(modelUsage)) {
          inputTokens += mu.inputTokens ?? 0;
          outputTokens += mu.outputTokens ?? 0;
          cacheRead += mu.cacheReadInputTokens ?? 0;
          cacheCreation += mu.cacheCreationInputTokens ?? 0;
          cost += mu.costUSD ?? 0;
        }
        tokenUsage = {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_input_tokens: cacheRead,
          cache_creation_input_tokens: cacheCreation,
          total_cost_usd: cost,
        };
      }

      yield {
        type: 'result',
        session_id: msg.session_id as string | undefined,
        duration_ms: msg.duration_ms as number | undefined,
        num_turns: msg.num_turns as number | undefined,
        is_error: msg.is_error as boolean | undefined,
        result: msg.result as string | undefined,
        token_usage: tokenUsage,
      };
      continue;
    }
  }
}

function buildContextualPrompt(payload: AgentPayload): string {
  const userMessage = payload.prompt;
  const history = payload.history;

  if (!history || history.length === 0) {
    return userMessage;
  }

  const contextParts = history.map(msg =>
    msg.role === 'user' ? `User: ${msg.content}` : `Assistant: ${msg.content}`,
  );

  return (
    `Here is our conversation so far:\n\n${contextParts.join('\n\n')}\n\n` +
    `Now the user says:\n${userMessage}\n\n` +
    `Please respond based on the full conversation context above.`
  );
}

function mapContentBlock(block: Record<string, unknown>): ContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text as string };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id as string,
        name: block.name as string,
        input: block.input,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id as string,
        content: block.content as string | undefined,
        is_error: block.is_error as boolean | undefined,
      };
    default:
      return block as unknown as ContentBlock;
  }
}
