import { trace, context, propagation, SpanKind, SpanStatusCode, ROOT_CONTEXT } from '@opentelemetry/api';
import type { Job } from 'bullmq';

const tracer = trace.getTracer('super-agent-bullmq');

export interface TracedJobData {
  __otel?: Record<string, string>;
}

export function injectTraceContext<T>(data: T): T & TracedJobData {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return { ...data, __otel: carrier } as T & TracedJobData;
}

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

export function traceProducer<T>(
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
