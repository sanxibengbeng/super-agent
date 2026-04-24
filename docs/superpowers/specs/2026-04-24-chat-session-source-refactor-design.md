# Chat Session Source Refactor & Claude Code Agent Seed

**Date:** 2026-04-24
**Status:** Draft
**Scope:** Backend schema, services, frontend project board + project creation

---

## Problem

The `chat_sessions.source` field is inconsistent and incomplete:

1. **Missing types**: Project workspace sessions and twin sessions default to `source = 'user'`, making them indistinguishable from regular user chat in queries and UI.
2. **No default agent scope**: Creating a project with "Default Claude Code Agent" sets `business_scope_id = null` and `agent_id = null`, which blocks issue execution (hard check in `project.service.ts:327`).
3. **Type/schema mismatch**: The TypeScript type says `'user' | 'workflow'` but the code actually writes `'workflow_copilot'` and `'scope_copilot'` — silently bypassing type checks via `as any`.
4. **Filter leaks**: `findByUser` and `getAllSessions` only exclude `source: 'workflow'`, so copilot, project, and twin sessions leak into the Chat page sidebar.
5. **Project Console is read-only**: The bottom Console panel polls chat history but has no input — users cannot interact with the project agent. The underlying `chat_sessions` + `/api/chat/stream` infrastructure already supports interaction; the Console just needs a send input.

---

## Design

### 1. Source Enum

Four values, categorized by **interaction mode**:

| `source` | Interaction Mode | Scenes |
|---|---|---|
| `chat` | User-initiated conversation | Chat page sessions |
| `copilot` | AI assistant embedded in an editor/workspace | Workflow Copilot, Scope Copilot, **Project workspace** |
| `execution` | System-triggered automation (no user interaction) | Workflow node execution |
| `twin_session` | User↔Agent collaboration bound to a project entity | Project twin sessions |

Business entity association lives in external tables (not in `source`):

| Scene | `source` | Entity table holding `session_id` |
|---|---|---|
| Normal chat | `chat` | None (managed from Chat page) |
| Workflow Copilot | `copilot` | Deterministic UUID via `computeWorkflowCopilotSessionId()` |
| Scope Copilot | `copilot` | Deterministic UUID via `computeScopeCopilotSessionId()` |
| Project workspace | `copilot` | `projects.workspace_session_id` |
| Workflow execution | `execution` | `workflow_executions` table |
| Twin session | `twin_session` | `project_twin_sessions.session_id` |

**Why Project workspace = `copilot`**: The project workspace session is a persistent, shared agent workspace for the project. All issues execute within it (shared file system, cumulative agent context). With this change, it also becomes interactive — users can chat with the project agent directly, not just watch execution logs. This matches the copilot pattern (embedded AI assistant within an editor/workspace).

### 2. Migration Mapping

| Current value | New value | Notes |
|---|---|---|
| `'user'` | `'chat'` | Default value change |
| `'workflow'` | `'execution'` | Workflow node execution |
| `'workflow_copilot'` | `'copilot'` | Workflow design copilot |
| `'scope_copilot'` | `'copilot'` | Scope generation copilot |
| _(missing)_ twin sessions | `'twin_session'` | Currently defaults to `'user'` |
| _(missing)_ project workspace | `'copilot'` | Currently defaults to `'user'` |

### 3. Claude Code Agent System Seed

A new system scope seeded per organization, following the existing `workflow-copilot` / `scope-copilot` pattern:

- **Seed file**: `seeds/system-copilots/claude-code-agent.json`
- **Scope**: name `"Claude Code Agent"`, `scope_type: "digital_twin"`, `origin: "system_seed"`
- **Agent**: name `"claude-code"`, role: full-stack software engineer
- Seeded on org creation (`organization.service.ts`) and on startup (`ensureAllOrgs`)

Frontend `Projects.tsx` `AgentScopeSelector`:
- Load scopes, find the one named `"Claude Code Agent"` with `scope_type = 'digital_twin'`
- Use it as the value behind "Default Claude Code Agent" option (instead of empty string)
- Result: `project.business_scope_id` and `project.agent_id` are always populated

### 4. Interactive Project Console

Transform the bottom Console panel from read-only log viewer to interactive chat, reusing the same infrastructure as `TwinSessionPanel`:

**Current state** (read-only):
- Polls `/api/chat/history/{sessionId}` every 3s
- Renders messages as monospace log entries (timestamp + arrow + text)
- No input field

**New state** (interactive):
- Same polling for history display
- Add input field + send button at the bottom
- Send messages via `POST /api/chat/stream` with `session_id = project.workspace_session_id` and `business_scope_id = project.business_scope_id`
- SSE streaming for real-time response display
- Keep the log-style rendering (not chat bubbles) to maintain the console aesthetic

**Backend**: No changes needed. The workspace session already has `business_scope_id` and `agent_id` set. `/api/chat/stream` accepts any valid `session_id` — it will route to the project's agent and scope context automatically.

**Frontend changes** (`ProjectBoard.tsx`):
- Add `<input>` + `<Send>` button in the Console footer (same pattern as `TwinSessionPanel.handleSend`)
- On send: POST to `/api/chat/stream`, stream SSE response, append messages to `consoleMessages`
- Disable input while `isSending` or while an issue is actively executing (check `consoleMessages` for generating status)

---

## Impact Audit

Every location where `chat_sessions.source` is read, written, or typed.

### WRITE locations (set the value)

| # | File | Line | Current Value | New Value | Risk |
|---|---|---|---|---|---|
| W1 | `prisma/schema.prisma` | 455 | `@default("user")` | `@default("chat")` | Migration required |
| W2 | `services/chat.service.ts` | 149 | `data.source ?? 'user'` | `data.source ?? 'chat'` | Low — fallback change |
| W3 | `services/workflow-executor-v2.ts` | 586 | `'workflow'` | `'execution'` | Low — isolated write |
| W4 | `services/workflow-executor-v2.ts` | 993 | `'workflow'` | `'execution'` | Low — same file |
| W5 | `routes/workflows.routes.ts` | 1085 | `'workflow_copilot'` | `'copilot'` | Low — isolated write |
| W6 | `routes/scope-generator.routes.ts` | 652 | `'scope_copilot'` | `'copilot'` | Low — isolated write |
| W7 | `services/project.service.ts` | 593-609 | _(no source set, defaults to 'user')_ | `source: 'copilot'` | Low — add field |
| W8 | `services/project-twin-session.service.ts` | 40-58 | _(no source set, defaults to 'user')_ | `source: 'twin_session'` | Low — add field |

### READ locations (filter/compare)

| # | File | Line | Current Logic | New Logic | Risk |
|---|---|---|---|---|---|
| R1 | `services/chat.service.ts` | 109 | `{ source: { not: 'workflow' } }` | `{ source: 'chat' }` | **Medium** — behavior change: previously included copilot sessions, now excludes them. This is the desired fix. |
| R2 | `repositories/chat.repository.ts` | 76 | `{ source: { not: 'workflow' } }` | `{ source: 'chat' }` | **Medium** — same as R1 |
| R3 | `repositories/chat.repository.ts` | 145 | `findByBusinessScope` — no source filter | No change (keep returning all types; frontend already handles display) | None |
| R4 | `frontend/.../SessionHistoryPanel.tsx` | 63 | `session.source === 'workflow'` | `session.source === 'execution'` | Low — category label change |
| R5 | `frontend/.../SessionHistoryPanel.tsx` | 256 | `session.source === 'workflow'` (icon) | `session.source === 'execution'` | Low — icon rendering |
| R6 | `frontend/.../SessionHistoryPanel.tsx` | 113 | `(s as any).source ?? 'user'` | `(s as any).source ?? 'chat'` | Low — default fallback |

### TYPE locations (definitions)

| # | File | Line | Current | New |
|---|---|---|---|---|
| T1 | `prisma/schema.prisma` | 455 | `// user \| workflow` | `// chat \| copilot \| execution \| twin_session` |
| T2 | `repositories/chat.repository.ts` | 24 | `'user' \| 'workflow'` | `'chat' \| 'copilot' \| 'execution' \| 'twin_session'` |
| T3 | `schemas/chat.schema.ts` | 26 | `z.string().max(20)` | `z.enum(['chat','copilot','execution','twin_session']).optional()` |

### UNRELATED `source` fields (no change needed)

These track **who triggered the LLM call** for billing/observability, not the chat session type. Values are intentionally different.

| File | Field | Values |
|---|---|---|
| `services/conversation-hooks.ts:22` | `ConversationHookContext.source` | `'chat' \| 'workflow' \| 'scope_generator'` |
| `services/token-usage.service.ts:16` | token usage input `.source` | `'chat' \| 'workflow' \| 'scope_generator'` |
| `prisma/schema.prisma:1602` | `token_usage_log.source` | VarChar(30) — separate table |

---

## Data Migration

```sql
-- 1. Remap old values to new enum
UPDATE chat_sessions SET source = 'chat'      WHERE source = 'user';
UPDATE chat_sessions SET source = 'execution'  WHERE source = 'workflow';
UPDATE chat_sessions SET source = 'copilot'    WHERE source = 'workflow_copilot';
UPDATE chat_sessions SET source = 'copilot'    WHERE source = 'scope_copilot';

-- 2. Backfill: existing twin sessions (now 'chat' from step 1, override to twin_session)
UPDATE chat_sessions SET source = 'twin_session'
WHERE id IN (SELECT session_id FROM project_twin_sessions);

-- 3. Backfill: existing project workspace sessions (now 'chat' from step 1, override to copilot)
UPDATE chat_sessions SET source = 'copilot'
WHERE id IN (SELECT workspace_session_id FROM projects WHERE workspace_session_id IS NOT NULL);

-- 4. Update default
ALTER TABLE chat_sessions ALTER COLUMN source SET DEFAULT 'chat';
```

Order matters: general remaps first (step 1), then specific backfills (steps 2-3) override.

---

## File Change Summary

| File | Change |
|---|---|
| **New** `seeds/system-copilots/claude-code-agent.json` | Claude Code Agent seed definition |
| `services/seed-copilot.service.ts` | Add `'claude-code-agent.json'` to `SEED_FILES` |
| `prisma/schema.prisma` | source default `'user'` → `'chat'`, comment update |
| `prisma/migrations/xxx` | Data migration SQL above |
| `repositories/chat.repository.ts` | Type: `'chat' \| 'copilot' \| 'execution' \| 'twin_session'`; `findByUser` filter: `source: 'chat'` |
| `services/chat.service.ts` | `createSession` default `'chat'`; `getAllSessions` filter `source: 'chat'` |
| `services/project.service.ts` | `ensureWorkspaceSession` add `source: 'copilot'` |
| `services/project-twin-session.service.ts` | `create()` add `source: 'twin_session'` |
| `services/workflow-executor-v2.ts` | `'workflow'` → `'execution'` (2 locations) |
| `routes/workflows.routes.ts` | `'workflow_copilot'` → `'copilot'` |
| `routes/scope-generator.routes.ts` | `'scope_copilot'` → `'copilot'` |
| `schemas/chat.schema.ts` | Zod enum validation |
| `frontend/.../SessionHistoryPanel.tsx` | `'workflow'` → `'execution'` in categorize + icon |
| `frontend/pages/Projects.tsx` | AgentScopeSelector default → Claude Code Agent scope |
| `frontend/pages/ProjectBoard.tsx` | Console panel: add input field + SSE send, reuse chat stream |
