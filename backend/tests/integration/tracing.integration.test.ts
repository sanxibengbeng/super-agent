import { describe, it, expect, beforeAll } from 'vitest';
import { trace, context, propagation } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider, AlwaysOnSampler } from '@opentelemetry/sdk-trace-base';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';

// Configure OTel for tests
beforeAll(() => {
  // Set up context manager for async context propagation
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);

  // Set up tracer provider
  const provider = new BasicTracerProvider({
    sampler: new AlwaysOnSampler(),
  });
  trace.setGlobalTracerProvider(provider);

  // Set up W3C TraceContext propagator
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
});

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

describe('BullMQ Trace Propagation', () => {
  it('injectTraceContext adds __otel field with traceparent', async () => {
    const { injectTraceContext } = await import('../../src/middleware/otel-bullmq.js');

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
    expect(enriched.nodeId).toBe('abc');
    span.end();
  });

  it('injectTraceContext preserves original data fields', async () => {
    const { injectTraceContext } = await import('../../src/middleware/otel-bullmq.js');

    const data = { executionId: 'exec-1', nodeId: 'node-1', extra: 'value' };
    const result = injectTraceContext(data);

    expect(result.executionId).toBe('exec-1');
    expect(result.nodeId).toBe('node-1');
    expect(result.extra).toBe('value');
    expect(result.__otel).toBeDefined();
  });
});

describe('ContainerTracer (agentcore)', () => {
  it('creates spans with correct parent chain', async () => {
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
    expect(spans[0].name).toBe('cold_start');
    expect(spans[0].attributes['resume']).toBe(false);
    expect(spans[2].parentSpanId).toBe(turn.spanId);
    expect(spans[2].name).toBe('tool_use:Bash');
  });

  it('handles missing traceparent gracefully', async () => {
    const { ContainerTracer } = await import('../../../agentcore/src/tracing.js');

    const tracer = new ContainerTracer('00--1234567890abcdef-01');
    const span = tracer.startSpan('test');
    span.end();

    const spans = tracer.getSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].traceId).toHaveLength(32);
  });

  it('records timing data', async () => {
    const { ContainerTracer } = await import('../../../agentcore/src/tracing.js');

    const traceparent = '00-abcdef1234567890abcdef1234567890-1234567890abcdef-01';
    const tracer = new ContainerTracer(traceparent);

    const span = tracer.startSpan('timed-op');
    await new Promise(resolve => setTimeout(resolve, 10));
    span.end();

    const spans = tracer.getSpans();
    expect(spans[0].startTimeMs).toBeGreaterThanOrEqual(0);
    expect(spans[0].endTimeMs).toBeGreaterThan(spans[0].startTimeMs);
  });

  it('records error status', async () => {
    const { ContainerTracer } = await import('../../../agentcore/src/tracing.js');

    const traceparent = '00-abcdef1234567890abcdef1234567890-1234567890abcdef-01';
    const tracer = new ContainerTracer(traceparent);

    const span = tracer.startSpan('failing-op');
    span.end('ERROR');

    const spans = tracer.getSpans();
    expect(spans[0].status).toBe('ERROR');
  });
});
