# Full-Chain Distributed Tracing & Latency Analysis

> Date: 2026-06-15
> Status: Approved
> Scope: Backend (api, worker, gateway) + CDK infra + local dev

---

## Problem Statement

The platform has zero distributed tracing. Debugging production latency requires log spelunking across three ECS services (api, worker, gateway) plus Aurora, Redis, Bedrock, and AgentCore. There is no way to:

1. See the full lifecycle of a user request (CloudFront → ALB → API → DB/Redis → BullMQ → Worker → Bedrock)
2. Identify which segment of the chain introduces latency
3. Correlate a slow workflow execution back to the specific node/agent that caused it
4. Get per-route latency percentiles (p50/p95/p99) over time

## Solution

OpenTelemetry Node.js SDK with auto-instrumentation, exporting traces and metrics to Grafana Cloud via OTLP. Custom instrumentation for BullMQ job propagation and Claude agent turns.

## Architecture

```
┌─────────────── ECS Fargate Task ──────────────────┐
│                                                     │
│  Node.js Process (api | worker | gateway)          │
│  ┌──────────────────────────────────────────────┐  │
│  │ tracing.ts (loaded via --import flag)        │  │
│  │                                              │  │
│  │ Auto-instrumentations:                       │  │
│  │  • @opentelemetry/instrumentation-http       │  │
│  │  • @opentelemetry/instrumentation-fastify    │  │
│  │  • @opentelemetry/instrumentation-pg         │  │
│  │  • @opentelemetry/instrumentation-ioredis    │  │
│  │  • @opentelemetry/instrumentation-aws-sdk    │  │
│  │                                              │  │
│  │ Custom instrumentations:                     │  │
│  │  • BullMQ producer/consumer propagation      │  │
│  │  • Claude agent turn spans                   │  │
│  │  • Workflow node execution spans             │  │
│  │                                              │  │
│  │ Exporters:                                   │  │
│  │  • OTLPTraceExporter → Grafana Cloud Tempo   │  │
│  │  • OTLPMetricExporter → Grafana Cloud Mimir  │  │
│  └──────────────────────────────────────────────┘  │
│                                                     │
│  No sidecar needed (OTLP over HTTPS directly)      │
└─────────────────────────────────────────────────────┘
          │                         │
          ▼                         ▼
   Grafana Tempo              Grafana Mimir
   (traces)                   (metrics)
          │                         │
          ▼                         ▼
   ┌───────────────────────────────────────┐
   │  Grafana Cloud Dashboards             │
   │  • Service Map (auto from traces)     │
   │  • RED metrics per route              │
   │  • Latency heatmap by endpoint        │
   │  • BullMQ job flow visualization      │
   │  • LLM call latency breakdown         │
   │  • Trace-to-log correlation           │
   └───────────────────────────────────────┘
```

## Trace Context Propagation

```
CloudFront
  │ adds: X-Amz-Cf-Id (CF request ID)
  ▼
ALB
  │ adds: X-Amzn-Trace-Id (Root=...; Self=...)
  ▼
Fastify (api service)
  │ OTel HTTP instrumentation extracts X-Amzn-Trace-Id as parent context
  │ Creates server span: "POST /api/chat/stream"
  │   ├── Prisma span: "prisma:query SELECT..." (auto via pg instrumentation)
  │   ├── Redis span: "redis:GET session:..." (auto via ioredis instrumentation)
  │   ├── S3 span: "S3.PutObject" (auto via aws-sdk instrumentation)
  │   ├── Bedrock span: "Bedrock.InvokeModelWithResponseStream" (auto)
  │   ├── AgentCore span: "agentcore:invocation" (custom)
  │   │     │ injects: traceparent into AgentPayload.traceparent
  │   │     ▼
  │   │   AgentCore microVM (isolated, no network)
  │   │     │ Extracts: payload.traceparent → ContainerTracer
  │   │     │ Creates in-memory span tree:
  │   │     │   ├── "agentcore:cold_start" (session resume attempt)
  │   │     │   ├── "agentcore:agent_turn" (Claude SDK query)
  │   │     │   │     ├── "agentcore:tool_use:Read" (15ms)
  │   │     │   │     ├── "agentcore:tool_use:Bash" (8.2s)
  │   │     │   │     └── "agentcore:tool_use:Write" (22ms)
  │   │     │   └── "agentcore:mcp_call:postgres" (if MCP used)
  │   │     │
  │   │     │ Serializes spans as SSE: data: {"type":"trace","spans":[...]}
  │   │     ▼
  │   │   Backend receives trace event → rehydrates as OTel spans
  │   │   (attached to parent agentcore:invocation span)
  │   │
  │   └── BullMQ span: "bullmq:producer workflow-queue"
  │         │ injects: traceparent + tracestate into job.data.__otel
  │         ▼
Worker service (picks up job)
  │ Extracts: job.data.__otel → parent context
  │ Creates span: "bullmq:consumer workflow-queue"
  │   ├── Span: "workflow:node agent-node-1"
  │   │     ├── AgentCore span (same piggyback pattern as above)
  │   │     └── Or: Bedrock span (auto, for claude runtime)
  │   ├── Span: "workflow:node condition-node-2"
  │   └── Span: "workflow:node agent-node-3"
  ▼
All spans exported to Grafana Cloud via backend's OTel exporter
```

## Components

### 1. OTel Bootstrap (`backend/src/tracing.ts`)

Loaded before the application via Node.js `--import` flag. Registers all auto-instrumentations and exporters.

Key behaviors:
- Uses `NodeSDK` from `@opentelemetry/sdk-node`
- Auto-detects `OTEL_SERVICE_NAME` from env (set per PROCESS_ROLE)
- Resource attributes: service.name, service.version, deployment.environment, cloud.provider, cloud.region
- Sampler: `parentbased_traceidratio` — respects upstream sampling decisions, samples new traces at configured rate
- Batch span processor with 5s export interval, 512 max queue size
- Graceful shutdown on SIGTERM (flushes pending spans)

### 2. BullMQ Instrumentation (`backend/src/middleware/otel-bullmq.ts`)

Custom wrapper since no official OTel BullMQ instrumentation exists.

**Producer side:**
```
function traceableJobAdd(queue, jobName, data, opts) {
  const span = tracer.startSpan(`bullmq:producer ${queue.name}`)
  const carrier = {}
  propagation.inject(context.active(), carrier)
  data.__otel = carrier  // { traceparent, tracestate }
  span.setAttribute('bullmq.queue', queue.name)
  span.setAttribute('bullmq.job_name', jobName)
  // ... add job, end span
}
```

**Consumer side:**
```
function traceableJobProcess(job, processor) {
  const parentContext = propagation.extract(ROOT_CONTEXT, job.data.__otel || {})
  return context.with(parentContext, async () => {
    const span = tracer.startSpan(`bullmq:consumer ${job.queueName}`, {
      kind: SpanKind.CONSUMER,
      attributes: {
        'bullmq.queue': job.queueName,
        'bullmq.job_id': job.id,
        'bullmq.job_name': job.name,
        'bullmq.attempts': job.attemptsMade,
      },
    })
    // ... process job, end span
  })
}
```

### 3. Custom Business Spans

Integrated into existing services (not separate files):

**Chat service** (`chat.service.ts`):
- Span: `chat:stream` — wraps entire streamChat call
- Attributes: session_id, agent_id, scope_id, model
- Child span: `chat:first_token` — measures time to first LLM token

**Workflow orchestrator** (`workflow-orchestrator.ts`):
- Span: `workflow:execution` — wraps entire workflow run
- Child spans: `workflow:node:{nodeType}` per DAG node
- Attributes: workflow_id, execution_id, node_id, node_type

**Agent runtime** (`agent-runtime-claude.ts`):
- Span: `claude:agent_turn` — wraps runConversation
- Child spans for each tool_use/tool_result pair
- Attributes: model, num_turns, total_tokens

### 4. Metrics via OTel (`backend/src/middleware/otel-metrics.ts`)

Replaces the custom in-memory MetricsCollector with OTel metrics SDK. Exported alongside traces to Grafana Cloud Mimir.

**Histograms:**
- `http_request_duration_seconds` — labels: method, route, status_code
- `chat_first_token_seconds` — labels: model, agent_id
- `workflow_node_execution_seconds` — labels: node_type, workflow_id
- `bullmq_job_duration_seconds` — labels: queue, job_name

**Gauges:**
- `http_active_connections`
- `ws_active_connections`
- `bullmq_queue_depth` — labels: queue
- `chat_sessions_active` (status=generating)

**Counters:**
- `http_requests_total` — labels: method, route, status_code
- `bullmq_jobs_total` — labels: queue, job_name, status (completed/failed)
- `bedrock_invocations_total` — labels: model, status

### 5. Pino-OTel Log Correlation

Bridge trace context into existing Pino structured logs so traces can be correlated with logs in Grafana:

```
// In requestLoggerHook, add to log payload:
const span = trace.getActiveSpan()
if (span) {
  logPayload.trace_id = span.spanContext().traceId
  logPayload.span_id = span.spanContext().spanId
}
```

This enables "Logs for this trace" in Grafana if logs are later sent to Loki.

### 6. Backward Compatibility

- The existing `/metrics` JSON endpoint remains unchanged
- `X-Request-ID` header continues to be set (now derived from OTel trace ID)
- Langfuse integration unchanged (it traces LLM semantics; OTel traces infrastructure)
- When `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, OTel SDK is a no-op (safe to deploy without Grafana Cloud credentials)

## Files to Create

| File | Purpose |
|------|---------|
| `backend/src/tracing.ts` | OTel SDK bootstrap, auto-instrumentations, exporters |
| `backend/src/middleware/otel-bullmq.ts` | BullMQ producer/consumer trace propagation |
| `backend/src/middleware/otel-metrics.ts` | Business metrics via OTel Meter SDK |
| `agentcore/src/tracing.ts` | Lightweight ContainerTracer (no external deps, no network) |

## Files to Modify

| File | Change |
|------|--------|
| `backend/package.json` | Add OTel dependencies |
| `backend/src/config/index.ts` | Add OTEL_* env vars to Zod schema |
| `backend/src/middleware/requestLogger.ts` | Inject trace_id/span_id into Pino log entries |
| `backend/src/services/chat.service.ts` | Add chat:stream and chat:first_token spans |
| `backend/src/services/workflow-orchestrator.ts` | Add workflow:execution and workflow:node spans |
| `backend/src/services/agent-runtime-claude.ts` | Add claude:agent_turn span |
| `backend/src/services/agent-runtime-agentcore.ts` | Inject traceparent into payload; handle `trace` event; rehydrate spans |
| `backend/src/setup/queue-initialization.ts` | Wrap BullMQ workers with traceableJobProcess |
| `infra/lib/constructs/ecs-cluster.ts` | Add OTEL_* env vars to sharedEnvironment |
| `docker-compose.yml` | Add OTEL env vars + Jaeger container for local dev |
| `agentcore/src/types.ts` | Add `traceparent`/`tracestate` to AgentPayload; add `trace` event type |
| `agentcore/src/agent-runner.ts` | Wrap execution with ContainerTracer; yield trace event before result |
| `agentcore/src/index.ts` | Pass traceparent from payload into agent-runner |

## Dependencies to Add

```json
{
  "@opentelemetry/api": "^1.9",
  "@opentelemetry/sdk-node": "^0.57",
  "@opentelemetry/sdk-metrics": "^1.29",
  "@opentelemetry/exporter-trace-otlp-proto": "^0.57",
  "@opentelemetry/exporter-metrics-otlp-proto": "^0.57",
  "@opentelemetry/instrumentation-http": "^0.57",
  "@opentelemetry/instrumentation-fastify": "^0.43",
  "@opentelemetry/instrumentation-pg": "^0.48",
  "@opentelemetry/instrumentation-ioredis": "^0.46",
  "@opentelemetry/instrumentation-aws-sdk": "^0.48",
  "@opentelemetry/resources": "^1.29",
  "@opentelemetry/semantic-conventions": "^1.29"
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | (none — disables tracing) | Grafana Cloud OTLP gateway URL |
| `OTEL_EXPORTER_OTLP_HEADERS` | (none) | `Authorization=Basic <base64>` for Grafana Cloud auth |
| `OTEL_SERVICE_NAME` | `super-agent-${PROCESS_ROLE}` | Service identity in traces |
| `OTEL_TRACES_SAMPLER` | `parentbased_traceidratio` | Sampling strategy |
| `OTEL_TRACES_SAMPLER_ARG` | `1.0` (dev) / `0.1` (prod) | Sample rate |
| `OTEL_METRICS_EXPORT_INTERVAL` | `60000` | Metrics push interval (ms) |

## Local Development

Add optional Jaeger all-in-one to docker-compose.yml:

```yaml
jaeger:
  image: jaegertracing/all-in-one:1.62
  ports:
    - "16686:16686"   # Jaeger UI
    - "4318:4318"     # OTLP HTTP receiver
  environment:
    COLLECTOR_OTLP_ENABLED: "true"
```

Backend env in docker-compose:
```yaml
OTEL_EXPORTER_OTLP_ENDPOINT: "http://jaeger:4318"
OTEL_SERVICE_NAME: "super-agent-all"
OTEL_TRACES_SAMPLER_ARG: "1.0"
```

Developers can view traces at `http://localhost:16686`.

## Sampling Strategy

| Environment | Rate | Rationale |
|-------------|------|-----------|
| Local dev | 100% | Full visibility, low volume |
| Staging | 50% | Good coverage for testing |
| Production | 10% | Cost control on Grafana Cloud free tier |
| Error paths | 100% | Always sample failed requests (via custom sampler) |

The `parentbased_traceidratio` sampler respects upstream decisions — if CloudFront/ALB already decided to trace a request, we honor it.

## AgentCore Container Tracing

### Constraint

AgentCore containers run in isolated microVMs with **no direct outbound network access** to arbitrary endpoints. Communication is strictly via the AgentCore invoke/response protocol (SSE stream) and S3 Files filesystem mounts. This means the container cannot export OTLP spans directly to Grafana Cloud.

### Strategy: Piggyback Trace Data on SSE Response

Since the container can only communicate back via SSE events, we embed span data in the SSE stream and reconstruct the trace on the backend side.

```
Backend (caller)                          AgentCore Container (callee)
─────────────────                         ──────────────────────────────
                                          
1. Start span: "agentcore:invocation"     
2. Inject traceparent into payload ──────→ 3. Extract traceparent from payload
                                           4. Create internal span tree (in-memory)
                                              ├── "agentcore:session_init" (cold/warm start)
                                              ├── "agentcore:agent_turn"
                                              │     ├── "claude:tool_use Bash" 
                                              │     ├── "claude:tool_use Read"
                                              │     └── "claude:tool_use Write"
                                              └── "agentcore:result"
                                           5. Serialize span tree as SSE event
                                      ←────── data: {"type":"trace","spans":[...]}
6. Receive trace event                    
7. Re-hydrate spans with correct          
   parent context and export to           
   Grafana Cloud via backend's            
   OTel exporter                          
8. End span: "agentcore:invocation"       
```

### Implementation Details

#### Container Side (`agentcore/src/tracing.ts`)

Lightweight in-process span collector — no external exporter needed:

```typescript
import { performance } from 'perf_hooks';

interface ContainerSpan {
  name: string;
  traceId: string;       // inherited from parent traceparent
  spanId: string;        // generated locally
  parentSpanId: string;  // links to parent
  startTimeMs: number;
  endTimeMs: number;
  attributes: Record<string, string | number | boolean>;
  status: 'OK' | 'ERROR';
  events?: Array<{ name: string; timeMs: number; attributes?: Record<string, unknown> }>;
}

class ContainerTracer {
  private spans: ContainerSpan[] = [];
  private traceId: string;
  private rootParentSpanId: string;

  constructor(traceparent: string) {
    // Parse W3C traceparent: "00-{traceId}-{parentSpanId}-{flags}"
    const parts = traceparent.split('-');
    this.traceId = parts[1];
    this.rootParentSpanId = parts[2];
  }

  startSpan(name: string, parentSpanId?: string): { spanId: string; end: (status?: 'OK'|'ERROR') => void } {
    const spanId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const span: ContainerSpan = {
      name,
      traceId: this.traceId,
      spanId,
      parentSpanId: parentSpanId ?? this.rootParentSpanId,
      startTimeMs: performance.now(),
      endTimeMs: 0,
      attributes: {},
      status: 'OK',
    };
    this.spans.push(span);
    return {
      spanId,
      end: (status = 'OK') => { span.endTimeMs = performance.now(); span.status = status; },
    };
  }

  getSpans(): ContainerSpan[] { return this.spans; }
}
```

#### Container Side: SSE Trace Event

After the agent run completes, emit a `trace` event before the final `result` event:

```typescript
// In agent-runner.ts, after runWithOptions completes:
if (containerTracer) {
  const traceEvent: AgentEvent = {
    type: 'trace',
    spans: containerTracer.getSpans(),
  };
  yield traceEvent;
}
```

#### Backend Side: Trace Re-hydration (`agent-runtime-agentcore.ts`)

The backend receives the `trace` SSE event and re-creates proper OTel spans:

```typescript
import { trace, context, SpanKind, SpanStatusCode } from '@opentelemetry/api';

function rehydrateContainerSpans(traceEvent: AgentCoreTraceEvent, parentContext: Context): void {
  const tracer = trace.getTracer('agentcore-rehydrator');

  for (const cs of traceEvent.spans) {
    const span = tracer.startSpan(cs.name, {
      kind: SpanKind.INTERNAL,
      startTime: [Math.floor(cs.startTimeMs / 1000), (cs.startTimeMs % 1000) * 1_000_000],
      links: [], // Could link to parent if needed
    }, parentContext);

    for (const [key, val] of Object.entries(cs.attributes)) {
      span.setAttribute(`agentcore.${key}`, val);
    }

    if (cs.status === 'ERROR') {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }

    span.end([Math.floor(cs.endTimeMs / 1000), (cs.endTimeMs % 1000) * 1_000_000]);
  }
}
```

### What Gets Traced Inside AgentCore

| Span Name | Attributes | Purpose |
|-----------|-----------|---------|
| `agentcore:cold_start` | `duration_ms`, `session_resume_attempted`, `resume_success` | MicroVM startup / session resume latency |
| `agentcore:agent_turn` | `model`, `num_turns`, `total_tokens` | Overall Claude SDK execution |
| `agentcore:tool_use:{name}` | `tool_name`, `duration_ms`, `is_error` | Per-tool execution time |
| `agentcore:s3files_read` | `path`, `size_bytes` | S3 Files read latency (if measurable) |
| `agentcore:s3files_write` | `path`, `size_bytes` | S3 Files write latency |
| `agentcore:mcp_call` | `server_name`, `tool_name`, `duration_ms` | MCP server tool calls |

### Trace Context Injection

Modify `AgentPayload` to include trace context:

```typescript
// types.ts — add to AgentPayload interface
export interface AgentPayload {
  // ... existing fields ...
  /** W3C traceparent header for distributed tracing */
  traceparent?: string;
  /** W3C tracestate header */
  tracestate?: string;
}
```

Backend injects before invoke:

```typescript
// agent-runtime-agentcore.ts — in runConversation, before JSON.stringify
import { propagation, context } from '@opentelemetry/api';

const carrier: Record<string, string> = {};
propagation.inject(context.active(), carrier);

const payload = JSON.stringify({
  // ... existing fields ...
  traceparent: carrier.traceparent,
  tracestate: carrier.tracestate,
});
```

### Files Changed (AgentCore additions)

| File | Change |
|------|--------|
| `agentcore/src/tracing.ts` | **NEW** — ContainerTracer class (lightweight, no external deps) |
| `agentcore/src/types.ts` | Add `traceparent`, `tracestate` to AgentPayload; add `trace` event type |
| `agentcore/src/agent-runner.ts` | Wrap runWithOptions with ContainerTracer; yield trace event |
| `agentcore/src/index.ts` | Pass traceparent from payload to agent-runner |
| `agentcore/package.json` | No new dependencies (pure Node.js implementation) |
| `backend/src/services/agent-runtime-agentcore.ts` | Inject traceparent; handle `trace` SSE event; rehydrate spans |

### Key Design Decisions

1. **No OTel SDK in AgentCore container** — keeps the image slim (no 12 extra packages) and avoids the network access constraint. The backend does the heavy lifting of exporting.

2. **Span timestamps are relative** — `performance.now()` inside the container gives wall-clock offsets from container start. Backend adjusts to absolute time using the invoke start timestamp.

3. **Trace event is optional** — if `traceparent` is not in the payload (e.g., tracing disabled), no ContainerTracer is created and no trace event is emitted. Zero overhead when tracing is off.

4. **Tool-level granularity** — we trace each `tool_use` block from Claude's response, giving visibility into which tools are slow (e.g., a Bash command taking 30s vs a Read taking 1ms).

5. **MicroVM cold start tracking** — the first span captures whether session resume succeeded or a full cold start happened. This is critical for understanding AgentCore latency patterns.

### End-to-End Example Trace (with AgentCore)

```
[Trace ID: abc123...]
│
├── POST /api/chat/stream (api service, 15.2s)
│   ├── prisma:query SELECT chat_sessions (3ms)
│   ├── redis:GET session:lock (1ms)
│   ├── agentcore:invocation (14.8s)  ← backend span wrapping the invoke call
│   │   │
│   │   │  ┌── [re-hydrated from container SSE] ──────────────┐
│   │   │  │                                                    │
│   │   ├──┤── agentcore:cold_start (2.1s)                     │
│   │   │  │     resume_attempted=true, resume_success=false   │
│   │   │  │                                                    │
│   │   ├──┤── agentcore:agent_turn (12.4s)                    │
│   │   │  │     model=us.anthropic.claude-sonnet-4-6          │
│   │   │  │     num_turns=3, total_tokens=4521                │
│   │   │  │     ├── agentcore:tool_use:Read (15ms)            │
│   │   │  │     ├── agentcore:tool_use:Bash (8.2s)  ← SLOW!  │
│   │   │  │     ├── agentcore:tool_use:Write (22ms)           │
│   │   │  │     └── agentcore:tool_use:Read (8ms)             │
│   │   │  │                                                    │
│   │   │  └──────────────────────────────────────────────────┘
│   │   │
│   ├── prisma:query INSERT chat_messages (5ms)
│   └── redis:PUBLISH chat:events (1ms)
```

This gives full visibility into:
- AgentCore invoke API latency (the outer span)
- Cold start vs warm start (session resume success/failure)
- Which tool calls inside the container are slow
- Total agent turn time vs individual tool breakdown
- Token usage per invocation

## Graceful Degradation

- If `OTEL_EXPORTER_OTLP_ENDPOINT` is not set → OTel SDK registers no-op providers. Zero performance impact.
- If Grafana Cloud is unreachable → batch exporter retries with exponential backoff, drops spans after queue fills. No impact on request processing.
- OTel SDK errors are logged at WARN level, never thrown to application code.
- If AgentCore container doesn't receive `traceparent` → no ContainerTracer created, no trace event emitted. Zero overhead.
- If backend receives no `trace` SSE event from container → only the outer `agentcore:invocation` span is recorded (still useful for invoke latency).

## Success Criteria

1. A single chat request produces a trace showing: HTTP span → DB queries → Redis ops → BullMQ dispatch → Worker pickup → Bedrock call → Response
2. Per-route latency histograms (p50/p95/p99) visible in Grafana dashboard
3. Workflow execution traces show full DAG with parallel node execution
4. No measurable latency increase (< 1ms overhead per request from OTel SDK)
5. Trace IDs appear in Pino log entries for correlation
6. Local dev: traces visible in Jaeger UI at localhost:16686
7. **AgentCore traces show cold start time, per-tool breakdown, and total agent turn duration**
8. **Can identify slow tool calls inside AgentCore containers from Grafana trace view**

## Non-Goals

- Frontend RUM / browser-side tracing (separate initiative)
- Log forwarding to Grafana Loki (future, uses same OTLP path)
- Custom X-Ray integration (replaced by Grafana Cloud)
- Alerting rules in Grafana (separate from instrumentation)
- Full OTel SDK inside AgentCore container (would add 12 packages + need network access)
