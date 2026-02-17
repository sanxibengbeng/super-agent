/**
 * DingTalk Adapter
 *
 * Handles DingTalk Robot webhook events, message parsing, and reply posting.
 * Implements the IMAdapter interface for DingTalk-specific behavior.
 *
 * DingTalk Robot: https://open.dingtalk.com/document/orgapp/robot-overview
 */

import crypto from 'crypto';
import type { IMAdapter, NormalizedIMMessage } from './im.service.js';
import type { IMChannelBindingEntity } from '../repositories/im-channel.repository.js';

interface DingTalkEventPayload {
  msgtype?: string;
  text?: { content: string };
  conversationId?: string;
  senderStaffId?: string;
  senderNick?: string;
  msgId?: string;
  createAt?: number;
  conversationType?: string; // '1' = private, '2' = group
  atUsers?: Array<{ dingtalkId: string }>;
  chatbotUserId?: string;
  isInAtList?: boolean;
}

export class DingTalkAdapter implements IMAdapter {
  /**
   * Verify DingTalk request using the sign-based security.
   * DingTalk sends timestamp + sign in headers.
   */
  verifyRequest(headers: Record<string, string>, _body: string): boolean {
    const secret = headers['x-dingtalk-secret-internal'];
    if (!secret) return true;

    const timestamp = headers['timestamp'];
    const sign = headers['sign'];
    if (!timestamp || !sign) return false;

    const stringToSign = `${timestamp}\n${secret}`;
    const hmac = crypto.createHmac('sha256', secret).update(stringToSign).digest('base64');
    return hmac === sign;
  }

  parseEvent(body: unknown): NormalizedIMMessage | null {
    const payload = body as DingTalkEventPayload;
    if (payload.msgtype !== 'text' || !payload.text?.content) return null;
    if (!payload.conversationId) return null;

    // Strip @bot mention from text
    let text = payload.text.content.trim();
    if (!text) return null;

    // Use msgId as thread — DingTalk doesn't have native threading,
    // so each message is its own session (or use conversationId for channel-level session)
    const threadId = payload.msgId || `dingtalk-${Date.now()}`;

    return {
      channelType: 'dingtalk',
      channelId: payload.conversationId,
      threadId,
      userId: payload.senderStaffId || 'unknown',
      userName: payload.senderNick,
      text,
    };
  }

  async sendReply(binding: IMChannelBindingEntity, _threadId: string, text: string): Promise<void> {
    // DingTalk robots reply via webhook URL (outgoing)
    const webhookUrl = binding.webhook_url || (binding.config as Record<string, string>)?.webhook_url;
    if (!webhookUrl) {
      console.error(`No webhook URL for DingTalk binding ${binding.id}`);
      return;
    }

    const chunks = this.splitMessage(text, 20000);
    for (const chunk of chunks) {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: chunk } }),
      });
      if (!response.ok) {
        console.error(`DingTalk API error: ${response.status} ${await response.text()}`);
      }
    }
  }

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxLen) chunks.push(text.substring(i, i + maxLen));
    return chunks;
  }
}

export const dingtalkAdapter = new DingTalkAdapter();
