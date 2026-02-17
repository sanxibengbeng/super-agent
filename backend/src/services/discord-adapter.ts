/**
 * Discord Adapter
 *
 * Handles Discord Interactions/webhook events, message parsing, and reply posting.
 * Implements the IMAdapter interface for Discord-specific behavior.
 *
 * Discord bots typically use Gateway (WebSocket), but for webhook-based integration
 * this adapter handles HTTP interaction endpoints.
 */

import crypto from 'crypto';
import type { IMAdapter, NormalizedIMMessage } from './im.service.js';
import type { IMChannelBindingEntity } from '../repositories/im-channel.repository.js';

interface DiscordMessage {
  type: number; // 0 = PING, 1 = message create (via webhook relay)
  id?: string;
  channel_id?: string;
  content?: string;
  author?: { id: string; username: string; bot?: boolean };
  message_reference?: { message_id?: string };
  /** For Interactions API verification */
  d?: {
    id?: string;
    channel_id?: string;
    content?: string;
    author?: { id: string; username: string; bot?: boolean };
    message_reference?: { message_id?: string };
  };
}

export class DiscordAdapter implements IMAdapter {
  /**
   * Verify Discord request using Ed25519 signature.
   * Discord sends X-Signature-Ed25519 and X-Signature-Timestamp headers.
   */
  verifyRequest(headers: Record<string, string>, body: string): boolean {
    const publicKey = headers['x-discord-public-key-internal'];
    if (!publicKey) return true; // No key configured — skip

    const signature = headers['x-signature-ed25519'];
    const timestamp = headers['x-signature-timestamp'];
    if (!signature || !timestamp) return false;

    try {
      const message = Buffer.from(timestamp + body);
      const sig = Buffer.from(signature, 'hex');
      const key = Buffer.from(publicKey, 'hex');
      return crypto.verify(undefined, message, { key, format: 'der', type: 'spki' } as any, sig);
    } catch {
      return false;
    }
  }

  parseEvent(body: unknown): NormalizedIMMessage | null {
    const payload = body as DiscordMessage;

    // Handle Discord PING (type 1 in Interactions API)
    if (payload.type === 1 && !payload.content && !payload.d) return null;

    const msg = payload.d || payload;
    if (!msg.content || !msg.channel_id) return null;

    // Ignore bot messages
    if (msg.author?.bot) return null;

    // Thread = message reference (reply chain) or own message ID
    const threadId = msg.message_reference?.message_id || msg.id || String(Date.now());

    return {
      channelType: 'discord',
      channelId: msg.channel_id,
      threadId,
      userId: msg.author?.id ?? 'unknown',
      userName: msg.author?.username,
      text: msg.content,
    };
  }

  /**
   * Check if payload is a Discord PING that needs a PONG response.
   */
  static isPing(body: unknown): boolean {
    return (body as DiscordMessage).type === 1 && !(body as DiscordMessage).content;
  }

  async sendReply(binding: IMChannelBindingEntity, _threadId: string, text: string): Promise<void> {
    const botToken = binding.bot_token_enc; // TODO: decrypt in production
    if (!botToken) {
      console.error(`No bot token for Discord binding ${binding.id}`);
      return;
    }

    // Discord has a 2000 char limit per message
    const chunks = this.splitMessage(text, 2000);

    for (const chunk of chunks) {
      const response = await fetch(
        `https://discord.com/api/v10/channels/${binding.channel_id}/messages`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bot ${botToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content: chunk }),
        },
      );

      if (!response.ok) {
        console.error(`Discord API error: ${response.status} ${await response.text()}`);
      }
    }
  }

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxLen) {
      chunks.push(text.substring(i, i + maxLen));
    }
    return chunks;
  }
}

export const discordAdapter = new DiscordAdapter();
