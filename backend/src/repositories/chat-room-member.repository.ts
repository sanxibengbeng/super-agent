/**
 * Chat Room Member Repository
 * Manages agent membership in chat rooms (group mode sessions).
 */

import { prisma } from '../config/database.js';

export interface ChatRoomMemberEntity {
  id: string;
  session_id: string;
  agent_id: string;
  role: 'primary' | 'member';
  is_active: boolean;
  added_by: string | null;
  joined_at: Date;
}

export interface ChatRoomMemberWithAgent extends ChatRoomMemberEntity {
  agent: {
    id: string;
    name: string;
    display_name: string;
    role: string | null;
    avatar: string | null;
    system_prompt: string | null;
    status: string;
  };
}

export class ChatRoomMemberRepository {
  async findBySession(sessionId: string, activeOnly = true): Promise<ChatRoomMemberWithAgent[]> {
    const where: Record<string, unknown> = { session_id: sessionId };
    if (activeOnly) where.is_active = true;

    return prisma.chat_room_members.findMany({
      where,
      include: {
        agent: {
          select: {
            id: true, name: true, display_name: true,
            role: true, avatar: true, system_prompt: true, status: true,
          },
        },
      },
      orderBy: [{ role: 'asc' }, { joined_at: 'asc' }],
    }) as unknown as Promise<ChatRoomMemberWithAgent[]>;
  }

  async addMember(
    sessionId: string,
    agentId: string,
    role: 'primary' | 'member' = 'member',
    addedBy?: string,
  ): Promise<ChatRoomMemberEntity> {
    return prisma.chat_room_members.upsert({
      where: { unique_room_member: { session_id: sessionId, agent_id: agentId } },
      update: { is_active: true, role },
      create: { session_id: sessionId, agent_id: agentId, role, added_by: addedBy ?? null },
    }) as unknown as Promise<ChatRoomMemberEntity>;
  }

  async removeMember(sessionId: string, agentId: string): Promise<void> {
    await prisma.chat_room_members.updateMany({
      where: { session_id: sessionId, agent_id: agentId },
      data: { is_active: false },
    });
  }

  async setRole(sessionId: string, agentId: string, role: 'primary' | 'member'): Promise<void> {
    // If setting as primary, demote existing primary first
    if (role === 'primary') {
      await prisma.chat_room_members.updateMany({
        where: { session_id: sessionId, role: 'primary' },
        data: { role: 'member' },
      });
    }
    await prisma.chat_room_members.updateMany({
      where: { session_id: sessionId, agent_id: agentId },
      data: { role },
    });
  }

  async findPrimary(sessionId: string): Promise<ChatRoomMemberWithAgent | null> {
    return prisma.chat_room_members.findFirst({
      where: { session_id: sessionId, role: 'primary', is_active: true },
      include: {
        agent: {
          select: {
            id: true, name: true, display_name: true,
            role: true, avatar: true, system_prompt: true, status: true,
          },
        },
      },
    }) as unknown as Promise<ChatRoomMemberWithAgent | null>;
  }

  async isMember(sessionId: string, agentId: string): Promise<boolean> {
    const count = await prisma.chat_room_members.count({
      where: { session_id: sessionId, agent_id: agentId, is_active: true },
    });
    return count > 0;
  }

  async countActive(sessionId: string): Promise<number> {
    return prisma.chat_room_members.count({
      where: { session_id: sessionId, is_active: true },
    });
  }
}

export const chatRoomMemberRepository = new ChatRoomMemberRepository();
