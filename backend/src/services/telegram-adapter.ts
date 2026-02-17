/**
 * Telegram Adapter
 *
 * Handles Telegram Bot API webhook events, message parsing, and reply posting.
 * Implements the IMAdapter interface for Telegram-specific behavior.
 */

import crypto from 'crypto';
import type { IMAdapter, NormalizedIMMessage } from './im.service.js';
import type { IMChannelBindingEntity } from '../repositories/im-channel.repository.js';

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string; first_name?: string };
    chat: { id: number; type: string };
    text?: string;
    reply_to_message?: { message_id: number };
  };
}

export class TelegramAdapter implements IMAdapter {
  /**
   * Verify Telegram webhook via secret_token header.
   * Telegram sends X-Telegram-Bot-Api-Secret-Token if configured on setWebhook.
   */
  verifyRequest(headers: Record<string, string>, _body: string): boolean {
    const secret = headers['x-telegram-bot-api-secret-token-internal'];
    const provided = headers['x-telegram-bot-api-secret-token'];
    if (!secret) return true; // No secret configured — skip verification
    if (!provided) return false;
    return crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(provided));
  }

  parseEvent(body: unknown): NormalizedIMMessage | null {
    const update = body as TelegramUpdate;
    if (!update.message?.text) return null;

    const msg = update.message;
    // Thread = reply chain. Use replied-to message_id as thread root, or own message_id
    const threadId = msg.reply_to_message
      ? String(msg.reply_to_message.message_id)
      : String(msg.message_id);

    return {
      channelType: 'telegram',
      channelId: String(msg.chat.id),
      threadId,
      userId: String(msg.from?.id ?? 'unknown'),
      userName: msg.from?.username || msg.from?.first_name || undefined,
      text: msg.text!,
    };
  }

  async sendReply(binding: IMChannelBindingEntity, _threadId: string, text: string): Promise<void> {
    const botToken = binding.bot_token_enc; // TODO: decrypt in production
    if (!botToken) {
      console.error(`No bot token for Telegram binding ${binding.id}`);
      return;
    }

    // Telegram has a 4096 char limit per message
    const chunks = this.splitMessage(text, 4096);

    for (const chunk of chunks) {
      const response = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: binding.channel_id,
            text: chunk,
            parse_mode: 'Markdown',
          }),
        },
      );

      if (!response.ok) {
        console.error(`Telegram API error: ${response.status} ${await response.text()}`);
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

export const telegramAdapter = new TelegramAdapter();
