/**
 * Metrics Route
 * Exposes in-memory request metrics for observability.
 * No authentication required (intended for internal monitoring).
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { metricsCollector } from '../middleware/metrics.js';

/**
 * Register the /metrics endpoint on the Fastify instance.
 * This route does NOT require authentication.
 */
export async function metricsRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /metrics
   * Returns a JSON snapshot of in-memory request metrics.
   */
  fastify.get(
    '/',
    {
      schema: {
        description: 'In-memory request metrics (counters, response times)',
        tags: ['Health'],
        response: {
          200: {
            type: 'object',
            properties: {
              totalRequests: { type: 'integer', description: 'Total requests since startup' },
              activeConnections: { type: 'integer', description: 'Currently in-flight requests' },
              clientErrors: { type: 'integer', description: 'Total 4xx responses' },
              serverErrors: { type: 'integer', description: 'Total 5xx responses' },
              avgResponseTimeMs: { type: 'number', description: 'Rolling 1-minute average response time (ms)' },
              uptimeSeconds: { type: 'integer', description: 'Process uptime in seconds' },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const snapshot = metricsCollector.getSnapshot();
      return reply.status(200).send(snapshot);
    }
  );
}
