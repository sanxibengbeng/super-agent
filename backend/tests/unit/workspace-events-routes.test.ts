import { describe, it, expect, vi, beforeEach } from 'vitest';

// Valid v4 UUIDs for testing (variant bits must be 8/9/a/b at position 19)
const SESSION_ID = 'a0000000-0000-4000-8000-000000000001';
const AFTER_EVENT_ID = 'a0000000-0000-4000-8000-000000000002';
const TASK_ID_1 = 'b0000000-0000-4000-8000-000000000001';
const TASK_ID_2 = 'b0000000-0000-4000-8000-000000000002';
const EVT_ID_1 = 'c0000000-0000-4000-8000-000000000001';
const EVT_ID_2 = 'c0000000-0000-4000-8000-000000000002';

// Use vi.hoisted so that mock objects are available in vi.mock factory functions
const mockEventRepo = vi.hoisted(() => ({
  findAfter: vi.fn(),
}));

const mockTaskRepo = vi.hoisted(() => ({
  findBySessionId: vi.fn(),
}));

vi.mock('../../src/repositories/execution-event.repository.js', () => ({
  executionEventRepository: mockEventRepo,
}));

vi.mock('../../src/repositories/execution-task.repository.js', () => ({
  executionTaskRepository: mockTaskRepo,
}));

vi.mock('../../src/middleware/auth.js', () => ({
  authenticate: vi.fn(async () => {}),
}));

import Fastify from 'fastify';
import { workspaceEventsRoutes } from '../../src/routes/workspace-events.routes.js';

describe('workspace-events routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify();
    await app.register(workspaceEventsRoutes, { prefix: '/api' });
    await app.ready();
  });

  describe('GET /api/workspace-events/recover', () => {
    it('should return missed events and summary', async () => {
      const events = [
        { id: EVT_ID_1, task_id: TASK_ID_1, session_id: SESSION_ID, type: 'task_completed', payload: {}, created_at: new Date('2026-05-01T00:00:00Z') },
        { id: EVT_ID_2, task_id: TASK_ID_2, session_id: SESSION_ID, type: 'task_failed', payload: {}, created_at: new Date('2026-05-01T00:01:00Z') },
      ];
      const tasks = [
        { id: TASK_ID_1, status: 'completed', source: 'project', started_at: new Date('2026-05-01T00:00:00Z'), completed_at: new Date('2026-05-01T00:00:30Z'), error_message: null },
      ];
      mockEventRepo.findAfter.mockResolvedValue(events);
      mockTaskRepo.findBySessionId.mockResolvedValue(tasks);

      const response = await app.inject({
        method: 'GET',
        url: `/api/workspace-events/recover?session_id=${SESSION_ID}&after_event_id=${AFTER_EVENT_ID}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.missed_events).toHaveLength(2);
      expect(body.missed_events[0].created_at).toBe('2026-05-01T00:00:00.000Z');
      expect(body.summary.completed_count).toBe(1);
      expect(body.summary.failed_count).toBe(1);
      expect(body.summary.failed_task_ids).toContain(TASK_ID_2);
    });

    it('should return null summary when no completion/failure events missed', async () => {
      mockEventRepo.findAfter.mockResolvedValue([]);
      mockTaskRepo.findBySessionId.mockResolvedValue([]);

      const response = await app.inject({
        method: 'GET',
        url: `/api/workspace-events/recover?session_id=${SESSION_ID}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.missed_events).toHaveLength(0);
      expect(body.current_tasks).toHaveLength(0);
      expect(body.summary).toBeNull();
    });

    it('should count task_timeout events as failures', async () => {
      const events = [
        { id: EVT_ID_1, task_id: TASK_ID_1, session_id: SESSION_ID, type: 'task_timeout', payload: {}, created_at: new Date('2026-05-01T00:00:00Z') },
      ];
      mockEventRepo.findAfter.mockResolvedValue(events);
      mockTaskRepo.findBySessionId.mockResolvedValue([]);

      const response = await app.inject({
        method: 'GET',
        url: `/api/workspace-events/recover?session_id=${SESSION_ID}`,
      });

      const body = JSON.parse(response.payload);
      expect(body.summary.failed_count).toBe(1);
      expect(body.summary.failed_task_ids).toContain(TASK_ID_1);
    });

    it('should call repositories with correct arguments', async () => {
      mockEventRepo.findAfter.mockResolvedValue([]);
      mockTaskRepo.findBySessionId.mockResolvedValue([]);

      await app.inject({
        method: 'GET',
        url: `/api/workspace-events/recover?session_id=${SESSION_ID}&after_event_id=${AFTER_EVENT_ID}`,
      });

      expect(mockEventRepo.findAfter).toHaveBeenCalledWith(
        SESSION_ID,
        AFTER_EVENT_ID,
      );
      expect(mockTaskRepo.findBySessionId).toHaveBeenCalledWith(
        SESSION_ID,
      );
    });

    it('should pass null when after_event_id is not provided', async () => {
      mockEventRepo.findAfter.mockResolvedValue([]);
      mockTaskRepo.findBySessionId.mockResolvedValue([]);

      await app.inject({
        method: 'GET',
        url: `/api/workspace-events/recover?session_id=${SESSION_ID}`,
      });

      expect(mockEventRepo.findAfter).toHaveBeenCalledWith(
        SESSION_ID,
        null,
      );
    });
  });
});
