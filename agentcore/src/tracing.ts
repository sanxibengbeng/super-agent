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
