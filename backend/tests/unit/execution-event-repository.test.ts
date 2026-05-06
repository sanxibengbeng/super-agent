import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config/database.js', () => ({
  prisma: {
    execution_events: {
      create: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

import { prisma } from '../../src/config/database.js';
import { executionEventRepository } from '../../src/repositories/execution-event.repository.js';

const mockExecutionEvents = prisma.execution_events as unknown as {
  create: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
  deleteMany: ReturnType<typeof vi.fn>;
};

describe('ExecutionEventRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should create an event and return it with id', async () => {
      const input = {
        task_id: 'task-1',
        session_id: 'session-1',
        type: 'task_completed',
        payload: { files_modified: ['scope-config.json'] },
      };
      mockExecutionEvents.create.mockResolvedValue({ id: 'evt-1', ...input, created_at: new Date() });

      const result = await executionEventRepository.create(input);

      expect(result.id).toBe('evt-1');
      expect(mockExecutionEvents.create).toHaveBeenCalledWith({ data: input });
    });
  });

  describe('findAfter', () => {
    it('should return events after a given event ID for a session', async () => {
      const refEvent = { created_at: new Date('2026-05-06T10:00:00Z') };
      const laterEvents = [{ id: 'evt-6' }, { id: 'evt-7' }];

      mockExecutionEvents.findMany
        .mockResolvedValueOnce([refEvent])
        .mockResolvedValueOnce(laterEvents);

      const result = await executionEventRepository.findAfter('session-1', 'evt-5');

      expect(result).toEqual(laterEvents);
    });

    it('should return all events if afterEventId is null', async () => {
      const allEvents = [{ id: 'evt-1' }, { id: 'evt-2' }];
      mockExecutionEvents.findMany.mockResolvedValue(allEvents);

      const result = await executionEventRepository.findAfter('session-1', null);

      expect(mockExecutionEvents.findMany).toHaveBeenCalledWith({
        where: { session_id: 'session-1' },
        orderBy: { created_at: 'asc' },
      });
      expect(result).toEqual(allEvents);
    });

    it('should return all events if afterEventId not found', async () => {
      const allEvents = [{ id: 'evt-1' }];
      mockExecutionEvents.findMany
        .mockResolvedValueOnce([]) // ref not found
        .mockResolvedValueOnce(allEvents);

      const result = await executionEventRepository.findAfter('session-1', 'nonexistent');

      expect(result).toEqual(allEvents);
    });
  });

  describe('deleteOlderThan', () => {
    it('should delete events older than given date', async () => {
      mockExecutionEvents.deleteMany.mockResolvedValue({ count: 42 });

      const cutoff = new Date('2026-04-29T00:00:00Z');
      const count = await executionEventRepository.deleteOlderThan(cutoff);

      expect(count).toBe(42);
      expect(mockExecutionEvents.deleteMany).toHaveBeenCalledWith({
        where: { created_at: { lt: cutoff } },
      });
    });
  });
});
