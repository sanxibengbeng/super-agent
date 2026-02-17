/**
 * Feishu (Lark) Adapter
 *
 * Handles Feishu Bot webhook events, message parsing, and reply posting.
 * Implements the IMAdapter interface for Feishu-specific behavior.
 *
 * Feishu Event Subscription: https://open.feishu.cn/document/server-docs/event-subscription
 */

import type { IMAdapter, NormalizedIMMessage } from './im.service.js';
import type { IMChannelBindingEntity } from '../repositories/im-channel.repository.js';

interface FeishuEventPayload {
  /** URL verification challenge */
  challenge?: string;
  type?: string; // 'url_verification'
  /** v2 event schema */
  schema?: string;
  header?: { event_type: string; token: string };
  event?: {
    sender?: { sender_id?: { open_id?: string; user_id?: string }; sender_type?: string };
    message?: {
      message_id: string;
      root_id?: string;
      parent_id?: string;
      chat_id: string;
      message_type: string;
      content: string; // JSON string, e.g. {"text":"hello"}
    };
  };
}

export class FeishuAdapter implements IMAdapter {
  verifyRequest(headers: Record<string, string>, body: string): boolean {
    const token = headers['x-feishu-verification-token-internal'];
    if (!token) return true;
    try {
      const payload = JSON.parse(body);
      return payload.header?.token === token;
    } catch {
      return false;
    }
  }

  parseEvent(body: unknown): NormalizedIMMessage | null {
    const payload = body as FeishuEventPayload;
    if (!payload.event?.message || payload.event.message.message_type !== 'text') return null;
    // Ignore bot messages
    if (payload.event.sender?.sender_type === 'bot') return null;

    let text: string;
    try {
      text = JSON.parse(payload.event.message.content).text;
    } catch {
      return null;
    }
    if (!text?.trim()) return null;

    // Thread: root_id (reply chain root) or own message_id
    const threadId = payload.event.message.root_id || payload.event.message.message_id;

    return {
      channelType: 'feishu',
      channelId: payload.event.message.chat_id,
      threadId,
      userId: payload.event.sender?.sender_id?.open_id || 'unknown',
      text: text.trim(),
    };
  }

  static isChallenge(body: unknown): string | null {
    const p = body as FeishuEventPayload;
    if (p.type === 'url_verification' && p.challenge) return p.challenge;
    return null;
  }

  async sendReply(binding: IMChannelBindingEntity, threadId: string, text: string): Promise<void> {
    const token = await this.getTenantAccessToken(binding);
    if (!token) return;

    const chunks = this.splitMessage(text, 30000);
    for (const chunk of chunks) {
      const response = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receive_id: binding.channel_id,
          msg_type: 'text',
          content: JSON.stringify({ text: chunk }),
          ...(threadId ? { root_id: threadId } : {}),
        }),
      });
      if (!response.ok) {
        console.error(`Feishu API error: ${response.status} ${await response.text()}`);
      }
    }
  }

  /**
   * Get tenant_access_token using app_id + app_secret stored in binding config.
   * In production, cache this token (expires in 2 hours).
   */
  private async getTenantAccessToken(binding: IMChannelBindingEntity): Promise<string | null> {
    const cfg = binding.config as Record<string, string>;
    const appId = cfg?.app_id;
    const appSecret = binding.bot_token_enc; // app_secret stored as bot_token
    if (!appId || !appSecret) {
      console.error(`Missing app_id/app_secret for Feishu binding ${binding.id}`);
      return null;
    }
    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { tenant_access_token?: string };
    return data.tenant_access_token || null;
  }

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxLen) chunks.push(text.substring(i, i + maxLen));
    return chunks;
  }
}

export const feishuAdapter = new FeishuAdapter();
