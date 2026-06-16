# Observability Gap Analysis and Improvement Plan

> Audit date: 2026-06-15
> Scope: backend, infrastructure (CDK), frontend admin surfaces

---

## Current State

### Logging

Pino structured JSON logging is integrated at the Fastify level with environment-aware configuration.

| Capability | Implementation | File |
|------------|----------------|------|
| Structured JSON output (production) | Pino with level via `LOG_LEVEL` env var | `backend/src/app.ts:47-65` |
| Human-readable output (dev) | `pino-pretty` transport | `backend/src/app.ts:49-57` |
| Sensitive field redaction | `req.headers.authorization`, `req.headers.cookie` | `backend/src/app.ts:64` |
| Request correlation ID | `crypto.randomUUID()` per request, propagated via `X-Request-ID` | `backend/src/app.ts:69`, `backend/src/middleware/requestLogger.ts:62-68` |
| Request context fields | method, url, userAgent, ip, userId, orgId | `backend/src/middleware/requestLogger.ts:37-47` |
| Response timing | High-resolution `process.hrtime.bigint()` measurement | `backend/src/middleware/requestLogger.ts:77,109-116` |
| Slow request warnings | Requests > 3000ms logged at WARN level | `backend/src/middleware/requestLogger.ts:132-139` |
| Error context | Error class, status code, route, sanitized body, stack trace | `backend/src/middleware/errorHandler.ts` |
| CloudWatch Log Groups | `/super-agent/{env}/ecs` with 90-day retention | `infra/lib/constructs/ecs-cluster.ts:73-76` |
| ECS log streams | Separate prefixes per service: `api`, `worker`, `gateway` | `infra/lib/constructs/ecs-cluster.ts:168,296,350` |

### Metrics

| Capability | Implementation | File |
|------------|----------------|------|
| In-memory counters | Total requests, active connections, 4xx/5xx counts | `backend/src/middleware/metrics.ts:35-108` |
| Rolling average response time | 1-minute sliding window | `backend/src/middleware/metrics.ts:33,86-92` |
| `/metrics` JSON endpoint | Unauthenticated, custom JSON format | `backend/src/routes/metrics.routes.ts` |
| Agent event tracking | Per-agent daily rollups (subagent, skill, tool, error events) | `backend/src/services/agent-metrics.service.ts` |
| Token usage tracking | Per-user/session token consumption with monthly rollups | `backend/src/services/token-usage.service.ts` |
| ECS Container Insights | CPU, memory, network at task/service level | `infra/lib/constructs/ecs-cluster.ts:47` |
| ALB metrics | 5xx count, unhealthy hosts, target response time (via CloudWatch) | `infra/lib/constructs/ecs-cluster.ts:428-451` |

### Tracing

| Capability | Implementation | File |
|------------|----------------|------|
| LLM conversation tracing | Langfuse SDK with nested spans (trace > generation > tool spans) | `backend/src/services/langfuse.service.ts` |
| Session-level grouping | `sessionId` on traces for conversation continuity | `backend/src/services/langfuse.service.ts:62` |
| User/org attribution | `userId`, `organizationId` metadata on traces | `backend/src/services/langfuse.service.ts:63-68` |
| Tool call spans | Individual spans per `tool_use`/`tool_result` pair | `backend/src/services/langfuse.service.ts:92-107` |
| Error events | Langfuse error events with code and message | `backend/src/services/langfuse.service.ts:112-118` |
| Graceful degradation | No-op when Langfuse is not configured | `backend/src/services/langfuse.service.ts:24-25` |
| Request correlation IDs | UUID v4 per request, propagated via X-Request-ID header | `backend/src/app.ts:69` |

### Alerting

| Capability | Implementation | File |
|------------|----------------|------|
| CPU alarm | API service CPU > 80% for 3 consecutive minutes | `infra/lib/constructs/ecs-cluster.ts:412-422` |
| 5xx alarm | API target group > 10 5xx responses in 5 minutes | `infra/lib/constructs/ecs-cluster.ts:425-438` |
| Unhealthy hosts alarm | ALB unhealthy host count > 0 for 2 minutes | `infra/lib/constructs/ecs-cluster.ts:441-451` |

### Health Checks

| Capability | Implementation | File |
|------------|----------------|------|
| Liveness (`/health`) | Returns 200 with uptime, memory usage, service version | `backend/src/routes/health.routes.ts:74-119` |
| Readiness (`/health/ready`) | Checks DB (SELECT 1) + Redis (PING), returns 503 if degraded | `backend/src/routes/health.routes.ts:127-253` |
| ECS container health | `curl -f http://localhost:3000/health` every 30s, 3 retries | `infra/lib/constructs/ecs-cluster.ts:173-177` |
| Docker Compose health | postgres, redis, backend containers with health commands | `docker-compose.yml` |
| ALB target health | Path `/health`, 30s interval, 2 healthy / 3 unhealthy thresholds | `infra/lib/constructs/ecs-cluster.ts:199-205` |

---

## Gap Analysis

| Category | Current Coverage | Missing | Impact | Priority |
|----------|-----------------|---------|--------|----------|
| **Logging** | 60% | No log aggregation/search in local dev; no cross-service correlation (nginx/postgres/redis logs disconnected); no log-based alerting (CloudWatch Metric Filters); no audit logging for sensitive ops (credential vault, membership changes); no log sampling for high-volume chat streaming | Cannot efficiently debug cross-service issues locally; compliance gaps for audit trail; log volume costs balloon in production | Medium |
| **Metrics** | 25% | No Prometheus/OpenMetrics format; no histograms or percentiles (p50/p95/p99); no per-route latency breakdown; no Node.js runtime metrics (GC, event loop lag, heap); no BullMQ queue metrics (lag, processing time, failure rate); no DB connection pool metrics; no Redis metrics; no custom CloudWatch metrics from app code | Cannot set SLOs; no visibility into tail latency; queue backlogs invisible until they cascade into failures | **High** |
| **Tracing** | 30% | No distributed tracing (X-Ray/OTel) across nginx->backend->DB->Redis->S3->AgentCore; no trace propagation to BullMQ workers; no trace propagation to AgentCore containers; non-LLM service calls completely untraced; no sampling configuration | Debugging production latency spikes requires log spelunking; workflow executions lose context when handed to workers | **High** |
| **Alerting** | 15% | No SNS topic or notification action on any alarm (alarms fire but nobody gets paged); no worker/gateway alarms; no DB CPU/connections/storage alarms; no Redis memory/eviction alarms; no queue backlog alarms; no token budget threshold alerts; no PagerDuty/OpsGenie/Slack integration; no synthetics/canaries | **Production incidents go undetected until users complain** | **Critical** |
| **Dashboards** | 10% | No Grafana/CloudWatch Dashboard in CDK; no local dev dashboarding; no pre-built dashboard definitions; no service map; no cost dashboard; no admin page for system health | Ops team has no single pane of glass; troubleshooting starts from scratch every time | High |

---

## Recommended Architecture

### Target Observability Stack

```
                                    +------------------+
                                    |  PagerDuty /     |
                                    |  OpsGenie        |
                                    +--------+---------+
                                             |
+-------------+    +------------------+      |      +------------------+
|  Application|    |  CloudWatch      |------+      |  Grafana Cloud   |
|  (Fastify)  |--->|  Logs + Metrics  |------------>|  (Dashboards)    |
+------+------+    +--------+---------+             +------------------+
       |                    |
       | OTel SDK           | X-Ray traces
       v                    v
+------+------+    +--------+---------+
| OpenTelemetry|    |  AWS X-Ray       |
| Collector    |--->|  (Distributed    |
| (sidecar)    |    |   Tracing)       |
+--------------+    +------------------+
```

**Structured Logging:** Pino (already in place) with request correlation IDs propagated end-to-end. Add CloudWatch Metric Filters for error rate extraction. Add structured audit events for sensitive operations.

**Metrics:** `prom-client` library exporting Prometheus-format `/metrics` endpoint. CloudWatch Agent or ECS Container Insights scrapes Prometheus metrics. Key metrics: HTTP request duration histogram (by route, method, status), Node.js runtime (GC, event loop lag, heap), BullMQ queue depth/processing time, active WebSocket connections, business metrics (active sessions, workflow executions).

**Distributed Tracing:** OpenTelemetry SDK auto-instrumenting HTTP, Prisma, Redis (ioredis), and AWS SDK calls. Export to AWS X-Ray via OTLP exporter or X-Ray daemon sidecar. Langfuse continues as the LLM-specific trace layer. Trace context propagated to BullMQ jobs via job metadata.

**Alerting:** SNS topic per environment with subscriptions (email, PagerDuty/OpsGenie webhook). All CloudWatch Alarms wired to SNS. Additional alarms: DB connections, Redis memory, queue backlog, error log rate. Composite alarms for correlated failures.

**Dashboards:** CloudWatch Dashboard CDK construct with panels for: request rate/latency/errors (RED), infrastructure health, queue status, active sessions. Optionally Grafana Cloud with CloudWatch data source for richer visualization.

---

## Implementation Plan

### P0 — Immediate (this sprint)

These items close critical gaps with minimal effort. All changes are backward-compatible.

#### 1. Wire CloudWatch Alarms to SNS (notify on incidents)

The alarms exist but have no actions. Add an SNS topic and wire all alarms.

```typescript
// infra/lib/constructs/ecs-cluster.ts — add after imports
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';

// Inside the constructor, before the alarm definitions:

// --- Alerting: SNS Topic ---
const alertTopic = new sns.Topic(this, 'AlertTopic', {
  topicName: `super-agent-${props.envName}-alerts`,
  displayName: `Super Agent ${props.envName} Alerts`,
});

// Wire email (replace with PagerDuty/OpsGenie endpoint in production)
alertTopic.addSubscription(
  new sns_subscriptions.EmailSubscription('ops-team@yourcompany.com')
);

// Then add alarmAction to each alarm:
const apiCpuAlarm = new cloudwatch.Alarm(this, 'ApiCpuAlarm', {
  // ... existing config ...
});
apiCpuAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));
apiCpuAlarm.addOkAction(new cloudwatch_actions.SnsAction(alertTopic));

// Repeat for Api5xxAlarm and AlbUnhealthyHostsAlarm
```

Add import:
```typescript
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
```

#### 2. Response Time Histogram by Route (prom-client)

Replace the custom in-memory metrics with `prom-client` for Prometheus-compatible metrics.

```typescript
// backend/src/middleware/prometheus-metrics.ts (new file)

import client from 'prom-client';

// Enable default Node.js metrics (GC, event loop lag, heap, etc.)
client.collectDefaultMetrics({ prefix: 'superagent_' });

// HTTP request duration histogram with route labels
export const httpRequestDuration = new client.Histogram({
  name: 'superagent_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

// Active connections gauge
export const httpActiveConnections = new client.Gauge({
  name: 'superagent_http_active_connections',
  help: 'Number of currently active HTTP connections',
});

// WebSocket connections gauge
export const wsActiveConnections = new client.Gauge({
  name: 'superagent_ws_active_connections',
  help: 'Number of active WebSocket connections',
});

// BullMQ queue depth (set externally by worker)
export const bullmqQueueDepth = new client.Gauge({
  name: 'superagent_bullmq_queue_depth',
  help: 'Number of jobs waiting in BullMQ queues',
  labelNames: ['queue'] as const,
});

// Business metrics
export const activeChatSessions = new client.Gauge({
  name: 'superagent_active_chat_sessions',
  help: 'Number of active chat sessions (generating)',
});

export const workflowExecutionsInFlight = new client.Gauge({
  name: 'superagent_workflow_executions_inflight',
  help: 'Number of workflow executions currently running',
});

export const promRegistry = client.register;
```

#### 3. Prometheus /metrics Endpoint

```typescript
// backend/src/routes/prometheus.routes.ts (new file)

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { promRegistry } from '../middleware/prometheus-metrics.js';

export async function prometheusRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/',
    { schema: { hide: true } },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.header('Content-Type', promRegistry.contentType);
      const metrics = await promRegistry.metrics();
      return reply.status(200).send(metrics);
    }
  );
}
```

Register in `backend/src/routes/index.ts`:
```typescript
import { prometheusRoutes } from './prometheus.routes.js';

// Inside registerRoutes():
app.register(prometheusRoutes, { prefix: '/metrics/prometheus' });
```

#### 4. Hook prom-client into Request Lifecycle

```typescript
// backend/src/middleware/requestLogger.ts — add to responseLoggerHook

import { httpRequestDuration, httpActiveConnections } from './prometheus-metrics.js';

// In requestLoggerHook, after metricsCollector.onRequestStart():
httpActiveConnections.inc();

// In responseLoggerHook, after metricsCollector.onRequestEnd():
httpActiveConnections.dec();

const route = request.routeOptions?.url || request.url;
httpRequestDuration.observe(
  {
    method: request.method,
    route,
    status_code: String(statusCode),
  },
  responseTimeMs / 1000 // convert ms to seconds
);
```

#### 5. Structured Audit Logging for Sensitive Operations

```typescript
// backend/src/services/audit-log.service.ts (new file)

import { FastifyBaseLogger } from 'fastify';

export interface AuditEvent {
  action: string;
  actor: { userId: string; orgId: string; ip?: string };
  target: { type: string; id: string };
  metadata?: Record<string, unknown>;
  outcome: 'success' | 'failure';
}

/**
 * Emit a structured audit log entry.
 * Uses a dedicated logger child with `audit: true` for easy filtering
 * via CloudWatch Logs Insights: filter @message like /\"audit\":true/
 */
export function emitAuditEvent(logger: FastifyBaseLogger, event: AuditEvent): void {
  logger.info(
    {
      audit: true,
      action: event.action,
      actor: event.actor,
      target: event.target,
      metadata: event.metadata,
      outcome: event.outcome,
      timestamp: new Date().toISOString(),
    },
    `AUDIT: ${event.action} on ${event.target.type}/${event.target.id}`
  );
}
```

Usage in routes:
```typescript
// Example: credential vault access
emitAuditEvent(request.log, {
  action: 'credential_vault.read',
  actor: { userId: request.user.id, orgId: request.user.orgId, ip: request.ip },
  target: { type: 'credential', id: credentialId },
  outcome: 'success',
});
```

---

### P1 — Next Sprint (1-2 weeks)

#### 1. CloudWatch Custom Metrics from Application

Push business metrics to CloudWatch using the AWS SDK (enables alarms without Prometheus infrastructure):

```typescript
// backend/src/services/cloudwatch-metrics.service.ts

import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { config } from '../config/index.js';

const cw = new CloudWatchClient({ region: config.aws.region });
const NAMESPACE = 'SuperAgent/Application';

export async function putMetric(
  name: string,
  value: number,
  unit: 'Count' | 'Milliseconds' | 'Percent' = 'Count',
  dimensions?: { Name: string; Value: string }[]
): Promise<void> {
  if (config.nodeEnv !== 'production') return; // Skip in dev
  try {
    await cw.send(new PutMetricDataCommand({
      Namespace: NAMESPACE,
      MetricData: [{
        MetricName: name,
        Value: value,
        Unit: unit,
        Timestamp: new Date(),
        Dimensions: dimensions,
      }],
    }));
  } catch (err) {
    console.error('[cloudwatch-metrics] Failed to push metric:', err);
  }
}
```

#### 2. Additional CloudWatch Alarms (CDK)

Add alarms for worker health, database, Redis, and queue backlog:

```typescript
// Worker CPU alarm
// Database connections alarm (Aurora metric)
// Redis memory alarm (ElastiCache metric)
// Custom metric alarm: queue backlog > 100 for 5 minutes
// Custom metric alarm: error rate > 5% of requests in 5 minutes
```

#### 3. Error Rate Alerting via CloudWatch Metric Filter

```typescript
// infra/lib/constructs/ecs-cluster.ts

const errorMetricFilter = new logs.MetricFilter(this, 'ErrorMetricFilter', {
  logGroup,
  filterPattern: logs.FilterPattern.stringValue('$.level', '=', '50'), // Pino ERROR = 50
  metricNamespace: 'SuperAgent/Application',
  metricName: 'ErrorLogCount',
  metricValue: '1',
});

new cloudwatch.Alarm(this, 'ErrorLogRateAlarm', {
  alarmName: `super-agent-${props.envName}-error-log-rate`,
  metric: errorMetricFilter.metric({
    period: Duration.minutes(5),
    statistic: 'Sum',
  }),
  threshold: 50,
  evaluationPeriods: 1,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
});
```

#### 4. BullMQ Queue Metrics Collection

```typescript
// backend/src/setup/queue-metrics.ts

import { Queue } from 'bullmq';
import { bullmqQueueDepth } from '../middleware/prometheus-metrics.js';
import { putMetric } from '../services/cloudwatch-metrics.service.js';

const QUEUES = ['workflow-execution', 'chat-distillation', 'scheduled-tasks'];

export function startQueueMetricsCollection(interval = 30_000): NodeJS.Timeout {
  return setInterval(async () => {
    for (const queueName of QUEUES) {
      try {
        const queue = new Queue(queueName);
        const waiting = await queue.getWaitingCount();
        const active = await queue.getActiveCount();
        bullmqQueueDepth.set({ queue: queueName }, waiting);
        await putMetric('QueueDepth', waiting, 'Count', [
          { Name: 'QueueName', Value: queueName },
        ]);
        await queue.close();
      } catch { /* ignore */ }
    }
  }, interval);
}
```

---

### P2 — Next Month

#### 1. OpenTelemetry SDK Integration

```typescript
// backend/src/telemetry.ts (initialized before app import)

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { AWSXRayPropagator } from '@opentelemetry/propagator-aws-xray';
import { AWSXRayIdGenerator } from '@opentelemetry/id-generator-aws-xray';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { PrismaInstrumentation } from '@prisma/instrumentation';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
  }),
  idGenerator: new AWSXRayIdGenerator(),
  textMapPropagator: new AWSXRayPropagator(),
  instrumentations: [
    new HttpInstrumentation(),
    new FastifyInstrumentation(),
    new PrismaInstrumentation(),
    new IORedisInstrumentation(),
    new AwsInstrumentation(),
  ],
});

sdk.start();
process.on('SIGTERM', () => sdk.shutdown());
```

Entry point change:
```jsonc
// package.json scripts
"start": "node --import ./dist/telemetry.js dist/index.js"
```

#### 2. X-Ray Sidecar in ECS Task Definition (CDK)

```typescript
// Add X-Ray daemon container to each task definition
apiTaskDefinition.addContainer('XRayDaemon', {
  image: ecs.ContainerImage.fromRegistry('amazon/aws-xray-daemon:latest'),
  memoryLimitMiB: 64,
  cpu: 32,
  essential: false,
  portMappings: [{ containerPort: 2000, protocol: ecs.Protocol.UDP }],
  logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'xray', logGroup }),
});

// Add X-Ray write policy to task role
apiTaskDefinition.addToTaskRolePolicy(
  new iam.PolicyStatement({
    actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
    resources: ['*'],
  })
);
```

#### 3. Trace Context Propagation to BullMQ Workers

```typescript
// When enqueuing a job, embed the active trace context:
import { context, propagation } from '@opentelemetry/api';

function enqueueWithTrace(queue: Queue, jobName: string, data: unknown) {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return queue.add(jobName, { ...data, _traceContext: carrier });
}

// In the worker processor, restore context:
import { ROOT_CONTEXT } from '@opentelemetry/api';

function processJob(job: Job) {
  const parentContext = propagation.extract(ROOT_CONTEXT, job.data._traceContext || {});
  return context.with(parentContext, async () => {
    // All spans created here are children of the original request trace
    // ...
  });
}
```

#### 4. CloudWatch Dashboard (CDK)

```typescript
// infra/lib/constructs/dashboard.ts

import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';

export class DashboardConstruct extends Construct {
  constructor(scope: Construct, id: string, props: DashboardProps) {
    super(scope, id);

    new cloudwatch.Dashboard(this, 'OpsDashboard', {
      dashboardName: `super-agent-${props.envName}-ops`,
      widgets: [
        // Row 1: Request Rate, Latency, Errors (RED method)
        [
          new cloudwatch.GraphWidget({ title: 'Request Count', /* ... */ }),
          new cloudwatch.GraphWidget({ title: 'p50/p95/p99 Latency', /* ... */ }),
          new cloudwatch.GraphWidget({ title: '4xx/5xx Error Rate', /* ... */ }),
        ],
        // Row 2: Infrastructure
        [
          new cloudwatch.GraphWidget({ title: 'ECS CPU/Memory', /* ... */ }),
          new cloudwatch.GraphWidget({ title: 'DB Connections', /* ... */ }),
          new cloudwatch.GraphWidget({ title: 'Redis Memory', /* ... */ }),
        ],
        // Row 3: Business Metrics
        [
          new cloudwatch.GraphWidget({ title: 'Active Chat Sessions', /* ... */ }),
          new cloudwatch.GraphWidget({ title: 'Workflow Executions', /* ... */ }),
          new cloudwatch.GraphWidget({ title: 'Queue Depth', /* ... */ }),
        ],
      ],
    });
  }
}
```

#### 5. Synthetic Canary (Optional)

```typescript
// CloudWatch Synthetics canary for end-to-end health
import * as synthetics from 'aws-cdk-lib/aws-synthetics';

new synthetics.Canary(this, 'HealthCanary', {
  canaryName: `super-agent-${props.envName}-health`,
  schedule: synthetics.Schedule.rate(Duration.minutes(5)),
  test: synthetics.Test.custom({
    code: synthetics.Code.fromInline(`
      const https = require('https');
      exports.handler = async () => {
        // Hit /health/ready and assert 200
      };
    `),
    handler: 'index.handler',
  }),
  runtime: synthetics.Runtime.SYNTHETICS_NODEJS_PUPPETEER_6_2,
});
```

---

## Summary: Priority Execution Order

| Phase | Item | Effort | Risk Reduction |
|-------|------|--------|----------------|
| **P0-1** | Wire SNS to existing CloudWatch Alarms | 1 hour | Critical (incidents now notify) |
| **P0-2** | Add `prom-client` + Prometheus `/metrics` endpoint | 2 hours | High (standard tooling can scrape) |
| **P0-3** | Hook histogram into request lifecycle | 1 hour | High (per-route latency visible) |
| **P0-4** | Audit logging service | 2 hours | Medium (compliance) |
| **P1-1** | CloudWatch custom metrics + additional alarms | 4 hours | High (DB/Redis/queue visibility) |
| **P1-2** | Error rate metric filter + alarm | 1 hour | High (log-based alerting) |
| **P1-3** | BullMQ queue metrics collection | 2 hours | Medium (queue health visible) |
| **P2-1** | OpenTelemetry SDK integration | 8 hours | High (full distributed tracing) |
| **P2-2** | X-Ray sidecar in ECS | 2 hours | High (production trace visualization) |
| **P2-3** | Trace propagation to BullMQ workers | 4 hours | Medium (workflow debugging) |
| **P2-4** | CloudWatch Dashboard construct | 4 hours | Medium (ops single pane of glass) |

**Total estimated effort:** ~31 hours across 3 phases (1 sprint for P0, 1 sprint for P1, 2 sprints for P2).

---

## Dependencies

| Item | npm Package | Version |
|------|-------------|---------|
| Prometheus metrics | `prom-client` | ^15.x |
| CloudWatch SDK | `@aws-sdk/client-cloudwatch` | ^3.x (already in lockfile) |
| OpenTelemetry SDK | `@opentelemetry/sdk-node` | ^1.x |
| OTel Fastify | `@opentelemetry/instrumentation-fastify` | ^0.x |
| OTel HTTP | `@opentelemetry/instrumentation-http` | ^0.x |
| OTel ioredis | `@opentelemetry/instrumentation-ioredis` | ^0.x |
| OTel AWS SDK | `@opentelemetry/instrumentation-aws-sdk` | ^0.x |
| Prisma OTel | `@prisma/instrumentation` | ^5.x |
| X-Ray propagator | `@opentelemetry/propagator-aws-xray` | ^1.x |
| X-Ray ID generator | `@opentelemetry/id-generator-aws-xray` | ^1.x |
| CDK SNS | `aws-cdk-lib/aws-sns` | (already in CDK) |
| CDK CW Actions | `aws-cdk-lib/aws-cloudwatch-actions` | (already in CDK) |
