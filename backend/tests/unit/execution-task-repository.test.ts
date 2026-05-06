import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config/database.js', () => ({
  prisma: {
    execution_tasks: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { prisma } from '../../src/config/database.js';
import { executionTaskRepository } from '../../src/repositories/execution-task.repository.js';

const mockExecutionTasks = prisma.execution_tasks as unknown as {
  create: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

describe('ExecutionTaskRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should create an execution task', async () => {
      const input = {
        org_id: 'org-1',
        session_id: 'session-1',
        source: 'project',
        runtime: 'agentcore',
        created_by: 'user-1',
      };
      mockExecutionTasks.create.mockResolvedValue({ id: 'task-1', ...input, status: 'pending' });

      const result = await executionTaskRepository.create(input);

      expect(mockExecutionTasks.create).toHaveBeenCalledWith({ data: input });
      expect(result.id).toBe('task-1');
      expect(result.status).toBe('pending');
    });
  });

  describe('findStale', () => {
    it('should find tasks in running state older than threshold', async () => {
      const staleTasks = [{ id: 'task-1', status: 'running' }];
      mockExecutionTasks.findMany.mockResolvedValue(staleTasks);

      const result = await executionTaskRepository.findStale(5 * 60 * 1000);

      expect(mockExecutionTasks.findMany).toHaveBeenCalledWith({
        where: {
          status: 'running',
          updated_at: { lt: expect.any(Date) },
        },
      });
      expect(result).toEqual(staleTasks);
    });
  });

  describe('updateStatusWhere', () => {
    it('should only update task if current status matches', async () => {
      mockExecutionTasks.updateMany.mockResolvedValue({ count: 1 });

      const updated = await executionTaskRepository.updateStatusWhere(
        'task-1',
        'running',
        { status: 'completed', completed_at: new Date() }
      );

      expect(updated).toBe(1);
      expect(mockExecutionTasks.updateMany).toHaveBeenCalledWith({
        where: { id: 'task-1', status: 'running' },
        data: expect.objectContaining({ status: 'completed' }),
      });
    });

    it('should return 0 if status does not match', async () => {
      mockExecutionTasks.updateMany.mockResolvedValue({ count: 0 });

      const updated = await executionTaskRepository.updateStatusWhere(
        'task-1',
        'running',
        { status: 'completed', completed_at: new Date() }
      );

      expect(updated).toBe(0);
    });
  });

  describe('findBySessionId', () => {
    it('should return tasks for a session ordered by creation', async () => {
      const tasks = [{ id: 'task-2' }, { id: 'task-1' }];
      mockExecutionTasks.findMany.mockResolvedValue(tasks);

      const result = await executionTaskRepository.findBySessionId('session-1');

      expect(mockExecutionTasks.findMany).toHaveBeenCalledWith({
        where: { session_id: 'session-1' },
        orderBy: { created_at: 'desc' },
      });
      expect(result).toEqual(tasks);
    });
  });
});
