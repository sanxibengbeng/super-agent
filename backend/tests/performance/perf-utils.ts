/**
 * Performance testing utilities for Super Agent backend.
 *
 * Provides measurement, statistics, and reporting helpers for API performance tests.
 */

// ============================================================================
// Types
// ============================================================================

export interface PerformanceReport {
  endpoint: string;
  method: string;
  iterations: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  rps: number;
  totalDuration: number;
  successCount: number;
  errorCount: number;
  statusCodes: Record<number, number>;
}

export interface MeasureOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  expectedStatus?: number | number[];
}

export interface ConcurrentReport extends PerformanceReport {
  concurrency: number;
}

// ============================================================================
// Configuration
// ============================================================================

export const PERF_BASE_URL = process.env.PERF_BASE_URL || 'http://localhost:3000';
export const PERF_ITERATIONS = parseInt(process.env.PERF_ITERATIONS || '100', 10);
export const PERF_CONCURRENCY = parseInt(process.env.PERF_CONCURRENCY || '10', 10);

// ============================================================================
// Statistics
// ============================================================================

/**
 * Calculate a specific percentile from a sorted array of numbers.
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

/**
 * Calculate basic statistics from an array of response times (ms).
 */
export function calculateStats(times: number[]): {
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
} {
  if (times.length === 0) {
    return { min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
  }

  const sorted = [...times].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, t) => acc + t, 0);

  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

// ============================================================================
// Measurement
// ============================================================================

/**
 * Measure a single HTTP request and return the response time in ms.
 */
async function measureSingleRequest(
  url: string,
  options: MeasureOptions
): Promise<{ duration: number; status: number }> {
  const fetchOptions: RequestInit = {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  };

  if (options.body) {
    fetchOptions.body = JSON.stringify(options.body);
  }

  const start = performance.now();
  const res = await fetch(url, fetchOptions);
  const duration = performance.now() - start;

  // Consume the body to ensure the connection is properly closed
  await res.text();

  return { duration, status: res.status };
}

/**
 * Run sequential requests to an endpoint and collect performance metrics.
 */
export async function measureEndpoint(
  path: string,
  options: MeasureOptions = {},
  iterations: number = PERF_ITERATIONS
): Promise<PerformanceReport> {
  const url = `${PERF_BASE_URL}${path}`;
  const method = options.method || 'GET';
  const expectedStatuses = Array.isArray(options.expectedStatus)
    ? options.expectedStatus
    : options.expectedStatus
      ? [options.expectedStatus]
      : [200];

  const times: number[] = [];
  const statusCodes: Record<number, number> = {};
  let successCount = 0;
  let errorCount = 0;

  const totalStart = performance.now();

  for (let i = 0; i < iterations; i++) {
    const { duration, status } = await measureSingleRequest(url, options);
    times.push(duration);
    statusCodes[status] = (statusCodes[status] || 0) + 1;

    if (expectedStatuses.includes(status)) {
      successCount++;
    } else {
      errorCount++;
    }
  }

  const totalDuration = performance.now() - totalStart;
  const stats = calculateStats(times);

  return {
    endpoint: path,
    method,
    iterations,
    ...stats,
    rps: (iterations / totalDuration) * 1000,
    totalDuration,
    successCount,
    errorCount,
    statusCodes,
  };
}

/**
 * Run concurrent requests to an endpoint and collect performance metrics.
 */
export async function measureEndpointConcurrent(
  path: string,
  options: MeasureOptions = {},
  concurrency: number = PERF_CONCURRENCY,
  iterations: number = PERF_ITERATIONS
): Promise<ConcurrentReport> {
  const url = `${PERF_BASE_URL}${path}`;
  const method = options.method || 'GET';
  const expectedStatuses = Array.isArray(options.expectedStatus)
    ? options.expectedStatus
    : options.expectedStatus
      ? [options.expectedStatus]
      : [200];

  const times: number[] = [];
  const statusCodes: Record<number, number> = {};
  let successCount = 0;
  let errorCount = 0;

  const totalStart = performance.now();

  // Process in batches of `concurrency`
  const batches = Math.ceil(iterations / concurrency);
  for (let batch = 0; batch < batches; batch++) {
    const batchSize = Math.min(concurrency, iterations - batch * concurrency);
    const promises = Array.from({ length: batchSize }, () =>
      measureSingleRequest(url, options)
    );

    const results = await Promise.all(promises);
    for (const { duration, status } of results) {
      times.push(duration);
      statusCodes[status] = (statusCodes[status] || 0) + 1;
      if (expectedStatuses.includes(status)) {
        successCount++;
      } else {
        errorCount++;
      }
    }
  }

  const totalDuration = performance.now() - totalStart;
  const stats = calculateStats(times);

  return {
    endpoint: path,
    method,
    iterations,
    ...stats,
    rps: (iterations / totalDuration) * 1000,
    totalDuration,
    successCount,
    errorCount,
    statusCodes,
    concurrency,
  };
}

// ============================================================================
// Reporting
// ============================================================================

/**
 * Format a PerformanceReport into a human-readable string for console output.
 */
export function formatReport(report: PerformanceReport): string {
  const lines = [
    ``,
    `--- Performance Report: ${report.method} ${report.endpoint} ---`,
    `  Iterations:    ${report.iterations}`,
    `  Success/Error: ${report.successCount}/${report.errorCount}`,
    `  Status Codes:  ${Object.entries(report.statusCodes).map(([k, v]) => `${k}:${v}`).join(', ')}`,
    `  `,
    `  Response Times (ms):`,
    `    Min:  ${report.min.toFixed(2)}`,
    `    Max:  ${report.max.toFixed(2)}`,
    `    Avg:  ${report.avg.toFixed(2)}`,
    `    P50:  ${report.p50.toFixed(2)}`,
    `    P95:  ${report.p95.toFixed(2)}`,
    `    P99:  ${report.p99.toFixed(2)}`,
    `  `,
    `  Throughput:    ${report.rps.toFixed(1)} req/s`,
    `  Total Time:   ${(report.totalDuration / 1000).toFixed(2)}s`,
    `---`,
  ];

  if ('concurrency' in report) {
    lines.splice(2, 0, `  Concurrency:   ${(report as ConcurrentReport).concurrency}`);
  }

  return lines.join('\n');
}

/**
 * Format multiple reports as a summary table.
 */
export function formatSummaryTable(reports: PerformanceReport[]): string {
  const header = `| ${'Endpoint'.padEnd(35)} | ${'Method'.padEnd(6)} | ${'Avg'.padStart(8)} | ${'P95'.padStart(8)} | ${'P99'.padStart(8)} | ${'RPS'.padStart(8)} | ${'Errors'.padStart(6)} |`;
  const separator = `|${'-'.repeat(37)}|${'-'.repeat(8)}|${'-'.repeat(10)}|${'-'.repeat(10)}|${'-'.repeat(10)}|${'-'.repeat(10)}|${'-'.repeat(8)}|`;

  const rows = reports.map((r) => {
    const endpoint = r.endpoint.length > 35 ? r.endpoint.slice(0, 32) + '...' : r.endpoint;
    return `| ${endpoint.padEnd(35)} | ${r.method.padEnd(6)} | ${r.avg.toFixed(1).padStart(6)}ms | ${r.p95.toFixed(1).padStart(6)}ms | ${r.p99.toFixed(1).padStart(6)}ms | ${r.rps.toFixed(0).padStart(6)}/s | ${String(r.errorCount).padStart(6)} |`;
  });

  return ['\n=== Performance Test Summary ===', header, separator, ...rows, ''].join('\n');
}
