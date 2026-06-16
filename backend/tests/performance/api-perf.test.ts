/**
 * Backend API Performance Tests
 *
 * Measures response times and throughput for critical API endpoints.
 * Requires a running backend server (default: http://localhost:3000).
 *
 * Run with: npm run test:perf
 *
 * Configuration (env vars):
 *   PERF_BASE_URL   - Backend URL (default: http://localhost:3000)
 *   PERF_ITERATIONS - Requests per endpoint (default: 100)
 *   PERF_CONCURRENCY - Parallel requests for concurrent tests (default: 10)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  measureEndpoint,
  measureEndpointConcurrent,
  formatReport,
  formatSummaryTable,
  PERF_BASE_URL,
  PERF_ITERATIONS,
  PERF_CONCURRENCY,
  type PerformanceReport,
  type MeasureOptions,
} from './perf-utils.js';

// ============================================================================
// Configuration
// ============================================================================

const PERF_USER = {
  username: 'perftest@superagent.dev',
  password: 'PerfTest2026!',
  fullName: 'Performance Test User',
};

// Thresholds (p95 in ms)
const THRESHOLDS = {
  health: 100,
  healthReady: 200,
  metrics: 200,
  authLogin: 300,
  authenticatedList: 500,
};

let AUTH_TOKEN: string;
const allReports: PerformanceReport[] = [];

// ============================================================================
// Helpers
// ============================================================================

async function api(
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${PERF_BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${AUTH_TOKEN}` };
}

function logReport(report: PerformanceReport): void {
  console.log(formatReport(report));
  allReports.push(report);
}

// ============================================================================
// Setup
// ============================================================================

beforeAll(async () => {
  // Verify backend is reachable
  const health = await api('GET', '/health');
  if (health.status !== 200) {
    throw new Error(
      `Backend not reachable at ${PERF_BASE_URL}. Got status ${health.status}. ` +
        'Start the backend before running performance tests.'
    );
  }

  // Register the performance test user (ignore 409 if already exists)
  const registerRes = await api('POST', '/api/auth/register', {
    username: PERF_USER.username,
    password: PERF_USER.password,
    fullName: PERF_USER.fullName,
  });

  if (registerRes.status === 200 || registerRes.status === 201) {
    AUTH_TOKEN = registerRes.data.token;
    console.log(`[perf] Registered new test user: ${PERF_USER.username}`);
  } else if (registerRes.status === 409) {
    // User already exists, login instead
    const loginRes = await api('POST', '/api/auth/login', {
      username: PERF_USER.username,
      password: PERF_USER.password,
    });
    if (loginRes.status !== 200) {
      throw new Error(
        `Failed to login perf test user. Status: ${loginRes.status}, ` +
          `Response: ${JSON.stringify(loginRes.data)}`
      );
    }
    AUTH_TOKEN = loginRes.data.token;
    console.log(`[perf] Logged in existing test user: ${PERF_USER.username}`);
  } else {
    throw new Error(
      `Failed to register perf test user. Status: ${registerRes.status}, ` +
        `Response: ${JSON.stringify(registerRes.data)}`
    );
  }

  // Verify auth works
  const meRes = await api('GET', '/api/auth/me', undefined, AUTH_TOKEN);
  expect(meRes.status).toBe(200);

  console.log(`\n[perf] Configuration:`);
  console.log(`  Base URL:    ${PERF_BASE_URL}`);
  console.log(`  Iterations:  ${PERF_ITERATIONS}`);
  console.log(`  Concurrency: ${PERF_CONCURRENCY}`);
  console.log(``);
}, 30000);

// ============================================================================
// Sequential Performance Tests
// ============================================================================

describe('Sequential Performance Tests', () => {
  // --------------------------------------------------------------------------
  // Health / Infrastructure endpoints (no auth)
  // --------------------------------------------------------------------------
  describe('Health & Infrastructure Endpoints', () => {
    it('GET /health - basic health check', async () => {
      const report = await measureEndpoint('/health', {
        expectedStatus: 200,
      });

      logReport(report);
      expect(report.errorCount).toBe(0);
      expect(report.p95).toBeLessThan(THRESHOLDS.health);
    }, 60000);

    it('GET /health/ready - readiness probe (DB + Redis)', async () => {
      const report = await measureEndpoint('/health/ready', {
        expectedStatus: [200, 503],
      });

      logReport(report);
      // Allow some errors if Redis is slow to respond
      expect(report.successCount).toBeGreaterThan(report.iterations * 0.9);
      expect(report.p95).toBeLessThan(THRESHOLDS.healthReady);
    }, 60000);

    it('GET /metrics - metrics endpoint', async () => {
      const report = await measureEndpoint('/metrics', {
        expectedStatus: [200, 404],
      });

      logReport(report);
      expect(report.p95).toBeLessThan(THRESHOLDS.metrics);
    }, 60000);
  });

  // --------------------------------------------------------------------------
  // Auth endpoints
  // --------------------------------------------------------------------------
  describe('Authentication Endpoints', () => {
    it('POST /api/auth/login - login performance', async () => {
      const report = await measureEndpoint('/api/auth/login', {
        method: 'POST',
        body: {
          username: PERF_USER.username,
          password: PERF_USER.password,
        },
        expectedStatus: 200,
      });

      logReport(report);
      expect(report.errorCount).toBe(0);
      expect(report.p95).toBeLessThan(THRESHOLDS.authLogin);
    }, 120000);

    it('GET /api/auth/me - token validation performance', async () => {
      const report = await measureEndpoint('/api/auth/me', {
        headers: authHeaders(),
        expectedStatus: 200,
      });

      logReport(report);
      expect(report.errorCount).toBe(0);
      expect(report.p95).toBeLessThan(THRESHOLDS.authenticatedList);
    }, 60000);
  });

  // --------------------------------------------------------------------------
  // Authenticated CRUD list endpoints
  // --------------------------------------------------------------------------
  describe('Authenticated List Endpoints', () => {
    it('GET /api/organizations - organization list', async () => {
      const report = await measureEndpoint('/api/organizations', {
        headers: authHeaders(),
        expectedStatus: 200,
      });

      logReport(report);
      expect(report.errorCount).toBe(0);
      expect(report.p95).toBeLessThan(THRESHOLDS.authenticatedList);
    }, 60000);

    it('GET /api/business-scopes - business scope list', async () => {
      const report = await measureEndpoint('/api/business-scopes', {
        headers: authHeaders(),
        expectedStatus: 200,
      });

      logReport(report);
      expect(report.errorCount).toBe(0);
      expect(report.p95).toBeLessThan(THRESHOLDS.authenticatedList);
    }, 60000);

    it('GET /api/agents - agent list', async () => {
      const report = await measureEndpoint('/api/agents', {
        headers: authHeaders(),
        expectedStatus: 200,
      });

      logReport(report);
      expect(report.errorCount).toBe(0);
      expect(report.p95).toBeLessThan(THRESHOLDS.authenticatedList);
    }, 60000);

    it('GET /api/chat/sessions - chat session list', async () => {
      const report = await measureEndpoint('/api/chat/sessions', {
        headers: authHeaders(),
        expectedStatus: 200,
      });

      logReport(report);
      expect(report.errorCount).toBe(0);
      expect(report.p95).toBeLessThan(THRESHOLDS.authenticatedList);
    }, 60000);

    it('GET /api/workflows - workflow list', async () => {
      const report = await measureEndpoint('/api/workflows', {
        headers: authHeaders(),
        expectedStatus: 200,
      });

      logReport(report);
      expect(report.errorCount).toBe(0);
      expect(report.p95).toBeLessThan(THRESHOLDS.authenticatedList);
    }, 60000);
  });
});

// ============================================================================
// Concurrent Load Tests
// ============================================================================

describe('Concurrent Load Tests', () => {
  const concurrentEndpoints: Array<{
    name: string;
    path: string;
    options: MeasureOptions;
    threshold: number;
  }> = [
    {
      name: 'GET /health',
      path: '/health',
      options: { expectedStatus: 200 },
      threshold: THRESHOLDS.health * 2, // Allow 2x for concurrent load
    },
    {
      name: 'GET /health/ready',
      path: '/health/ready',
      options: { expectedStatus: [200, 503] },
      threshold: THRESHOLDS.healthReady * 2,
    },
    {
      name: 'POST /api/auth/login',
      path: '/api/auth/login',
      options: {
        method: 'POST',
        body: { username: PERF_USER.username, password: PERF_USER.password },
        expectedStatus: 200,
      },
      threshold: THRESHOLDS.authLogin * 2,
    },
    {
      name: 'GET /api/organizations',
      path: '/api/organizations',
      options: { headers: {}, expectedStatus: 200 },
      threshold: THRESHOLDS.authenticatedList * 2,
    },
    {
      name: 'GET /api/business-scopes',
      path: '/api/business-scopes',
      options: { headers: {}, expectedStatus: 200 },
      threshold: THRESHOLDS.authenticatedList * 2,
    },
    {
      name: 'GET /api/agents',
      path: '/api/agents',
      options: { headers: {}, expectedStatus: 200 },
      threshold: THRESHOLDS.authenticatedList * 2,
    },
    {
      name: 'GET /api/chat/sessions',
      path: '/api/chat/sessions',
      options: { headers: {}, expectedStatus: 200 },
      threshold: THRESHOLDS.authenticatedList * 2,
    },
    {
      name: 'GET /api/workflows',
      path: '/api/workflows',
      options: { headers: {}, expectedStatus: 200 },
      threshold: THRESHOLDS.authenticatedList * 2,
    },
  ];

  for (const endpoint of concurrentEndpoints) {
    it(`${endpoint.name} (${PERF_CONCURRENCY} concurrent)`, async () => {
      // Inject auth headers for authenticated endpoints
      const options = { ...endpoint.options };
      if (options.headers && !('Authorization' in options.headers)) {
        options.headers = { ...options.headers, ...authHeaders() };
      }

      const report = await measureEndpointConcurrent(
        endpoint.path,
        options,
        PERF_CONCURRENCY,
        PERF_ITERATIONS
      );

      logReport(report);
      expect(report.successCount).toBeGreaterThan(report.iterations * 0.9);
      expect(report.p95).toBeLessThan(endpoint.threshold);
    }, 120000);
  }
});

// ============================================================================
// Summary (runs after all tests)
// ============================================================================

describe('Performance Summary', () => {
  it('prints summary table', () => {
    if (allReports.length > 0) {
      console.log(formatSummaryTable(allReports));
    }
    // This test always passes - it is just for reporting
    expect(true).toBe(true);
  });
});
