# Scope Copilot — Split-Pane Redesign

## Summary

Redesign the `/create-business-scope/ai` page from a single-column chat-only flow into a split-pane Scope Copilot matching the Workflow Editor pattern. Fix the core bug where AI-generated scope configuration is never persisted because the SSE → JSON parse → confirm flow breaks silently.

## Problems Solved

1. **Scope not created after chat**: AI generates config and says "created" in chat, but the `scope_config` SSE event / JSON parse often fails silently, so the confirm UI never appears and no database write occurs.
2. **Poor UX**: Single-column layout gives no workspace preview; user can't see generated scope alongside chat.
3. **No persistence across refresh**: Closing the tab loses all generated configuration.
4. **No incremental editing**: User must regenerate entirely to make changes.

## Architecture Change

### Route & Data Model Change

**Before:**
- `/create-business-scope` → wizard page → navigate to `/create-business-scope/ai` with nav state
- `/create-business-scope/ai` is a full-page route (no AppShell)
- Scope only created at the very end via `/generate/confirm`

**After:**
- `/create-business-scope` → wizard page → **create empty scope via API** → get `scopeId`
- Navigate to `/create-business-scope/ai?scopeId=xxx`
- This page is **inside AppShell** (left nav sidebar preserved)
- Scope already exists in DB (empty); this page fills it in via AI + manual edits
- **Same URL for editing existing scopes** — dashboard can link directly to edit

### New Backend Endpoints

All scope copilot endpoints live under `/api/scope-generator`:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/scope-generator/generate` | POST | First-time AI generation (existing) |
| `/api/scope-generator/modify` | POST | AI modification of existing config (new) |
| `/api/scope-generator/save` | POST | Save full config to DB (new, replaces `/generate/confirm`) |

**`POST /api/scope-generator/modify`** — AI-powered modification of existing scope config.

Accepts: `{ scopeConfig: GeneratedScopeConfig, modificationRequest: string, history?: ChatMessage[] }`

Returns: SSE stream with either:
- Full replacement JSON (for large changes)
- Patch array `[{op, path, value}]` (for targeted changes)

The frontend detects the response type and applies accordingly.

**`POST /api/scope-generator/save`** — Persist the complete scope + agents + skills to the database.

Accepts: `{ scopeId: string, config: GeneratedScopeConfig }`

Logic:
- Updates scope fields (name, description, icon, color)
- Upserts agents (create new, update existing, delete removed)
- Upserts skills per agent (create new, update existing, delete removed)
- All within a Prisma transaction
- Returns the full updated scope with agents

The old `/generate/confirm` endpoint remains for backward compatibility.

## Frontend Components

### Page: ScopeCopilotPage

**File:** `frontend/src/pages/ScopeCopilotPage.tsx`
**Route:** `/create-business-scope/ai` (inside AppShell)

Orchestrates the split-pane layout:

```
┌──────┬─────────────────────────────────┬──────────────┐
│ App  │         ScopeWorkspace          │  ScopeCopilot│
│ Shell│  ┌───────────────────────────┐  │  (chat)      │
│ side │  │   Scope Overview Card     │  │              │
│ bar  │  ├───────────────────────────┤  │  [user msg]  │
│      │  │   Agent Grid (2×N)        │  │  [ai reply]  │
│      │  │   ┌─────┐ ┌─────┐        │  │  [user msg]  │
│      │  │   │ Ag1 │ │ Ag2 │        │  │  [ai reply]  │
│      │  │   └─────┘ └─────┘        │  │              │
│      │  │   ┌─────┐ ┌─────┐        │  │              │
│      │  │   │ Ag3 │ │ Ag4 │        │  │              │
│      │  │   └─────┘ └─────┘        │  │              │
│      │  ├───────────────────────────┤  │              │
│      │  │   Selected Agent Detail   │  │              │
│      │  │   (progressive disclosure)│  │              │
│      │  └───────────────────────────┘  │  [input box] │
│      │  ┌───────────────────────────┐  │              │
│      │  │ v3 · 2min ago    Start over│  │              │
│      │  └───────────────────────────┘  │              │
└──────┴─────────────────────────────────┴──────────────┘
```

**Header bar:** Back button + "Scope Copilot" + scope name + unsaved indicator + Save button

**State management:**
- `scopeId` from URL query param
- `scopeDraft` — current working state (scope + agents + skills)
- `selectedAgentId` — which agent detail is expanded
- `isDirty` — tracks unsaved changes
- `versions` — LocalStorage version history

**On mount:**
1. Read `scopeId` from URL query param; if missing → redirect to `/create-business-scope`
2. Fetch scope from API to validate it exists; if 404 → redirect to `/create-business-scope`
3. Check LocalStorage for draft `scopeDraft:{scopeId}`
4. If draft exists and `lastModified` > scope `updatedAt` → load draft, show "unsaved changes"
5. Else → use API data, populate workspace

### Component: ScopeWorkspace

**File:** `frontend/src/components/ScopeWorkspace.tsx`

Left panel workspace with three sections:

1. **Scope Overview Card** (top)
   - Shows icon, name, description, color
   - Click "Edit" → inline editable fields
   - Changes update `scopeDraft` + mark dirty

2. **Agent Grid** (middle, scrollable)
   - 2-column grid of agent summary cards
   - Each card: avatar, displayName, skill count
   - Click to select → detail panel appears below
   - "+ Add" button to create empty agent

3. **Agent Detail Panel** (below grid, when selected)
   - Progressive disclosure: appears when agent is clicked
   - Read-only by default: role, system prompt (truncated), skills list
   - Edit button → inline editable fields
   - Delete button → removes agent from draft
   - Skills shown as compact list with name + description

4. **Version Bar** (bottom, fixed)
   - Left: version indicator `v3 · 2 min ago`, click to expand version history panel
   - Right: "Start over" link — resets draft to empty scope (v0), clears chat history, creates a new version snapshot
   - Version history panel slides up from bottom when clicked

### Component: ScopeCopilot

**File:** `frontend/src/components/ScopeCopilot.tsx`

Right panel chat, modeled on `WorkflowCopilot.tsx`:

- Chat message list with user/assistant bubbles
- SSE streaming with text + tool_use block rendering
- Input textarea with Enter to send
- Chat history persisted in LocalStorage `scopeDraft:{scopeId}.chatHistory` — survives refresh

**Chat modes:**

1. **Generate mode** (no agents in draft yet):
   - Sends to `POST /api/scope-generator/generate` (existing endpoint)
   - On receiving `scope_config` or parsing JSON from stream → update `scopeDraft`
   - Falls back to extracting JSON from assistant text blocks

2. **Modify mode** (agents already exist in draft):
   - Sends to `POST /api/scope-generator/modify` (new endpoint)
   - Sends current `scopeDraft` + modification request + chat history
   - Response is either full JSON replacement or patch array
   - Frontend detects format and applies to `scopeDraft`

**On generation/modification complete:**
- Update `scopeDraft` state
- Auto-create version snapshot
- Mark as dirty

### Hook: useScopeDraft

**File:** `frontend/src/hooks/useScopeDraft.ts`

Central state management for the scope draft:

```typescript
interface ScopeDraft {
  scope: GeneratedScope;
  agents: AgentDraft[];
}

interface AgentDraft extends GeneratedAgent {
  id?: string;         // DB id if already persisted
  _localId: string;    // stable local identifier
  _deleted: boolean;   // soft delete
}

interface VersionSnapshot {
  version: number;
  label: string;
  timestamp: number;
  source: 'created' | 'ai-generated' | 'ai-modified' | 'manual-edit' | 'saved';
  data: ScopeDraft;
}
```

**Responsibilities:**
- Hold `scopeDraft` state
- Sync to LocalStorage on every change: `scopeDraft:{scopeId}`
- Track dirty state (draft differs from last saved)
- Version management:
  - `createSnapshot(label, source)` — push to `scopeVersions:{scopeId}`
  - `loadVersion(version)` — restore draft from snapshot
  - `getVersions()` — list all snapshots
  - Auto-prune to last 20 versions
- `applyFullConfig(config)` — replace entire draft (from AI generation)
- `applyPatches(patches)` — apply JSON patches (from AI modification)
- `updateScope(fields)` — manual scope field edits
- `updateAgent(localId, fields)` — manual agent edits
- `addAgent()` / `removeAgent(localId)` — add/remove agents
- `save()` — call `POST /api/scope-generator/save` → clear dirty → create "saved" snapshot

## Backend Changes

All new endpoints are added to the existing `scope-generator.routes.ts`.

### POST /api/scope-generator/save

**Auth:** JWT required
**Body:**
```typescript
{
  scopeId: string,
  config: {
    scope: { name, description, icon, color },
    agents: [{
      id?: string,              // existing agent ID (for update)
      name: string,
      displayName: string,
      role: string,
      systemPrompt: string,
      _deleted?: boolean,       // true = delete this agent
      skills?: [{
        id?: string,            // existing skill ID
        name: string,
        description: string,
        body: string,
        _deleted?: boolean,
      }]
    }]
  }
}
```

**Logic:**
1. Update scope record
2. For each agent:
   - If `id` present + `_deleted` → delete agent + its skills
   - If `id` present → update agent
   - If no `id` → create agent
3. For each agent's skills: same create/update/delete logic
4. All in a Prisma transaction
5. Return updated scope with full agent + skill tree

### POST /api/scope-generator/modify

**Auth:** JWT required
**Body:**
```typescript
{
  scopeConfig: GeneratedScopeConfig,
  modificationRequest: string,
  history?: Array<{ role: 'user' | 'assistant', content: string }>
}
```

**Response:** SSE stream (same format as `/generate`)

**System prompt:** Instructs the AI to return either:
- A full JSON replacement (if the change is large / structural)
- A JSON patch array `[{op: "replace", path: "/agents/1/role", value: "..."}]` (if targeted)

The AI decides which format based on the scope of the modification.

### Empty Scope Creation

Modify the existing `POST /api/business-scopes` endpoint (or the `/create-business-scope` wizard flow) to allow creating a scope with just a name. The scope is created with `status: 'draft'` or equivalent, so it doesn't appear in active scope lists until it has content.

## LocalStorage Schema

```typescript
// Current draft state
localStorage.setItem(`scopeDraft:${scopeId}`, JSON.stringify({
  scope: GeneratedScope,
  agents: AgentDraft[],
  chatHistory: ChatMessage[],   // preserve chat across refresh
  lastModified: number,         // timestamp
}))

// Version history
localStorage.setItem(`scopeVersions:${scopeId}`, JSON.stringify(
  VersionSnapshot[]             // max 20, auto-pruned
))
```

## Routing Changes

**Before (App.tsx):**
```tsx
// Full-page routes (no AppShell)
<Route path="/create-business-scope" element={<CreateBusinessScope />} />
<Route path="/create-business-scope/ai" element={<AIScopeGenerator />} />
```

**After (App.tsx):**
```tsx
// Full-page route (no AppShell) — wizard only
<Route path="/create-business-scope" element={<CreateBusinessScope />} />

// Inside AppShell
<Route path="/create-business-scope/ai" element={<ScopeCopilotPage />} />
```

The wizard page (`CreateBusinessScope`) remains full-page. After the wizard creates an empty scope, it navigates to the copilot page which is inside AppShell.

## Migration

- The old `AIScopeGenerator` component is replaced by `ScopeCopilotPage`
- The old `/generate/confirm` endpoint is kept but no longer called by the copilot
- `CreateBusinessScope` page updated to create empty scope before navigating
- `scopeGeneratorService.ts` (frontend) updated with new `modifyScope()` function

## Files to Create

| File | Purpose |
|------|---------|
| `frontend/src/pages/ScopeCopilotPage.tsx` | Split-pane orchestrator page |
| `frontend/src/components/ScopeWorkspace.tsx` | Left panel: scope dashboard + agent grid + detail |
| `frontend/src/components/ScopeCopilot.tsx` | Right panel: chat with generate/modify modes |
| `frontend/src/hooks/useScopeDraft.ts` | Draft state, LocalStorage sync, version management |

## Files to Modify

| File | Change |
|------|--------|
| `frontend/src/App.tsx` | Move `/create-business-scope/ai` inside AppShell, point to new page |
| `frontend/src/pages/CreateBusinessScope.tsx` | Create empty scope on submit, navigate with scopeId |
| `frontend/src/services/scopeGeneratorService.ts` | Add `modifyScope()`, `saveScopeConfig()` functions |
| `backend/src/routes/scope-generator.routes.ts` | Add `/modify` SSE endpoint + `/save` endpoint |
| `backend/src/services/scope-generator.service.ts` | Add `modify()` generator method + `saveFullConfig()` method |
| `frontend/src/components/index.ts` | Export new components, remove old AIScopeGenerator export |
