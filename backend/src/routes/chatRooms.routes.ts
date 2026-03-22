/**
 * Chat Room Routes
 * REST API endpoints for group chat room management.
 */

import { FastifyInstance } from 'fastify';
import { authenticate, requireModifyAccess } from '../middleware/auth.js';
import { chatRoomService } from '../services/chat-room.service.js';

export async function chatRoomRoutes(fastify: FastifyInstance): Promise<void> {

  // ==========================================================================
  // Room Lifecycle
  // ==========================================================================

  /**
   * POST /api/chat/rooms — Create a group chat room
   */
  fastify.post<{
    Body: {
      title?: string;
      business_scope_id?: string;
      agent_ids: string[];
      primary_agent_id?: string;
      routing_strategy?: 'auto' | 'mention' | 'round_robin';
    };
  }>(
    '/',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const room = await chatRoomService.createRoom(
        request.user!.orgId,
        request.user!.id,
        {
          title: request.body.title,
          businessScopeId: request.body.business_scope_id,
          agentIds: request.body.agent_ids,
          primaryAgentId: request.body.primary_agent_id,
          routingStrategy: request.body.routing_strategy,
        },
      );
      return reply.status(201).send(room);
    }
  );

  /**
   * POST /api/chat/rooms/from-scope — Create room from all agents in a scope
   */
  fastify.post<{ Body: { business_scope_id: string } }>(
    '/from-scope',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const room = await chatRoomService.createRoomFromScope(
        request.user!.orgId,
        request.user!.id,
        request.body.business_scope_id,
      );
      return reply.status(201).send(room);
    }
  );

  /**
   * GET /api/chat/rooms/:roomId — Get room details with members
   */
  fastify.get<{ Params: { roomId: string } }>(
    '/:roomId',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { chatSessionRepository } = await import('../repositories/chat.repository.js');
      const session = await chatSessionRepository.findById(request.params.roomId, request.user!.orgId);
      if (!session) return reply.status(404).send({ error: 'Room not found' });

      const members = await chatRoomService.getMembers(request.user!.orgId, request.params.roomId);
      return reply.status(200).send({ ...session, members });
    }
  );

  /**
   * DELETE /api/chat/rooms/:roomId — Delete a room
   */
  fastify.delete<{ Params: { roomId: string } }>(
    '/:roomId',
    { preHandler: [authenticate, requireModifyAccess] },
    async (request, reply) => {
      const { chatSessionRepository } = await import('../repositories/chat.repository.js');
      await chatSessionRepository.delete(request.params.roomId, request.user!.orgId);
      return reply.status(204).send();
    }
  );

  // ==========================================================================
  // Member Management
  // ==========================================================================

  /**
   * GET /api/chat/rooms/:roomId/members
   */
  fastify.get<{ Params: { roomId: string } }>(
    '/:roomId/members',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const members = await chatRoomService.getMembers(request.user!.orgId, request.params.roomId);
      return reply.status(200).send({ members });
    }
  );

  /**
   * POST /api/chat/rooms/:roomId/members — Add agent to room
   */
  fastify.post<{ Params: { roomId: string }; Body: { agent_id: string; role?: 'primary' | 'member' } }>(
    '/:roomId/members',
    { preHandler: [authenticate, requireModifyAccess] },
    async (request, reply) => {
      await chatRoomService.addMember(
        request.user!.orgId,
        request.params.roomId,
        request.body.agent_id,
        request.body.role ?? 'member',
        request.user!.id,
      );
      return reply.status(201).send({ ok: true });
    }
  );

  /**
   * DELETE /api/chat/rooms/:roomId/members/:agentId — Remove agent from room
   */
  fastify.delete<{ Params: { roomId: string; agentId: string } }>(
    '/:roomId/members/:agentId',
    { preHandler: [authenticate, requireModifyAccess] },
    async (request, reply) => {
      await chatRoomService.removeMember(
        request.user!.orgId,
        request.params.roomId,
        request.params.agentId,
      );
      return reply.status(204).send();
    }
  );

  /**
   * PATCH /api/chat/rooms/:roomId/members/:agentId — Update member role
   */
  fastify.patch<{ Params: { roomId: string; agentId: string }; Body: { role: 'primary' | 'member' } }>(
    '/:roomId/members/:agentId',
    { preHandler: [authenticate, requireModifyAccess] },
    async (request, reply) => {
      await chatRoomService.setMemberRole(
        request.user!.orgId,
        request.params.roomId,
        request.params.agentId,
        request.body.role,
      );
      return reply.status(200).send({ ok: true });
    }
  );

  // ==========================================================================
  // Group Chat Messaging
  // ==========================================================================

  /**
   * POST /api/chat/rooms/:roomId/messages — Send message and get routed response
   */
  fastify.post<{
    Params: { roomId: string };
    Body: { content: string; mention_agent_id?: string };
  }>(
    '/:roomId/messages',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const orgId = request.user!.orgId;
      const roomId = request.params.roomId;
      const { content, mention_agent_id } = request.body;

      // Persist user message
      const { chatMessageRepository } = await import('../repositories/chat.repository.js');
      await chatMessageRepository.create({
        session_id: roomId,
        type: 'user',
        content,
        agent_id: null,
        mention_agent_id: mention_agent_id ?? null,
        metadata: {},
      }, orgId);

      // Route the message
      const route = await chatRoomService.routeMessage(orgId, roomId, content, mention_agent_id);

      return reply.status(200).send({
        route,
        message: 'Message received. Use POST /api/chat/rooms/:roomId/stream for streaming response.',
      });
    }
  );

  /**
   * GET /api/chat/rooms/:roomId/messages — Get message history
   */
  fastify.get<{ Params: { roomId: string }; Querystring: { limit?: number; before?: string } }>(
    '/:roomId/messages',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { chatMessageRepository } = await import('../repositories/chat.repository.js');
      const messages = await chatMessageRepository.findBySession(
        request.user!.orgId,
        request.params.roomId,
        {
          limit: Number(request.query.limit) || 50,
          before: request.query.before ? new Date(request.query.before) : undefined,
        },
      );
      return reply.status(200).send({ messages: messages.reverse() });
    }
  );

  // ==========================================================================
  // In-Room Agent Creation
  // ==========================================================================

  /**
   * POST /api/chat/rooms/:roomId/create-agent — Suggest a new agent for the room
   */
  fastify.post<{ Params: { roomId: string }; Body: { description: string } }>(
    '/:roomId/create-agent',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const result = await chatRoomService.suggestAgentForRoom(
        request.user!.orgId,
        request.params.roomId,
        request.body.description,
      );
      return reply.status(200).send(result);
    }
  );

  /**
   * POST /api/chat/rooms/:roomId/create-agent/confirm — Create and add agent to room
   */
  fastify.post<{
    Params: { roomId: string };
    Body: { name: string; display_name: string; role?: string; system_prompt?: string; tools?: unknown[] };
  }>(
    '/:roomId/create-agent/confirm',
    { preHandler: [authenticate, requireModifyAccess] },
    async (request, reply) => {
      const result = await chatRoomService.createAgentInRoom(
        request.user!.orgId,
        request.params.roomId,
        request.user!.id,
        request.body,
      );
      return reply.status(201).send(result);
    }
  );
}
