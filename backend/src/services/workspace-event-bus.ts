/**
 * Workspace Event Bus
 *
 * Central coordination service for workspace execution events. Responsible for:
 * 1. Persisting events to the database (execution_events table)
 * 2. Broadcasting events to local WebSocket clients
 * 3. Publishing events to Redis for cross-process delivery
 * 4. Subscribing to remote events and forwarding to local clients
 */

import { executionEventRepository } from '../repositories/execution-event.repository.js';
import { workspaceWebSocketGateway } from '../websocket/workspace.gateway.js';
import { redisService } from './redis.service.js';

export type WorkspaceEventType =
  | 'task_started'
  | 'task_completed'
  | 'task_failed'
  | 'task_timeout'
  | 'files_changed'
  | 'heartbeat';

export interface WorkspaceEvent {
  id: string;
  task_id: string;
  session_id: string;
  type: WorkspaceEventType;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface EmitEventInput {
  task_id: string;
  session_id: string;
  type: WorkspaceEventType;
  payload: Record<string, unknown>;
}

const REDIS_CHANNEL_PREFIX = 'workspace:events:';

export class WorkspaceEventBus {
  /**
   * Initialize the event bus by subscribing to remote workspace events via Redis.
   */
  async initialize(): Promise<void> {
    await redisService.psubscribe(`${REDIS_CHANNEL_PREFIX}*`, (channel, message) => {
      this.handleRemoteEvent(channel, message);
    });
  }

  /**
   * Emit a workspace event:
   * 1. Persist to DB
   * 2. Broadcast to local WebSocket clients
   * 3. Publish to Redis for other processes
   */
  async emit(input: EmitEventInput): Promise<WorkspaceEvent> {
    // Step 1: Persist to database
    const saved = await executionEventRepository.create({
      task_id: input.task_id,
      session_id: input.session_id,
      type: input.type,
      payload: input.payload,
    });

    const event: WorkspaceEvent = {
      id: saved.id,
      task_id: saved.task_id,
      session_id: saved.session_id,
      type: saved.type as WorkspaceEventType,
      payload: saved.payload as Record<string, unknown>,
      created_at: saved.created_at.toISOString(),
    };

    // Step 2: Broadcast to local WebSocket clients
    workspaceWebSocketGateway.broadcastToLocal(input.session_id, event);

    // Step 3: Publish to Redis for cross-process delivery
    await redisService.publish(
      `${REDIS_CHANNEL_PREFIX}${input.session_id}`,
      JSON.stringify(event)
    );

    return event;
  }

  /**
   * Handle a remote event received via Redis pub/sub.
   * Forwards it to local WebSocket clients.
   */
  handleRemoteEvent(channel: string, message: string): void {
    try {
      const event = JSON.parse(message);
      const sessionId = channel.replace(REDIS_CHANNEL_PREFIX, '');
      workspaceWebSocketGateway.broadcastToLocal(sessionId, event);
    } catch {
      // Malformed message — log and skip
    }
  }

  /**
   * Shutdown the event bus by unsubscribing from Redis patterns.
   */
  async shutdown(): Promise<void> {
    await redisService.punsubscribe(`${REDIS_CHANNEL_PREFIX}*`);
  }
}

export const workspaceEventBus = new WorkspaceEventBus();
