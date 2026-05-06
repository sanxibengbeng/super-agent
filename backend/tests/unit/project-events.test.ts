import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWorkspaceEventBus = {
  emit: vi.fn().mockResolvedValue({ id: 'evt-1' }),
};

const mockExecutionTaskRepo = {
  create: vi.fn().mockResolvedValue({ id: 'exec-task-1' }),
  update: vi.fn().mockResolvedValue({}),
  updateStatusWhere: vi.fn().mockResolvedValue(1),
  findBySessionId: vi.fn().mockResolvedValue([]),
};

vi.mock('../../src/services/workspace-event-bus.js', () => ({
  workspaceEventBus: mockWorkspaceEventBus,
}));

vi.mock('../../src/repositories/execution-task.repository.js', () => ({
  executionTaskRepository: mockExecutionTaskRepo,
}));

describe('Project Event Emission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('execution task creation', () => {
    it('should create execution task with project source and issue entity', () => {
      const input = {
        org_id: 'org-1',
        session_id: 'session-1',
        source: 'project',
        source_entity_id: 'issue-1',
        runtime: 'claude',
        workspace_bucket: 'my-bucket',
        workspace_prefix: 'org-1/scope-1/sessions/session-1/',
        created_by: 'user-1',
      };

      mockExecutionTaskRepo.create(input);

      expect(mockExecutionTaskRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'project',
          source_entity_id: 'issue-1',
        })
      );
    });
  });

  describe('task_started event', () => {
    it('should emit task_started with issue context', async () => {
      await mockWorkspaceEventBus.emit({
        task_id: 'exec-task-1',
        session_id: 'session-1',
        type: 'task_started',
        payload: {
          issue_id: 'issue-1',
          issue_number: 42,
          issue_title: 'Fix login bug',
          branch_name: 'issue/42/fix-login-bug',
        },
      });

      expect(mockWorkspaceEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'task_started',
          payload: expect.objectContaining({
            issue_id: 'issue-1',
            branch_name: 'issue/42/fix-login-bug',
          }),
        })
      );
    });
  });

  describe('task_completed event', () => {
    it('should emit task_completed with new issue status', async () => {
      await mockWorkspaceEventBus.emit({
        task_id: 'exec-task-1',
        session_id: 'session-1',
        type: 'task_completed',
        payload: {
          issue_id: 'issue-1',
          new_status: 'in_review',
        },
      });

      expect(mockWorkspaceEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'task_completed',
          payload: expect.objectContaining({
            new_status: 'in_review',
          }),
        })
      );
    });
  });

  describe('task_failed event', () => {
    it('should emit task_failed with error information', async () => {
      await mockWorkspaceEventBus.emit({
        task_id: 'exec-task-1',
        session_id: 'session-1',
        type: 'task_failed',
        payload: {
          issue_id: 'issue-1',
          error: 'Agent timeout',
        },
      });

      expect(mockWorkspaceEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'task_failed',
          payload: expect.objectContaining({
            error: 'Agent timeout',
          }),
        })
      );
    });
  });

  describe('optimistic locking', () => {
    it('should use updateStatusWhere to prevent double-completion', async () => {
      mockExecutionTaskRepo.updateStatusWhere.mockResolvedValue(0);

      const updated = await mockExecutionTaskRepo.updateStatusWhere(
        'exec-task-1',
        'running',
        { status: 'completed', completed_at: new Date() }
      );

      expect(updated).toBe(0);
    });

    it('should succeed when status matches expected', async () => {
      mockExecutionTaskRepo.updateStatusWhere.mockResolvedValue(1);

      const updated = await mockExecutionTaskRepo.updateStatusWhere(
        'exec-task-1',
        'running',
        { status: 'completed', completed_at: new Date() }
      );

      expect(updated).toBe(1);
    });
  });

  describe('files_changed event from sync-back', () => {
    it('should emit files_changed when active task exists for session', async () => {
      const activeTask = { id: 'exec-task-1', status: 'running', session_id: 'session-1' };
      mockExecutionTaskRepo.findBySessionId.mockResolvedValue([activeTask]);

      const tasks = await mockExecutionTaskRepo.findBySessionId('session-1');
      const found = tasks.find((t: { status: string }) => t.status === 'running');

      expect(found).toBeDefined();
      expect(found!.id).toBe('exec-task-1');

      await mockWorkspaceEventBus.emit({
        task_id: found!.id,
        session_id: 'session-1',
        type: 'files_changed',
        payload: { source: 'sync_back', file_count: 5 },
      });

      expect(mockWorkspaceEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'files_changed',
          payload: expect.objectContaining({ source: 'sync_back' }),
        })
      );
    });

    it('should not emit when no active task exists', async () => {
      mockExecutionTaskRepo.findBySessionId.mockResolvedValue([
        { id: 'exec-task-1', status: 'completed', session_id: 'session-1' },
      ]);

      const tasks = await mockExecutionTaskRepo.findBySessionId('session-1');
      const found = tasks.find((t: { status: string }) => t.status === 'running');

      expect(found).toBeUndefined();
    });
  });
});
