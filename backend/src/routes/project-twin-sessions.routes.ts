/**
 * Project Twin Session Routes
 * Routes for managing digital twin chat sessions within projects.
 */

import { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { projectTwinSessionService } from '../services/project-twin-session.service.js';
import {
  createTwinSessionSchema,
  updateVisibilitySchema,
  listTwinSessionsSchema,
} from '../schemas/project-twin-session.schema.js';

function validate<T>(schema: { parse: (data: unknown) => T }, data: unknown): T {
  try {
    return schema.parse(data);
  } catch (error) {
    if (error instanceof ZodError) {
      throw AppError.validation('Validation failed', error.issues);
    }
    throw error;
  }
}

export async function projectTwinSessionRoutes(fastify: FastifyInstance): Promise<void> {

  // ==========================================================================
  // Twin Sessions
  // ==========================================================================

  /**
   * POST / - Create a new twin session
   */
  fastify.post<{ Params: { id: string }; Body: { agent_id: string; issue_id?: string; visibility?: string } }>(
    '/',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const body = validate(createTwinSessionSchema, request.body);
      const session = await projectTwinSessionService.create(
        request.user!.orgId,
        request.params.id,
        request.user!.id,
        body,
      );
      return reply.status(201).send(session);
    }
  );

  /**
   * GET / - List twin sessions for project
   */
  fastify.get<{
    Params: { id: string };
    Querystring: { issue_id?: string; visibility?: string; mine_only?: boolean };
  }>(
    '/',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const query = validate(listTwinSessionsSchema, request.query);
      const sessions = await projectTwinSessionService.list(
        request.user!.orgId,
        request.params.id,
        request.user!.id,
        query,
      );
      return reply.send({ data: sessions });
    }
  );

  /**
   * GET /active - Get active sessions for project
   * IMPORTANT: This route MUST come before /:twinSessionId to avoid route conflict
   */
  fastify.get<{ Params: { id: string } }>(
    '/active',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const sessions = await projectTwinSessionService.getActiveSessionsForProject(request.params.id);
      return reply.send({ data: sessions });
    }
  );

  /**
   * GET /:twinSessionId - Get session detail
   */
  fastify.get<{ Params: { id: string; twinSessionId: string } }>(
    '/:twinSessionId',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const session = await projectTwinSessionService.getById(
        request.user!.orgId,
        request.params.id,
        request.params.twinSessionId,
        request.user!.id,
      );
      return reply.send(session);
    }
  );

  /**
   * PATCH /:twinSessionId/visibility - Toggle visibility
   */
  fastify.patch<{
    Params: { id: string; twinSessionId: string };
    Body: { visibility: 'private' | 'public' };
  }>(
    '/:twinSessionId/visibility',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const body = validate(updateVisibilitySchema, request.body);
      const session = await projectTwinSessionService.updateVisibility(
        request.user!.orgId,
        request.params.id,
        request.params.twinSessionId,
        request.user!.id,
        body.visibility,
      );
      return reply.send(session);
    }
  );

  /**
   * DELETE /:twinSessionId - Delete session
   */
  fastify.delete<{ Params: { id: string; twinSessionId: string } }>(
    '/:twinSessionId',
    { preHandler: [authenticate] },
    async (request, reply) => {
      await projectTwinSessionService.delete(
        request.user!.orgId,
        request.params.id,
        request.params.twinSessionId,
        request.user!.id,
      );
      return reply.status(204).send();
    }
  );

  /**
   * POST /:twinSessionId/actions/:actionId/confirm - Confirm action
   */
  fastify.post<{ Params: { id: string; twinSessionId: string; actionId: string } }>(
    '/:twinSessionId/actions/:actionId/confirm',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const result = await projectTwinSessionService.confirmAction(
        request.user!.orgId,
        request.params.id,
        request.params.twinSessionId,
        request.params.actionId,
        request.user!.id,
      );
      return reply.send(result);
    }
  );

  /**
   * POST /:twinSessionId/actions/:actionId/reject - Reject action
   */
  fastify.post<{ Params: { id: string; twinSessionId: string; actionId: string } }>(
    '/:twinSessionId/actions/:actionId/reject',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const result = await projectTwinSessionService.rejectAction(
        request.user!.orgId,
        request.params.id,
        request.params.twinSessionId,
        request.params.actionId,
        request.user!.id,
      );
      return reply.send(result);
    }
  );
}
