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
