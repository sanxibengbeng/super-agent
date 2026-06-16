# Full-Chain Distributed Tracing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add end-to-end distributed tracing from CloudFront through ECS Fargate (api/worker/gateway) to AgentCore containers, with per-route latency histograms, BullMQ propagation, and Grafana Cloud export.

**Architecture:** OpenTelemetry Node.js SDK with auto-instrumentation (HTTP, Fastify, pg, ioredis, AWS SDK) exports traces and metrics to Grafana Cloud via OTLP. AgentCore containers use a zero-dependency in-process tracer that piggybacks span data on SSE response events, which the backend rehydrates into proper OTel spans.

**Tech Stack:** `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-proto`, `@opentelemetry/exporter-metrics-otlp-proto`, Grafana Cloud (Tempo + Mimir), Jaeger (local dev)

---

## File Map

| File | Responsibility |
|------|---------------|
| `backend/src/tracing.ts` | OTel SDK bootstrap — loaded via `--import` before app starts |
| `backend/src/middleware/otel-bullmq.ts` | BullMQ producer/consumer trace context propagation |
| `backend/src/middleware/otel-metrics.ts` | Custom business metrics (histograms, gauges, counters) |
| `agentcore/src/tracing.ts` | Lightweight in-process ContainerTracer (zero deps) |

---

### Task 1: Install OTel Dependencies

**Files:**
- Modify: `backend/package.json`

- [ ] **Step 1: Install OTel packages**

```bash
cd backend && npm install \
  @opentelemetry/api@^1.9 \
  @opentelemetry/sdk-node@^0.57 \
  @opentelemetry/sdk-metrics@^1.29 \
  @opentelemetry/exporter-trace-otlp-proto@^0.57 \
  @opentelemetry/exporter-metrics-otlp-proto@^0.57 \
  @opentelemetry/instrumentation-http@^0.57 \
  @opentelemetry/instrumentation-fastify@^0.43 \
  @opentelemetry/instrumentation-pg@^0.48 \
  @opentelemetry/instrumentation-ioredis@^0.46 \
  @opentelemetry/instrumentation-aws-sdk@^0.48 \
  @opentelemetry/resources@^1.29 \
  @opentelemetry/semantic-conventions@^1.29
```

- [ ] **Step 2: Verify install succeeded**

Run: `cd backend && npm ls @opentelemetry/api`
Expected: Shows `@opentelemetry/api@1.9.x` in the tree without errors.

- [ ] **Step 3: Commit**

```bash
cd backend && git add package.json package-lock.json
git commit -m "chore(backend): add OpenTelemetry dependencies for distributed tracing"
```

---

### Task 2: OTel SDK Bootstrap (`backend/src/tracing.ts`)

**Files:**
- Create: `backend/src/tracing.ts`
- Modify: `backend/package.json` (scripts)

- [ ] **Step 1: Create the tracing bootstrap module**

```typescript
// backend/src/tracing.ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { Resource } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from '@opentelemetry/semantic-conventions';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';

const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (OTLP_ENDPOINT) {
  const serviceName = process.env.OTEL_SERVICE_NAME
    ?? `super-agent-${process.env.PROCESS_ROLE ?? 'all'}`;
  const environment = process.env.NODE_ENV ?? 'development';

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '1.0.0',
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: environment,
    'cloud.provider': 'aws',
    'cloud.region': process.env.AWS_REGION ?? 'us-east-1',
  });

  const traceExporter = new OTLPTraceExporter({
    url: `${OTLP_ENDPOINT}/v1/traces`,
    headers: parseOtlpHeaders(),
  });

  const metricExporter = new OTLPMetricExporter({
    url: `${OTLP_ENDPOINT}/v1/metrics`,
    headers: parseOtlpHeaders(),
  });

  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: parseInt(process.env.OTEL_METRICS_EXPORT_INTERVAL ?? '60000', 10),
  });

  const sdk = new NodeSDK({
    resource,
    traceExporter,
    metricReader,
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => {
          const url = req.url ?? '';
          return url === '/health' || url === '/ping' || url === '/metrics';
        },
      }),
      new FastifyInstrumentation(),
      new PgInstrumentation({ enhancedDatabaseReporting: true }),
      new IORedisInstrumentation(),
      new AwsInstrumentation({ suppressInternalInstrumentation: true }),
    ],
  });

  sdk.start();
  console.log(`[tracing] OTel SDK started: service=${serviceName} endpoint=${OTLP_ENDPOINT}`);

  const shutdown = async () => {
    try {
      await sdk.shutdown();
      console.log('[tracing] OTel SDK shut down successfully');
    } catch (err) {
      console.warn('[tracing] OTel SDK shutdown error:', err);
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} else {
  console.log('[tracing] OTel disabled (OTEL_EXPORTER_OTLP_ENDPOINT not set)');
}

function parseOtlpHeaders(): Record<string, string> {
  const raw = process.env.OTEL_EXPORTER_OTLP_HEADERS ?? '';
  if (!raw) return {};
  const headers: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const [key, ...rest] = pair.split('=');
    if (key && rest.length > 0) {
      headers[key.trim()] = rest.join('=').trim();
    }
  }
  return headers;
}
```

- [ ] **Step 2: Update package.json scripts to load tracing before app**

In `backend/package.json`, change the `dev` and `start` scripts:

```json
"dev": "tsx watch --import ./src/tracing.ts src/index.ts",
"start": "node --import ./dist/tracing.js dist/index.js",
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd backend && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Verify dev server starts without OTEL endpoint (no-op path)**

Run: `cd backend && timeout 5 npx tsx --import ./src/tracing.ts src/index.ts 2>&1 | head -20`
Expected: Contains `[tracing] OTel disabled (OTEL_EXPORTER_OTLP_ENDPOINT not set)` and server starts normally.

- [ ] **Step 5: Commit**

```bash
git add backend/src/tracing.ts backend/package.json
git commit -m "feat(backend): add OTel SDK bootstrap with auto-instrumentation"
```

---

### Task 3: Add OTEL Environment Variables to Config

**Files:**
- Modify: `backend/src/config/index.ts`
- Modify: `infra/lib/constructs/ecs-cluster.ts`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Add OTEL vars to Zod env schema**

In `backend/src/config/index.ts`, add after the `OAUTH_REDIRECT_BASE_URL` line (before the closing `}`):

```typescript
  // OpenTelemetry (optional — no-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset)
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  OTEL_EXPORTER_OTLP_HEADERS: z.string().optional(),
  OTEL_SERVICE_NAME: z.string().optional(),
  OTEL_TRACES_SAMPLER: z.string().optional().default('parentbased_traceidratio'),
  OTEL_TRACES_SAMPLER_ARG: z.string().optional().default('1.0'),
  OTEL_METRICS_EXPORT_INTERVAL: z.string().optional().default('60000'),
```

- [ ] **Step 2: Add otel config section to the exported config object**

After the `logLevel` line, add:

```typescript
  otel: {
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    headers: env.OTEL_EXPORTER_OTLP_HEADERS,
    serviceName: env.OTEL_SERVICE_NAME,
    sampler: env.OTEL_TRACES_SAMPLER,
    samplerArg: env.OTEL_TRACES_SAMPLER_ARG,
    metricsInterval: env.OTEL_METRICS_EXPORT_INTERVAL,
    enabled: !!env.OTEL_EXPORTER_OTLP_ENDPOINT,
  },
```

- [ ] **Step 3: Add OTEL env vars to ECS shared environment**

In `infra/lib/constructs/ecs-cluster.ts`, add to the `sharedEnvironment` object (after `CLAUDE_CODE_USE_BEDROCK: '1'`):

```typescript
      OTEL_EXPORTER_OTLP_ENDPOINT: props.otelEndpoint ?? '',
      OTEL_EXPORTER_OTLP_HEADERS: props.otelHeaders ?? '',
      OTEL_TRACES_SAMPLER: 'parentbased_traceidratio',
      OTEL_TRACES_SAMPLER_ARG: '0.1',
      OTEL_METRICS_EXPORT_INTERVAL: '60000',
```

Also add `OTEL_SERVICE_NAME` per container (in each `addContainer` call's environment):
- API container: `OTEL_SERVICE_NAME: 'super-agent-api'`
- Worker container: `OTEL_SERVICE_NAME: 'super-agent-worker'`
- Gateway container: `OTEL_SERVICE_NAME: 'super-agent-gateway'`

Add to `EcsClusterConstructProps`:
```typescript
  otelEndpoint?: string;
  otelHeaders?: string;
```

- [ ] **Step 4: Add OTEL env vars and Jaeger to docker-compose.yml**

Add to the `backend` service environment section:
```yaml
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://jaeger:4318"
      OTEL_SERVICE_NAME: "super-agent-all"
      OTEL_TRACES_SAMPLER_ARG: "1.0"
```

Add a new `jaeger` service:
```yaml
  jaeger:
    image: jaegertracing/all-in-one:1.62
    ports:
      - "16686:16686"
      - "4318:4318"
    environment:
      COLLECTOR_OTLP_ENABLED: "true"
    profiles:
      - tracing
```

Note: Using Docker Compose profiles — Jaeger only starts with `docker compose --profile tracing up`.

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd backend && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/config/index.ts infra/lib/constructs/ecs-cluster.ts docker-compose.yml
git commit -m "feat(config): add OTel environment variables to backend, CDK, and docker-compose"
```

---

### Task 4: Pino Log Correlation with Trace IDs

**Files:**
- Modify: `backend/src/middleware/requestLogger.ts`

- [ ] **Step 1: Add trace context to log entries**

At the top of `backend/src/middleware/requestLogger.ts`, add:

```typescript
import { trace } from '@opentelemetry/api';
```

- [ ] **Step 2: Inject trace_id and span_id into request log payload**

In the `responseLoggerHook` function, after `const logPayload = {` block (around line 121), add trace fields:

```typescript
  const activeSpan = trace.getActiveSpan();
  const logPayload = {
    requestId: context.requestId,
    method: context.method,
    url: context.url,
    statusCode,
    responseTimeMs: Math.round(responseTimeMs * 100) / 100,
    userId: context.userId || undefined,
    orgId: context.orgId || undefined,
    ...(activeSpan ? {
      trace_id: activeSpan.spanContext().traceId,
      span_id: activeSpan.spanContext().spanId,
      trace_flags: activeSpan.spanContext().traceFlags,
    } : {}),
  };
```

Do the same for the `requestLoggerHook` log entry (around line 81).

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd backend && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/middleware/requestLogger.ts
git commit -m "feat(backend): inject OTel trace_id into Pino log entries for correlation"
```

---

### Task 5: BullMQ Trace Propagation

**Files:**
- Create: `backend/src/middleware/otel-bullmq.ts`
- Modify: `backend/src/services/workflow-queue.service.ts`
- Modify: `backend/src/setup/workflow-queue-setup.ts`

- [ ] **Step 1: Create the BullMQ instrumentation helper**

```typescript
// backend/src/middleware/otel-bullmq.ts
import { trace, context, propagation, SpanKind, SpanStatusCode, ROOT_CONTEXT } from '@opentelemetry/api';
import type { Job } from 'bullmq';

const tracer = trace.getTracer('super-agent-bullmq');

export interface TracedJobData {
  __otel?: Record<string, string>;
}

/**
 * Inject current trace context into job data before adding to queue.
 * Call this in the producer (before queue.add).
 */
export function injectTraceContext<T extends Record<string, unknown>>(data: T): T & TracedJobData {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return { ...data, __otel: carrier };
}

/**
 * Wrap a BullMQ processor function with trace context extraction.
 * The processor runs inside a span that is a child of the producer's span.
 */
export function tracedProcessor<T extends TracedJobData>(
  queueName: string,
  processor: (job: Job<T>) => Promise<void>,
): (job: Job<T>) => Promise<void> {
  return async (job: Job<T>) => {
    const parentContext = job.data.__otel
      ? propagation.extract(ROOT_CONTEXT, job.data.__otel)
      : context.active();

    await context.with(parentContext, async () => {
      const span = tracer.startSpan(`bullmq:consumer ${queueName}`, {
        kind: SpanKind.CONSUMER,
        attributes: {
          'bullmq.queue': queueName,
          'bullmq.job_id': job.id ?? 'unknown',
          'bullmq.job_name': job.name,
          'bullmq.attempts': job.attemptsMade,
        },
      });

      try {
        await processor(job);
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        span.end();
      }
    });
  };
}

/**
 * Create a producer span and inject trace context.
 * Returns the enriched job data with __otel carrier.
 */
export function traceProducer<T extends Record<string, unknown>>(
  queueName: string,
  jobName: string,
  data: T,
): T & TracedJobData {
  const span = tracer.startSpan(`bullmq:producer ${queueName}`, {
    kind: SpanKind.PRODUCER,
    attributes: {
      'bullmq.queue': queueName,
      'bullmq.job_name': jobName,
    },
  });

  const enrichedData = injectTraceContext(data);
  span.end();
  return enrichedData;
}
```

- [ ] **Step 2: Modify workflow-queue.service.ts to inject trace context on job add**

In `backend/src/services/workflow-queue.service.ts`, add import at top:

```typescript
import { traceProducer, type TracedJobData } from '../middleware/otel-bullmq.js';
```

Modify `addRunWorkflowJob` method (line 140):

```typescript
  async addRunWorkflowJob(data: RunWorkflowJobData): Promise<Job<RunWorkflowJobData & TracedJobData>> {
    if (!this.runWorkflowQueue) {
      throw new Error('Run workflow queue not initialized');
    }

    const tracedData = traceProducer(QUEUE_RUN_WORKFLOW, 'runWorkflow', data);
    const job = await this.runWorkflowQueue.add('runWorkflow', tracedData, {
      jobId: `run-${data.executionId}-${data.nodeId}`,
    });

    return job;
  }
```

Do the same for `addPollWorkflowJob` (line 155):

```typescript
  async addPollWorkflowJob(data: PollWorkflowJobData): Promise<Job<PollWorkflowJobData & TracedJobData>> {
    if (!this.pollWorkflowQueue) {
      throw new Error('Poll workflow queue not initialized');
    }

    const tracedData = traceProducer(QUEUE_POLL_WORKFLOW, 'pollWorkflow', data);
    const job = await this.pollWorkflowQueue.add('pollWorkflow', tracedData, {
      ...pollJobOptions,
      jobId: `poll-${data.executionId}-${Date.now()}`,
    });

    return job;
  }
```

- [ ] **Step 3: Modify workflow-queue-setup.ts to wrap processors with tracing**

In `backend/src/setup/workflow-queue-setup.ts`, add import:

```typescript
import { tracedProcessor } from '../middleware/otel-bullmq.js';
import { QUEUE_RUN_WORKFLOW, QUEUE_POLL_WORKFLOW } from '../config/queue.js';
```

Wrap the processor registrations (lines 43-56):

```typescript
    // 3. Register run-workflow processor (with trace propagation)
    workflowQueueService.registerRunWorkflowProcessor(
      tracedProcessor(QUEUE_RUN_WORKFLOW, async (job: Job<RunWorkflowJobData>) => {
        console.log(`🔄 Processing run-workflow job: ${job.id}`, job.data);
        await workflowExecutionService.runWorkflow(job.data);
      })
    );

    // 4. Register poll-workflow processor (with trace propagation)
    workflowQueueService.registerPollWorkflowProcessor(
      tracedProcessor(QUEUE_POLL_WORKFLOW, async (job: Job<PollWorkflowJobData>) => {
        console.log(`🔄 Processing poll-workflow job: ${job.id}`, job.data);
        await workflowExecutionService.pollWorkflow(job.data);
      })
    );
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd backend && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/middleware/otel-bullmq.ts backend/src/services/workflow-queue.service.ts backend/src/setup/workflow-queue-setup.ts
git commit -m "feat(backend): add BullMQ trace context propagation for workflow queues"
```

---

### Task 6: Custom Business Metrics

**Files:**
- Create: `backend/src/middleware/otel-metrics.ts`
- Modify: `backend/src/middleware/requestLogger.ts`

- [ ] **Step 1: Create the OTel metrics module**

```typescript
// backend/src/middleware/otel-metrics.ts
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
```

- [ ] **Step 2: Integrate HTTP metrics into requestLogger**

In `backend/src/middleware/requestLogger.ts`, add import:

```typescript
import { httpRequestDuration, httpActiveConnections } from './otel-metrics.js';
```

In `requestLoggerHook` (after `metricsCollector.onRequestStart()`):

```typescript
  httpActiveConnections.add(1);
```

In `responseLoggerHook` (after `metricsCollector.onRequestEnd(...)`):

```typescript
  httpActiveConnections.add(-1);
  httpRequestDuration.record(responseTimeMs / 1000, {
    method: request.method,
    route: request.routeOptions?.url || request.url,
    status_code: String(statusCode),
  });
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd backend && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/middleware/otel-metrics.ts backend/src/middleware/requestLogger.ts
git commit -m "feat(backend): add OTel metrics for HTTP latency, connections, and business events"
```

---

### Task 7: AgentCore Container Tracer (Zero Dependencies)

**Files:**
- Create: `agentcore/src/tracing.ts`
- Modify: `agentcore/src/types.ts`

- [ ] **Step 1: Create the lightweight ContainerTracer**

```typescript
// agentcore/src/tracing.ts
import { performance } from 'perf_hooks';
import crypto from 'crypto';

export interface ContainerSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  startTimeMs: number;
  endTimeMs: number;
  attributes: Record<string, string | number | boolean>;
  status: 'OK' | 'ERROR';
}

export class ContainerTracer {
  private spans: ContainerSpan[] = [];
  private traceId: string;
  private rootParentSpanId: string;
  private baseTime: number;

  constructor(traceparent: string) {
    const parts = traceparent.split('-');
    this.traceId = parts[1] ?? crypto.randomUUID().replace(/-/g, '');
    this.rootParentSpanId = parts[2] ?? '0000000000000000';
    this.baseTime = performance.now();
  }

  startSpan(name: string, parentSpanId?: string): {
    spanId: string;
    setAttribute: (key: string, value: string | number | boolean) => void;
    end: (status?: 'OK' | 'ERROR') => void;
  } {
    const spanId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const span: ContainerSpan = {
      name,
      traceId: this.traceId,
      spanId,
      parentSpanId: parentSpanId ?? this.rootParentSpanId,
      startTimeMs: performance.now() - this.baseTime,
      endTimeMs: 0,
      attributes: {},
      status: 'OK',
    };
    this.spans.push(span);

    return {
      spanId,
      setAttribute: (key: string, value: string | number | boolean) => {
        span.attributes[key] = value;
      },
      end: (status: 'OK' | 'ERROR' = 'OK') => {
        span.endTimeMs = performance.now() - this.baseTime;
        span.status = status;
      },
    };
  }

  getSpans(): ContainerSpan[] {
    return this.spans;
  }

  getBaseTime(): number {
    return this.baseTime;
  }
}
```

- [ ] **Step 2: Update types.ts to include trace fields in payload and events**

In `agentcore/src/types.ts`, add to `AgentPayload` interface:

```typescript
  /** W3C traceparent header for distributed tracing */
  traceparent?: string;
  /** W3C tracestate header */
  tracestate?: string;
```

Add `trace` to the `AgentEvent` type union:

```typescript
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
  /** Span data piggybacked from container (only on type='trace' events) */
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
```

- [ ] **Step 3: Verify agentcore compiles**

Run: `cd agentcore && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add agentcore/src/tracing.ts agentcore/src/types.ts
git commit -m "feat(agentcore): add lightweight ContainerTracer for distributed tracing"
```

---

### Task 8: Instrument AgentCore Agent Runner

**Files:**
- Modify: `agentcore/src/agent-runner.ts`
- Modify: `agentcore/src/index.ts`

- [ ] **Step 1: Integrate ContainerTracer into agent-runner.ts**

Add import at top of `agentcore/src/agent-runner.ts`:

```typescript
import { ContainerTracer } from './tracing.js';
```

Modify the `runAgent` function to accept and use the tracer. Change the signature:

```typescript
export async function* runAgent(payload: AgentPayload): AsyncGenerator<AgentEvent> {
  const tracer = payload.traceparent ? new ContainerTracer(payload.traceparent) : null;
  const model = payload.model || process.env.ANTHROPIC_MODEL;
```

After the `model` line, start the cold_start span:

```typescript
  const coldStartSpan = tracer?.startSpan('agentcore:cold_start');
  coldStartSpan?.setAttribute('session_resume_attempted', !!payload.session_id);
```

In the session resume try block (after `yield* runWithOptions(...)` on line 49), before `return`:

```typescript
      coldStartSpan?.setAttribute('resume_success', true);
      coldStartSpan?.end();
```

In the catch block (after `console.log` on line 52):

```typescript
      coldStartSpan?.setAttribute('resume_success', false);
```

After the fallback prompt execution (line 57), after `yield* runWithOptions(prompt, baseOptions)`:

```typescript
  coldStartSpan?.end();
```

Wrap `runWithOptions` to emit per-tool spans. Modify the inner `runWithOptions` generator to accept and use a tracer:

Replace the inner function signature from:
```typescript
async function* runWithOptions(
  prompt: string,
  options: Record<string, unknown>,
): AsyncGenerator<AgentEvent> {
```

To:
```typescript
async function* runWithOptions(
  prompt: string,
  options: Record<string, unknown>,
  tracer?: ContainerTracer | null,
): AsyncGenerator<AgentEvent> {
  const turnSpan = tracer?.startSpan('agentcore:agent_turn');
```

Inside the assistant message handling (where `msg.type === 'assistant'`), add tool_use tracking:

```typescript
    if (msg.type === 'assistant') {
      const rawContent = (msg.message as Record<string, unknown>)?.content;
      const blocks = Array.isArray(rawContent) ? rawContent.map(mapContentBlock) : [];

      // Track tool_use spans
      if (tracer) {
        for (const block of blocks) {
          if (block.type === 'tool_use' && block.name) {
            const toolSpan = tracer.startSpan(`agentcore:tool_use:${block.name}`, turnSpan?.spanId);
            toolSpan.end();
          }
        }
      }

      yield { type: 'assistant', content: blocks, session_id: msg.session_id as string | undefined };
      continue;
    }
```

In the result handler, end the turn span and record attributes:

```typescript
    if (msg.type === 'result') {
      if (turnSpan) {
        turnSpan.setAttribute('model', model ?? 'unknown');
        turnSpan.setAttribute('num_turns', (msg.num_turns as number) ?? 0);
        turnSpan.end(msg.is_error ? 'ERROR' : 'OK');
      }
      // ... existing result handling ...
```

At the very end of `runAgent`, after all yields, emit the trace event:

```typescript
  // Emit trace event with collected spans (before function returns)
  if (tracer && tracer.getSpans().length > 0) {
    yield { type: 'trace', spans: tracer.getSpans() };
  }
```

Update the two calls to `runWithOptions` to pass the tracer:

```typescript
yield* runWithOptions(payload.prompt, { ...baseOptions, resume: payload.session_id }, tracer);
// ...
yield* runWithOptions(prompt, baseOptions, tracer);
```

- [ ] **Step 2: No changes needed in index.ts**

The `index.ts` already passes the full payload to `runAgent`, and `runAgent` reads `traceparent` from it. No modification needed.

- [ ] **Step 3: Verify agentcore compiles**

Run: `cd agentcore && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add agentcore/src/agent-runner.ts
git commit -m "feat(agentcore): instrument agent-runner with ContainerTracer spans"
```

---

### Task 9: Backend Rehydration of AgentCore Traces

**Files:**
- Modify: `backend/src/services/agent-runtime-agentcore.ts`

- [ ] **Step 1: Add trace context injection into payload**

At the top of `backend/src/services/agent-runtime-agentcore.ts`, add imports:

```typescript
import { trace, context, propagation, SpanKind, SpanStatusCode } from '@opentelemetry/api';
```

In the `runConversation` method, before `const payload = JSON.stringify({` (around line 112), inject trace context:

```typescript
    // Inject OTel trace context for AgentCore container tracing
    const traceCarrier: Record<string, string> = {};
    propagation.inject(context.active(), traceCarrier);
```

Add `traceparent` and `tracestate` to the payload object:

```typescript
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
      workspace_access_point_arn: accessPoint.arn,
      execution_task_id: options.executionTaskId ?? undefined,
      traceparent: traceCarrier.traceparent,
      tracestate: traceCarrier.tracestate,
    });
```

- [ ] **Step 2: Add trace event handling in the SSE event mapper**

Add a `rehydrateContainerSpans` helper method to the class:

```typescript
  private rehydrateContainerSpans(spans: AgentCoreEvent['spans']): void {
    if (!spans || spans.length === 0) return;
    const tracer = trace.getTracer('agentcore-rehydrator');

    for (const cs of spans) {
      const span = tracer.startSpan(cs.name, {
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
```

In the `mapEvent` method, add a case for `trace`:

```typescript
      case 'trace':
        this.rehydrateContainerSpans(event.spans);
        // Don't yield trace events to the chat consumer — they're internal
        return { type: 'assistant', content: [] }; // no-op event
```

Also add `spans` to the `AgentCoreEvent` interface at the top:

```typescript
interface AgentCoreEvent {
  type: 'session_start' | 'assistant' | 'result' | 'error' | 'trace';
  // ... existing fields ...
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
```

- [ ] **Step 3: Skip empty assistant events in the SSE stream**

In the `parseSSEStream` generator, after `yield this.mapEvent(JSON.parse(data))`, the consumer already handles empty content arrays gracefully — no change needed.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd backend && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/agent-runtime-agentcore.ts
git commit -m "feat(backend): inject trace context into AgentCore and rehydrate container spans"
```

---

### Task 10: Integration Test

**Files:**
- Create: `backend/tests/integration/tracing.integration.test.ts`

- [ ] **Step 1: Write integration test verifying trace bootstrap**

```typescript
// backend/tests/integration/tracing.integration.test.ts
import { describe, it, expect } from 'vitest';
import { trace, context } from '@opentelemetry/api';

describe('OTel Tracing Integration', () => {
  it('trace.getTracer returns a valid tracer (even when no exporter configured)', () => {
    const tracer = trace.getTracer('test');
    expect(tracer).toBeDefined();

    const span = tracer.startSpan('test-span');
    expect(span).toBeDefined();
    expect(span.spanContext().traceId).toHaveLength(32);
    expect(span.spanContext().spanId).toHaveLength(16);
    span.end();
  });

  it('context propagation works in-process', () => {
    const tracer = trace.getTracer('test');
    const parentSpan = tracer.startSpan('parent');
    const parentCtx = trace.setSpan(context.active(), parentSpan);

    context.with(parentCtx, () => {
      const childSpan = tracer.startSpan('child');
      expect(childSpan.spanContext().traceId).toBe(parentSpan.spanContext().traceId);
      childSpan.end();
    });

    parentSpan.end();
  });
});
```

- [ ] **Step 2: Write test for BullMQ trace propagation helper**

```typescript
// backend/tests/integration/tracing.integration.test.ts (append)
import { injectTraceContext, tracedProcessor } from '../../src/middleware/otel-bullmq.js';

describe('BullMQ Trace Propagation', () => {
  it('injectTraceContext adds __otel field with traceparent', () => {
    const tracer = trace.getTracer('test');
    const span = tracer.startSpan('producer');
    const ctx = trace.setSpan(context.active(), span);

    let enriched: any;
    context.with(ctx, () => {
      enriched = injectTraceContext({ executionId: '123', nodeId: 'abc' });
    });

    expect(enriched.__otel).toBeDefined();
    expect(enriched.__otel.traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-0[01]$/);
    expect(enriched.executionId).toBe('123');
    span.end();
  });
});
```

- [ ] **Step 3: Write test for ContainerTracer**

```typescript
// backend/tests/integration/tracing.integration.test.ts (append)
describe('ContainerTracer (agentcore)', () => {
  it('creates spans with correct parent chain', async () => {
    // Dynamically import since it's in agentcore package
    const { ContainerTracer } = await import('../../../agentcore/src/tracing.js');

    const traceparent = '00-abcdef1234567890abcdef1234567890-1234567890abcdef-01';
    const tracer = new ContainerTracer(traceparent);

    const root = tracer.startSpan('cold_start');
    root.setAttribute('resume', false);
    root.end();

    const turn = tracer.startSpan('agent_turn');
    const tool = tracer.startSpan('tool_use:Bash', turn.spanId);
    tool.end();
    turn.end();

    const spans = tracer.getSpans();
    expect(spans).toHaveLength(3);
    expect(spans[0].traceId).toBe('abcdef1234567890abcdef1234567890');
    expect(spans[0].parentSpanId).toBe('1234567890abcdef');
    expect(spans[2].parentSpanId).toBe(turn.spanId);
    expect(spans[0].attributes['resume']).toBe(false);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `cd backend && npx vitest run tests/integration/tracing.integration.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/tests/integration/tracing.integration.test.ts
git commit -m "test(backend): add integration tests for OTel tracing and BullMQ propagation"
```

---

### Task 11: Final Verification and Documentation

**Files:**
- Modify: `backend/src/app.ts` (ensure tracing.ts exports no side-effects that break tests)

- [ ] **Step 1: Verify full build**

Run: `cd backend && npm run build`
Expected: Compiles with no errors.

- [ ] **Step 2: Verify tests pass**

Run: `cd backend && npm run test`
Expected: All existing + new tests pass.

- [ ] **Step 3: Verify agentcore builds**

Run: `cd agentcore && npm run build`
Expected: Compiles with no errors.

- [ ] **Step 4: Verify local dev starts cleanly (no OTEL endpoint)**

Run: `cd backend && timeout 8 npx tsx --import ./src/tracing.ts src/index.ts 2>&1 | grep -E "tracing|OTel|listening"`
Expected: Shows `[tracing] OTel disabled` and server starts on port 3000.

- [ ] **Step 5: Commit any fixups**

```bash
git add -A
git commit -m "chore: final build verification for distributed tracing feature"
```

---

## Summary of Deliverables

| # | What | Key File |
|---|------|---------|
| 1 | OTel SDK bootstrap (auto-instruments HTTP/Fastify/pg/ioredis/AWS) | `backend/src/tracing.ts` |
| 2 | Env var config (backend + CDK + docker-compose) | `backend/src/config/index.ts` |
| 3 | Pino log correlation (trace_id in every log line) | `backend/src/middleware/requestLogger.ts` |
| 4 | BullMQ trace propagation (producer→consumer) | `backend/src/middleware/otel-bullmq.ts` |
| 5 | HTTP latency histograms + business metrics | `backend/src/middleware/otel-metrics.ts` |
| 6 | AgentCore container tracer (zero deps) | `agentcore/src/tracing.ts` |
| 7 | AgentCore span piggyback on SSE + backend rehydration | `agent-runtime-agentcore.ts` |
| 8 | Integration tests | `tests/integration/tracing.integration.test.ts` |
| 9 | Local Jaeger for dev (opt-in via Docker Compose profile) | `docker-compose.yml` |
