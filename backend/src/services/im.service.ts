/**
 * IM (Instant Messaging) Service
 *
 * Handles incoming messages from IM platforms (Slack, Discord, etc.),
 * resolves them to chat sessions, and sends responses back.
 */

import {
  imChannelRepository,
  imThreadSessionRepository,
  type IMChannelBindingEntity,
} from '../repositories/im-channel.repository.js';
import { chatService } from './chat.service.js';

/** Normalized message from any IM platform. */
export interface NormalizedIMMessage {
  channelType: string;
  channelId: string;
  threadId: string;
  userId: string;
  userName?: string;
  text: string;
}

/** Adapter interface — each IM platform implements this. */
export interface IMAdapter {
  /** Verify the incoming request signature. Returns true if valid. */
  verifyRequest(headers: Record<string, string>, body: string): boolean;
  /** Parse the raw platform event into a normalized message (or null if not a user message). */
  parseEvent(body: unknown): NormalizedIMMessage | null;
  /** Send a reply back to the IM platform. */
  sendReply(binding: IMChannelBindingEntity, threadId: string, text: string): Promise<void>;
}

class IMService {
  private adapters = new Map<string, IMAdapter>();

  registerAdapter(channelType: string, adapter: IMAdapter): void {
    this.adapters.set(channelType, adapter);
  }

  getAdapter(channelType: string): IMAdapter | undefined {
    return this.adapters.get(channelType);
  }

  /**
   * Handle an incoming IM message end-to-end:
   * 1. Find channel binding → determines org + scope
   * 2. Find or create thread→session mapping
   * 3. Call ChatService.processMessage (same as web UI)
   * 4. Send response back via adapter
   */
  async handleMessage(msg: NormalizedIMMessage): Promise<{ text: string; sessionId: string }> {
    // 1. Find binding
    const binding = await imChannelRepository.findByChannelTypeAndId(msg.channelType, msg.channelId);
    if (!binding) {
      throw new Error(`No active IM binding for ${msg.channelType}:${msg.channelId}`);
    }

    // 2. Resolve or create session
    const { sessionId, isNew } = await this.resolveSession(binding, msg);

    // 3. Process message through ChatService (same code path as web UI)
    const response = await chatService.processMessage({
      sessionId: isNew ? undefined : sessionId,
      businessScopeId: binding.business_scope_id,
      message: msg.text,
      organizationId: binding.organization_id,
      userId: msg.userId,
    });

    // If new session, update the thread mapping with the actual session ID
    if (isNew && response.sessionId !== sessionId) {
      // The processMessage created a new session — update our mapping
      await imThreadSessionRepository.create({
        binding_id: binding.id,
        thread_id: msg.threadId,
        session_id: response.sessionId,
        im_user_id: msg.userId,
      }).catch(() => {
        // Unique constraint — another request already created it
      });
    }

    // 4. Send reply back
    const adapter = this.adapters.get(msg.channelType);
    if (adapter) {
      await adapter.sendReply(binding, msg.threadId, response.text);
    }

    return { text: response.text, sessionId: response.sessionId };
  }

  private async resolveSession(
    binding: IMChannelBindingEntity,
    msg: NormalizedIMMessage,
  ): Promise<{ sessionId: string; isNew: boolean }> {
    // Check existing thread→session mapping
    const existing = await imThreadSessionRepository.findByThread(binding.id, msg.threadId);
    if (existing) {
      return { sessionId: existing.session_id, isNew: false };
    }

    // New thread — create session + mapping
    const session = await chatService.createSession(
      { business_scope_id: binding.business_scope_id, context: {} },
      binding.organization_id,
      msg.userId,
    );

    await imThreadSessionRepository.create({
      binding_id: binding.id,
      thread_id: msg.threadId,
      session_id: session.id,
      im_user_id: msg.userId,
    });

    return { sessionId: session.id, isNew: false }; // isNew=false because we already created the mapping
  }
}

export const imService = new IMService();
