/**
 * Request logging middleware with correlation ID propagation,
 * performance monitoring, and metrics integration.
 * Requirements: 13.3
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { trace } from '@opentelemetry/api';
import { metricsCollector } from './metrics.js';
import { httpRequestDuration, httpActiveConnections } from './otel-metrics.js';

/** Threshold in ms above which a request is logged at WARN level */
const SLOW_REQUEST_THRESHOLD_MS = 3000;

/**
 * Request context interface for logging
 */
export interface RequestContext {
  requestId: string;
  method: string;
  url: string;
  userAgent?: string;
  ip?: string;
  userId?: string;
  orgId?: string;
}

/**
 * Generates a unique request ID
 * Uses crypto.randomUUID() for UUID v4 generation
 */
export function generateRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Extracts request context for logging
 */
export function extractRequestContext(request: FastifyRequest): RequestContext {
  return {
    requestId: request.id,
    method: request.method,
    url: request.url,
    userAgent: request.headers['user-agent'],
    ip: request.ip,
    userId: request.user?.id,
    orgId: request.user?.orgId,
  };
}

// Store request start times keyed by request id
const requestStartTimes = new Map<string, bigint>();

/**
 * Request logger hook that:
 * - Propagates X-Request-ID (or uses the auto-generated request.id)
 * - Sets the correlation ID on the reply header
 * - Increments the active connection counter
 * - Records high-resolution start time
 */
export async function requestLoggerHook(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // If the client sent an X-Request-ID header, adopt it as the canonical request ID
  const incomingId = request.headers['x-request-id'];
  if (incomingId && typeof incomingId === 'string') {
    // Override Fastify's generated ID with the client-provided one
    (request as { id: string }).id = incomingId;
  }

  // Expose the correlation ID to the client on the response
  reply.header('X-Request-ID', request.id);

  // Track the request in metrics
  metricsCollector.onRequestStart();
  httpActiveConnections.add(1);

  // Record high-resolution start time for response time calculation
  requestStartTimes.set(request.id, process.hrtime.bigint());

  const context = extractRequestContext(request);

  const incomingSpan = trace.getActiveSpan();
  request.log.info(
    {
      requestId: context.requestId,
      method: context.method,
      url: context.url,
      userAgent: context.userAgent,
      ip: context.ip,
      ...(incomingSpan ? {
        trace_id: incomingSpan.spanContext().traceId,
        span_id: incomingSpan.spanContext().spanId,
      } : {}),
    },
    'Incoming request'
  );
}

/**
 * Response logger hook that:
 * - Logs the completed response
 * - Warns on slow requests (> 3000ms)
 * - Records response time and status in metrics
 */
export async function responseLoggerHook(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const context = extractRequestContext(request);
  const statusCode = reply.statusCode;

  // Calculate response time from stored start time (more reliable than reply.elapsedTime
  // which may not be set when disableRequestLogging is true)
  let responseTimeMs: number;
  const startTime = requestStartTimes.get(request.id);
  if (startTime) {
    const elapsed = process.hrtime.bigint() - startTime;
    responseTimeMs = Number(elapsed) / 1_000_000; // nanoseconds -> milliseconds
    requestStartTimes.delete(request.id);
  } else {
    responseTimeMs = reply.elapsedTime ?? 0;
  }

  // Record in metrics collector
  metricsCollector.onRequestEnd(statusCode, responseTimeMs);
  httpActiveConnections.add(-1);
  httpRequestDuration.record(responseTimeMs / 1000, {
    method: request.method,
    route: request.routeOptions?.url || request.url,
    status_code: String(statusCode),
  });

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

  // Warn on slow requests
  if (responseTimeMs > SLOW_REQUEST_THRESHOLD_MS) {
    request.log.warn(
      {
        ...logPayload,
        durationMs: responseTimeMs,
        route: request.routeOptions?.url || request.url,
      },
      `Slow request detected (${responseTimeMs.toFixed(0)}ms)`
    );
  } else {
    request.log.info(logPayload, 'Request completed');
  }
}

/**
 * Registers request logging hooks on a Fastify instance
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerRequestLogger(app: any): void {
  // Log incoming requests
  app.addHook('onRequest', requestLoggerHook);

  // Log completed responses
  app.addHook('onResponse', responseLoggerHook);
}
