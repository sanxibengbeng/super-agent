/**
 * Scope Generator Service (Frontend)
 *
 * Calls the backend SSE endpoint to generate a business scope + agents
 * from a free-text description, and the confirm endpoint to persist them.
 */

import { getAuthToken } from './api/restClient';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

// ---------------------------------------------------------------------------
// Types (mirror backend GeneratedScopeConfig)
// ---------------------------------------------------------------------------

export interface GeneratedScope {
  name: string;
  description: string;
  icon: string;
  color: string;
}

export interface GeneratedSkill {
  name: string;
  description: string;
  body: string;
}

export interface GeneratedAgent {
  name: string;
  displayName: string;
  role: string;
  systemPrompt: string;
  skills?: GeneratedSkill[];
}

export interface GeneratedScopeConfig {
  scope: GeneratedScope;
  agents: GeneratedAgent[];
}

export interface ConfirmResult {
  scope: { id: string; name: string; description: string; icon: string; color: string };
  agents: Array<{ id: string; name: string; displayName: string; role: string; avatar?: string | null }>;
}

// SSE event types from the backend
export interface SSEEvent {
  type: 'session_start' | 'assistant' | 'result' | 'heartbeat' | 'error';
  sessionId?: string;
  content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> | string }>;
  code?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Streaming generator
// ---------------------------------------------------------------------------

export type GenerateCallback = (event: SSEEvent) => void;

/**
 * Streams scope generation via SSE. Calls onEvent for each parsed event.
 * Returns the accumulated text content when done.
 */
export async function generateScope(
  description: string,
  onEvent: GenerateCallback,
  signal?: AbortSignal,
): Promise<string> {
  const token = getAuthToken();
  const response = await fetch(`${API_BASE_URL}/api/scope-generator/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ description }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Generation failed: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';
  let accumulatedText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Parse SSE lines
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // keep incomplete line in buffer

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      try {
        const event: SSEEvent = JSON.parse(data);
        onEvent(event);

        // Accumulate text from assistant/result events
        if ((event.type === 'assistant' || event.type === 'result') && event.content) {
          for (const block of event.content) {
            if (block.type === 'text' && block.text) {
              accumulatedText += block.text;
            }
            // Also capture tool_use input — Claude may return the JSON via a tool call
            if (block.type === 'tool_use' && block.input) {
              const inputStr = typeof block.input === 'string' ? block.input : JSON.stringify(block.input);
              accumulatedText += inputStr;
            }
          }
        }
      } catch {
        // skip unparseable lines
      }
    }
  }

  return accumulatedText;
}

/**
 * Parse the accumulated text into a GeneratedScopeConfig.
 */
export function parseScopeConfig(text: string): GeneratedScopeConfig {
  let jsonStr = text.trim();

  // If empty, fail early with a clear message
  if (!jsonStr) {
    throw new Error('No content received from AI generation');
  }

  // Try parsing directly first (tool_use input is often already valid JSON)
  try {
    const direct = JSON.parse(jsonStr);
    if (direct.scope && direct.agents && Array.isArray(direct.agents)) {
      return direct as GeneratedScopeConfig;
    }
  } catch {
    // Not direct JSON, try extraction below
  }

  // Strip markdown code fences
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1]!.trim();
  }

  // Find JSON boundaries
  const firstBrace = jsonStr.indexOf('{');
  const lastBrace = jsonStr.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
  }

  const parsed = JSON.parse(jsonStr);
  if (!parsed.scope || !parsed.agents || !Array.isArray(parsed.agents)) {
    throw new Error('Invalid config: missing scope or agents');
  }
  return parsed as GeneratedScopeConfig;
}

/**
 * Confirm and persist the generated scope + agents.
 */
export async function confirmScopeGeneration(
  config: GeneratedScopeConfig,
  isDefault = false,
): Promise<ConfirmResult> {
  const token = getAuthToken();
  const response = await fetch(`${API_BASE_URL}/api/scope-generator/generate/confirm`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ config, isDefault }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Confirm failed: ${response.status}`);
  }

  const result = await response.json();
  return result.data as ConfirmResult;
}
