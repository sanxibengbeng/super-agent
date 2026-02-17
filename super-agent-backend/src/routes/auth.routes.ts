/**
 * Authentication Routes (Cognito)
 *
 * With Cognito handling authentication, the backend only needs:
 * - GET /auth/me — return current user info from a verified Cognito token
 * - GET /auth/config — return Cognito config for the frontend (public)
 *
 * Login/register are handled entirely by Cognito Hosted UI on the frontend.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken } from '../middleware/auth.js';
import { prisma } from '../config/database.js';
import { config } from '../config/index.js';

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /auth/config
   * Returns Cognito configuration for the frontend (public, no auth required).
   */
  fastify.get(
    '/config',
    {
      schema: {
        description: 'Get Cognito configuration for frontend',
        tags: ['auth'],
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.send({
        userPoolId: config.cognito.userPoolId,
        clientId: config.cognito.clientId,
        region: config.cognito.region,
        domain: config.cognito.domain,
      });
    },
  );

  /**
   * GET /auth/me
   * Returns the current user's information from a verified Cognito id_token.
   */
  fastify.get(
    '/me',
    {
      schema: {
        description: 'Get current user information',
        tags: ['auth'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        return reply.status(401).send({
          error: 'Missing or invalid authorization header',
          code: 'UNAUTHORIZED',
        });
      }

      const token = authHeader.substring(7);

      try {
        const claims = await verifyToken(token);

        // Look up profile
        let profile = await prisma.profiles.findUnique({
          where: { id: claims.sub },
        });

        // Fall back to email lookup (pre-migration)
        if (!profile) {
          profile = await prisma.profiles.findUnique({
            where: { username: claims.email },
          });
        }

        if (!profile) {
          return reply.status(404).send({
            error: 'User profile not found',
            code: 'NOT_FOUND',
          });
        }

        const membership = await prisma.memberships.findFirst({
          where: { user_id: profile.id },
          include: { organization: true },
        });

        return reply.send({
          id: profile.id,
          email: profile.username || claims.email,
          name: profile.full_name || profile.username || 'Unknown',
          organizationId: membership?.organization_id,
          organizationName: membership?.organization.name,
          role: membership?.role,
        });
      } catch (error) {
        return reply.status(401).send({
          error: 'Invalid token',
          code: 'UNAUTHORIZED',
        });
      }
    },
  );
}
