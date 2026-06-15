/**
 * Shared types for the AgentCore container runner.
 */

// ---------------------------------------------------------------------------
// Inbound payload (from Super Agent backend via invoke_agent_runtime)
// ---------------------------------------------------------------------------

export interface AgentPayload {
  prompt: string;
  session_id?: string;
  chat_session_id?: string;
  scope_id?: string;
  org_id?: string;
  agent_id?: string;
  system_prompt?: string;
  mcp_servers?: Record<string, unknown>;
  allowed_tools?: string[];
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Claude model ID to use (e.g. us.anthropic.claude-sonnet-4-6) */
  model?: string;
  /** S3 Files Access Point ARN for workspace filesystem mount */
  workspace_access_point_arn?: string;
  /** Execution task ID for Layer 1 reconciliation */
  execution_task_id?: string;
  /** W3C traceparent header for distributed tracing */
  traceparent?: string;
  /** W3C tracestate header */
  tracestate?: string;
}

// ---------------------------------------------------------------------------
// Outbound events (SSE data: lines back to the caller)
// ---------------------------------------------------------------------------

export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  total_cost_usd: number;
}

export interface AgentEvent {
  type: 'session_start' | 'assistant' | 'result' | 'error' | 'trace';
  session_id?: string;
  content?: ContentBlock[];
  code?: string;
  message?: string;
  duration_ms?: number;
  num_turns?: number;
  is_error?: boolean;
  result?: string;
  token_usage?: TokenUsage;
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
