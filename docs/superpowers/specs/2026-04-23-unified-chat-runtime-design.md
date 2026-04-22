# Unified Chat Runtime: Workflow Copilot & Scope Copilot

**Date:** 2026-04-23
**Status:** Draft
**Scope:** Backend + Frontend changes for Workflow Copilot and Scope Copilot only. No modifications to existing chat functionality.

---

## 1. Problem Statement

The platform has three scenarios that run Claude Agent SDK conversations:

| Scenario | Service | Session Resume | Message Persistence | Workspace |
|----------|---------|---------------|-------------------|-----------|
| Scope Chat | `chat.service.ts` | Yes (claude_session_id) | Yes (chat_sessions / chat_messages) | Persistent per-session directory |
| Workflow Copilot | `workflow-generator.service.ts` | No | No | None |
| Scope Copilot | `scope-copilot.service.ts` | No | No | Ephemeral temp directory |

Workflow Copilot and Scope Copilot each have their own runtime code that duplicates concerns already solved by `chat.service.ts`: session management, message persistence, SSE streaming, workspace provisioning, and SDK lifecycle. This creates three problems:

1. **No conversation history** — Workflow Copilot loses all context on page refresh. Scope Copilot is one-shot with no ability to iterate.
2. **Horizontal scaling blocked** — Each service manages in-memory state (abort controllers, concurrency counters, stream buffers). Multiple backend replicas break session resume, disconnect handling, and stream reconnection.
3. **Divergent code paths** — Bug fixes and improvements to the chat runtime (e.g., heartbeat, reconnection, Langfuse tracing) must be manually replicated to the other two services.

## 2. Design Principle: chat.service.ts as Universal Runtime

`chat.service.ts` is already the de facto runtime base. Five other modules consume it today: IM service, Project service, Project Governance, Workshop, and Enterprise Skill. Rather than abstracting a new layer, the approach is to **make Workflow Copilot and Scope Copilot additional consumers of `chatService.streamChat()`**.

This means:
- **chat.service.ts is not modified structurally** — it remains the universal runtime
- **Each scenario adapts to chat's conventions** — system agent, session binding, workspace, source field
- **All scenarios automatically gain** persistence, SSE streaming, stream registry, session resume, heartbeat, Langfuse tracing, and workspace management

## 3. System Agent Seed Mechanism

### 3.1 Concept

Workflow Copilot and Scope Copilot currently use hardcoded `AgentConfig` objects with inline system prompts. These are replaced by **real agent records in the database**, allowing:
- Customers to customize system agent behavior per organization
- System prompts to evolve through the standard agent editing UI
- Skills and MCP tools to be attached like any other agent

### 3.2 Seed Copilots

Each system copilot is a **digital twin scope** (`scope_type = 'digital_twin'`) with one agent underneath — the same pattern as user-created digital twins. The copilot scopes are org-level; every member can access them.

| Copilot | Scope Name | Agent `name` | Purpose |
|---------|-----------|-------------|---------|
| Workflow Copilot | Workflow Copilot | `workflow-copilot` | Design, modify, and analyze workflow DAG plans |
| Scope Copilot | Scope Copilot | `scope-copilot` | Generate and iteratively refine scope configurations |

### 3.3 Seed Template Location

Seed templates are defined in code at `backend/seeds/system-copilots/`:

```
backend/seeds/system-copilots/
  workflow-copilot.json    # { scope: { name, icon, color, ... }, agent: { name, displayName, role, systemPrompt, ... } }
  scope-copilot.json       # { scope: { name, icon, color, ... }, agent: { name, displayName, role, systemPrompt, ... } }
```

The agent `systemPrompt` content migrates from the existing `WORKFLOW_GENERATOR_SYSTEM_PROMPT` and `SCOPE_GENERATOR_SYSTEM_PROMPT` constants.

### 3.4 Injection Flow

```
Organization creation (or application startup for existing orgs)
  → For each seed copilot template:
    → Query: does this org have a digital_twin scope with this name?
      → No  → Create digital twin scope from seed template
              Create agent under the scope (reuses digital twin creation flow)
              Set agent origin = 'system_seed'
      → Yes → Skip (already exists, customer may have customized it)
```

### 3.5 Record Field Mapping

**Scope record (`business_scopes`):**

| Field | Value |
|-------|-------|
| `organization_id` | Target org ID |
| `name` | `Workflow Copilot` / `Scope Copilot` |
| `scope_type` | `digital_twin` |
| `icon` | Copilot-appropriate emoji |
| `description` | Brief description of the copilot's purpose |

**Agent record (`agents`):**

| Field | Value |
|-------|-------|
| `organization_id` | Target org ID |
| `business_scope_id` | The copilot scope ID created above |
| `name` | `workflow-copilot` / `scope-copilot` |
| `display_name` | Human-readable name |
| `role` | Brief role description |
| `system_prompt` | Migrated from existing hardcoded prompts |
| `origin` | `system_seed` (new value, distinguishes from `scope_generation`) |
| `model_config` | `{}` (uses platform default model) |

### 3.6 Upgrade Strategy

On new version deployment:
- Agents with `origin = 'system_seed'` whose `updated_at == created_at` → auto-upgrade to new seed template (overwrite system_prompt, skills, MCP servers, and all other config)
- Agents whose `updated_at > created_at` → skip (customer has made modifications, preserve customization)
- This covers the full agent configuration (prompt, skills, MCP, model_config) without needing per-field hash comparisons

## 4. Session Binding & Lifecycle

### 4.1 Design Principle: Deterministic Session IDs

Instead of creating sessions on demand and querying by composite keys, each scenario computes a **deterministic session ID** from its binding dimensions. This eliminates lookup queries and race conditions:

```
session_id = uuid_v5(namespace, binding_key)
```

Session ID computation happens on the **backend only** — the frontend passes binding parameters (e.g., `workflowId` + `version`, or `scopeId`), and the backend computes the deterministic UUID. This keeps the ID generation logic in one place.

When the frontend opens a copilot or generator panel:
- Send binding parameters to the backend
- Backend computes the deterministic session_id, creates or resumes the session

### 4.2 Workflow Copilot Session

**Binding:** `workflow_id` + `version`

```
session_id = deterministic(workflow_id + ":" + version)
```

| Field | Value |
|-------|-------|
| `session_id` | `uuid_v5(workflow_id + ":" + version)` |
| `source` | `workflow_copilot` |
| `agent_id` | `workflow-copilot` agent ID (under the Workflow Copilot digital twin scope) |
| `business_scope_id` | Workflow Copilot scope ID (the digital twin scope) |
| `user_id` | current user |

**Lifecycle:**
- Opening a workflow editor → compute session_id from workflow_id + current version → load or create
- Team members editing the same workflow version share the same session (collaborative history)
- Saving a new version → version string changes → next open computes a different session_id → fresh session
- Old version sessions remain as historical records, no cleanup action needed

### 4.3 Scope Copilot Session

**Binding:** `scope_id`

```
session_id = deterministic(scope_id + ":scope_copilot")
```

| Field | Value |
|-------|-------|
| `session_id` | `uuid_v5(scope_id + ":scope_copilot")` |
| `source` | `scope_copilot` |
| `agent_id` | `scope-copilot` agent ID (under the Scope Copilot digital twin scope) |
| `business_scope_id` | Scope Copilot scope ID (the digital twin scope) |
| `user_id` | current user |

**Lifecycle:**
- User clicks "Create Scope" → create empty scope record (get scope_id) → compute session_id → enter chat + config panel UI
- All subsequent scope editing (add agents, refine prompts, adjust skills) continues in the same session
- Session persists for the lifetime of the scope — full creation and evolution history in one thread

### 4.4 Source Field Extension

The existing `chat_sessions.source` field (varchar(20)) is extended with new values:

| Value | Scenario |
|-------|----------|
| `user` | Scope chat (existing) |
| `workflow` | Workflow execution chat (existing) |
| `workflow_copilot` | Workflow copilot session (new) |
| `scope_copilot` | Scope generator/editor session (new) |

No schema migration needed — the field is a varchar, not an enum.

## 5. Workspace Strategy

All three scenarios use the same workspace path convention managed by `WorkspaceManager`:

```
{baseDir}/{orgId}/{scopeId}/sessions/{sessionId}/
```

Since session IDs are deterministic (Section 4), workspace paths are also deterministic:

| Scenario | Workspace Path |
|----------|---------------|
| Scope Chat | `{baseDir}/{orgId}/{scopeId}/sessions/{chatSessionId}/` |
| Workflow Copilot | `{baseDir}/{orgId}/{scopeId}/sessions/{deterministic(workflowId+version)}/` |
| Scope Copilot | `{baseDir}/{orgId}/{scopeId}/sessions/{deterministic(scopeId+"scope_copilot")}/` |

Workspace content (CLAUDE.md, .claude/settings.json, skills, plugins) is provisioned by `WorkspaceManager.ensureSessionWorkspace()`. Two small extensions are needed:

- **Workflow Copilot sessions:** The workspace manager must write the workflow definition (nodes, connections) and the list of available agents into the session's `CLAUDE.md` so the copilot agent has context. This is driven by the `source` field — when `source = 'workflow_copilot'`, the route layer passes workflow data to the workspace manager before calling `chatService.streamChat()`.
- **Scope Copilot sessions:** The workspace manager must write the current scope configuration into `CLAUDE.md`. When the user uploads an SOP document, it is placed in the workspace directory before the chat stream starts.

These are additive — the existing workspace provisioning logic for scope chat sessions is unchanged.

## 6. Migration Plan: Workflow Copilot

### 6.1 What Gets Removed

- `backend/src/services/workflow-generator.service.ts` — entire file
- Route handlers in `workflows.routes.ts` for `/generate`, `/modify`, `/patch` that directly call `workflowGeneratorService`

### 6.2 What Gets Added/Changed

**Backend:**
- Seed template: `backend/seeds/system-agents/workflow-copilot.json`
- Seed injection logic in startup / org creation
- New route handlers (or modified existing ones) that call `chatService.streamChat()` with:
  - `source: 'workflow_copilot'`
  - `agent_id`: workflow-copilot agent (under Workflow Copilot digital twin scope)
  - `business_scope_id`: workflow's parent scope
  - Deterministic `session_id` from workflow_id + version
- The existing `WORKFLOW_GENERATOR_SYSTEM_PROMPT` and `WORKFLOW_PATCH_SYSTEM_PROMPT` migrate to the seed agent's `system_prompt`

**Frontend:**
- `WorkflowCopilot.tsx` — replace direct SSE fetch to `/api/workflows/generate` and `/api/workflows/modify` with calls to the standard chat stream endpoint (`/api/chat/stream`)
- Load and display chat history from the persistent session on editor open
- Frontend passes `workflowId` + `version` to the backend; backend computes the deterministic session_id

### 6.3 Special Logic Migration

| Current Logic | New Location |
|--------------|-------------|
| `WORKFLOW_GENERATOR_SYSTEM_PROMPT` + `WORKFLOW_PATCH_SYSTEM_PROMPT` | Merged into a single system agent `system_prompt` in DB. The agent dynamically determines whether to generate a new workflow or modify the existing one based on workspace context — if the workspace already contains a workflow definition (nodes/connections), it operates in modification mode; otherwise it generates from scratch. |
| `parseGeneratedPlan()` / `parsePatches()` | Frontend — parse JSON from chat message content (same as current `WorkflowCopilot.tsx` already does) |
| `fixUnescapedControlChars()` | Removed — resolved through prompt optimization in the merged system prompt |
| Available agents context injection | Written into workspace CLAUDE.md by workspace manager |

## 7. Migration Plan: Scope Copilot

### 7.1 What Gets Removed

- `backend/src/services/scope-copilot.service.ts` — entire file
- Route handlers in `business-scopes.routes.ts` (or wherever `/generate`, `/generate-with-document`, `/generate/confirm` are defined) that directly call `scopeGeneratorService`

### 7.2 What Gets Added/Changed

**Backend:**
- Seed template: `backend/seeds/system-agents/scope-copilot.json`
- New routes that:
  1. Create an empty scope record first (get scope_id)
  2. Call `chatService.streamChat()` with deterministic session_id, `source: 'scope_copilot'`
- SOP document upload: place document in the session workspace before starting the chat stream (workspace manager handles the directory)

**Frontend:**
- New UI: left panel = chat (standard chat component), right panel = scope configuration preview
- Replace the current one-shot generation flow with persistent chat interaction
- Load chat history on re-opening scope editor
- Parse `scope-config.json` output from chat messages to update the right panel

### 7.3 Special Logic Migration

| Current Logic | New Location |
|--------------|-------------|
| `SCOPE_GENERATOR_SYSTEM_PROMPT` + language instructions | System agent `system_prompt` in DB (language preference passed via user message or workspace context) |
| `validateScopeConfigJson()` | Removed — validation responsibility moves into the agent's system prompt |
| Repair loop (re-ask agent to fix invalid JSON) | Built into the system prompt: agent must self-validate its JSON output before writing to file, and self-repair if invalid. No external repair loop needed. |
| `scope-config.json` file extraction strategies | Simplified — agent writes to workspace file, workspace persists across turns |
| `/generate/confirm` endpoint | Replaced by standard scope CRUD — scope already exists, agent output updates it directly |

## 8. Frontend Interaction Changes

### 8.1 Workflow Editor

**Before:** Copilot panel with ephemeral in-memory chat, custom SSE endpoints
**After:** Copilot panel backed by standard chat session, same `/api/chat/stream` endpoint

```
Open workflow editor
  → GET /api/chat/messages?workflow_id={id}&version={version}&source=workflow_copilot
    (backend computes deterministic session_id, returns messages)
    → Has history → render messages
    → No history → show empty copilot panel
  → User sends message → POST /api/chat/stream with workflow_id + version
    (backend computes session_id, creates/resumes session)
  → Parse workflow JSON from assistant messages → update canvas
```

### 8.2 Scope Copilot / Editor

**Before:** One-shot generation wizard → confirm → create scope. Editing after creation uses form-based CRUD, no AI assistance.
**After:** Persistent chat + live config panel, used for both creation and ongoing editing.

**Creating a new scope:**
```
User clicks "Create Scope"
  → POST /api/business-scopes (create empty scope, get scope_id)
  → Render: left = chat panel, right = config preview (empty)
  → User describes business → POST /api/chat/stream with scope_id + source=scope_copilot
    (backend computes deterministic session_id from scope_id)
  → Agent generates config → right panel updates live
  → User iterates ("add another agent", "change the color") → continues in same session
  → User clicks "Save" → PATCH /api/business-scopes/{id} with current config
```

**Editing an existing scope:**
```
User opens scope settings / clicks "Edit Scope"
  → Same UI: left = chat panel (with full history), right = current config
  → Backend loads existing session (deterministic session_id from scope_id)
  → Current scope configuration is written into workspace CLAUDE.md so the agent has context
  → User requests changes via chat ("add a new agent for customer support", "update the system prompt for agent X")
  → Agent modifies config → right panel updates live
  → User clicks "Save" → PATCH /api/business-scopes/{id}
```

The creation and editing flows share the same session, same UI, and same copilot agent. Re-opening scope settings at any time resumes the conversation with full history.

## 9. What Is NOT Changed

- `chat.service.ts` — no structural modifications
- `ChatService.streamChat()` — no API changes
- Existing scope chat sessions (`source = 'user'`) — unaffected
- Existing workflow execution sessions (`source = 'workflow'`) — unaffected
- IM service, Project service, Workshop, Enterprise Skill — all existing chatService consumers unaffected
- `AgentRuntime` abstraction layer — unchanged
- WebSocket gateway — unchanged
- Database schema — no new columns or tables (only new `source` values and new agent records)

## 10. Future Considerations (Out of Scope)

- **Workflow execution history MCP tool** — query execution results from within copilot. Blocked on cross-session permission model design.
- **Horizontal scaling improvements** — Redis-based concurrency control, stream registry migration to Redis Pub/Sub. Enabled by this unification (all scenarios now go through one code path) but not part of this change.
- **System agent version management** — UI for comparing seed vs customized prompts, selective rollback. Deferred until customer customization patterns are observed.
