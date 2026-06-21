/**
 * IM Bridge Routes
 *
 * API routes for bridge-mode IM adapters (whatsapp-bridge and lark-bridge).
 * Handles QR code generation, connection status polling, connect/disconnect.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate } from '../middleware/auth.js';
import { imChannelRepository } from '../repositories/im-channel.repository.js';
import { imService } from '../services/im.service.js';
import { whatsappBridgeAdapter } from '../services/whatsapp-bridge-adapter.js';
import { larkBridgeAdapter } from '../services/lark-bridge-adapter.js';

imService.registerAdapter('whatsapp-bridge', whatsappBridgeAdapter);
imService.registerAdapter('lark-bridge', larkBridgeAdapter);

interface BindingIdParam {
  Params: { bindingId: string };
}

export async function imBridgeRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /:bindingId/qr — Get QR code or connection status */
  fastify.get<BindingIdParam>(
    '/:bindingId/qr',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<BindingIdParam>, reply: FastifyReply) => {
      const { bindingId } = request.params;

      const binding = await imChannelRepository.findById(bindingId, request.user!.orgId);
      if (!binding) {
        return reply.status(404).send({ error: 'Binding not found', code: 'NOT_FOUND' });
      }

      if (binding.channel_type === 'whatsapp-bridge') {
        const qr = await whatsappBridgeAdapter.getQRCode(bindingId);
        const status = await whatsappBridgeAdapter.getConnectionStatus(bindingId);
        return reply.status(200).send({ data: { qr, status } });
      }

      if (binding.channel_type === 'lark-bridge') {
        const status = larkBridgeAdapter.getConnectionStatus(bindingId);
        return reply.status(200).send({ data: { status } });
      }

      return reply.status(400).send({
        error: 'Unsupported channel type for QR generation',
        code: 'UNSUPPORTED',
      });
    },
  );

  /** GET /:bindingId/status — Get connection status for a bridge binding */
  fastify.get<BindingIdParam>(
    '/:bindingId/status',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<BindingIdParam>, reply: FastifyReply) => {
      const { bindingId } = request.params;

      const binding = await imChannelRepository.findById(bindingId, request.user!.orgId);
      if (!binding) {
        return reply.status(404).send({ error: 'Binding not found', code: 'NOT_FOUND' });
      }

      let status: string;
      if (binding.channel_type === 'whatsapp-bridge') {
        status = await whatsappBridgeAdapter.getConnectionStatus(bindingId);
      } else if (binding.channel_type === 'lark-bridge') {
        status = larkBridgeAdapter.getConnectionStatus(bindingId);
      } else {
        return reply.status(400).send({
          error: 'Unsupported channel type for status check',
          code: 'UNSUPPORTED',
        });
      }

      return reply.status(200).send({ data: { status } });
    },
  );

  /** POST /:bindingId/connect — Initiate bridge connection */
  fastify.post<BindingIdParam>(
    '/:bindingId/connect',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<BindingIdParam>, reply: FastifyReply) => {
      const { bindingId } = request.params;

      const binding = await imChannelRepository.findById(bindingId, request.user!.orgId);
      if (!binding) {
        return reply.status(404).send({ error: 'Binding not found', code: 'NOT_FOUND' });
      }

      if (binding.channel_type === 'whatsapp-bridge') {
        await whatsappBridgeAdapter.addBot(binding);
        const status = await whatsappBridgeAdapter.getConnectionStatus(bindingId);
        return reply.status(200).send({ data: { status } });
      }

      if (binding.channel_type === 'lark-bridge') {
        await larkBridgeAdapter.addBot(binding);
        const status = larkBridgeAdapter.getConnectionStatus(bindingId);
        return reply.status(200).send({ data: { status } });
      }

      return reply.status(400).send({
        error: 'Unsupported channel type for connect',
        code: 'UNSUPPORTED',
      });
    },
  );

  /** POST /:bindingId/disconnect — Disconnect a bridge binding */
  fastify.post<BindingIdParam>(
    '/:bindingId/disconnect',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<BindingIdParam>, reply: FastifyReply) => {
      const { bindingId } = request.params;

      const binding = await imChannelRepository.findById(bindingId, request.user!.orgId);
      if (!binding) {
        return reply.status(404).send({ error: 'Binding not found', code: 'NOT_FOUND' });
      }

      if (binding.channel_type === 'whatsapp-bridge') {
        await whatsappBridgeAdapter.removeBot(bindingId);
      } else if (binding.channel_type === 'lark-bridge') {
        larkBridgeAdapter.removeBot(bindingId);
      } else {
        return reply.status(400).send({
          error: 'Unsupported channel type for disconnect',
          code: 'UNSUPPORTED',
        });
      }

      return reply.status(200).send({ data: { status: 'disconnected' } });
    },
  );
}
