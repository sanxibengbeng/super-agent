import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/repositories/execution-event.repository.js', () => ({
  executionEventRepository: {
    create: vi.fn(),
  },
}));

vi.mock('../../src/repositories/execution-task.repository.js', () => ({
  executionTaskRepository: {
    update: vi.fn(),
  },
}));

vi.mock('../../src/websocket/workspace.gateway.js', () => ({
  workspaceWebSocketGateway: {
    broadcastToLocal: vi.fn(),
  },
}));

vi.mock('../../src/services/redis.service.js', () => ({
  redisService: {
    publish: vi.fn().mockResolvedValue(undefined),
    psubscribe: vi.fn().mockResolvedValue(undefined),
    punsubscribe: vi.fn().mockResolvedValue(undefined),
  },
}));

import { executionEventRepository } from '../../src/repositories/execution-event.repository.js';
import { workspaceWebSocketGateway } from '../../src/websocket/workspace.gateway.js';
import { redisService } from '../../src/services/redis.service.js';
import { WorkspaceEventBus } from '../../src/services/workspace-event-bus.js';

const mockEventRepo = executionEventRepository as unknown as {
  create: ReturnType<typeof vi.fn>;
};

const mockGateway = workspaceWebSocketGateway as unknown as {
  broadcastToLocal: ReturnType<typeof vi.fn>;
};

const mockRedis = redisService as unknown as {
  publish: ReturnType<typeof vi.fn>;
  psubscribe: ReturnType<typeof vi.fn>;
  punsubscribe: ReturnType<typeof vi.fn>;
};

describe('WorkspaceEventBus', () => {
  let bus: WorkspaceEventBus;

  beforeEach(() => {
    vi.clearAllMocks();
    bus = new WorkspaceEventBus();
  });

  describe('emit', () => {
    it('should persist event, broadcast locally, and publish to Redis', async () => {
      const event = {
        task_id: 'task-1',
        session_id: 'session-1',
        type: 'task_completed' as const,
        payload: { files_modified: ['scope-config.json'] },
      };
      const savedEvent = {
        id: 'evt-1',
        task_id: 'task-1',
        session_id: 'session-1',
        type: 'task_completed',
        payload: { files_modified: ['scope-config.json'] },
        created_at: new Date('2026-05-06T00:00:00.000Z'),
      };
      mockEventRepo.create.mockResolvedValue(savedEvent);

      await bus.emit(event);

      expect(mockEventRepo.create).toHaveBeenCalledWith(event);
      expect(mockGateway.broadcastToLocal).toHaveBeenCalledWith('session-1', {
        id: 'evt-1',
        task_id: 'task-1',
        session_id: 'session-1',
        type: 'task_completed',
        payload: { files_modified: ['scope-config.json'] },
        created_at: '2026-05-06T00:00:00.000Z',
      });
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'workspace:events:session-1',
        JSON.stringify({
          id: 'evt-1',
          task_id: 'task-1',
          session_id: 'session-1',
          type: 'task_completed',
          payload: { files_modified: ['scope-config.json'] },
          created_at: '2026-05-06T00:00:00.000Z',
        })
      );
    });

    it('should not broadcast if DB persistence fails', async () => {
      const event = {
        task_id: 'task-1',
        session_id: 'session-1',
        type: 'files_changed' as const,
        payload: {},
      };
      mockEventRepo.create.mockRejectedValue(new Error('DB error'));

      await expect(bus.emit(event)).rejects.toThrow('DB error');

      expect(mockGateway.broadcastToLocal).not.toHaveBeenCalled();
    });

    it('should return the persisted event', async () => {
      const savedEvent = {
        id: 'evt-2',
        task_id: 'task-2',
        session_id: 'session-2',
        type: 'task_started',
        payload: { agent_id: 'agent-1' },
        created_at: new Date('2026-05-06T12:00:00.000Z'),
      };
      mockEventRepo.create.mockResolvedValue(savedEvent);

      const result = await bus.emit({
        task_id: 'task-2',
        session_id: 'session-2',
        type: 'task_started',
        payload: { agent_id: 'agent-1' },
      });

      expect(result).toEqual({
        id: 'evt-2',
        task_id: 'task-2',
        session_id: 'session-2',
        type: 'task_started',
        payload: { agent_id: 'agent-1' },
        created_at: '2026-05-06T12:00:00.000Z',
      });
    });
  });

  describe('handleRemoteEvent', () => {
    it('should broadcast remote events to local WebSocket clients', () => {
      const event = { id: 'evt-2', session_id: 'session-1', type: 'task_started', payload: {} };

      bus.handleRemoteEvent('workspace:events:session-1', JSON.stringify(event));

      expect(mockGateway.broadcastToLocal).toHaveBeenCalledWith('session-1', event);
    });

    it('should extract session ID from channel name', () => {
      const event = { id: 'evt-3', type: 'heartbeat' };

      bus.handleRemoteEvent('workspace:events:abc-def-123', JSON.stringify(event));

      expect(mockGateway.broadcastToLocal).toHaveBeenCalledWith('abc-def-123', event);
    });

    it('should not throw on malformed messages', () => {
      expect(() => bus.handleRemoteEvent('workspace:events:x', 'not json')).not.toThrow();
      expect(mockGateway.broadcastToLocal).not.toHaveBeenCalled();
    });
  });

  describe('initialize', () => {
    it('should subscribe to workspace events pattern via Redis', async () => {
      await bus.initialize();

      expect(mockRedis.psubscribe).toHaveBeenCalledWith(
        'workspace:events:*',
        expect.any(Function)
      );
    });
  });

  describe('shutdown', () => {
    it('should unsubscribe from workspace events pattern', async () => {
      await bus.shutdown();

      expect(mockRedis.punsubscribe).toHaveBeenCalledWith('workspace:events:*');
    });
  });
});
