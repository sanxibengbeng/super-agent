/**
 * useChatRoom Hook
 * State management for group chat rooms.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  RestChatRoomService,
  type ChatRoom,
  type RoomMember,
  type RoomMessage,
  type RouteDecision,
  type SuggestedAgent,
} from './api/restChatRoomService';

interface UseChatRoomOptions {
  roomId?: string;
  pollInterval?: number;
}

interface UseChatRoomReturn {
  room: ChatRoom | null;
  members: RoomMember[];
  messages: RoomMessage[];
  isLoading: boolean;
  error: string | null;

  // Room actions
  createRoom: (options: Parameters<typeof RestChatRoomService.createRoom>[0]) => Promise<ChatRoom>;
  createRoomFromScope: (scopeId: string) => Promise<ChatRoom>;

  // Member actions
  addMember: (agentId: string, role?: 'primary' | 'member') => Promise<void>;
  removeMember: (agentId: string) => Promise<void>;
  setMemberRole: (agentId: string, role: 'primary' | 'member') => Promise<void>;

  // Messaging
  sendMessage: (content: string, mentionAgentId?: string) => Promise<RouteDecision | null>;
  loadMoreMessages: () => Promise<void>;

  // In-room agent creation
  suggestAgent: (description: string) => Promise<{ suggested_agent: SuggestedAgent; follow_up_questions: string[]; confidence: number } | null>;
  confirmCreateAgent: (agentDef: Parameters<typeof RestChatRoomService.confirmCreateAgent>[1]) => Promise<void>;

  // Refresh
  refresh: () => Promise<void>;
}

export function useChatRoom(options: UseChatRoomOptions = {}): UseChatRoomReturn {
  const [room, setRoom] = useState<ChatRoom | null>(null);
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roomIdRef = useRef(options.roomId);

  const loadRoom = useCallback(async (id: string) => {
    try {
      setIsLoading(true);
      const [roomData, memberData, msgData] = await Promise.all([
        RestChatRoomService.getRoom(id),
        RestChatRoomService.getMembers(id),
        RestChatRoomService.getMessages(id, 50),
      ]);
      setRoom(roomData);
      setMembers(memberData);
      setMessages(msgData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load room');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    roomIdRef.current = options.roomId;
    if (options.roomId) loadRoom(options.roomId);
  }, [options.roomId, loadRoom]);

  // Polling for new messages
  useEffect(() => {
    if (!options.roomId || !options.pollInterval) return;
    const interval = setInterval(async () => {
      if (!roomIdRef.current) return;
      try {
        const msgs = await RestChatRoomService.getMessages(roomIdRef.current, 50);
        setMessages(msgs);
      } catch { /* ignore polling errors */ }
    }, options.pollInterval);
    return () => clearInterval(interval);
  }, [options.roomId, options.pollInterval]);

  const createRoom = useCallback(async (opts: Parameters<typeof RestChatRoomService.createRoom>[0]) => {
    const newRoom = await RestChatRoomService.createRoom(opts);
    setRoom(newRoom);
    setMembers(newRoom.members);
    setMessages([]);
    return newRoom;
  }, []);

  const createRoomFromScope = useCallback(async (scopeId: string) => {
    const newRoom = await RestChatRoomService.createRoomFromScope(scopeId);
    setRoom(newRoom);
    setMembers(newRoom.members);
    setMessages([]);
    return newRoom;
  }, []);

  const addMember = useCallback(async (agentId: string, role?: 'primary' | 'member') => {
    if (!room) return;
    await RestChatRoomService.addMember(room.id, agentId, role);
    const updated = await RestChatRoomService.getMembers(room.id);
    setMembers(updated);
  }, [room]);

  const removeMember = useCallback(async (agentId: string) => {
    if (!room) return;
    await RestChatRoomService.removeMember(room.id, agentId);
    const updated = await RestChatRoomService.getMembers(room.id);
    setMembers(updated);
  }, [room]);

  const setMemberRole = useCallback(async (agentId: string, role: 'primary' | 'member') => {
    if (!room) return;
    await RestChatRoomService.setMemberRole(room.id, agentId, role);
    const updated = await RestChatRoomService.getMembers(room.id);
    setMembers(updated);
  }, [room]);

  const sendMessage = useCallback(async (content: string, mentionAgentId?: string): Promise<RouteDecision | null> => {
    if (!room) return null;
    const result = await RestChatRoomService.sendMessage(room.id, content, mentionAgentId);
    // Refresh messages after sending
    const msgs = await RestChatRoomService.getMessages(room.id, 50);
    setMessages(msgs);
    return result.route;
  }, [room]);

  const loadMoreMessages = useCallback(async () => {
    if (!room || messages.length === 0) return;
    const oldest = messages[0];
    const older = await RestChatRoomService.getMessages(room.id, 50, oldest.created_at);
    setMessages(prev => [...older, ...prev]);
  }, [room, messages]);

  const suggestAgent = useCallback(async (description: string) => {
    if (!room) return null;
    return RestChatRoomService.suggestAgent(room.id, description);
  }, [room]);

  const confirmCreateAgent = useCallback(async (agentDef: Parameters<typeof RestChatRoomService.confirmCreateAgent>[1]) => {
    if (!room) return;
    await RestChatRoomService.confirmCreateAgent(room.id, agentDef);
    const updated = await RestChatRoomService.getMembers(room.id);
    setMembers(updated);
  }, [room]);

  const refresh = useCallback(async () => {
    if (room) await loadRoom(room.id);
  }, [room, loadRoom]);

  return {
    room, members, messages, isLoading, error,
    createRoom, createRoomFromScope,
    addMember, removeMember, setMemberRole,
    sendMessage, loadMoreMessages,
    suggestAgent, confirmCreateAgent,
    refresh,
  };
}
