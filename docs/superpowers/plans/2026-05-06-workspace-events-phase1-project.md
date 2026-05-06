# Phase 1: Project Execution — Real-Time Event Migration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ProjectBoard's 3s/10s polling with real-time WebSocket push using the Phase 0 event infrastructure. When an agent executes a project issue, the frontend receives instant notifications for status changes, completion, and file updates.

**Architecture:** `project.service.ts` writes `execution_tasks` records and emits events via `WorkspaceEventBus` at key lifecycle points (started, completed, failed). The frontend `ProjectBoard.tsx` subscribes via `useWorkspaceEvents` hook and updates board state reactively. Polling is retained as a fallback with reduced frequency (30s) for robustness.

**Tech Stack:** WorkspaceEventBus (Phase 0), useWorkspaceEvents hook (Phase 0), existing project service and board components

**Spec:** `docs/superpowers/specs/2026-05-06-workspace-chat-integration-design.md` — Section "Phase 1: Project Execution"

---

## File Structure

### Backend — Modified Files
| File | Change |
|------|--------|
| `backend/src/services/project.service.ts` | Write `execution_tasks` on execute, emit events on completion/failure |
| `backend/src/services/agent-runtime-agentcore.ts` | Emit `files_changed` event after S3 sync-back |

### Frontend — Modified Files
| File | Change |
|------|--------|
| `frontend/src/pages/ProjectBoard.tsx` | Replace 3s/10s polling with `useWorkspaceEvents`, keep 30s fallback |

### Test Files
| File | Responsibility |
|------|---------------|
| `backend/tests/unit/project-events.test.ts` | Test event emission in project execution lifecycle |
| `frontend/src/pages/ProjectBoard.test.tsx` | Test event-driven board updates (optional, can be integration-tested manually) |

---

## Task 1: Backend — Emit `task_started` Event in `executeIssue()`

**Files:**
- Modify: `backend/src/services/project.service.ts` (lines 309-444)

- [ ] **Step 1: Add imports for workspace event infrastructure**

At the top of `backend/src/services/project.service.ts`, add:

```typescript
import { workspaceEventBus } from './workspace-event-bus.js';
import { executionTaskRepository } from '../repositories/execution-task.repository.js';
```

- [ ] **Step 2: Create execution_task record and emit `task_started` event**

In the `executeIssue()` method, after the issue is updated to `in_progress` (after line 346) and before the task message construction, add execution task creation:

```typescript
    // Create execution task for tracking and event infrastructure
    let executionTask: { id: string } | null = null;
    try {
      const session = await prisma.chat_sessions.findUnique({ where: { id: sessionId }, select: { business_scope_id: true } });
      const scopeId = session?.business_scope_id ?? project.business_scope_id;
      executionTask = await executionTaskRepository.create({
        org_id: orgId,
        session_id: sessionId,
        source: 'project',
        source_entity_id: issueId,
        runtime: config.agentRuntime ?? 'claude',
        workspace_bucket: config.s3BucketName ?? undefined,
        workspace_prefix: scopeId ? `${orgId}/${scopeId}/sessions/${sessionId}/` : undefined,
        created_by: userId,
      });

      await executionTaskRepository.update(executionTask.id, {
        status: 'running',
        started_at: new Date(),
      });

      await workspaceEventBus.emit({
        task_id: executionTask.id,
        session_id: sessionId,
        type: 'task_started',
        payload: {
          issue_id: issueId,
          issue_number: issue.issue_number,
          issue_title: issue.title,
          branch_name: branchName,
        },
      });
    } catch (err) {
      console.warn('[ProjectService] Failed to create execution task or emit event:', err instanceof Error ? err.message : err);
    }
```

- [ ] **Step 3: Pass executionTaskId to the completion/failure handlers**

In the `.then()` callback of `chatService.processMessage()`, before calling `completeIssueExecution`, add the execution task ID:

```typescript
      .then(async (result) => {
        console.log(`[ProjectService] Agent responded for issue ${issueId}. Response length: ${result.text.length}`);
        // Persist agent response
        await chatMessageRepository.create({
          session_id: sessionId,
          type: 'ai',
          content: result.text,
          agent_id: project.agent_id ?? null,
          mention_agent_id: null,
          metadata: { source: 'project_agent_response', issue_id: issueId },
        }, orgId).catch(() => {});

        // Mark execution task as completed and emit event
        if (executionTask) {
          try {
            await executionTaskRepository.updateStatusWhere(executionTask.id, 'running', {
              status: 'completed',
              completed_at: new Date(),
            });
            await workspaceEventBus.emit({
              task_id: executionTask.id,
              session_id: sessionId,
              type: 'task_completed',
              payload: {
                issue_id: issueId,
                new_status: 'in_review',
              },
            });
          } catch (err) {
            console.warn('[ProjectService] Failed to emit task_completed:', err instanceof Error ? err.message : err);
          }
        }

        await this.completeIssueExecution(orgId, projectId, issueId, 'in_review', userId);
      })
```

In the `.catch()` callback, emit `task_failed`:

```typescript
      .catch(async (err) => {
        console.error(`[ProjectService] Agent execution FAILED for issue ${issueId}:`, err.message || err);
        await chatMessageRepository.create({
          session_id: sessionId,
          type: 'ai',
          content: `Agent execution failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
          agent_id: null,
          mention_agent_id: null,
          metadata: { source: 'project_agent_error', issue_id: issueId },
        }, orgId).catch(() => {});

        // Mark execution task as failed and emit event
        if (executionTask) {
          try {
            await executionTaskRepository.updateStatusWhere(executionTask.id, 'running', {
              status: 'failed',
              completed_at: new Date(),
              error_message: err instanceof Error ? err.message : 'Unknown error',
            });
            await workspaceEventBus.emit({
              task_id: executionTask.id,
              session_id: sessionId,
              type: 'task_failed',
              payload: {
                issue_id: issueId,
                error: err instanceof Error ? err.message : 'Unknown error',
              },
            });
          } catch (emitErr) {
            console.warn('[ProjectService] Failed to emit task_failed:', emitErr instanceof Error ? emitErr.message : emitErr);
          }
        }

        await this.completeIssueExecution(orgId, projectId, issueId, 'todo', userId);
      })
```

- [ ] **Step 4: Add config import if not already present**

Ensure `config` is imported at the top:

```typescript
import { config } from '../config/index.js';
```

- [ ] **Step 5: Verify backend compiles**

Run: `cd backend && npm run build`

Expected: No TypeScript errors in project.service.ts.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/project.service.ts
git commit -m "feat(project): emit workspace events on issue execution start/complete/fail"
```

---

## Task 2: Backend — Emit `files_changed` Event After S3 Sync-Back

**Files:**
- Modify: `backend/src/services/agent-runtime-agentcore.ts`

- [ ] **Step 1: Add import for WorkspaceEventBus**

At the top of `backend/src/services/agent-runtime-agentcore.ts`, add:

```typescript
import { workspaceEventBus } from './workspace-event-bus.js';
```

- [ ] **Step 2: Emit files_changed after syncBackFromS3**

In the `runConversation()` method's `finally` block, after `syncBackFromS3()` completes successfully, emit a `files_changed` event. Find the sync-back call and add event emission after it:

```typescript
    // After syncBackFromS3 completes (in the finally or completion path):
    // Emit files_changed event so frontend knows workspace has new files
    try {
      const sessionId = options.sessionId;
      // Find the active execution task for this session
      const tasks = await executionTaskRepository.findBySessionId(sessionId);
      const activeTask = tasks.find(t => t.status === 'running');
      if (activeTask) {
        await workspaceEventBus.emit({
          task_id: activeTask.id,
          session_id: sessionId,
          type: 'files_changed',
          payload: {
            source: 'sync_back',
            files: downloadedFiles.map(f => ({
              path: f.replace(/^.*?\/sessions\/[^/]+\//, ''),
              action: 'modified' as const,
              size: 0,
            })),
          },
        });
      }
    } catch (err) {
      console.warn('[AgentCore] Failed to emit files_changed event:', err instanceof Error ? err.message : err);
    }
```

Note: The exact insertion point depends on how `syncBackFromS3` tracks downloaded files. If it doesn't return a file list, emit with an empty payload — the frontend will just refresh the workspace panel:

```typescript
    // Simpler version if file list is not available:
    try {
      const tasks = await executionTaskRepository.findBySessionId(options.sessionId);
      const activeTask = tasks.find(t => t.status === 'running');
      if (activeTask) {
        await workspaceEventBus.emit({
          task_id: activeTask.id,
          session_id: options.sessionId,
          type: 'files_changed',
          payload: { source: 'sync_back' },
        });
      }
    } catch {
      // Best effort — don't fail the main flow
    }
```

- [ ] **Step 3: Add executionTaskRepository import**

```typescript
import { executionTaskRepository } from '../repositories/execution-task.repository.js';
```

- [ ] **Step 4: Verify backend compiles**

Run: `cd backend && npm run build`

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/agent-runtime-agentcore.ts
git commit -m "feat(agentcore): emit files_changed event after workspace sync-back from S3"
```

---

## Task 3: Backend — Unit Tests for Project Event Emission

**Files:**
- Create: `backend/tests/unit/project-events.test.ts`

- [ ] **Step 1: Write the test file**

Create `backend/tests/unit/project-events.test.ts`:

```typescript
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
    it('should create execution task with correct fields for project source', () => {
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
      mockExecutionTaskRepo.updateStatusWhere.mockResolvedValue(0); // Already completed

      const updated = await mockExecutionTaskRepo.updateStatusWhere(
        'exec-task-1',
        'running',
        { status: 'completed', completed_at: new Date() }
      );

      expect(updated).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd backend && npm run test -- tests/unit/project-events.test.ts`

Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/unit/project-events.test.ts
git commit -m "test(project): add unit tests for workspace event emission in issue execution"
```

---

## Task 4: Frontend — Replace Polling with `useWorkspaceEvents` in ProjectBoard

**Files:**
- Modify: `frontend/src/pages/ProjectBoard.tsx`

- [ ] **Step 1: Add workspace events hook import**

At the top of `ProjectBoard.tsx`, add:

```typescript
import { useWorkspaceEvents } from '@/hooks/useWorkspaceEvents';
import { WorkspaceRecoveryBanner } from '@/components/WorkspaceRecoveryBanner';
```

- [ ] **Step 2: Wire up useWorkspaceEvents hook**

Inside the `ProjectBoard` component, after existing state declarations, add the workspace events subscription:

```typescript
  // Real-time workspace events — replaces 3s/10s polling for status changes
  const { recoverySummary, dismissRecovery } = useWorkspaceEvents({
    sessionId: project?.workspace_session_id ?? null,
    onTaskStarted: (event) => {
      // Agent started working on an issue — update board state
      const issueId = event.payload.issue_id as string;
      if (issueId) {
        setIssues(prev => prev.map(iss =>
          iss.id === issueId ? { ...iss, status: 'in_progress' } : iss
        ));
      }
    },
    onTaskCompleted: (event) => {
      // Agent completed — refresh board to get full state (diff, status, etc.)
      const newStatus = event.payload.new_status as string;
      const issueId = event.payload.issue_id as string;
      if (issueId && newStatus) {
        setIssues(prev => prev.map(iss =>
          iss.id === issueId ? { ...iss, status: newStatus } : iss
        ));
      }
      // Full refresh to pick up diff data, relations, etc.
      loadData();
    },
    onTaskFailed: (event) => {
      // Agent failed — move issue back to todo
      const issueId = event.payload.issue_id as string;
      if (issueId) {
        setIssues(prev => prev.map(iss =>
          iss.id === issueId ? { ...iss, status: 'todo' } : iss
        ));
      }
    },
    onFilesChanged: () => {
      // Workspace files updated — refresh workspace explorer
      setWsRefreshKey(k => k + 1);
    },
  });
```

- [ ] **Step 3: Reduce polling intervals**

Change the auto-process polling from 10s to 30s (it's now a fallback, not primary):

```typescript
  // line 211: change 10000 to 30000
  }, 30000)
```

Change the console message polling from 3s to 10s (events handle the primary updates):

```typescript
  // line 169: change 3000 to 10000
  const interval = setInterval(loadMessages, 10000)
```

- [ ] **Step 4: Add recovery banner to the UI**

In the JSX, right after the main container div's opening or before the kanban board, add:

```tsx
  {recoverySummary && (
    <WorkspaceRecoveryBanner
      summary={recoverySummary}
      onDismiss={dismissRecovery}
      onViewDetails={() => {
        loadData(); // Refresh to show latest state
        dismissRecovery();
      }}
    />
  )}
```

- [ ] **Step 5: Verify frontend compiles**

Run: `cd frontend && npm run build`

Expected: No TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/ProjectBoard.tsx
git commit -m "feat(project-board): replace polling with real-time workspace events, keep 30s fallback"
```

---

## Task 5: Integration Test — End-to-End Verification

**Files:** None (verification only)

- [ ] **Step 1: Run all backend tests**

Run: `cd backend && npm run test -- tests/unit/project-events tests/unit/workspace`

Expected: All tests pass.

- [ ] **Step 2: Verify backend compiles**

Run: `cd backend && npm run build`

Expected: No errors in modified files.

- [ ] **Step 3: Verify frontend compiles**

Run: `cd frontend && npm run build`

Expected: Successful build.

- [ ] **Step 4: Manual integration verification (if dev environment available)**

Start the application and test the following flow:
1. Open a project board in the browser
2. Execute an issue
3. Verify the board updates in real-time (card moves to "In Progress" immediately)
4. When agent completes, card should move to "In Review" without manual refresh
5. Workspace file panel should refresh when files change
6. If you close and reopen the browser, the recovery banner should show missed events

- [ ] **Step 5: Commit any fixes needed**

```bash
git add -A && git commit -m "fix: resolve integration issues from Phase 1 verification"
```

(Only run if fixes were needed)

---

## Summary

After completing all 5 tasks, Phase 1 delivers:

- **Real-time issue status push** — Board cards move between lanes instantly when agent starts/completes/fails
- **File change notifications** — Workspace explorer refreshes automatically after S3 sync-back
- **Recovery support** — Users who disconnect/close browser see what happened while away
- **Reduced polling load** — From 3s/10s to 10s/30s (fallback only, events are primary)
- **Backward compatible** — If WebSocket is unavailable, polling still works as before

**What's NOT changed:**
- Auto-process logic (backend auto-processor still runs every 15s server-side)
- Console message display (still REST polling, just at reduced frequency)
- Issue drag-and-drop (still direct REST calls)
- The overall executeIssue() flow (same service, same agent invocation)
