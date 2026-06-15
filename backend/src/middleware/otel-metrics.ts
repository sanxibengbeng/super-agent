import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('super-agent');

export const httpRequestDuration = meter.createHistogram('http_request_duration_seconds', {
  description: 'Duration of HTTP requests in seconds',
  unit: 's',
});

export const httpActiveConnections = meter.createUpDownCounter('http_active_connections', {
  description: 'Number of currently active HTTP connections',
});

export const wsActiveConnections = meter.createUpDownCounter('ws_active_connections', {
  description: 'Number of active WebSocket connections',
});

export const bullmqJobDuration = meter.createHistogram('bullmq_job_duration_seconds', {
  description: 'Duration of BullMQ job processing in seconds',
  unit: 's',
});

export const bullmqQueueDepth = meter.createUpDownCounter('bullmq_queue_depth', {
  description: 'Number of jobs waiting in BullMQ queues',
});

export const chatFirstTokenSeconds = meter.createHistogram('chat_first_token_seconds', {
  description: 'Time to first token in chat responses',
  unit: 's',
});

export const workflowNodeDuration = meter.createHistogram('workflow_node_execution_seconds', {
  description: 'Duration of individual workflow node execution',
  unit: 's',
});

export const bedrockInvocations = meter.createCounter('bedrock_invocations_total', {
  description: 'Total Bedrock model invocations',
});

export const chatSessionsActive = meter.createUpDownCounter('chat_sessions_active', {
  description: 'Number of chat sessions currently generating',
});
