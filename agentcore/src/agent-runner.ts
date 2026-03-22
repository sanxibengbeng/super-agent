/**
 * Agent Runner — wraps Claude Agent SDK query() for AgentCore invocations.
 *
 * Yields AgentEvent objects that get serialized as SSE `data:` lines.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentPayload, AgentEvent, ContentBlock } from './types.js';

const DEFAULT_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch', 'Task', 'Skill',
  'TodoWrite', 'ToolSearch', 'NotebookEdit',
];

export async function* runAgent(payload: AgentPayload): AsyncGenerator<AgentEvent> {
  const baseOptions: Record<string, unknown> = {
    systemPrompt: payload.system_prompt ?? undefined,
    allowedTools: payload.allowed_tools ?? DEFAULT_TOOLS,
    cwd: '/workspace',
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    // Skills, agents, CLAUDE.md, settings.json are all in /workspace/.claude/
    // (downloaded from S3). 'project' source discovers them via cwd.
    settingSources: ['project'],
  };

  if (payload.mcp_servers && Object.keys(payload.mcp_servers).length > 0) {
    baseOptions.mcpServers = payload.mcp_servers;
  }

  // Strategy: try Claude Code session resume first (fast, native history).
  // If resume fails (microVM was recycled), fallback to history-injected prompt.
  if (payload.session_id) {
    try {
      yield* runWithOptions(payload.prompt, { ...baseOptions, resume: payload.session_id });
      return; // resume succeeded
    } catch (err) {
      console.log(`[agent-runner] Session resume failed (${err}), falling back to history injection`);
    }
  }

  // Fallback: new session with history context in the prompt
  const prompt = buildContextualPrompt(payload);
  yield* runWithOptions(prompt, baseOptions);
}

async function* runWithOptions(
  prompt: string,
  options: Record<string, unknown>,
): AsyncGenerator<AgentEvent> {
  for await (const message of query({ prompt, options })) {
    const msg = message as Record<string, unknown>;

    // system/init → session_start
    if (msg.type === 'system' && msg.subtype === 'init') {
      yield {
        type: 'session_start',
        session_id: msg.session_id as string,
      };
      continue;
    }

    // assistant → content blocks
    if (msg.type === 'assistant') {
      const rawContent = (msg.message as Record<string, unknown>)?.content;
      const blocks = Array.isArray(rawContent)
        ? rawContent.map(mapContentBlock)
        : [];
      yield {
        type: 'assistant',
        content: blocks,
        session_id: msg.session_id as string | undefined,
      };
      continue;
    }

    // result → completion
    if (msg.type === 'result') {
      yield {
        type: 'result',
        session_id: msg.session_id as string | undefined,
        duration_ms: msg.duration_ms as number | undefined,
        num_turns: msg.num_turns as number | undefined,
        is_error: msg.is_error as boolean | undefined,
        result: msg.result as string | undefined,
      };
      continue;
    }
  }
}

/**
 * Build a prompt that includes conversation history for context continuity.
 * Since Claude Code session resume doesn't work across AgentCore invocations,
 * we prepend the conversation history to the user's message.
 */
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
