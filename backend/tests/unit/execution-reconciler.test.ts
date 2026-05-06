import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockTaskRepo, mockEventBus, mockRedis, mockS3Send } = vi.hoisted(() => {
  const mockS3Send = vi.fn();
  return {
    mockTaskRepo: {
      findStale: vi.fn(),
      updateStatusWhere: vi.fn(),
    },
    mockEventBus: {
      emit: vi.fn().mockResolvedValue({ id: 'evt-1' }),
    },
    mockRedis: {
      acquireLock: vi.fn(),
    },
    mockS3Send,
  };
});

vi.mock('../../src/repositories/execution-task.repository.js', () => ({
  executionTaskRepository: mockTaskRepo,
}));

vi.mock('../../src/services/workspace-event-bus.js', () => ({
  workspaceEventBus: mockEventBus,
}));

vi.mock('../../src/services/redis.service.js', () => ({
  redisService: mockRedis,
}));

vi.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: class MockS3Client {
      send = mockS3Send;
    },
    HeadObjectCommand: class MockHeadObjectCommand {
      constructor(public args: any) {}
    },
    GetObjectCommand: class MockGetObjectCommand {
      constructor(public args: any) {}
    },
  };
});

vi.mock('../../src/config/index.js', () => ({
  config: { aws: { region: 'us-east-1' } },
}));

import { ExecutionReconciler } from '../../src/services/execution-reconciler.service.js';

describe('ExecutionReconciler', () => {
  let reconciler: ExecutionReconciler;

  beforeEach(() => {
    vi.clearAllMocks();
    reconciler = new ExecutionReconciler();
  });

  describe('reconcile', () => {
    it('should skip if lock not acquired', async () => {
      mockRedis.acquireLock.mockResolvedValue(null);

      await reconciler.reconcile();

      expect(mockTaskRepo.findStale).not.toHaveBeenCalled();
    });

    it('should process stale tasks when lock acquired', async () => {
      const releaseLock = vi.fn();
      mockRedis.acquireLock.mockResolvedValue(releaseLock);
      mockTaskRepo.findStale.mockResolvedValue([]);

      await reconciler.reconcile();

      expect(mockTaskRepo.findStale).toHaveBeenCalled();
      expect(releaseLock).toHaveBeenCalled();
    });

    it('should release lock even when findStale throws', async () => {
      const releaseLock = vi.fn();
      mockRedis.acquireLock.mockResolvedValue(releaseLock);
      mockTaskRepo.findStale.mockRejectedValue(new Error('db error'));

      await expect(reconciler.reconcile()).rejects.toThrow('db error');

      expect(releaseLock).toHaveBeenCalled();
    });
  });

  describe('reconcileTask', () => {
    it('should skip task with no workspace_bucket', async () => {
      const task = {
        id: 'task-0',
        session_id: 'session-1',
        workspace_bucket: null,
        workspace_prefix: 'org/scope/sessions/s1/',
        status: 'running',
        created_at: new Date(Date.now() - 10 * 60 * 1000),
      };

      await reconciler.reconcileTask(task);

      expect(mockS3Send).not.toHaveBeenCalled();
      expect(mockTaskRepo.updateStatusWhere).not.toHaveBeenCalled();
    });

    it('should mark task completed when S3 status file shows completed', async () => {
      const task = {
        id: 'task-1',
        session_id: 'session-1',
        workspace_bucket: 'my-bucket',
        workspace_prefix: 'org/scope/sessions/s1/',
        status: 'running',
        created_at: new Date(Date.now() - 10 * 60 * 1000),
      };

      const statusJson = JSON.stringify({
        task_id: 'task-1',
        status: 'completed',
        finished_at: '2026-05-06T10:30:00Z',
        files_modified: ['scope-config.json'],
      });

      // First call is HeadObject (succeeds), second is GetObject
      mockS3Send
        .mockResolvedValueOnce({}) // HeadObject success
        .mockResolvedValueOnce({
          Body: { transformToString: () => Promise.resolve(statusJson) },
        });
      mockTaskRepo.updateStatusWhere.mockResolvedValue(1);

      await reconciler.reconcileTask(task as any);

      expect(mockTaskRepo.updateStatusWhere).toHaveBeenCalledWith(
        'task-1',
        'running',
        expect.objectContaining({ status: 'completed' }),
      );
      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task_completed', session_id: 'session-1' }),
      );
    });

    it('should mark task failed when S3 status file shows failed', async () => {
      const task = {
        id: 'task-4',
        session_id: 'session-1',
        workspace_bucket: 'my-bucket',
        workspace_prefix: 'org/scope/sessions/s1/',
        status: 'running',
        created_at: new Date(Date.now() - 10 * 60 * 1000),
      };

      const statusJson = JSON.stringify({
        task_id: 'task-4',
        status: 'failed',
        finished_at: '2026-05-06T10:30:00Z',
        error: 'Something went wrong',
      });

      mockS3Send
        .mockResolvedValueOnce({}) // HeadObject success
        .mockResolvedValueOnce({
          Body: { transformToString: () => Promise.resolve(statusJson) },
        });
      mockTaskRepo.updateStatusWhere.mockResolvedValue(1);

      await reconciler.reconcileTask(task as any);

      expect(mockTaskRepo.updateStatusWhere).toHaveBeenCalledWith(
        'task-4',
        'running',
        expect.objectContaining({ status: 'failed' }),
      );
      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task_failed' }),
      );
    });

    it('should not emit event if updateStatusWhere returns 0 (race condition)', async () => {
      const task = {
        id: 'task-5',
        session_id: 'session-1',
        workspace_bucket: 'my-bucket',
        workspace_prefix: 'org/scope/sessions/s1/',
        status: 'running',
        created_at: new Date(Date.now() - 10 * 60 * 1000),
      };

      const statusJson = JSON.stringify({
        task_id: 'task-5',
        status: 'completed',
        finished_at: '2026-05-06T10:30:00Z',
      });

      mockS3Send
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          Body: { transformToString: () => Promise.resolve(statusJson) },
        });
      mockTaskRepo.updateStatusWhere.mockResolvedValue(0);

      await reconciler.reconcileTask(task as any);

      expect(mockTaskRepo.updateStatusWhere).toHaveBeenCalled();
      expect(mockEventBus.emit).not.toHaveBeenCalled();
    });

    it('should mark task timeout when no S3 status and past threshold', async () => {
      const task = {
        id: 'task-2',
        session_id: 'session-1',
        workspace_bucket: 'my-bucket',
        workspace_prefix: 'org/scope/sessions/s1/',
        status: 'running',
        created_at: new Date(Date.now() - 35 * 60 * 1000), // 35 min ago
      };

      const notFoundError: any = new Error('NotFound');
      notFoundError.name = 'NotFound';
      mockS3Send.mockRejectedValueOnce(notFoundError);
      mockTaskRepo.updateStatusWhere.mockResolvedValue(1);

      await reconciler.reconcileTask(task as any);

      expect(mockTaskRepo.updateStatusWhere).toHaveBeenCalledWith(
        'task-2',
        'running',
        expect.objectContaining({ status: 'timeout' }),
      );
      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task_timeout' }),
      );
    });

    it('should skip task if within timeout threshold and no S3 status', async () => {
      const task = {
        id: 'task-3',
        session_id: 'session-1',
        workspace_bucket: 'my-bucket',
        workspace_prefix: 'org/scope/sessions/s1/',
        status: 'running',
        created_at: new Date(Date.now() - 2 * 60 * 1000), // 2 min ago
      };

      const notFoundError: any = new Error('NotFound');
      notFoundError.name = 'NotFound';
      mockS3Send.mockRejectedValueOnce(notFoundError);

      await reconciler.reconcileTask(task as any);

      expect(mockTaskRepo.updateStatusWhere).not.toHaveBeenCalled();
      expect(mockEventBus.emit).not.toHaveBeenCalled();
    });

    it('should handle S3 errors gracefully without crashing', async () => {
      const task = {
        id: 'task-6',
        session_id: 'session-1',
        workspace_bucket: 'my-bucket',
        workspace_prefix: 'org/scope/sessions/s1/',
        status: 'running',
        created_at: new Date(Date.now() - 10 * 60 * 1000),
      };

      const unknownError = new Error('NetworkError');
      unknownError.name = 'NetworkError';
      mockS3Send.mockRejectedValueOnce(unknownError);

      // Should not throw
      await reconciler.reconcileTask(task as any);

      expect(mockTaskRepo.updateStatusWhere).not.toHaveBeenCalled();
      expect(mockEventBus.emit).not.toHaveBeenCalled();
    });
  });

  describe('start/stop', () => {
    it('should start and stop the interval', () => {
      vi.useFakeTimers();

      reconciler.start();
      expect((reconciler as any).intervalHandle).not.toBeNull();

      reconciler.stop();
      expect((reconciler as any).intervalHandle).toBeNull();

      vi.useRealTimers();
    });
  });
});
