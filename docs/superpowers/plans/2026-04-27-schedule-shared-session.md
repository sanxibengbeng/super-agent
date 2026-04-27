# Schedule Shared Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable scheduled workflow executions to share a persistent AgentCore session across runs, accumulating knowledge via the filesystem; add variable editing to the schedule form; and add scroll-to-execution when navigating to a shared chat session.

**Architecture:** Add `use_shared_session` boolean to `workflow_schedules`. The schedule service computes a deterministic UUID v5 (shared) or random UUID (fresh) as `chatSessionId` and passes it to the workflow executor. The executor gains a `findOrCreate` session path and passes `providerSessionId` for AgentCore resume. Frontend adds a shared session toggle + variables editor to SchedulePanel, and a `scrollToTimestamp` prop to MessageList.

**Tech Stack:** Prisma (PostgreSQL migration), Fastify/Zod (API), React/TypeScript (frontend), Node.js `crypto` (deterministic UUID)

---

### Task 1: Database Migration — `use_shared_session` Column

**Files:**
- Modify: `backend/prisma/schema.prisma:700-728`
- Create: `backend/prisma/migrations/<timestamp>_add_use_shared_session/migration.sql`

- [ ] **Step 1: Add column to Prisma schema**

In `backend/prisma/schema.prisma`, add `use_shared_session` to the `workflow_schedules` model, after the `variables` field:

```prisma
  variables         Json      @default("[]")
  use_shared_session Boolean  @default(true)
  next_run_at       DateTime? @db.Timestamptz
```

- [ ] **Step 2: Generate migration**

Run:
```bash
cd backend && npx prisma migrate dev --name add_use_shared_session
```

Expected: Migration created, Prisma Client regenerated. All existing schedules default to `use_shared_session = true`.

- [ ] **Step 3: Verify migration**

Run:
```bash
cd backend && npx prisma migrate status
```

Expected: All migrations applied, no pending migrations.

- [ ] **Step 4: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/
git commit -m "feat(db): add use_shared_session column to workflow_schedules"
```

---

### Task 2: Backend API — `useSharedSession` and Tighter `variables` Validation

**Files:**
- Modify: `backend/src/routes/schedules.routes.ts:16-34`
- Modify: `backend/src/services/schedule.service.ts:80-96,130-187,192-257,729-747`
- Modify: `backend/src/services/api/restScheduleService.ts` (frontend types)

- [ ] **Step 1: Update Zod schemas in schedules.routes.ts**

Replace the create and update schemas (lines 16-34) with tighter `variables` validation and the new `useSharedSession` field:

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

const createScheduleSchema = z.object({
  name: z.string().min(1).max(255),
  cronExpression: z.string().min(1).max(100),
  timezone: z.string().max(50).optional(),
  variables: z.array(workflowVariableSchema).optional(),
  isEnabled: z.boolean().optional(),
  useSharedSession: z.boolean().optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  timeoutMinutes: z.number().int().min(1).max(1440).optional(),
});

const updateScheduleSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  cronExpression: z.string().min(1).max(100).optional(),
  timezone: z.string().max(50).optional(),
  variables: z.array(workflowVariableSchema).optional(),
  isEnabled: z.boolean().optional(),
  useSharedSession: z.boolean().optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  timeoutMinutes: z.number().int().min(1).max(1440).optional(),
});
```

- [ ] **Step 2: Add `useSharedSession` to JSON schema in create route**

In the `POST /workflows/:workflowId/schedules` route's `schema.body.properties` (around line 141), add:

```typescript
useSharedSession: { type: 'boolean' },
```

- [ ] **Step 3: Pass `useSharedSession` through to service in create handler**

In the create handler (around line 153), add `useSharedSession` to the options:

```typescript
const schedule = await scheduleService.createSchedule(
  request.user!.orgId,
  request.params.workflowId,
  {
    ...body,
    createdBy: request.user!.id,
  }
);
```

The spread already passes `useSharedSession` from `body` since it's part of the Zod schema.

- [ ] **Step 4: Add `useSharedSession` to JSON schema in update route**

In the `PATCH /schedules/:scheduleId` route's `schema.body.properties` (around line 257), add:

```typescript
useSharedSession: { type: 'boolean' },
```

- [ ] **Step 5: Update `ScheduleConfig` interface in schedule.service.ts**

Add `useSharedSession` to the `ScheduleConfig` interface (around line 80):

```typescript
export interface ScheduleConfig {
  id: string;
  organizationId: string;
  workflowId: string;
  name: string;
  cronExpression: string;
  timezone: string;
  isEnabled: boolean;
  variables: any[];
  useSharedSession: boolean;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  runCount: number;
  failureCount: number;
  maxRetries: number;
  timeoutMinutes: number;
  createdAt: Date;
}
```

- [ ] **Step 6: Update `createSchedule` method to persist `useSharedSession`**

In `createSchedule()` (around line 155), add `use_shared_session` to the Prisma `create` data:

```typescript
const schedule = await prisma.workflow_schedules.create({
  data: {
    organization_id: organizationId,
    workflow_id: workflowId,
    name: options.name,
    cron_expression: options.cronExpression,
    timezone: options.timezone || 'UTC',
    variables: options.variables || [],
    is_enabled: options.isEnabled || false,
    use_shared_session: options.useSharedSession ?? true,
    next_run_at: nextRunAt,
    max_retries: options.maxRetries || 3,
    timeout_minutes: options.timeoutMinutes ?? 10,
    created_by: options.createdBy,
  },
});
```

Also add `useSharedSession?: boolean;` to the `options` type parameter of `createSchedule()`.

- [ ] **Step 7: Update `updateSchedule` method to persist `useSharedSession`**

In `updateSchedule()` (around line 225), add `use_shared_session` to the Prisma `update` data:

```typescript
const updated = await prisma.workflow_schedules.update({
  where: { id: scheduleId },
  data: {
    name: updates.name,
    cron_expression: updates.cronExpression,
    timezone: updates.timezone,
    variables: updates.variables,
    is_enabled: updates.isEnabled,
    use_shared_session: updates.useSharedSession,
    max_retries: updates.maxRetries,
    timeout_minutes: updates.timeoutMinutes,
    next_run_at: nextRunAt,
  },
});
```

Also add `useSharedSession?: boolean;` to the `updates` type parameter of `updateSchedule()`.

- [ ] **Step 8: Update `mapToScheduleConfig` to include `useSharedSession`**

In `mapToScheduleConfig()` (around line 729), add:

```typescript
private mapToScheduleConfig(schedule: any): ScheduleConfig {
  return {
    id: schedule.id,
    organizationId: schedule.organization_id,
    workflowId: schedule.workflow_id,
    name: schedule.name,
    cronExpression: schedule.cron_expression,
    timezone: schedule.timezone,
    isEnabled: schedule.is_enabled,
    variables: schedule.variables as any[],
    useSharedSession: schedule.use_shared_session ?? true,
    nextRunAt: schedule.next_run_at,
    lastRunAt: schedule.last_run_at,
    runCount: schedule.run_count,
    failureCount: schedule.failure_count,
    maxRetries: schedule.max_retries,
    timeoutMinutes: (schedule as any).timeout_minutes ?? 10,
    createdAt: schedule.created_at,
  };
}
```

- [ ] **Step 9: Return `useSharedSession` and `variables` from list schedules route**

In the `GET /workflows/:workflowId/schedules` handler response (around line 98), add the missing fields:

```typescript
return reply.status(200).send({
  data: schedules.map(s => ({
    id: s.id,
    name: s.name,
    cronExpression: s.cronExpression,
    timezone: s.timezone,
    isEnabled: s.isEnabled,
    variables: s.variables,
    useSharedSession: s.useSharedSession,
    timeoutMinutes: s.timeoutMinutes,
    nextRunAt: s.nextRunAt?.toISOString() || null,
    lastRunAt: s.lastRunAt?.toISOString() || null,
    runCount: s.runCount,
    failureCount: s.failureCount,
    createdAt: s.createdAt.toISOString(),
  })),
});
```

- [ ] **Step 10: Return `useSharedSession` from get schedule and update schedule routes**

In the `GET /schedules/:scheduleId` response (around line 214), add:
```typescript
useSharedSession: schedule.useSharedSession,
```

In the `PATCH /schedules/:scheduleId` response (around line 279), add:
```typescript
useSharedSession: schedule.useSharedSession,
variables: schedule.variables,
```

- [ ] **Step 11: Verify backend compiles**

Run:
```bash
cd backend && npm run build
```

Expected: No TypeScript errors.

- [ ] **Step 12: Commit**

```bash
git add backend/src/routes/schedules.routes.ts backend/src/services/schedule.service.ts
git commit -m "feat(api): add useSharedSession field and tighter variables validation to schedule CRUD"
```

---

### Task 3: Deterministic Session ID and Executor Integration

**Files:**
- Modify: `backend/src/services/schedule.service.ts:381-413,588-672`
- Modify: `backend/src/services/workflow-executor-v2.ts:556-618,787-916`

- [ ] **Step 1: Add deterministic UUID v5 helper to schedule.service.ts**

At the top of `schedule.service.ts`, after the existing imports, add:

```typescript
import crypto from 'crypto';

const SCHEDULE_SESSION_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

function deterministicUuid(name: string): string {
  const hash = crypto.createHash('sha1')
    .update(SCHEDULE_SESSION_NAMESPACE.replace(/-/g, ''))
    .update(name)
    .digest();
  // Set version 5 (bits 4-7 of byte 6)
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  // Set variant (bits 6-7 of byte 8)
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
```

- [ ] **Step 2: Compute session ID in `executeSchedule()`**

In `executeSchedule()` (around line 654), before calling `runV2Execution()`, compute the session ID:

```typescript
    try {
      // Build V2 plan (same as the manual Run button)
      const plan = buildV2Plan(workflow, schedule.variables as any[]);

      // Compute deterministic or fresh session ID based on use_shared_session
      const useShared = schedule.use_shared_session ?? true;
      const chatSessionId = useShared
        ? deterministicUuid(`schedule:${schedule.id}`)
        : crypto.randomUUID();

      // Execute using runV2Execution (same as manual trigger — collects logs)
      const cronTimeoutMs = ((schedule as any).timeout_minutes ?? 10) * 60 * 1000;
      await this.runV2Execution(plan, schedule.organization_id, scopeId, record.id, schedule.id, schedule.workflow_id, schedule.created_by || schedule.organization_id, cronTimeoutMs, chatSessionId);
```

- [ ] **Step 3: Compute session ID in `triggerSchedule()` (manual trigger)**

In `triggerSchedule()` (around line 361), compute the session ID before calling `runV2Execution()`:

```typescript
    const creatorId = schedule.created_by || organizationId;
    const timeoutMs = ((schedule as any).timeout_minutes ?? 10) * 60 * 1000;

    // Compute deterministic or fresh session ID
    const useShared = schedule.use_shared_session ?? true;
    const chatSessionId = useShared
      ? deterministicUuid(`schedule:${schedule.id}`)
      : crypto.randomUUID();

    this.runV2Execution(plan, organizationId, scopeId, record.id, scheduleId, schedule.workflow_id, creatorId, timeoutMs, chatSessionId)
      .catch(err => console.error(`[SCHEDULE] V2 execution error for schedule ${scheduleId}:`, err));
```

- [ ] **Step 4: Add `chatSessionId` parameter to `runV2Execution()`**

Update the method signature (around line 381) to accept `chatSessionId`:

```typescript
  private async runV2Execution(
    plan: WorkflowV2Plan,
    organizationId: string,
    scopeId: string,
    recordId: string,
    scheduleId: string,
    workflowId: string,
    userId: string,
    timeoutMs?: number,
    chatSessionId?: string,
  ): Promise<void> {
```

And pass it through to the executor (around line 407):

```typescript
      const generator = workflowExecutorV2.execute(
        plan,
        organizationId,
        scopeId,
        userId,
        { workflowId, triggerType: 'scheduled', timeoutMs, chatSessionId },
      );
```

- [ ] **Step 5: Add `chatSessionId` to executor options type**

In `workflow-executor-v2.ts`, update the `execute()` method options type (around line 566):

```typescript
    options?: {
      workflowId?: string;
      timeoutMs?: number;
      triggerType?: string;
      chatSessionId?: string;
    },
```

- [ ] **Step 6: Implement `findOrCreate` session logic in `execute()`**

Replace the session creation block (lines 577-595) with a `findOrCreate` pattern:

```typescript
    let chatSessionId: string | undefined;
    let claudeSessionId: string | undefined;
    try {
      if (options?.chatSessionId) {
        // findOrCreate: try to reuse existing session
        const existing = await prisma.chat_sessions.findUnique({
          where: { id: options.chatSessionId },
        });
        if (existing) {
          chatSessionId = existing.id;
          claudeSessionId = existing.claude_session_id ?? undefined;
          console.log(`[workflow-v2] Reusing chat session ${chatSessionId} (claude_session=${claudeSessionId ?? 'none'}) for workflow "${plan.title}"`);
        } else {
          const chatSession = await prisma.chat_sessions.create({
            data: {
              id: options.chatSessionId,
              organization_id: organizationId,
              user_id: userId,
              business_scope_id: scopeId,
              source: 'workflow',
              title: `Workflow: ${plan.title}`,
              status: 'idle',
            },
          });
          chatSessionId = chatSession.id;
          console.log(`[workflow-v2] Created chat session ${chatSessionId} for workflow "${plan.title}"`);
        }
      } else {
        const chatSession = await prisma.chat_sessions.create({
          data: {
            organization_id: organizationId,
            user_id: userId,
            business_scope_id: scopeId,
            source: 'workflow',
            title: `Workflow: ${plan.title}`,
            status: 'idle',
          },
        });
        chatSessionId = chatSession.id;
        console.log(`[workflow-v2] Created chat session ${chatSessionId} for workflow "${plan.title}"`);
      }
    } catch (err) {
      console.warn('[workflow-v2] Failed to create/find chat session:', err);
    }
```

- [ ] **Step 7: Pass `claudeSessionId` to `executeSegment()`**

Update all `executeSegment()` calls in `execute()` to pass `claudeSessionId`. The method signature (line 787) needs a new parameter:

```typescript
  private async *executeSegment(
    plan: WorkflowV2Plan,
    segment: Segment,
    organizationId: string,
    scopeId: string,
    userId: string,
    executionId: string | undefined,
    timeoutMs: number,
    priorOutputs?: Record<string, { title: string; output: unknown }>,
    checkpointResult?: { nodeTitle: string; result: Record<string, unknown> },
    chatSessionId?: string,
    claudeSessionId?: string,
  ): AsyncGenerator<WorkflowProgressEvent> {
```

Update the calls in `execute()` at lines 614, 625, and similar to pass the new argument:

```typescript
yield* this.executeSegment(plan, segments[0]!, organizationId, scopeId, userId, executionId, timeoutMs, undefined, undefined, chatSessionId, claudeSessionId);
```

Also update the `resume()` method's call to `executeSegment()` (around line 744) to read and pass `claudeSessionId`:

```typescript
    // Read claude_session_id for provider resume
    const chatSessionId = (execution as any).chat_session_id ?? undefined;
    let claudeSessionId: string | undefined;
    if (chatSessionId) {
      const session = await prisma.chat_sessions.findUnique({ where: { id: chatSessionId } });
      claudeSessionId = session?.claude_session_id ?? undefined;
    }

    // Execute the segment with resume context
    yield* this.executeSegment(
      plan, segment, execution.organization_id, scopeId, execution.user_id,
      executionId, DEFAULT_TIMEOUT_MS, priorOutputs,
      checkpoint.nodeTitle ? { nodeTitle: checkpoint.nodeTitle, result: checkpoint.result || {} } : undefined,
      chatSessionId,
      claudeSessionId,
    );
```

- [ ] **Step 8: Pass `providerSessionId` to `agentRuntime.runConversation()`**

In `executeSegment()`, update the `runConversation` call (around line 902) to include `providerSessionId`:

```typescript
      const generator = agentRuntime.runConversation(
        {
          agentId: agentConfig.id,
          sessionId: chatSessionId,
          providerSessionId: claudeSessionId,
          message: userMessage,
          organizationId,
          userId,
          workspacePath,
          scopeId,
        },
        agentConfig,
        skills,
        undefined,
        mcpServers as Record<string, import('./claude-agent.service.js').MCPServerSDKConfig> | undefined,
      );
```

- [ ] **Step 9: Verify backend compiles**

Run:
```bash
cd backend && npm run build
```

Expected: No TypeScript errors.

- [ ] **Step 10: Commit**

```bash
git add backend/src/services/schedule.service.ts backend/src/services/workflow-executor-v2.ts
git commit -m "feat: shared session support for scheduled workflow executions"
```

---

### Task 4: Frontend — `useSharedSession` Toggle and Types

**Files:**
- Modify: `frontend/src/services/api/restScheduleService.ts:13-69`
- Modify: `frontend/src/components/SchedulePanel.tsx:64-129,210-298`

- [ ] **Step 1: Add `useSharedSession` to frontend types**

In `restScheduleService.ts`, add `useSharedSession` to the `Schedule` interface (after `isEnabled`):

```typescript
export interface Schedule {
  id: string;
  workflowId: string;
  name: string;
  cronExpression: string;
  timezone: string;
  isEnabled: boolean;
  useSharedSession: boolean;
  variables: unknown[];
  nextRunAt: string | null;
  lastRunAt: string | null;
  runCount: number;
  failureCount: number;
  maxRetries: number;
  timeoutMinutes: number;
  createdAt: string;
}
```

Add `useSharedSession` to `CreateScheduleRequest` and `UpdateScheduleRequest`:

```typescript
export interface CreateScheduleRequest {
  name: string;
  cronExpression: string;
  timezone?: string;
  variables?: unknown[];
  isEnabled?: boolean;
  useSharedSession?: boolean;
  maxRetries?: number;
  timeoutMinutes?: number;
}

export interface UpdateScheduleRequest {
  name?: string;
  cronExpression?: string;
  timezone?: string;
  variables?: unknown[];
  isEnabled?: boolean;
  useSharedSession?: boolean;
  maxRetries?: number;
  timeoutMinutes?: number;
}
```

- [ ] **Step 2: Add shared session toggle state to SchedulePanel**

In `SchedulePanel.tsx`, add a new state variable for the create form (around line 68):

```typescript
  const [newTimeoutMinutes, setNewTimeoutMinutes] = useState(10);
  const [newUseSharedSession, setNewUseSharedSession] = useState(true);
```

- [ ] **Step 3: Add shared session toggle to create form UI**

In the create form JSX (after the timeout field, around line 279), add a toggle:

```tsx
            <div className="flex items-center justify-between">
              <div>
                <label className="block text-xs text-gray-400">{t('schedule.sharedSession')}</label>
                <span className="text-[10px] text-gray-500">{t('schedule.sharedSessionHint')}</span>
              </div>
              <button
                onClick={() => setNewUseSharedSession(!newUseSharedSession)}
                className="p-1"
              >
                {newUseSharedSession ? (
                  <ToggleRight className="w-6 h-6 text-green-400" />
                ) : (
                  <ToggleLeft className="w-6 h-6 text-gray-500" />
                )}
              </button>
            </div>
```

- [ ] **Step 4: Pass `useSharedSession` in `handleCreate`**

Update `handleCreate()` (around line 115) to include the new field:

```typescript
    const result = await createSchedule(workflowId, {
      name: newName.trim(),
      cronExpression: newCron.trim(),
      timezone: newTimezone,
      timeoutMinutes: newTimeoutMinutes,
      useSharedSession: newUseSharedSession,
      isEnabled: true,
    });
```

And reset in the success callback:

```typescript
    if (result) {
      setShowCreateForm(false);
      setNewName('');
      setNewCron('0 9 * * *');
      setNewUseSharedSession(true);
    }
```

- [ ] **Step 5: Show shared session indicator in schedule list item**

In the schedule card (around line 398, after the status/timezone row), add a small indicator:

```tsx
                <div className="flex items-center justify-between text-xs">
                  <span className={`px-2 py-0.5 rounded ${
                    schedule.isEnabled
                      ? 'bg-green-500/20 text-green-400'
                      : 'bg-gray-500/20 text-gray-400'
                  }`}>
                    {schedule.isEnabled ? t('schedule.active') : t('schedule.disabled')}
                  </span>
                  <div className="flex items-center gap-2 text-gray-500">
                    {schedule.useSharedSession && (
                      <span className="px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400 text-[10px]">
                        {t('schedule.shared')}
                      </span>
                    )}
                    <span>{schedule.timeoutMinutes ?? 10}min</span>
                    <span>{schedule.timezone}</span>
                  </div>
                </div>
```

- [ ] **Step 6: Add inline toggle for shared session in schedule list**

Allow toggling `useSharedSession` from the schedule card action buttons. Add a toggle button next to the existing enable/disable toggle (around line 343):

```tsx
                    <button
                      onClick={() => updateSchedule(schedule.id, { useSharedSession: !schedule.useSharedSession })}
                      className="p-1 hover:bg-gray-700 rounded"
                      title={schedule.useSharedSession ? t('schedule.disableSharedSession') : t('schedule.enableSharedSession')}
                    >
                      {schedule.useSharedSession ? (
                        <span className="text-[10px] text-purple-400 font-medium px-1">🔗</span>
                      ) : (
                        <span className="text-[10px] text-gray-500 font-medium px-1">🔗</span>
                      )}
                    </button>
```

- [ ] **Step 7: Verify frontend compiles**

Run:
```bash
cd frontend && npm run build
```

Expected: No TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/services/api/restScheduleService.ts frontend/src/components/SchedulePanel.tsx
git commit -m "feat(ui): add shared session toggle to schedule panel"
```

---

### Task 5: Frontend — Variables Editing in Schedule Form

**Files:**
- Modify: `frontend/src/components/SchedulePanel.tsx`
- Modify: `frontend/src/pages/WorkflowEditor.tsx:1229-1234`

- [ ] **Step 1: Pass canvas data to SchedulePanel**

In `WorkflowEditor.tsx`, pass the `getStartNodeVariables` function as a prop to `SchedulePanel`:

```tsx
                {showSchedulePanel && selectedWorkflow && (
                  <SchedulePanel
                    workflowId={selectedWorkflow.id}
                    getStartNodeVariables={getStartNodeVariables}
                    onClose={() => setShowSchedulePanel(false)}
                  />
                )}
```

- [ ] **Step 2: Update SchedulePanel props interface**

In `SchedulePanel.tsx`, update the props interface and add the import:

```typescript
import type { WorkflowVariableDefinition } from '@/types/canvas/metadata';

interface SchedulePanelProps {
  workflowId: string;
  getStartNodeVariables?: () => WorkflowVariableDefinition[];
  onClose: () => void;
}

export function SchedulePanel({ workflowId, getStartNodeVariables, onClose }: SchedulePanelProps) {
```

- [ ] **Step 3: Add variables state to create form**

Add state for new schedule variables (around line 68):

```typescript
  const [newVariables, setNewVariables] = useState<Array<{ variableId: string; name: string; value: string; description?: string; required?: boolean }>>([]);
```

- [ ] **Step 4: Initialize variables from start node on form open**

Update the "show create form" button handler to pre-populate variables:

```typescript
            <button
              onClick={() => {
                setShowCreateForm(true);
                // Pre-populate variables from start node
                if (getStartNodeVariables) {
                  const vars = getStartNodeVariables();
                  setNewVariables(vars.map(v => ({
                    variableId: v.variableId,
                    name: v.name,
                    value: Array.isArray(v.value)
                      ? v.value.map(val => typeof val === 'string' ? val : (val as { text?: string })?.text || '').join('')
                      : '',
                    description: v.description,
                    required: v.required,
                  })));
                }
              }}
```

- [ ] **Step 5: Add variables editor to create form**

After the timeout field and before the shared session toggle, add the variables section:

```tsx
            {newVariables.length > 0 && (
              <div>
                <label className="block text-xs text-gray-400 mb-2">{t('schedule.variables')}</label>
                <div className="space-y-2">
                  {newVariables.map((v, i) => (
                    <div key={v.variableId}>
                      <div className="flex items-center gap-1 mb-1">
                        <span className="text-xs text-gray-300">{v.name}</span>
                        {v.required && <span className="text-red-400 text-[10px]">*</span>}
                        {v.description && (
                          <span className="text-[10px] text-gray-500 ml-1">{v.description}</span>
                        )}
                      </div>
                      <input
                        type="text"
                        value={v.value}
                        onChange={(e) => {
                          setNewVariables(prev => prev.map((pv, pi) =>
                            pi === i ? { ...pv, value: e.target.value } : pv
                          ));
                        }}
                        placeholder={`Enter ${v.name}...`}
                        className="w-full px-3 py-1.5 bg-gray-900 border border-gray-700 rounded text-sm text-white focus:border-blue-500 outline-none"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
```

- [ ] **Step 6: Include variables in `handleCreate`**

Update `handleCreate()` to send the variables:

```typescript
    const result = await createSchedule(workflowId, {
      name: newName.trim(),
      cronExpression: newCron.trim(),
      timezone: newTimezone,
      timeoutMinutes: newTimeoutMinutes,
      useSharedSession: newUseSharedSession,
      variables: newVariables.length > 0 ? newVariables : undefined,
      isEnabled: true,
    });
```

Reset variables on success:

```typescript
    if (result) {
      setShowCreateForm(false);
      setNewName('');
      setNewCron('0 9 * * *');
      setNewUseSharedSession(true);
      setNewVariables([]);
    }
```

- [ ] **Step 7: Add variables editing to existing schedule cards**

Add an expandable variables section to each schedule card. After the stats section (around line 432), add an edit-variables expandable:

```tsx
                {/* Variables */}
                {Array.isArray(schedule.variables) && schedule.variables.length > 0 && (
                  <ScheduleVariablesEditor
                    variables={schedule.variables as Array<{ variableId: string; name: string; value: string; description?: string; required?: boolean }>}
                    onSave={(vars) => updateSchedule(schedule.id, { variables: vars })}
                  />
                )}
```

- [ ] **Step 8: Create `ScheduleVariablesEditor` component inside SchedulePanel.tsx**

Add a small inline component before the `SchedulePanel` function or after `ExecutionLogModal`:

```tsx
function ScheduleVariablesEditor({
  variables,
  onSave,
}: {
  variables: Array<{ variableId: string; name: string; value: string; description?: string; required?: boolean }>;
  onSave: (vars: Array<{ variableId: string; name: string; value: string; description?: string; required?: boolean }>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState(variables);
  const { t } = useTranslation();

  const handleSave = () => {
    onSave(values);
    setEditing(false);
  };

  return (
    <div className="mt-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-[10px] text-gray-400 hover:text-gray-300 flex items-center gap-1"
      >
        {expanded ? '▾' : '▸'} {t('schedule.variables')} ({variables.length})
      </button>
      {expanded && (
        <div className="mt-1 space-y-1.5">
          {values.map((v, i) => (
            <div key={v.variableId} className="flex items-center gap-2">
              <span className="text-[10px] text-gray-400 w-20 truncate" title={v.name}>
                {v.name}
                {v.required && <span className="text-red-400 ml-0.5">*</span>}
              </span>
              {editing ? (
                <input
                  type="text"
                  value={v.value}
                  onChange={(e) => setValues(prev => prev.map((pv, pi) =>
                    pi === i ? { ...pv, value: e.target.value } : pv
                  ))}
                  className="flex-1 px-2 py-0.5 bg-gray-900 border border-gray-600 rounded text-[10px] text-white focus:border-blue-500 outline-none"
                />
              ) : (
                <span className="flex-1 text-[10px] text-gray-300 truncate">{v.value || '(empty)'}</span>
              )}
            </div>
          ))}
          <div className="flex gap-1 pt-1">
            {editing ? (
              <>
                <button onClick={handleSave} className="text-[10px] text-green-400 hover:text-green-300">
                  {t('common.save')}
                </button>
                <button onClick={() => { setEditing(false); setValues(variables); }} className="text-[10px] text-gray-400 hover:text-gray-300">
                  {t('common.cancel')}
                </button>
              </>
            ) : (
              <button onClick={() => setEditing(true)} className="text-[10px] text-blue-400 hover:text-blue-300">
                {t('common.edit')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 9: Verify frontend compiles**

Run:
```bash
cd frontend && npm run build
```

Expected: No TypeScript errors.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/components/SchedulePanel.tsx frontend/src/pages/WorkflowEditor.tsx
git commit -m "feat(ui): add variable editing to schedule create/edit form"
```

---

### Task 6: Scroll-to-Execution in Shared Chat Session

**Files:**
- Modify: `frontend/src/components/MessageList.tsx`
- Modify: `frontend/src/pages/Chat.tsx:2000-2027`
- Modify: `frontend/src/components/ExecutionDetailModal.tsx:221-231`
- Modify: `frontend/src/pages/WorkflowEditor.tsx:1196-1207`

- [ ] **Step 1: Add `scrollToTimestamp` prop to MessageList**

In `MessageList.tsx`, update the interface and scroll logic:

```typescript
interface MessageListProps {
  messages: Message[]
  isTyping?: boolean
  scrollToTimestamp?: Date
}
```

Replace the component (lines 121-152):

```typescript
export function MessageList({ messages, isTyping = false, scrollToTimestamp }: MessageListProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollTargetRef = useRef<HTMLDivElement>(null)
  const hasScrolledToTarget = useRef(false)
  const { t } = useTranslation()

  useEffect(() => {
    if (scrollToTimestamp && !hasScrolledToTarget.current && messages.length > 0) {
      // Find first message at or after the timestamp
      const targetIdx = messages.findIndex(m => m.timestamp >= scrollToTimestamp)
      if (targetIdx >= 0) {
        hasScrolledToTarget.current = true
        // Defer scroll to allow DOM render
        requestAnimationFrame(() => {
          scrollTargetRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        })
        return
      }
    }
    if (!scrollToTimestamp) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, isTyping, scrollToTimestamp])

  if (messages.length === 0 && !isTyping) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        <p>{t('chat.emptyState')}</p>
      </div>
    )
  }

  const targetIdx = scrollToTimestamp
    ? messages.findIndex(m => m.timestamp >= scrollToTimestamp)
    : -1

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {messages.map((message, idx) => (
        <div key={message.id} ref={idx === targetIdx ? scrollTargetRef : undefined}>
          {idx === targetIdx && (
            <div className="flex items-center gap-2 py-1 mb-2">
              <div className="flex-1 border-t border-blue-500/30" />
              <span className="text-[10px] text-blue-400 px-2">▼ Execution start</span>
              <div className="flex-1 border-t border-blue-500/30" />
            </div>
          )}
          {message.type === 'user'
            ? <UserBubble message={message} />
            : <AIBubble
                message={message}
                isStreaming={isTyping && idx === messages.length - 1}
              />
          }
        </div>
      ))}
      {isTyping && !messages.some(m => m.type === 'ai' && !m.content) && <TypingIndicator />}
      <div ref={messagesEndRef} />
    </div>
  )
}
```

- [ ] **Step 2: Read `at` query param in Chat.tsx**

In `Chat.tsx` (around line 2002), add parsing of the `at` param:

```typescript
  const params = new URLSearchParams(window.location.search)
  const urlScope = params.get('scope') || undefined
  const urlAgent = params.get('agent') || undefined
  const urlSession = params.get('session') || undefined
  const urlPrompt = params.get('prompt') || undefined
  const urlAt = params.get('at') || undefined
```

- [ ] **Step 3: Pass `scrollToTimestamp` to MessageList in ChatInterfaceContent**

The `urlAt` is read in the `Chat()` wrapper but `MessageList` is rendered inside `ChatInterfaceContent`. The simplest approach: pass `urlAt` through via a `data-` attribute or context. Since `ChatInterfaceContent` is defined in the same file, add a module-level variable or use `useSearchParams`.

In `ChatInterfaceContent` (where `MessageList` is rendered, around line 1942), read the param directly:

```typescript
  const scrollToTimestamp = useMemo(() => {
    const at = new URLSearchParams(window.location.search).get('at')
    return at ? new Date(at) : undefined
  }, [])
```

Then pass it to MessageList:

```tsx
  <MessageList messages={messages} isTyping={isSending} scrollToTimestamp={scrollToTimestamp} />
```

Add `useMemo` to the imports if not already present.

- [ ] **Step 4: Append `&at=` to navigation in ExecutionDetailModal**

In `ExecutionDetailModal.tsx` (around line 225), update the navigate call:

```typescript
                  <button
                    onClick={() => {
                      onClose();
                      navigate(`/chat?session=${detail.chat_session_id}&at=${encodeURIComponent(detail.created_at)}`);
                    }}
```

- [ ] **Step 5: Append `&at=` to navigation in WorkflowEditor**

In `WorkflowEditor.tsx` (around line 1200), update the navigate call:

```typescript
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    navigate(`/chat?session=${exec.chatSessionId}&at=${encodeURIComponent(exec.createdAt)}`);
                                  }}
```

- [ ] **Step 6: Verify frontend compiles**

Run:
```bash
cd frontend && npm run build
```

Expected: No TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/MessageList.tsx frontend/src/pages/Chat.tsx frontend/src/components/ExecutionDetailModal.tsx frontend/src/pages/WorkflowEditor.tsx
git commit -m "feat(ui): scroll to execution timestamp when viewing shared chat session"
```

---

### Task 7: i18n Keys

**Files:**
- Modify: `frontend/src/i18n/en.ts` (or equivalent i18n file)
- Modify: `frontend/src/i18n/zh.ts` (or equivalent)

- [ ] **Step 1: Find the i18n files**

Run:
```bash
find frontend/src/i18n -name "*.ts" -o -name "*.json" | head -10
```

- [ ] **Step 2: Add English translations**

Add these keys to the English locale under the `schedule` namespace:

```typescript
'schedule.sharedSession': 'Shared Session',
'schedule.sharedSessionHint': 'Reuse workspace across runs to accumulate knowledge',
'schedule.shared': 'Shared',
'schedule.disableSharedSession': 'Disable shared session',
'schedule.enableSharedSession': 'Enable shared session',
'schedule.variables': 'Variables',
```

- [ ] **Step 3: Add Chinese translations**

```typescript
'schedule.sharedSession': '共享会话',
'schedule.sharedSessionHint': '跨次运行复用工作区以积累经验',
'schedule.shared': '共享',
'schedule.disableSharedSession': '禁用共享会话',
'schedule.enableSharedSession': '启用共享会话',
'schedule.variables': '变量',
```

- [ ] **Step 4: Verify frontend compiles**

Run:
```bash
cd frontend && npm run build
```

Expected: No TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/i18n/
git commit -m "feat(i18n): add translations for shared session and variable editing"
```

---

### Task 8: Integration Verification

- [ ] **Step 1: Verify backend starts**

Run:
```bash
cd backend && npm run dev
```

Expected: Server starts on port 3000 with no errors.

- [ ] **Step 2: Verify frontend starts**

Run:
```bash
cd frontend && npm run dev
```

Expected: Vite dev server starts on port 5173.

- [ ] **Step 3: Test schedule CRUD with new fields**

Using curl or the UI, verify:
1. Create a schedule with `useSharedSession: true` and `variables`
2. Update a schedule to toggle `useSharedSession`
3. List schedules returns `useSharedSession` and `variables` fields
4. Get schedule by ID returns all new fields

- [ ] **Step 4: Verify deterministic session ID**

Create a schedule with `useSharedSession: true`. Trigger it twice. Check that both workflow executions reference the same `chat_session_id`:

```bash
curl -s localhost:3000/api/schedules/{id}/records | jq '.data[].executionId'
# Then check each execution's chat_session_id
```

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: integration fixes for shared session feature"
```
