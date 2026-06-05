/**
 * Health Check Routes
 * Endpoints for service health monitoring and readiness checks.
 * Requirements: 13.1, 13.2
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { checkDatabaseHealth } from '../config/database.js';
import { redisService } from '../services/redis.service.js';

/**
 * Health check response interface
 */
interface HealthResponse {
  status: 'ok' | 'degraded' | 'unhealthy';
  timestamp: string;
  service: string;
  version: string;
  uptime: number;
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
  };
}

/**
 * Readiness check response interface
 */
interface ReadinessResponse extends HealthResponse {
  checks: {
    database: {
      status: 'ok' | 'error';
      latency?: number;
      error?: string;
    };
    redis: {
      status: 'ok' | 'error';
      latency?: number;
      error?: string;
    };
  };
}

/**
 * Check Redis connectivity with a PING command
 */
async function checkRedisHealth(): Promise<{ healthy: boolean; latency: number; error?: string }> {
  const start = Date.now();
  try {
    const client = redisService.getClient();
    await client.ping();
    return { healthy: true, latency: Date.now() - start };
  } catch (err) {
    return {
      healthy: false,
      latency: Date.now() - start,
      error: err instanceof Error ? err.message : 'Redis connection failed',
    };
  }
}

/**
 * Register health check routes on the Fastify instance.
 * These routes do NOT require authentication.
 */
export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /health
   * Basic health check endpoint.
   * Returns 200 OK if the service is running, with process info.
   * Requirements: 13.1
   */
  fastify.get(
    '/',
    {
      schema: {
        description: 'Basic health check - returns service status, uptime, and memory usage',
        tags: ['Health'],
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['ok', 'degraded', 'unhealthy'] },
              timestamp: { type: 'string', format: 'date-time' },
              service: { type: 'string' },
              version: { type: 'string' },
              uptime: { type: 'number' },
              memory: {
                type: 'object',
                properties: {
                  rss: { type: 'number' },
                  heapUsed: { type: 'number' },
                  heapTotal: { type: 'number' },
                },
              },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const mem = process.memoryUsage();
      const response: HealthResponse = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'backend',
        version: process.env.npm_package_version || '1.0.0',
        uptime: Math.round(process.uptime()),
        memory: {
          rss: Math.round(mem.rss / 1024 / 1024),
          heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
        },
      };

      return reply.status(200).send(response);
    }
  );

  /**
   * GET /health/ready
   * Readiness check endpoint with database and Redis connectivity verification.
   * Returns 200 OK if all dependencies are healthy, 503 otherwise.
   * Requirements: 13.2
   */
  fastify.get(
    '/ready',
    {
      schema: {
        description: 'Readiness check - verifies database and Redis connectivity',
        tags: ['Health'],
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['ok', 'degraded', 'unhealthy'] },
              timestamp: { type: 'string', format: 'date-time' },
              service: { type: 'string' },
              version: { type: 'string' },
              uptime: { type: 'number' },
              memory: {
                type: 'object',
                properties: {
                  rss: { type: 'number' },
                  heapUsed: { type: 'number' },
                  heapTotal: { type: 'number' },
                },
              },
              checks: {
                type: 'object',
                properties: {
                  database: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', enum: ['ok', 'error'] },
                      latency: { type: 'number' },
                    },
                  },
                  redis: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', enum: ['ok', 'error'] },
                      latency: { type: 'number' },
                    },
                  },
                },
              },
            },
          },
          503: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['ok', 'degraded', 'unhealthy'] },
              timestamp: { type: 'string', format: 'date-time' },
              service: { type: 'string' },
              version: { type: 'string' },
              uptime: { type: 'number' },
              memory: {
                type: 'object',
                properties: {
                  rss: { type: 'number' },
                  heapUsed: { type: 'number' },
                  heapTotal: { type: 'number' },
                },
              },
              checks: {
                type: 'object',
                properties: {
                  database: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', enum: ['ok', 'error'] },
                      error: { type: 'string' },
                    },
                  },
                  redis: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', enum: ['ok', 'error'] },
                      error: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      // Run DB and Redis checks in parallel
      const dbStart = Date.now();
      let dbHealthy = false;
      let dbError: string | undefined;

      try {
        dbHealthy = await checkDatabaseHealth();
      } catch (error) {
        dbError = error instanceof Error ? error.message : 'Unknown database error';
      }
      const dbLatency = Date.now() - dbStart;

      const redisResult = await checkRedisHealth();

      const allHealthy = dbHealthy && redisResult.healthy;
      const mem = process.memoryUsage();

      const response: ReadinessResponse = {
        status: allHealthy ? 'ok' : (!dbHealthy && !redisResult.healthy ? 'unhealthy' : 'degraded'),
        timestamp: new Date().toISOString(),
        service: 'backend',
        version: process.env.npm_package_version || '1.0.0',
        uptime: Math.round(process.uptime()),
        memory: {
          rss: Math.round(mem.rss / 1024 / 1024),
          heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
        },
        checks: {
          database: dbHealthy
            ? { status: 'ok', latency: dbLatency }
            : { status: 'error', error: dbError || 'Database connection failed' },
          redis: redisResult.healthy
            ? { status: 'ok', latency: redisResult.latency }
            : { status: 'error', error: redisResult.error || 'Redis connection failed' },
        },
      };

      const statusCode = allHealthy ? 200 : 503;
      return reply.status(statusCode).send(response);
    }
  );
}
