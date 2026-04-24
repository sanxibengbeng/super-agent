# Claude Code Agent Seed & Project Session Source

**Date:** 2026-04-24
**Status:** Draft
**Scope:** Backend seed, project session source, frontend project creation

---

## Problem

1. Creating a project with "Default Claude Code Agent" sets `business_scope_id = null` and `agent_id = null`, which blocks issue execution (`project.service.ts:327` requires scope).
2. Project workspace sessions and twin sessions use `source = 'user'` (default), making them indistinguishable from regular chat in the session list.

## Changes

### 1. New System Seed: Claude Code Agent

Follow the existing `workflow-copilot` / `scope-copilot` pattern:

**`seeds/system-copilots/claude-code-agent.json`**:
- Scope: `name: "Claude Code Agent"`, `scope_type: "digital_twin"`
- Agent: `name: "claude-code"`, `origin: "system_seed"`

**`services/seed-copilot.service.ts`**:
- Add `'claude-code-agent.json'` to `SEED_FILES` array

Seeded automatically on org creation and startup via existing `ensureAllOrgs()`.

### 2. Add `source = 'project'`

New value for project-related sessions. No changes to existing values.

| Existing values (unchanged) | Usage |
|---|---|
| `'user'` | Regular chat (default) |
| `'workflow'` | Workflow node execution |
| `'workflow_copilot'` | Workflow Copilot |
| `'scope_copilot'` | Scope Copilot |

| New value | Usage | Cardinality |
|---|---|---|
| `'project'` | Project workspace session | One per project (`projects.workspace_session_id`) |
| `'twin_session'` | Twin session (per issue/agent) | Many per project (`project_twin_sessions.session_id`) |

**Write points**:

| File | Change |
|---|---|
| `services/project.service.ts` `ensureWorkspaceSession()` | Add `source: 'project'` to `chat_sessions.create()` |
| `services/project-twin-session.service.ts` `create()` | Add `source: 'twin_session'` to `chat_sessions.create()` |

No migration needed — only new sessions get the value. Existing sessions keep `'user'`.

### 3. Frontend: Default to Claude Code Agent Scope

**`pages/Projects.tsx` `AgentScopeSelector`**:
- On load, find scope where `name === 'Claude Code Agent'` and `scopeType === 'digital_twin'`
- Use its `id` as the default value for the "Default Claude Code Agent" option
- When user selects this default: `onSelectScope(claudeCodeScopeId)` instead of `onSelectScope('')`
- Result: `project.business_scope_id` and `project.agent_id` are always populated

---

## File Change Summary

| File | Change |
|---|---|
| **New** `seeds/system-copilots/claude-code-agent.json` | Seed definition |
| `services/seed-copilot.service.ts` | `SEED_FILES` += `'claude-code-agent.json'` |
| `services/project.service.ts` | `ensureWorkspaceSession`: add `source: 'project'` |
| `services/project-twin-session.service.ts` | `create()`: add `source: 'twin_session'` |
| `frontend/pages/Projects.tsx` | AgentScopeSelector default → Claude Code Agent scope |
