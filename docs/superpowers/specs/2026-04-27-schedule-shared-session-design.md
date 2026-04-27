# Scheduled Workflow Shared Session & Variable Editing

## Problem

Each scheduled workflow run currently creates a brand-new chat session and AgentCore runtime. The agent starts from scratch every time — no memory of what worked, what failed, or what patterns emerged in previous runs. Additionally, schedule variables cannot be edited after creation in the UI.

## Goals

1. Let scheduled workflows share a persistent AgentCore session across runs, so the agent accumulates knowledge via the filesystem.
2. Let users toggle between shared and fresh sessions per schedule.
3. Add variable editing to the schedule form so users can configure workflow inputs without recreating the schedule.

## Non-Goals

- Structured knowledge storage conventions (agent decides its own strategy).
- Cross-schedule knowledge sharing (each schedule has its own session).
- Context window management (each run is a fresh Claude Code session within the persistent AgentCore runtime; no context explosion).

---

## Design

### 1. Session ID Strategy

The schedule service computes a deterministic or unique session ID before calling the workflow executor. No new DB columns for session mapping — the ID itself encodes the strategy.

Note: `chat_sessions.id` is a PostgreSQL UUID column (`@db.Uuid`). We use UUID v5 (namespace-based deterministic UUID) to derive a stable UUID from the schedule ID string, ensuring compatibility.

**Shared session (default):**
```typescript
import { v5 as uuidv5 } from 'uuid';
const SCHEDULE_SESSION_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // DNS namespace or custom
const chatSessionId = uuidv5(`schedule:${schedule.id}`, SCHEDULE_SESSION_NAMESPACE);
```
Deterministic. Same UUID every run for the same schedule. Same AgentCore runtime, same S3 workspace prefix, same filesystem. Knowledge accumulates naturally through files the agent creates.

**Fresh session (opt-out):**
```typescript
const chatSessionId = crypto.randomUUID();
```
Random UUID per run. Fresh workspace each time. No carry-over.

### 2. Schema Change: `use_shared_session` on `workflow_schedules`

Add a boolean column to `workflow_schedules`:

```sql
ALTER TABLE workflow_schedules ADD COLUMN use_shared_session BOOLEAN NOT NULL DEFAULT true;
```

Exposed in the schedule CRUD API (create and update) and the frontend schedule form as a toggle.

### 3. Workflow Executor: `findOrCreate` Session Path

Currently `workflow-executor-v2.ts` `execute()` always creates a new `chat_sessions` row (line 581). Change to support a pre-computed session ID:

**New option on `execute()`:**
```typescript
interface WorkflowExecuteOptions {
  // ... existing fields
  chatSessionId?: string;  // Pre-computed session ID for reuse
}
```

**Logic in `execute()`:**
```
if options.chatSessionId:
  session = findById(options.chatSessionId, organizationId)
  if session exists:
    reuse it, read claude_session_id for provider resume
  else:
    create with id = options.chatSessionId
else:
  create with random UUID (current behavior, unchanged)
```

This mirrors the `prepareScopeSession()` pattern from `chat.service.ts`.

### 4. Pass `providerSessionId` in `executeSegment()`

Currently `executeSegment()` (line 905) does not pass `providerSessionId` to `agentRuntime.runConversation()`. When reusing a session, read `claude_session_id` from the chat session and pass it through:

```typescript
const generator = agentRuntime.runConversation(
  {
    agentId: agentConfig.id,
    sessionId: chatSessionId,
    providerSessionId: claudeSessionId,  // NEW: enables AgentCore session resume
    message: userMessage,
    organizationId,
    userId,
    workspacePath,
    scopeId,
  },
  agentConfig,
  skills,
  undefined,
  mcpServers,
);
```

This also benefits checkpoint-based resume (existing feature), not just shared sessions.

### 5. Schedule Service Changes

In `schedule.service.ts` `executeSchedule()`, compute the session ID before calling `runV2Execution()`:

```typescript
import { v5 as uuidv5 } from 'uuid';

const SCHEDULE_SESSION_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const useShared = schedule.use_shared_session ?? true;
const chatSessionId = useShared
  ? uuidv5(`schedule:${schedule.id}`, SCHEDULE_SESSION_NAMESPACE)
  : crypto.randomUUID();
```

Pass it into `workflowExecutorV2.execute()` via the options object.

### 6. Workspace Lifecycle

No changes needed. The workspace path is already keyed by `chatSessionId` through `workspace-manager.ensureSessionWorkspace()`. When the session ID is deterministic:

- Same `chatSessionId` -> same workspace path -> same local directory
- `ensureWorkspaceUpToDate()` handles lazy refresh if scope config changed
- S3 sync uses `{orgId}/{scopeId}/{chatSessionId}/` prefix — same prefix reuses same S3 state
- AgentCore pulls from S3 on startup, pushes back on completion
- Files the agent creates (logs, learnings, artifacts) persist across runs

### 7. Variable Editing UI

**Backend**: Already supports `variables` in create/update API. Tighten validation from `z.array(z.any())` to match `WorkflowV2Variable` schema:

```typescript
const workflowVariableSchema = z.object({
  variableId: z.string(),
  name: z.string(),
  value: z.union([
    z.string(),
    z.array(z.object({ type: z.string(), text: z.string().optional() })),
  ]),
  description: z.string().optional(),
  required: z.boolean().optional(),
});
```

**Frontend**: Add a variables section to the `SchedulePanel` schedule form (both create and edit):

- On create: pre-populate from the workflow's start node `inputVariables` definitions
- On edit: show current schedule variables, editable
- Each variable row shows: name (read-only), value (editable input), description (hint text), required badge
- Pattern follows `RunWorkflowModal` — same UX, embedded in the schedule form

To get the start node variables, the frontend reads the workflow's canvas data (already loaded in the WorkflowEditor context) and extracts `inputVariables` from the start/trigger node metadata.

---

## Data Flow

### Shared Session Execution (Happy Path)

```
Schedule triggers (BullMQ cron)
  -> schedule.service.executeSchedule()
  -> compute chatSessionId = uuidv5("schedule:{scheduleId}", NAMESPACE)  // deterministic UUID
  -> workflowExecutorV2.execute(plan, org, scope, user, { chatSessionId })
  -> findOrCreate chat_sessions with id = chatSessionId
     -> if exists: read claude_session_id
     -> if new: create row
  -> provisionWorkflowWorkspace(org, scope, chatSessionId)
     -> workspace-manager.ensureSessionWorkspace() or ensureWorkspaceUpToDate()
     -> same directory, same S3 prefix as previous runs
  -> write CLAUDE.md (mission brief for this run)
  -> agentRuntime.runConversation({ providerSessionId: claude_session_id })
     -> AgentCore routes to same microVM (same runtimeSessionId)
     -> S3 workspace has files from previous runs
     -> Agent reads prior artifacts, executes, writes new artifacts
  -> sync workspace back to S3
  -> store new claude_session_id for next run
```

### Run N+1: Agent Sees Previous Knowledge

The agent's CLAUDE.md describes the current workflow task. The workspace filesystem contains whatever the agent wrote in previous runs (logs, summaries, data files). The agent is free to read these and use them to inform the current run. No structured convention imposed — the workflow's skill definitions and CLAUDE.md guide agent behavior.

### 8. Scroll-to-Execution in Shared Chat Session

When multiple executions share a single chat session, clicking "View Chat" from a specific execution should scroll to that execution's messages rather than the bottom of the conversation.

**Navigation side** (ExecutionDetailModal + WorkflowEditor execution history):

Append the execution's `created_at` timestamp to the URL:
```
/chat?session={chatSessionId}&at={execution.created_at}
```

**Chat page side** (Chat.tsx):

Read the `at` query parameter. Pass it down to `MessageList` as `scrollToTimestamp`.

**MessageList component**:

- Each message element gets a ref via `data-msg-id={message.id}`
- On mount, if `scrollToTimestamp` is provided:
  1. Find the first message with `timestamp >= scrollToTimestamp`
  2. Scroll to that element with `scrollIntoView({ behavior: 'smooth', block: 'start' })`
  3. Optionally flash-highlight the message briefly to orient the user
- If no `scrollToTimestamp` (normal chat), keep current behavior (scroll to bottom)

This is a small, self-contained enhancement. The `at` param is ignored by all other pages, and the scroll-to-timestamp is a pure additive change to `MessageList`.

---

## Files to Modify

### Backend
| File | Change |
|------|--------|
| `prisma/schema.prisma` | Add `use_shared_session` column to `workflow_schedules` |
| `prisma/migrations/` | New migration |
| `routes/schedules.routes.ts` | Add `useSharedSession` to create/update schemas, tighten `variables` validation |
| `services/schedule.service.ts` | Compute deterministic session ID, pass to executor |
| `services/workflow-executor-v2.ts` | Add `chatSessionId` option, `findOrCreate` session, pass `providerSessionId` |

### Frontend
| File | Change |
|------|--------|
| `components/SchedulePanel.tsx` | Add `use_shared_session` toggle, add variables editing section |
| `components/MessageList.tsx` | Add `scrollToTimestamp` prop, scroll to target message on mount |
| `components/ExecutionDetailModal.tsx` | Append `&at={created_at}` to chat navigation URL |
| `pages/WorkflowEditor.tsx` | Append `&at={created_at}` to chat navigation URL |
| `pages/Chat.tsx` | Read `at` query param, pass to MessageList |
| `services/api/restScheduleService.ts` | Add `useSharedSession` to interfaces |
| `services/useSchedules.ts` | Pass through new fields |

---

## Edge Cases

**Schedule deleted**: Shared session and workspace become orphaned. Acceptable — no different from any other deleted workflow's chat sessions. Can be cleaned up by a future GC job.

**Schedule disabled then re-enabled**: Shared session persists. Agent picks up where it left off. This is the desired behavior.

**Workflow definition changes**: Shared session continues. The workspace's CLAUDE.md is rewritten each run with the current workflow plan. Old filesystem knowledge persists. The user can reset by toggling `use_shared_session` off and back on (which creates a new timestamped session on the next run), or they can leave it as-is — accumulated knowledge doesn't fade with workflow changes.

**Concurrent schedule runs**: If a schedule triggers while a previous run is still executing (unlikely given typical cron intervals + timeout), BullMQ's stalled job detection and the existing concurrency=5 limit handle this. The shared session's workspace may see concurrent writes, but AgentCore's S3 sync is per-invocation so they'd get separate workspace snapshots. Not a practical concern for cron-triggered schedules.

**First run of a shared session**: No prior knowledge exists. Agent runs normally, potentially creating files for future reference. Identical to the current non-shared behavior.
