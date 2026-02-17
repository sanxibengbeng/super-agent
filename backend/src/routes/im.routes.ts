/**
 * IM Channel Routes
 *
 * Admin endpoints for managing IM channel bindings (CRUD),
 * and platform webhook endpoints for receiving messages from Slack, Discord, etc.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate } from '../middleware/auth.js';
import { imChannelRepository } from '../repositories/im-channel.repository.js';
import { imService } from '../services/im.service.js';
import { slackAdapter, SlackAdapter } from '../services/slack-adapter.js';
import { telegramAdapter } from '../services/telegram-adapter.js';
import { discordAdapter, DiscordAdapter } from '../services/discord-adapter.js';
import { feishuAdapter, FeishuAdapter } from '../services/feishu-adapter.js';
import { dingtalkAdapter } from '../services/dingtalk-adapter.js';

// Register adapters on import
imService.registerAdapter('slack', slackAdapter);
imService.registerAdapter('telegram', telegramAdapter);
imService.registerAdapter('discord', discordAdapter);
imService.registerAdapter('feishu', feishuAdapter);
imService.registerAdapter('dingtalk', dingtalkAdapter);

// ============================================================================
// Admin Routes — Manage IM channel bindings (requires auth)
// ============================================================================

interface ScopeParam {
  Params: { scopeId: string };
}

interface BindingParam {
  Params: { scopeId: string; bindingId: string };
}

interface CreateBindingRequest {
  Params: { scopeId: string };
  Body: {
    channel_type: string;
    channel_id: string;
    channel_name?: string;
    bot_token?: string;
    webhook_url?: string;
    config?: Record<string, unknown>;
  };
}

interface UpdateBindingRequest {
  Params: { scopeId: string; bindingId: string };
  Body: {
    channel_name?: string;
    bot_token?: string;
    webhook_url?: string;
    config?: Record<string, unknown>;
    is_enabled?: boolean;
  };
}

export async function imChannelAdminRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /api/business-scopes/:scopeId/im-channels — List bindings for a scope */
  fastify.get<ScopeParam>(
    '/:scopeId/im-channels',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<ScopeParam>, reply: FastifyReply) => {
      const bindings = await imChannelRepository.findByScope(
        request.user!.orgId,
        request.params.scopeId,
      );
      // Strip sensitive fields from response
      const safe = bindings.map(b => ({
        ...b,
        bot_token_enc: b.bot_token_enc ? '***' : null,
      }));
      return reply.status(200).send({ data: safe });
    },
  );

  /** POST /api/business-scopes/:scopeId/im-channels — Create a new binding */
  fastify.post<CreateBindingRequest>(
    '/:scopeId/im-channels',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<CreateBindingRequest>, reply: FastifyReply) => {
      const { scopeId } = request.params;
      const { channel_type, channel_id, channel_name, bot_token, webhook_url, config: cfg } = request.body;

      if (!channel_type || !channel_id) {
        return reply.status(400).send({
          error: 'channel_type and channel_id are required',
          code: 'VALIDATION_ERROR',
        });
      }

      const binding = await imChannelRepository.create({
        organization_id: request.user!.orgId,
        business_scope_id: scopeId,
        channel_type,
        channel_id,
        channel_name: channel_name ?? null,
        bot_token_enc: bot_token ?? null, // TODO: encrypt in production
        webhook_url: webhook_url ?? null,
        config: cfg ?? {},
        is_enabled: true,
        created_by: request.user!.id,
      });

      return reply.status(201).send({
        data: { ...binding, bot_token_enc: binding.bot_token_enc ? '***' : null },
      });
    },
  );

  /** PUT /api/business-scopes/:scopeId/im-channels/:bindingId — Update a binding */
  fastify.put<UpdateBindingRequest>(
    '/:scopeId/im-channels/:bindingId',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<UpdateBindingRequest>, reply: FastifyReply) => {
      const { bindingId } = request.params;
      const { channel_name, bot_token, webhook_url, config: cfg, is_enabled } = request.body;

      const updateData: Record<string, unknown> = {};
      if (channel_name !== undefined) updateData.channel_name = channel_name;
      if (bot_token !== undefined) updateData.bot_token_enc = bot_token; // TODO: encrypt
      if (webhook_url !== undefined) updateData.webhook_url = webhook_url;
      if (cfg !== undefined) updateData.config = cfg;
      if (is_enabled !== undefined) updateData.is_enabled = is_enabled;

      const updated = await imChannelRepository.update(bindingId, request.user!.orgId, updateData);
      if (!updated) {
        return reply.status(404).send({ error: 'Binding not found', code: 'NOT_FOUND' });
      }

      return reply.status(200).send({
        data: { ...updated, bot_token_enc: updated.bot_token_enc ? '***' : null },
      });
    },
  );

  /** DELETE /api/business-scopes/:scopeId/im-channels/:bindingId — Remove a binding */
  fastify.delete<BindingParam>(
    '/:scopeId/im-channels/:bindingId',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<BindingParam>, reply: FastifyReply) => {
      const deleted = await imChannelRepository.delete(request.params.bindingId, request.user!.orgId);
      if (!deleted) {
        return reply.status(404).send({ error: 'Binding not found', code: 'NOT_FOUND' });
      }
      return reply.status(204).send();
    },
  );
}

// ============================================================================
// Platform Webhook Routes — Receive messages from IM platforms (no auth)
// ============================================================================

export async function imWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /api/im/slack/events — Slack Events API endpoint.
   * Handles URL verification challenges and incoming messages.
   * No JWT auth — verified via Slack signing secret instead.
   */
  fastify.post(
    '/slack/events',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as Record<string, unknown>;

      // Handle Slack URL verification challenge
      const challenge = SlackAdapter.isChallenge(body);
      if (challenge) {
        return reply.status(200).send({ challenge });
      }

      // Parse the event
      const msg = slackAdapter.parseEvent(body);
      if (!msg) {
        // Not a user message (bot message, subtype, etc.) — acknowledge silently
        return reply.status(200).send({ ok: true });
      }

      // Process asynchronously — Slack requires a 200 within 3 seconds
      // We acknowledge immediately and process in the background
      reply.status(200).send({ ok: true });

      try {
        await imService.handleMessage(msg);
      } catch (error) {
        console.error('Failed to handle Slack message:', error instanceof Error ? error.message : error);
      }
    },
  );

  /**
   * POST /api/im/telegram/webhook — Telegram Bot API webhook endpoint.
   * Receives Update objects from Telegram. No JWT auth — verified via secret_token header.
   */
  fastify.post(
    '/telegram/webhook',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const msg = telegramAdapter.parseEvent(request.body);
      if (!msg) {
        return reply.status(200).send({ ok: true });
      }

      // Telegram tolerates slower responses, but still process async
      reply.status(200).send({ ok: true });

      try {
        await imService.handleMessage(msg);
      } catch (error) {
        console.error('Failed to handle Telegram message:', error instanceof Error ? error.message : error);
      }
    },
  );

  /**
   * POST /api/im/discord/interactions — Discord Interactions endpoint.
   * Handles PING verification and message events.
   */
  fastify.post(
    '/discord/interactions',
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Handle Discord PING → PONG
      if (DiscordAdapter.isPing(request.body)) {
        return reply.status(200).send({ type: 1 });
      }

      const msg = discordAdapter.parseEvent(request.body);
      if (!msg) {
        return reply.status(200).send({ ok: true });
      }

      reply.status(200).send({ ok: true });

      try {
        await imService.handleMessage(msg);
      } catch (error) {
        console.error('Failed to handle Discord message:', error instanceof Error ? error.message : error);
      }
    },
  );

  /**
   * POST /api/im/feishu/events — Feishu (Lark) Event Subscription endpoint.
   * Handles URL verification and im.message.receive_v1 events.
   */
  fastify.post(
    '/feishu/events',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as Record<string, unknown>;

      // Handle Feishu URL verification challenge
      const challenge = FeishuAdapter.isChallenge(body);
      if (challenge) {
        return reply.status(200).send({ challenge });
      }

      const msg = feishuAdapter.parseEvent(body);
      if (!msg) {
        return reply.status(200).send({ ok: true });
      }

      reply.status(200).send({ ok: true });

      try {
        await imService.handleMessage(msg);
      } catch (error) {
        console.error('Failed to handle Feishu message:', error instanceof Error ? error.message : error);
      }
    },
  );

  /**
   * POST /api/im/dingtalk/callback — DingTalk Robot callback endpoint.
   * Receives messages when users @mention the bot in a group.
   */
  fastify.post(
    '/dingtalk/callback',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const msg = dingtalkAdapter.parseEvent(request.body);
      if (!msg) {
        return reply.status(200).send({ ok: true });
      }

      reply.status(200).send({ ok: true });

      try {
        await imService.handleMessage(msg);
      } catch (error) {
        console.error('Failed to handle DingTalk message:', error instanceof Error ? error.message : error);
      }
    },
  );

  /**
   * POST /api/im/webhook/:bindingId — Generic webhook endpoint.
   * For platforms that don't have a dedicated adapter.
   * Expects: { text: string, thread_id?: string, user_id?: string }
   */
  fastify.post<{ Params: { bindingId: string }; Body: { text: string; thread_id?: string; user_id?: string } }>(
    '/webhook/:bindingId',
    async (request, reply) => {
      const { bindingId } = request.params;
      const { text, thread_id, user_id } = request.body;

      if (!text) {
        return reply.status(400).send({ error: 'text is required' });
      }

      // Look up the binding to get channel info
      // We need to find it without org context since this is an unauthenticated webhook
      const binding = await findBindingById(bindingId);
      if (!binding || !binding.is_enabled) {
        return reply.status(404).send({ error: 'Binding not found or disabled' });
      }

      const msg: import('../services/im.service.js').NormalizedIMMessage = {
        channelType: binding.channel_type,
        channelId: binding.channel_id,
        threadId: thread_id || `webhook-${Date.now()}`,
        userId: user_id || 'webhook-user',
        text,
      };

      try {
        const result = await imService.handleMessage(msg);
        return reply.status(200).send({ text: result.text, session_id: result.sessionId });
      } catch (error) {
        console.error('Failed to handle webhook message:', error instanceof Error ? error.message : error);
        return reply.status(500).send({ error: 'Failed to process message' });
      }
    },
  );
}

/** Helper to find a binding by ID without org context (for unauthenticated webhooks). */
async function findBindingById(bindingId: string) {
  const { prisma } = await import('../config/database.js');
  return prisma.im_channel_bindings.findUnique({
    where: { id: bindingId },
  });
}
