# Workspace-Chat Integration: Unified Event Architecture

## Summary

Design a unified workspace-chat synchronization layer that decouples frontend, backend, and AgentCore runtime. Any of the three can independently fail and recover without losing state. The architecture introduces a WorkspaceEventBus as the central event coordination point, backed by database persistence and Redis pub/sub for multi-instance deployment.

## Goals

1. **Unified abstraction** — Single workspace-chat sync protocol across Scope Copilot, Workflow, and Project
2. **Real-time push** — Replace polling with WebSocket event push for all scenarios
3. **Three-endpoint fault tolerance** — Browser close, backend restart, AgentCore crash all recoverable
4. **Consistent state** — DB records intent, S3 records results, reconciler ensures convergence
5. **Gradual migration** — New infrastructure first, then migrate scenarios one by one with feature flags

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Migration strategy | Gradual (Phase 0-4) | Reduce risk, validate per-scenario |
| File change notification | Full push, frontend filters | Maximum flexibility, backend stays generic |
| State persistence | DB intent + S3 result + reconciliation | No single point of failure |
| Frontend recovery UX | Silent restore + explicit notification banner | User knows what happened without being overwhelmed |
| Real-time channel | SSE for streaming text + WebSocket for discrete events | Each protocol used for its strength |
| Multi-instance broadcast | Redis pub/sub | Already have Redis infra, low latency, simple |

## Architecture Overview

```
┌──────────────┐    SSE stream     ┌───────────────────────────┐    WebSocket     ┌──────────────┐
│  AgentCore   │ ─────────────────→│         Backend           │ ────────────────→│   Frontend   │
│  Container   │                   │                           │                  │              │
└──────┬───────┘                   │  ┌─────────────────────┐  │                  │  useWorkspace │
       │                           │  │  WorkspaceEventBus  │  │                  │  Events hook │
       │ S3 sync                   │  └──────────┬──────────┘  │                  │  (per scene  │
       ▼                           │             │             │                  │   filters)   │
┌──────────────┐                   │     ┌───────┼───────┐     │                  └──────────────┘
│     S3       │                   │     ▼       ▼       ▼     │
│  workspace/  │◄──── sync-back ───│   DB     Redis    WS     │
│  __executions__/                 │  persist  pub/sub  push   │
└──────────────┘                   └───────────────────────────┘
```

## Section 1: Execution Task State Machine + Data Model

### New Table: `execution_tasks`

Records every execution intent. This is the reconciliation baseline — written before AgentCore invocation.

```sql
CREATE TABLE execution_tasks (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id),
  session_id          UUID NOT NULL REFERENCES chat_sessions(id),

  -- Scenario identification
  source              VARCHAR(30) NOT NULL,  -- 'scope_copilot' | 'workflow' | 'project' | 'twin_session'
  source_entity_id    UUID,                  -- scope_id / workflow_id / project_id

  -- Runtime engine
  runtime             VARCHAR(20) NOT NULL,  -- 'claude' | 'agentcore'
  runtime_session_id  VARCHAR(100),          -- AgentCore session ID (sticky routing)

  -- S3 workspace coordinates
  workspace_bucket    VARCHAR(200),
  workspace_prefix    VARCHAR(500),

  -- State machine
  status              VARCHAR(20) NOT NULL DEFAULT 'pending',
  -- pending → running → completed | failed | timeout
  -- pending → cancelled

  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  error_message       TEXT,

  -- Metadata
  created_by          UUID REFERENCES profiles(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_execution_tasks_session ON execution_tasks(session_id);
CREATE INDEX idx_execution_tasks_status ON execution_tasks(status) WHERE status = 'running';
```

### State Machine

```
         Create task
            │
            ▼
        ┌─────────┐
        │ pending  │
        └────┬────┘
             │ AgentCore invocation succeeds
             ▼
        ┌─────────┐     Backend restart reconcile
        │ running  │◄────── (DB=running + S3=completed → compensate)
        └────┬────┘
             │
     ┌───────┼───────┐
     │       │       │
     ▼       ▼       ▼
┌────────┐ ┌──────┐ ┌─────────┐
│completed│ │failed│ │ timeout │
└────────┘ └──────┘ └─────────┘
```

### S3 Execution Status Files

Per-task status files under `__executions__/` directory (namespaced by task ID to support multi-turn conversations):

```
{orgId}/{scopeId}/sessions/{sessionId}/
├── workspace/                    # Working files (accumulate across turns)
│   ├── scope-config.json
│   ├── drafts/
│   └── ...
└── __executions__/               # Per-task independent status
    ├── {taskId-1}.json
    ├── {taskId-2}.json
    └── {taskId-3}.json
```

Each `{taskId}.json`:

```json
{
  "task_id": "uuid-xxx",
  "status": "completed",
  "started_at": "2026-05-06T10:28:00Z",
  "finished_at": "2026-05-06T10:30:00Z",
  "error": null,
  "files_modified": ["scope-config.json", "drafts/agent-billing.md"]
}
```

### Three-Layer Status Write Guarantee

No single writer is guaranteed to succeed. Three layers ensure convergence:

| Layer | Writer | Covers | Doesn't cover |
|-------|--------|--------|---------------|
| 1 | AgentCore container (`workspace-sync.ts` final step) | Normal completion, code-level errors | OOM/kill, microVM crash |
| 2 | Backend (on SSE `result`/`error` event) | Normal completion + container didn't write | Backend restart, SSE disconnect |
| 3 | Reconciler (timeout scan) | Everything above | — (final fallback) |

Container writes status in `syncWorkspaceToS3()`:
```
try {
  Execute Claude Agent
  syncWorkspaceToS3()  // includes writing __executions__/{taskId}.json = completed
} catch (error) {
  Write __executions__/{taskId}.json = {status: "failed", error: error.message}
  Upload to S3
} finally {
  // Even if status write fails, Layer 2 and 3 will cover
}
```

## Section 2: WorkspaceEventBus + WebSocket Event Push

### WorkspaceEventBus Service

Single backend service coordinating all event emission:

```typescript
// backend/src/services/workspace-event-bus.ts

interface WorkspaceEvent {
  id: string;                     // Unique event ID
  task_id: string;                // FK to execution_tasks
  session_id: string;             // Chat session
  timestamp: string;
  type: WorkspaceEventType;
  payload: Record<string, unknown>;
}

type WorkspaceEventType =
  | 'task_started'
  | 'task_completed'
  | 'task_failed'
  | 'task_timeout'
  | 'files_changed'              // Full list of changed files pushed
  | 'heartbeat';
```

### Event Persistence Table: `execution_events`

```sql
CREATE TABLE execution_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     UUID NOT NULL REFERENCES execution_tasks(id),
  session_id  UUID NOT NULL REFERENCES chat_sessions(id),
  type        VARCHAR(30) NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_execution_events_session_time
  ON execution_events(session_id, created_at);
```

### Event Bus Implementation

```typescript
class WorkspaceEventBus {
  constructor(
    private eventRepo: ExecutionEventRepository,
    private wsGateway: WorkspaceWebSocketGateway,
    private redis: RedisService,
  ) {
    // Subscribe to events from other instances
    this.redis.psubscribe('workspace:events:*', (channel, message) => {
      const event = JSON.parse(message);
      this.wsGateway.broadcastToLocal(event.session_id, event);
    });
  }

  async emit(event: Omit<WorkspaceEvent, 'id'>) {
    // 1. Persist to DB (for disconnect recovery)
    const saved = await this.eventRepo.create(event);

    // 2. Push to local WebSocket connections
    this.wsGateway.broadcastToLocal(event.session_id, saved);

    // 3. Broadcast to other instances via Redis pub/sub
    await this.redis.publish(
      `workspace:events:${event.session_id}`,
      JSON.stringify(saved)
    );
  }
}
```

### WebSocket Channel Design

Unified endpoint `/ws/workspace` with subscription model:

```typescript
// Client subscribes
ws.send({ type: 'subscribe', session_id: 'xxx', token: 'jwt-xxx' })

// Server pushes events
ws.receive → { type: 'workspace_event', event: WorkspaceEvent }

// Client unsubscribes
ws.send({ type: 'unsubscribe', session_id: 'xxx' })
```

One WebSocket connection supports multiple session subscriptions (user has multiple tabs/panels open).

### Multi-Instance Broadcasting via Redis Pub/Sub

```
          Instance A                          Instance B
     ┌─────────────────┐               ┌─────────────────┐
     │ WorkspaceEventBus│               │ WorkspaceEventBus│
     │       │         │               │       │         │
     │       ▼         │               │       ▼         │
     │  Local WS       │               │  Local WS       │
     │  clients        │               │  clients        │
     └───────┬─────────┘               └───────┬─────────┘
             │                                 │
             ▼                                 ▼
     ┌─────────────────────────────────────────────────┐
     │              Redis Pub/Sub                       │
     │   Channel: workspace:events:{session_id}        │
     └─────────────────────────────────────────────────┘
```

### Event Trigger Points

| Source | Timing | Event Emitted |
|--------|--------|---------------|
| Backend initiates AgentCore call | After call succeeds | `task_started` |
| AgentCore SSE `result` event received | Execution ends | Triggers S3 sync-back |
| S3 sync-back completes | Files downloaded | `files_changed` + `task_completed` |
| AgentCore SSE `error` event | Execution error | `task_failed` |
| Reconciler detects timeout | Periodic scan | `task_timeout` |

### Streaming Text Stays on SSE

Chat streaming content (`assistant` content blocks) remains on per-request SSE. Rationale:
- High volume, high frequency — DB persistence per chunk is wasteful
- SSE request-response model naturally maps to "one conversation turn"
- Content is flushed to `chat_messages` table periodically; disconnect recovery reads from DB

EventBus handles only discrete state events and file change notifications.

### Changes to Existing Code

| Existing Component | Change |
|--------------------|--------|
| `execution.gateway.ts` | Extend into `WorkspaceWebSocketGateway`, add session-level subscriptions |
| `event-websocket-bridge.ts` | Route through EventBus instead of direct gateway calls |
| `redis.service.ts` | Add pub/sub capability (currently only locks) |
| WebSocket route | Add JWT authentication (currently none) |

## Section 3: Frontend Unified Subscription and Recovery

### Core Hook: `useWorkspaceEvents`

```typescript
// frontend/src/hooks/useWorkspaceEvents.ts

interface UseWorkspaceEventsOptions {
  sessionId: string | null;
  onFilesChanged?: (files: FileChange[]) => void;
  onTaskStarted?: (task: TaskEvent) => void;
  onTaskCompleted?: (task: TaskEvent) => void;
  onTaskFailed?: (task: TaskEvent) => void;
  onTaskTimeout?: (task: TaskEvent) => void;
}

interface FileChange {
  path: string;
  content: string;
  action: 'created' | 'modified' | 'deleted';
}

function useWorkspaceEvents(options: UseWorkspaceEventsOptions): {
  connected: boolean;
  reconnecting: boolean;
  missedEvents: WorkspaceEvent[];
}
```

### Per-Scenario Filtering

Each scenario subscribes to the same event stream but filters for its own files:

```typescript
// Scope Copilot — cares about scope-config.json and scope-integrations.json
useWorkspaceEvents({
  sessionId,
  onFilesChanged: (files) => {
    const scopeConfig = files.find(f => f.path === 'scope-config.json');
    if (scopeConfig) applyFullConfig(JSON.parse(scopeConfig.content));

    const integrations = files.find(f => f.path === 'scope-integrations.json');
    if (integrations) applyIntegrations(JSON.parse(integrations.content));
  },
});

// Workflow — cares about workflow.json and node execution states
useWorkspaceEvents({
  sessionId,
  onFilesChanged: (files) => {
    const wf = files.find(f => f.path === 'workflow.json');
    if (wf) onGenerateWorkflow(parseWorkflowPlan(wf.content));
  },
  onTaskStarted: (task) => setNodeState(task.id, 'executing'),
  onTaskCompleted: (task) => setNodeState(task.id, 'finish'),
});

// Project — cares about diffs, actions, and task completion
useWorkspaceEvents({
  sessionId,
  onFilesChanged: (files) => {
    const actions = files.find(f => f.path.startsWith('actions/'));
    if (actions) refreshActionList();
  },
  onTaskCompleted: () => refreshIssueBoard(),
  onTaskFailed: (task) => showRetryOption(task),
});
```

### WebSocket Connection Manager: `WorkspaceSocketClient`

Singleton managing the persistent connection:

```typescript
// frontend/src/services/workspaceSocketClient.ts

class WorkspaceSocketClient {
  private ws: WebSocket | null;
  private subscriptions: Map<string, Set<EventHandler>>;  // sessionId → handlers
  private lastEventIds: Map<string, string>;              // sessionId → last seen event ID
  private reconnectAttempt: number;

  subscribe(sessionId: string, handler: EventHandler): Unsubscribe;
  unsubscribe(sessionId: string): void;

  private connect(): void;
  private reconnect(): void;          // Exponential backoff
  private recoverMissedEvents(sessionId: string): Promise<void>;
}
```

### Disconnect Recovery Flow

```
Browser closed / network disconnect
         │
         │  User reopens page
         ▼
┌─────────────────────────────┐
│ 1. Establish WebSocket      │
│ 2. Read lastEventId from    │
│    localStorage per session │
│ 3. Call recovery API        │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ GET /api/workspace-events/recover       │
│   ?session_id=xxx                       │
│   &after_event_id=last-seen-id          │
│                                         │
│ Response: {                             │
│   missed_events: WorkspaceEvent[],      │
│   current_tasks: ExecutionTask[],       │
│   notification: string | null           │
│ }                                       │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ 4. Replay missed_events in order        │
│    → Trigger onFilesChanged callbacks   │
│ 5. Check current_tasks for new results  │
│    → Show notification banner           │
│ 6. Update lastEventId in localStorage   │
│ 7. Switch to live WebSocket subscription│
└─────────────────────────────────────────┘
```

### Notification Banner

When tasks completed/failed while user was offline:

```
┌─────────────────────────────────────────────────────────────┐
│ ℹ️  While you were away: 2 tasks completed, 1 failed  [View] [×] │
└─────────────────────────────────────────────────────────────┘
```

- Click "View" navigates to relevant scenario page
- Failed tasks show retry button in their respective UI

### lastEventId Persistence

```typescript
// On every WebSocket event received
localStorage.setItem(`workspace:lastEvent:${sessionId}`, event.id);

// On page load, read for recovery API
const lastEventId = localStorage.getItem(`workspace:lastEvent:${sessionId}`);
```

Uses localStorage (not sessionStorage) because recovery must survive browser close.

### Relationship to Chat SSE

```
         Page opens
              │
   ┌──────────┼──────────┐
   │          │          │
   ▼          ▼          ▼
WebSocket   Load chat   Recovery
connect     history      API
(events)   (messages)  (missed)
   │          │          │
   │          ▼          │
   │    Render history   │
   │          │          │
   ▼          │          ▼
Subscribe     │    Replay events
session       │   + notification
   │          │          │
   └──────────┼──────────┘
              │
              ▼
       Page ready
              │
       User sends message
              │
              ▼
        SSE stream
      (chat content)
              │
       EventBus triggers
       files_changed
              │
              ▼
       WebSocket push
       → frontend callback
       → workspace UI update
```

## Section 4: Reconciler

### Responsibilities

Periodically scans `execution_tasks` for stuck tasks, reconciles against S3 status, pushes to terminal state.

### Implementation

```typescript
// backend/src/services/execution-reconciler.service.ts

class ExecutionReconciler {
  static readonly INTERVAL = 60_000;            // Run every 60 seconds
  static readonly STALE_THRESHOLD = 5 * 60_000; // 5 min without update triggers check
  static readonly TIMEOUT_THRESHOLD = 30 * 60_000; // 30 min hard timeout

  async reconcile() {
    // Distributed lock — only one instance runs reconciler
    const lock = await this.redis.acquireLock(
      'reconciler:execution_tasks',
      this.INTERVAL
    );
    if (!lock) return;

    try {
      const staleTasks = await this.taskRepo.findStale(this.STALE_THRESHOLD);
      for (const task of staleTasks) {
        await this.reconcileTask(task);
      }
    } finally {
      await this.redis.releaseLock('reconciler:execution_tasks');
    }
  }
}
```

### Reconciliation Logic

```
reconcileTask(task):
  │
  ├─ Check S3: __executions__/{taskId}.json exists?
  │
  ├─ YES → Read status
  │   ├─ completed → syncBackFiles() → updateDB(completed) → eventBus.emit(task_completed + files_changed)
  │   └─ failed → updateDB(failed) → eventBus.emit(task_failed)
  │
  └─ NO → Check age
      ├─ age < TIMEOUT_THRESHOLD → Skip (might still be executing)
      └─ age >= TIMEOUT_THRESHOLD → updateDB(timeout) → eventBus.emit(task_timeout)
```

### Idempotency

```typescript
async reconcileTask(task: ExecutionTask) {
  // Optimistic lock: only update tasks still in 'running' state
  const updated = await this.taskRepo.updateWhere(
    { id: task.id, status: 'running' },
    { status: newStatus, completed_at: now() }
  );

  // If 0 rows affected, another process already handled it
  if (updated === 0) return;

  // Emit events...
}
```

### Multi-Instance Safety

Uses existing Redis distributed lock pattern. Only one instance runs reconciler per interval. Lock auto-expires to prevent deadlock if holder crashes.

## Gradual Migration Strategy

### Phase 0: Infrastructure (Build, Don't Migrate)

New components, zero changes to existing behavior:

| New Component | Description |
|---------------|-------------|
| `execution_tasks` table | Prisma migration |
| `execution_events` table | Prisma migration |
| `WorkspaceEventBus` service | New file, registered in DI |
| `WorkspaceWebSocketGateway` | Extend existing gateway, new `/ws/workspace` route |
| Redis pub/sub layer | Extend `redis.service.ts` |
| `ExecutionReconciler` | BullMQ repeatable job |
| Frontend `WorkspaceSocketClient` | New file |
| Frontend `useWorkspaceEvents` hook | New file |
| Recovery API `GET /api/workspace-events/recover` | New route |

### Phase 1: Project Execution (Highest Pain Point)

Replace 3-second polling with real-time WebSocket push + disconnect recovery.

**Changes:**
- `project.service.ts`: Write `execution_tasks` on `executeIssue()`
- `agent-runtime-agentcore.ts`: Trigger `eventBus.emit(files_changed)` after sync-back
- `agentcore/src/workspace-sync.ts`: Write `__executions__/{taskId}.json`
- `ProjectBoard.tsx`: Replace polling with `useWorkspaceEvents`

### Phase 2: Scope Copilot

Replace manual SSE `scope_config` event construction with EventBus file change notification.

**Changes:**
- `scope-generator.routes.ts`: Remove manual SSE event construction
- `ScopeCopilot.tsx`: Remove SSE file parsing, use hook
- `ScopeCopilotPage.tsx`: Wire `useWorkspaceEvents`

### Phase 3: Workflow

Unify execution state push through EventBus.

**Changes:**
- `workflow-executor-v2.ts`: Emit progress events through EventBus
- `workflows.routes.ts`: Simplify execute-v2 route
- `WorkflowEditor.tsx`: Replace SSE reader with hook
- `WorkflowCopilot.tsx`: Replace ref handle pattern with hook

### Phase 4: Cleanup

Remove deprecated code paths after Phases 1-3 stabilize:
- Old `execution.gateway.ts`
- `event-websocket-bridge.ts`
- Frontend `workflowWebSocketClient.ts`
- Project polling code
- Scope Copilot SSE file event parsing

### Feature Flags for Safe Rollback

```bash
WORKSPACE_EVENTS_ENABLED=true    # Global kill switch
WORKSPACE_EVENTS_PROJECT=true    # Phase 1
WORKSPACE_EVENTS_SCOPE=true      # Phase 2
WORKSPACE_EVENTS_WORKFLOW=true   # Phase 3
```

When disabled, falls back to existing code paths.

### Timeline Estimate

| Phase | Effort | Dependencies |
|-------|--------|--------------|
| Phase 0 | 3-4 days | None |
| Phase 1 | 2-3 days | Phase 0 |
| Phase 2 | 2 days | Phase 0 |
| Phase 3 | 2-3 days | Phase 0 |
| Phase 4 | 1 day | Phases 1+2+3 stable |

Phases 1/2/3 are independent and can run in parallel or be prioritized.

## Key Principles

- **DB is intent, S3 is truth** — reconciler bridges the gap
- **Events are discrete, streams are continuous** — WebSocket for events, SSE for chat text
- **Frontend filters, backend broadcasts** — new scenarios need zero backend changes
- **No single point of failure** — three-layer write guarantee ensures convergence
- **Gradual migration** — feature flags allow per-scenario rollback at any time
