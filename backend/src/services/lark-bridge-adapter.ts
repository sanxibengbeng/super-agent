/**
 * Lark/Feishu Bridge Adapter — @larksuite/channel WebSocket Mode
 *
 * Uses the official @larksuite/channel SDK for bidirectional messaging via
 * persistent WebSocket. Each binding connects as a PersonalAgent app. The user
 * creates an app by scanning a QR code (via lark-channel-bridge CLI flow or
 * manual developer console), provides app_id + app_secret, and we maintain
 * the WebSocket connection for message relay.
 *
 * No public IP or webhook needed — the SDK dials out over WebSocket.
 */

import { LarkChannel } from '@larksuite/channel';
import type { IMAdapter, NormalizedIMMessage } from './im.service.js';
import type { IMChannelBindingEntity } from '../repositories/im-channel.repository.js';
import { imQueueService } from './im-queue.service.js';

type ConnectionStatus = 'disconnected' | 'qr_pending' | 'connected';

interface ChannelEntry {
  channel: LarkChannel;
  bindingId: string;
  status: ConnectionStatus;
}

const activeChannels = new Map<string, ChannelEntry>();

export class LarkBridgeAdapter implements IMAdapter {
  verifyRequest(_headers: Record<string, string>, _body: string): boolean {
    return true;
  }

  parseEvent(_body: unknown): NormalizedIMMessage | null {
    return null;
  }

  async sendReply(
    binding: IMChannelBindingEntity,
    threadId: string,
    text: string,
    replyContext?: Record<string, unknown>,
  ): Promise<void> {
    const entry = activeChannels.get(binding.id);
    if (!entry || entry.status !== 'connected') {
      console.error(`[LARK-BRIDGE] No active connection for binding ${binding.id}`);
      return;
    }

    const chatId = (replyContext?.larkChatId as string) || threadId;
    try {
      await entry.channel.send(chatId, { text }, threadId ? { replyTo: threadId } : undefined);
    } catch (err) {
      console.error(`[LARK-BRIDGE] Send failed for binding ${binding.id}:`, err instanceof Error ? err.message : err);
    }
  }

  async startGateway(): Promise<void> {
    const bindings = await this.discoverBindings();
    if (bindings.length === 0) {
      console.log('[LARK-BRIDGE] No enabled lark-bridge bindings found, gateway idle');
      return;
    }

    for (const binding of bindings) {
      try {
        await this.connectBinding(binding);
      } catch (err) {
        console.error(`[LARK-BRIDGE] Failed to connect binding ${binding.id}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  async stopGateway(): Promise<void> {
    for (const [bindingId, entry] of activeChannels) {
      try {
        await entry.channel.disconnect();
      } catch {
        // best-effort
      }
      console.log(`[LARK-BRIDGE] Disconnected binding ${bindingId}`);
    }
    activeChannels.clear();
  }

  async addBot(binding: IMChannelBindingEntity): Promise<void> {
    if (activeChannels.has(binding.id)) return;
    await this.connectBinding(binding);
  }

  removeBot(bindingId: string): void {
    const entry = activeChannels.get(bindingId);
    if (entry) {
      entry.channel.disconnect().catch(() => {});
      activeChannels.delete(bindingId);
    }
  }

  getConnectionStatus(bindingId: string): ConnectionStatus {
    const entry = activeChannels.get(bindingId);
    if (!entry) return 'disconnected';
    return entry.status;
  }

  private async connectBinding(binding: IMChannelBindingEntity): Promise<void> {
    const cfg = (binding.config ?? {}) as Record<string, string>;
    const appId = cfg.app_id || binding.channel_id;
    const appSecret = cfg.app_secret || binding.bot_token_enc || '';
    const domain = cfg.domain || 'feishu';

    if (!appId || !appSecret) {
      console.error(`[LARK-BRIDGE] Missing app_id/app_secret for binding ${binding.id}`);
      return;
    }

    const channel = new LarkChannel({
      appId,
      appSecret,
      domain: domain as 'feishu' | 'lark',
      transport: 'websocket',
    });

    const entry: ChannelEntry = { channel, bindingId: binding.id, status: 'qr_pending' };
    activeChannels.set(binding.id, entry);

    channel.on('message', async (msg) => {
      const normalized: NormalizedIMMessage = {
        channelType: 'lark-bridge',
        channelId: msg.chatId,
        threadId: msg.rootId || msg.messageId,
        userId: msg.senderId,
        userName: msg.senderName,
        text: msg.content,
        bindingId: binding.id,
      };
      try {
        await imQueueService.enqueue(normalized);
      } catch (err) {
        console.error(`[LARK-BRIDGE] Enqueue failed:`, err instanceof Error ? err.message : err);
      }
    });

    channel.on('error', (err) => {
      console.error(`[LARK-BRIDGE] Channel error for ${binding.id}:`, err.message);
    });

    channel.on('reconnecting', () => {
      entry.status = 'qr_pending';
    });

    channel.on('reconnected', () => {
      entry.status = 'connected';
    });

    try {
      await channel.connect();
      entry.status = 'connected';
      console.log(`[LARK-BRIDGE] Connected binding ${binding.id} (${domain})`);
    } catch (err) {
      entry.status = 'disconnected';
      console.error(`[LARK-BRIDGE] Connect failed for ${binding.id}:`, err instanceof Error ? err.message : err);
    }
  }

  private async discoverBindings(): Promise<IMChannelBindingEntity[]> {
    const { prisma } = await import('../config/database.js');
    return (await prisma.im_channel_bindings.findMany({
      where: { channel_type: 'lark-bridge', is_enabled: true },
    })) as unknown as IMChannelBindingEntity[];
  }
}

export const larkBridgeAdapter = new LarkBridgeAdapter();
