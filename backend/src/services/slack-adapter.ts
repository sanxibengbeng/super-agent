/**
 * Slack Adapter
 *
 * Handles Slack Events API verification, message parsing, and reply posting.
 * Implements the IMAdapter interface for Slack-specific behavior.
 */

import crypto from 'crypto';
import type { IMAdapter, NormalizedIMMessage } from './im.service.js';
import type { IMChannelBindingEntity } from '../repositories/im-channel.repository.js';

/** Slack Events API event wrapper. */
interface SlackEventPayload {
  type: string;
  token?: string;
  challenge?: string;
  event?: {
    type: string;
    text?: string;
    user?: string;
    channel?: string;
    thread_ts?: string;
    ts?: string;
    bot_id?: string;
    subtype?: string;
  };
}

export class SlackAdapter implements IMAdapter {
  /**
   * Verify Slack request signature using the signing secret.
   * See: https://api.slack.com/authentication/verifying-requests-from-slack
   */
  verifyRequest(headers: Record<string, string>, body: string): boolean {
    const signingSecret = this.getSigningSecretFromHeaders(headers);
    if (!signingSecret) return false;

    const timestamp = headers['x-slack-request-timestamp'];
    const signature = headers['x-slack-signature'];
    if (!timestamp || !signature) return false;

    // Reject requests older than 5 minutes
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;

    const baseString = `v0:${timestamp}:${body}`;
    const hmac = crypto.createHmac('sha256', signingSecret).update(baseString).digest('hex');
    const expected = `v0=${hmac}`;

    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }

  /**
   * Parse a Slack Events API payload into a normalized message.
   * Returns null for non-message events (bot messages, subtypes, etc.).
   */
  parseEvent(body: unknown): NormalizedIMMessage | null {
    const payload = body as SlackEventPayload;
    if (!payload.event || payload.event.type !== 'message') return null;

    // Ignore bot messages and message subtypes (edits, deletes, etc.)
    if (payload.event.bot_id || payload.event.subtype) return null;

    const text = payload.event.text?.trim();
    if (!text) return null;

    return {
      channelType: 'slack',
      channelId: payload.event.channel!,
      // Use thread_ts if in a thread, otherwise use the message ts as the thread root
      threadId: payload.event.thread_ts || payload.event.ts!,
      userId: payload.event.user!,
      text,
    };
  }

  /**
   * Post a reply to Slack using chat.postMessage.
   * Replies in the same thread as the original message.
   */
  async sendReply(binding: IMChannelBindingEntity, threadId: string, text: string): Promise<void> {
    const botToken = binding.bot_token_enc; // TODO: decrypt in production
    if (!botToken) {
      console.error(`No bot token for Slack binding ${binding.id}`);
      return;
    }

    // Slack has a 40K char limit per message — split if needed
    const chunks = this.splitMessage(text, 39000);

    for (const chunk of chunks) {
      const response = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel: binding.channel_id,
          thread_ts: threadId,
          text: chunk,
        }),
      });

      if (!response.ok) {
        console.error(`Slack API error: ${response.status} ${await response.text()}`);
      }
    }
  }

  /**
   * Check if the payload is a Slack URL verification challenge.
   */
  static isChallenge(body: unknown): string | null {
    const payload = body as SlackEventPayload;
    if (payload.type === 'url_verification' && payload.challenge) {
      return payload.challenge;
    }
    return null;
  }

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxLen) {
      chunks.push(text.substring(i, i + maxLen));
    }
    return chunks;
  }

  /**
   * In a real implementation, the signing secret would come from the binding config.
   * For now, we pass it through a custom header set by the route handler.
   */
  private getSigningSecretFromHeaders(headers: Record<string, string>): string | null {
    return headers['x-slack-signing-secret-internal'] || null;
  }
}

export const slackAdapter = new SlackAdapter();
