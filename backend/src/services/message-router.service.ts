/**
 * Message Router Service
 * Routes messages to the appropriate agent in a group chat room.
 */

import type { ChatRoomMemberWithAgent } from '../repositories/chat-room-member.repository.js';
import type { ChatMessageEntity } from '../repositories/chat.repository.js';
import { aiService } from './ai.service.js';

export interface RouteDecision {
  targetAgentId: string;
  targetAgentName: string;
  confidence: number;
  reasoning: string;
  routedBy: 'mention' | 'auto' | 'primary' | 'fallback';
}

export class MessageRouter {
  /**
   * Parse @mention from message content.
   * Supports formats: @agent-name, @显示名称
   */
  parseMention(content: string, members: ChatRoomMemberWithAgent[]): string | null {
    const mentionMatch = content.match(/^@(\S+)/);
    if (!mentionMatch) return null;

    const mentionText = mentionMatch[1].toLowerCase();
    for (const member of members) {
      if (!member.is_active) continue;
      if (member.agent.name.toLowerCase() === mentionText) return member.agent_id;
      if (member.agent.display_name.toLowerCase() === mentionText) return member.agent_id;
    }
    return null;
  }

  /**
   * Route a message to the appropriate agent.
   */
  async route(params: {
    message: string;
    mentionAgentId?: string;
    members: ChatRoomMemberWithAgent[];
    recentMessages: ChatMessageEntity[];
    routingStrategy: string;
  }): Promise<RouteDecision> {
    const activeMembers = params.members.filter(m => m.is_active);
    if (activeMembers.length === 0) {
      throw new Error('No active members in room');
    }

    // 1. Explicit @mention (from frontend or parsed)
    if (params.mentionAgentId) {
      const target = activeMembers.find(m => m.agent_id === params.mentionAgentId);
      if (target) {
        return {
          targetAgentId: target.agent_id,
          targetAgentName: target.agent.display_name,
          confidence: 1.0,
          reasoning: 'User explicitly mentioned this agent',
          routedBy: 'mention',
        };
      }
    }

    // 2. Parse @mention from content
    const parsedMentionId = this.parseMention(params.message, activeMembers);
    if (parsedMentionId) {
      const target = activeMembers.find(m => m.agent_id === parsedMentionId);
      if (target) {
        return {
          targetAgentId: target.agent_id,
          targetAgentName: target.agent.display_name,
          confidence: 1.0,
          reasoning: 'Parsed @mention from message content',
          routedBy: 'mention',
        };
      }
    }

    // 3. mention-only strategy: don't route if no mention
    if (params.routingStrategy === 'mention') {
      const primary = activeMembers.find(m => m.role === 'primary') ?? activeMembers[0];
      return {
        targetAgentId: primary.agent_id,
        targetAgentName: primary.agent.display_name,
        confidence: 0.3,
        reasoning: 'No @mention in mention-only mode, falling back to primary',
        routedBy: 'fallback',
      };
    }

    // 4. Single member: no routing needed
    if (activeMembers.length === 1) {
      return {
        targetAgentId: activeMembers[0].agent_id,
        targetAgentName: activeMembers[0].agent.display_name,
        confidence: 1.0,
        reasoning: 'Only one active member',
        routedBy: 'primary',
      };
    }

    // 5. Auto-route via AI
    try {
      return await this.autoRoute(params.message, activeMembers, params.recentMessages);
    } catch {
      // Fallback to primary
      const primary = activeMembers.find(m => m.role === 'primary') ?? activeMembers[0];
      return {
        targetAgentId: primary.agent_id,
        targetAgentName: primary.agent.display_name,
        confidence: 0.5,
        reasoning: 'AI routing failed, falling back to primary',
        routedBy: 'fallback',
      };
    }
  }

  private async autoRoute(
    message: string,
    members: ChatRoomMemberWithAgent[],
    recentMessages: ChatMessageEntity[],
  ): Promise<RouteDecision> {
    const memberDescriptions = members.map(m =>
      `- ${m.agent.display_name} (@${m.agent.name}): ${m.agent.role || 'General assistant'}`
    ).join('\n');

    const recentContext = recentMessages.slice(-5).map(msg => {
      if (msg.type === 'user') return `[User]: ${msg.content.substring(0, 200)}`;
      const agent = members.find(m => m.agent_id === msg.agent_id);
      return `[@${agent?.agent.display_name ?? 'AI'}]: ${msg.content.substring(0, 200)}`;
    }).join('\n');

    const prompt = `You are a message router. Based on the user's message, decide which AI assistant should respond.

Room members:
${memberDescriptions}

Recent conversation:
${recentContext}

New user message: ${message}

Return ONLY valid JSON (no markdown):
{"target_agent_name": "agent-name", "confidence": 0.85, "reasoning": "brief reason"}`;

    const response = await aiService.chatCompletion({
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 256,
    });

    let jsonStr = response.trim();
    if (jsonStr.startsWith('```json')) jsonStr = jsonStr.slice(7);
    else if (jsonStr.startsWith('```')) jsonStr = jsonStr.slice(3);
    if (jsonStr.endsWith('```')) jsonStr = jsonStr.slice(0, -3);

    const parsed = JSON.parse(jsonStr.trim());
    const targetName = String(parsed.target_agent_name || '');
    const target = members.find(m =>
      m.agent.name.toLowerCase() === targetName.toLowerCase() ||
      m.agent.display_name.toLowerCase() === targetName.toLowerCase()
    );

    if (target) {
      return {
        targetAgentId: target.agent_id,
        targetAgentName: target.agent.display_name,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.7,
        reasoning: String(parsed.reasoning || 'AI auto-routed'),
        routedBy: 'auto',
      };
    }

    // AI returned unknown agent name, fall back to primary
    const primary = members.find(m => m.role === 'primary') ?? members[0];
    return {
      targetAgentId: primary.agent_id,
      targetAgentName: primary.agent.display_name,
      confidence: 0.4,
      reasoning: `AI suggested "${targetName}" but not found in room, falling back to primary`,
      routedBy: 'fallback',
    };
  }
}

export const messageRouter = new MessageRouter();
