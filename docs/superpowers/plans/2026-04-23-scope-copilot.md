# Scope Copilot Split-Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign `/create-business-scope/ai` from a broken single-column chat into a split-pane Scope Copilot (left workspace + right chat) that reliably generates, previews, edits, and persists business scopes.

**Architecture:** Split-pane page inside AppShell. Left panel shows a scope dashboard (overview card + agent grid + agent detail). Right panel is a chat copilot. A `useScopeDraft` hook manages state, LocalStorage persistence, and version history. Two new backend endpoints handle saving and AI modification.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, Fastify 5, Prisma, SSE streaming, LocalStorage

**Spec:** `docs/superpowers/specs/2026-04-23-scope-copilot-design.md`

---

### Task 1: Backend — POST /api/scope-generator/save endpoint

**Files:**
- Modify: `backend/src/routes/scope-generator.routes.ts`
- Modify: `backend/src/services/scope-generator.service.ts`

This endpoint persists the full scope + agents + skills configuration to the database. It replaces the old `/generate/confirm` for the copilot flow.

- [ ] **Step 1: Add `saveFullConfig` method to scope-generator service**

In `backend/src/services/scope-generator.service.ts`, add this method to the `ScopeGeneratorService` class. Place it after the existing `generate` method. You'll need to import the services at the top of the file:

```typescript
import { businessScopeService } from './businessScope.service.js';
import { agentService } from './agent.service.js';
import { skillService } from './skill.service.js';
```

Add this method to the class:

```typescript
async saveFullConfig(
  scopeId: string,
  config: GeneratedScopeConfig,
  organizationId: string,
): Promise<{ scope: Record<string, unknown>; agents: Array<Record<string, unknown>> }> {
  // 1. Update scope fields
  const scope = await businessScopeService.updateBusinessScope(
    scopeId,
    {
      name: config.scope.name,
      description: config.scope.description,
      icon: config.scope.icon,
      color: config.scope.color,
    },
    organizationId,
  );

  // 2. Upsert agents
  const resultAgents: Array<Record<string, unknown>> = [];

  for (const agentDef of config.agents) {
    const isDeleted = (agentDef as Record<string, unknown>)._deleted === true;
    const existingId = (agentDef as Record<string, unknown>).id as string | undefined;

    if (existingId && isDeleted) {
      await agentService.deleteAgent(existingId, organizationId);
      continue;
    }

    let agent: { id: string; name: string; display_name: string; role: string; avatar?: string | null };

    if (existingId) {
      agent = await agentService.updateAgent(
        existingId,
        {
          name: agentDef.name,
          display_name: agentDef.displayName,
          role: agentDef.role,
          system_prompt: agentDef.systemPrompt,
        },
        organizationId,
      );
    } else {
      agent = await agentService.createAgent(
        {
          name: agentDef.name,
          display_name: agentDef.displayName,
          role: agentDef.role,
          business_scope_id: scopeId,
          system_prompt: agentDef.systemPrompt,
          status: 'active',
          metrics: {},
          tools: [],
          scope: [],
          model_config: {},
        },
        organizationId,
      );
    }

    // 3. Upsert skills
    const skills = agentDef.skills ?? [];
    for (const skillDef of skills) {
      const skillDeleted = (skillDef as Record<string, unknown>)._deleted === true;
      const skillId = (skillDef as Record<string, unknown>).id as string | undefined;

      if (skillId && skillDeleted) {
        await skillService.deleteSkill(organizationId, skillId);
        continue;
      }

      if (skillId) {
        // Update existing skill metadata
        await skillService.updateSkill(organizationId, skillId, {
          name: skillDef.name,
          description: skillDef.description,
          metadata: { body: skillDef.body, generatedBy: 'scope-generator' },
        });
      } else {
        const skill = await skillService.createSkill(organizationId, {
          name: skillDef.name,
          display_name: skillDef.name.replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
          description: skillDef.description,
          metadata: { body: skillDef.body, generatedBy: 'scope-generator' },
        });
        await skillService.assignSkillToAgent(organizationId, agent.id, skill.id);
      }
    }

    resultAgents.push({
      id: agent.id,
      name: agent.name,
      displayName: agent.display_name,
      role: agent.role,
      avatar: agent.avatar ?? null,
    });
  }

  return {
    scope: {
      id: scope.id,
      name: scope.name,
      description: scope.description,
      icon: scope.icon,
      color: scope.color,
    },
    agents: resultAgents,
  };
}
```

- [ ] **Step 2: Add `/save` route**

In `backend/src/routes/scope-generator.routes.ts`, add this route inside the `scopeGeneratorRoutes` function, after the existing `/generate/confirm` endpoint. The file already imports `businessScopeService`, `agentService`, `skillService`, and `authenticate`.

Add this interface near the existing `ConfirmBody` interface:

```typescript
interface SaveBody {
  Body: {
    scopeId: string;
    config: GeneratedScopeConfig;
  };
}
```

Add this route:

```typescript
fastify.post<SaveBody>('/save', { preHandler: [authenticate] }, async (request: FastifyRequest<SaveBody>, reply: FastifyReply) => {
  const { scopeId, config } = request.body;
  const orgId = request.user!.orgId;

  if (!scopeId || !config?.scope || !config?.agents) {
    return reply.status(400).send({ error: 'scopeId and config (scope + agents) are required', code: 'INVALID_INPUT' });
  }

  try {
    const result = await scopeGeneratorService.saveFullConfig(scopeId, config, orgId);
    return reply.status(200).send({ data: result });
  } catch (error) {
    console.error('[scope-generator] Save error:', error);
    return reply.status(500).send({
      error: error instanceof Error ? error.message : 'Save failed',
      code: 'SAVE_ERROR',
    });
  }
});
```

- [ ] **Step 3: Verify the endpoint works**

Run: `cd backend && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/scope-generator.routes.ts backend/src/services/scope-generator.service.ts
git commit -m "feat(backend): add POST /api/scope-generator/save endpoint"
```

---

### Task 2: Backend — POST /api/scope-generator/modify endpoint

**Files:**
- Modify: `backend/src/services/scope-generator.service.ts`
- Modify: `backend/src/routes/scope-generator.routes.ts`

This endpoint accepts the current scope config + a modification request, calls the AI, and streams back either a full replacement JSON or a patch array.

- [ ] **Step 1: Add modification system prompt constant**

In `backend/src/services/scope-generator.service.ts`, add this constant after the existing `LANGUAGE_INSTRUCTIONS` object (around line 123):

```typescript
const SCOPE_MODIFIER_SYSTEM_PROMPT = `You are a business scope configuration modifier. You will receive the current scope configuration as JSON and a modification request from the user.

RULES:
1. For SMALL, TARGETED changes (rename an agent, change a role, update a description, add/remove a single skill), respond with a JSON PATCH ARRAY:
   \`\`\`json
   [
     {"op": "replace", "path": "/agents/0/displayName", "value": "New Name"},
     {"op": "replace", "path": "/agents/0/role", "value": "New role description"}
   ]
   \`\`\`
   Supported ops: "replace" (update a field), "add" (add to array), "remove" (remove from array by index).
   Paths use JSON Pointer format: /scope/name, /agents/0/displayName, /agents/0/skills/1/body, etc.

2. For LARGE, STRUCTURAL changes (add multiple agents, reorganize skills across agents, change the overall scope purpose), respond with the COMPLETE updated JSON configuration:
   \`\`\`json
   {
     "scope": { "name": "...", "description": "...", "icon": "...", "color": "..." },
     "agents": [...]
   }
   \`\`\`

3. ALWAYS wrap your JSON output in a markdown code fence (\`\`\`json ... \`\`\`).
4. You may include a brief explanation BEFORE the JSON code fence, but the JSON must be parseable.
5. Preserve all existing fields that are not being changed.
6. Agent names must be kebab-case. Skills names must be kebab-case.
`;
```

- [ ] **Step 2: Add `modify` async generator method**

In the `ScopeGeneratorService` class, add this method after `saveFullConfig`:

```typescript
async *modify(
  scopeConfig: GeneratedScopeConfig,
  modificationRequest: string,
  history?: Array<{ role: 'user' | 'assistant'; content: string }>,
  language?: string,
): AsyncGenerator<ConversationEvent & { content?: unknown }> {
  const tempWorkspace = await mkdtemp(join(tmpdir(), 'scope-mod-'));
  const sessionId = `scope-mod-${Date.now()}`;

  try {
    const systemPrompt = SCOPE_MODIFIER_SYSTEM_PROMPT + '\n' + LANGUAGE_INSTRUCTIONS[language === 'cn' ? 'cn' : 'en'];

    const agentConfig: AgentConfig = {
      systemPrompt,
      model: 'claude-sonnet-4-5-20250929',
      maxTurns: 3,
      tools: [],
      mcpServers: [],
      permissions: [],
    };

    const currentConfigJson = JSON.stringify(scopeConfig, null, 2);
    const message = `Current scope configuration:\n\`\`\`json\n${currentConfigJson}\n\`\`\`\n\nModification request: ${modificationRequest}`;

    yield { type: 'session_start', sessionId } as ConversationEvent & { content?: unknown };

    for await (const event of agentRuntime.runConversation(
      {
        agentId: 'scope-modifier',
        sessionId,
        message,
        organizationId: 'system',
        userId: 'system',
        workspacePath: tempWorkspace,
        scopeId: 'system',
        history: history?.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
      },
      agentConfig,
      [],
    )) {
      yield event as ConversationEvent & { content?: unknown };
    }
  } finally {
    try { await rm(tempWorkspace, { recursive: true }); } catch { /* ignore */ }
  }
}
```

- [ ] **Step 3: Add `/modify` route**

In `backend/src/routes/scope-generator.routes.ts`, add this interface:

```typescript
interface ModifyBody {
  Body: {
    scopeConfig: GeneratedScopeConfig;
    modificationRequest: string;
    history?: Array<{ role: 'user' | 'assistant'; content: string }>;
    language?: string;
  };
}
```

Add this route after the `/save` route:

```typescript
fastify.post<ModifyBody>('/modify', { preHandler: [authenticate] }, async (request: FastifyRequest<ModifyBody>, reply: FastifyReply) => {
  const { scopeConfig, modificationRequest, history, language } = request.body;

  if (!scopeConfig || !modificationRequest?.trim()) {
    return reply.status(400).send({ error: 'scopeConfig and modificationRequest are required', code: 'INVALID_INPUT' });
  }

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });

  let clientDisconnected = false;
  reply.raw.on('close', () => { clientDisconnected = true; });

  const heartbeat = setInterval(() => {
    if (!clientDisconnected) {
      try { reply.raw.write(formatSSEEvent({ data: JSON.stringify({ type: 'heartbeat' }) })); }
      catch { /* disconnected */ }
    }
  }, 15_000);

  try {
    const generator = scopeGeneratorService.modify(scopeConfig, modificationRequest.trim(), history, language);

    for await (const event of generator) {
      if (clientDisconnected) break;

      const sseData: Record<string, unknown> = { type: event.type };

      if (event.type === 'session_start') {
        sseData.sessionId = event.sessionId;
      } else if (event.type === 'assistant' || event.type === 'result') {
        sseData.content = event.content;
      } else if (event.type === 'error') {
        sseData.code = (event as ConversationEvent & { code?: string }).code;
        sseData.message = (event as ConversationEvent & { message?: string }).message;
      }

      reply.raw.write(formatSSEEvent({ data: JSON.stringify(sseData) }));
    }
  } catch (error) {
    console.error('[scope-generator] Modify SSE error:', error);
    if (!clientDisconnected) {
      reply.raw.write(formatSSEEvent({
        data: JSON.stringify({
          type: 'error',
          code: 'MODIFY_ERROR',
          message: error instanceof Error ? error.message : 'Modification failed',
        }),
      }));
    }
  } finally {
    clearInterval(heartbeat);
    if (!clientDisconnected) {
      try {
        reply.raw.write(formatSSEEvent({ data: '[DONE]' }));
        reply.raw.end();
      } catch { /* disconnected */ }
    }
  }
});
```

- [ ] **Step 4: Verify types compile**

Run: `cd backend && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/scope-generator.routes.ts backend/src/services/scope-generator.service.ts
git commit -m "feat(backend): add POST /api/scope-generator/modify SSE endpoint"
```

---

### Task 3: Frontend — useScopeDraft hook

**Files:**
- Create: `frontend/src/hooks/useScopeDraft.ts`

This hook manages all scope draft state, LocalStorage persistence, version history, and saving to the backend.

- [ ] **Step 1: Create the hook file**

Create `frontend/src/hooks/useScopeDraft.ts`:

```typescript
import { useState, useCallback, useEffect, useRef } from 'react'
import type { GeneratedScope, GeneratedAgent, GeneratedScopeConfig } from '@/services/scopeGeneratorService'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentDraft extends GeneratedAgent {
  id?: string
  _localId: string
  _deleted: boolean
}

export interface ScopeDraft {
  scope: GeneratedScope
  agents: AgentDraft[]
}

export interface ChatMessageDraft {
  id: string
  role: 'user' | 'assistant'
  content: string
  status?: 'streaming' | 'done' | 'error'
  timestamp: number
}

interface StoredDraft {
  draft: ScopeDraft
  chatHistory: ChatMessageDraft[]
  lastModified: number
}

export interface VersionSnapshot {
  version: number
  label: string
  timestamp: number
  source: 'created' | 'ai-generated' | 'ai-modified' | 'manual-edit' | 'saved'
  data: ScopeDraft
}

// ---------------------------------------------------------------------------
// LocalStorage helpers
// ---------------------------------------------------------------------------

const MAX_VERSIONS = 20

function loadDraft(scopeId: string): StoredDraft | null {
  try {
    const raw = localStorage.getItem(`scopeDraft:${scopeId}`)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function saveDraftToStorage(scopeId: string, stored: StoredDraft): void {
  try {
    localStorage.setItem(`scopeDraft:${scopeId}`, JSON.stringify(stored))
  } catch { /* storage full — silently ignore */ }
}

function loadVersions(scopeId: string): VersionSnapshot[] {
  try {
    const raw = localStorage.getItem(`scopeVersions:${scopeId}`)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveVersionsToStorage(scopeId: string, versions: VersionSnapshot[]): void {
  try {
    localStorage.setItem(`scopeVersions:${scopeId}`, JSON.stringify(versions))
  } catch { /* storage full */ }
}

// ---------------------------------------------------------------------------
// UID helper
// ---------------------------------------------------------------------------

let _counter = 0
function localId(): string {
  return `local-${++_counter}-${Date.now()}`
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const EMPTY_SCOPE: GeneratedScope = { name: '', description: '', icon: '📋', color: '#6366f1' }

export function useScopeDraft(scopeId: string | null) {
  const [draft, setDraft] = useState<ScopeDraft>({ scope: EMPTY_SCOPE, agents: [] })
  const [chatHistory, setChatHistory] = useState<ChatMessageDraft[]>([])
  const [isDirty, setIsDirty] = useState(false)
  const [versions, setVersions] = useState<VersionSnapshot[]>([])
  const [isSaving, setIsSaving] = useState(false)
  const savedDraftRef = useRef<string>('')

  // Load from LocalStorage on mount
  useEffect(() => {
    if (!scopeId) return
    const stored = loadDraft(scopeId)
    if (stored) {
      setDraft(stored.draft)
      setChatHistory(stored.chatHistory)
      setIsDirty(true)
      savedDraftRef.current = JSON.stringify(stored.draft)
    }
    setVersions(loadVersions(scopeId))
  }, [scopeId])

  // Persist to LocalStorage on every draft/chat change
  useEffect(() => {
    if (!scopeId) return
    const stored: StoredDraft = { draft, chatHistory, lastModified: Date.now() }
    saveDraftToStorage(scopeId, stored)
  }, [scopeId, draft, chatHistory])

  // -----------------------------------------------------------------------
  // Version management
  // -----------------------------------------------------------------------

  const createSnapshot = useCallback((label: string, source: VersionSnapshot['source']) => {
    if (!scopeId) return
    setVersions(prev => {
      const nextVersion = prev.length > 0 ? prev[prev.length - 1].version + 1 : 0
      const snapshot: VersionSnapshot = {
        version: nextVersion,
        label,
        timestamp: Date.now(),
        source,
        data: JSON.parse(JSON.stringify(draft)),
      }
      const updated = [...prev, snapshot].slice(-MAX_VERSIONS)
      saveVersionsToStorage(scopeId, updated)
      return updated
    })
  }, [scopeId, draft])

  const loadVersion = useCallback((version: number) => {
    const snapshot = versions.find(v => v.version === version)
    if (!snapshot) return
    setDraft(JSON.parse(JSON.stringify(snapshot.data)))
    setIsDirty(true)
  }, [versions])

  // -----------------------------------------------------------------------
  // Draft mutations
  // -----------------------------------------------------------------------

  const initializeFromApi = useCallback((scope: GeneratedScope, agents: AgentDraft[]) => {
    const newDraft = { scope, agents }
    setDraft(newDraft)
    savedDraftRef.current = JSON.stringify(newDraft)
    setIsDirty(false)
  }, [])

  const applyFullConfig = useCallback((config: GeneratedScopeConfig) => {
    const agents: AgentDraft[] = config.agents.map(a => ({
      ...a,
      _localId: localId(),
      _deleted: false,
    }))
    setDraft({ scope: config.scope, agents })
    setIsDirty(true)
  }, [])

  const applyPatches = useCallback((patches: Array<{ op: string; path: string; value?: unknown }>) => {
    setDraft(prev => {
      const next = JSON.parse(JSON.stringify(prev)) as ScopeDraft
      for (const patch of patches) {
        const segments = patch.path.split('/').filter(Boolean)
        let target: unknown = next
        for (let i = 0; i < segments.length - 1; i++) {
          const seg = segments[i]
          const idx = Number(seg)
          target = Number.isNaN(idx)
            ? (target as Record<string, unknown>)[seg]
            : (target as unknown[])[idx]
        }
        const lastSeg = segments[segments.length - 1]
        const lastIdx = Number(lastSeg)

        if (patch.op === 'replace') {
          if (Number.isNaN(lastIdx)) {
            (target as Record<string, unknown>)[lastSeg] = patch.value
          } else {
            (target as unknown[])[lastIdx] = patch.value
          }
        } else if (patch.op === 'add') {
          if (Array.isArray(target)) {
            if (lastSeg === '-') {
              (target as unknown[]).push(patch.value)
            } else {
              (target as unknown[]).splice(lastIdx, 0, patch.value)
            }
          } else {
            (target as Record<string, unknown>)[lastSeg] = patch.value
          }
        } else if (patch.op === 'remove') {
          if (Array.isArray(target)) {
            (target as unknown[]).splice(lastIdx, 1)
          } else {
            delete (target as Record<string, unknown>)[lastSeg]
          }
        }
      }
      return next
    })
    setIsDirty(true)
  }, [])

  const updateScope = useCallback((fields: Partial<GeneratedScope>) => {
    setDraft(prev => ({ ...prev, scope: { ...prev.scope, ...fields } }))
    setIsDirty(true)
  }, [])

  const updateAgent = useCallback((agentLocalId: string, fields: Partial<AgentDraft>) => {
    setDraft(prev => ({
      ...prev,
      agents: prev.agents.map(a => a._localId === agentLocalId ? { ...a, ...fields } : a),
    }))
    setIsDirty(true)
  }, [])

  const addAgent = useCallback(() => {
    const newAgent: AgentDraft = {
      name: `new-agent-${Date.now()}`,
      displayName: 'New Agent',
      role: 'Define this agent\'s role',
      systemPrompt: 'You are a helpful assistant.',
      skills: [],
      _localId: localId(),
      _deleted: false,
    }
    setDraft(prev => ({ ...prev, agents: [...prev.agents, newAgent] }))
    setIsDirty(true)
    return newAgent._localId
  }, [])

  const removeAgent = useCallback((agentLocalId: string) => {
    setDraft(prev => ({
      ...prev,
      agents: prev.agents.map(a => a._localId === agentLocalId ? { ...a, _deleted: true } : a),
    }))
    setIsDirty(true)
  }, [])

  const restoreAgent = useCallback((agentLocalId: string) => {
    setDraft(prev => ({
      ...prev,
      agents: prev.agents.map(a => a._localId === agentLocalId ? { ...a, _deleted: false } : a),
    }))
    setIsDirty(true)
  }, [])

  const startOver = useCallback(() => {
    createSnapshot('Before reset', 'manual-edit')
    setDraft({ scope: { ...EMPTY_SCOPE, name: draft.scope.name }, agents: [] })
    setChatHistory([])
    setIsDirty(true)
  }, [createSnapshot, draft.scope.name])

  // -----------------------------------------------------------------------
  // Save to backend
  // -----------------------------------------------------------------------

  const save = useCallback(async (): Promise<boolean> => {
    if (!scopeId) return false
    setIsSaving(true)
    try {
      const { getAuthToken } = await import('@/services/api/restClient')
      const token = getAuthToken()
      const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000'

      const response = await fetch(`${API_BASE_URL}/api/scope-generator/save`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          scopeId,
          config: {
            scope: draft.scope,
            agents: draft.agents.map(a => ({
              ...(a.id ? { id: a.id } : {}),
              name: a.name,
              displayName: a.displayName,
              role: a.role,
              systemPrompt: a.systemPrompt,
              skills: a.skills,
              _deleted: a._deleted,
            })),
          },
        }),
      })

      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error || `Save failed: ${response.status}`)
      }

      const result = await response.json()

      // Update agent IDs from server response
      const serverAgents = result.data?.agents as Array<{ id: string; name: string }> | undefined
      if (serverAgents) {
        setDraft(prev => {
          const updated = { ...prev, agents: prev.agents.filter(a => !a._deleted).map(a => {
            const match = serverAgents.find(sa => sa.name === a.name)
            return match ? { ...a, id: match.id } : a
          })}
          savedDraftRef.current = JSON.stringify(updated)
          return updated
        })
      }

      setIsDirty(false)
      createSnapshot('Saved', 'saved')
      return true
    } catch (error) {
      console.error('[useScopeDraft] Save failed:', error)
      throw error
    } finally {
      setIsSaving(false)
    }
  }, [scopeId, draft, createSnapshot])

  // -----------------------------------------------------------------------
  // Derived
  // -----------------------------------------------------------------------

  const activeAgents = draft.agents.filter(a => !a._deleted)
  const currentVersion = versions.length > 0 ? versions[versions.length - 1] : null

  return {
    draft,
    chatHistory,
    setChatHistory,
    isDirty,
    isSaving,
    versions,
    currentVersion,
    activeAgents,
    initializeFromApi,
    applyFullConfig,
    applyPatches,
    updateScope,
    updateAgent,
    addAgent,
    removeAgent,
    restoreAgent,
    startOver,
    createSnapshot,
    loadVersion,
    save,
  }
}
```

- [ ] **Step 2: Verify types compile**

Run: `cd frontend && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useScopeDraft.ts
git commit -m "feat(frontend): add useScopeDraft hook with LocalStorage + version management"
```

---

### Task 4: Frontend — scopeGeneratorService additions

**Files:**
- Modify: `frontend/src/services/scopeGeneratorService.ts`

Add `modifyScope()` and `saveScopeConfig()` functions to the frontend service.

- [ ] **Step 1: Add `modifyScope` function**

In `frontend/src/services/scopeGeneratorService.ts`, add this function after the existing `generateScopeWithDocument`:

```typescript
/**
 * Stream AI modification of an existing scope config via SSE.
 * Returns accumulated text from assistant for JSON parsing.
 */
export async function modifyScope(
  scopeConfig: GeneratedScopeConfig,
  modificationRequest: string,
  onEvent: GenerateCallback,
  signal?: AbortSignal,
  history?: Array<{ role: 'user' | 'assistant'; content: string }>,
  language?: string,
): Promise<string> {
  const token = getAuthToken();
  const response = await fetch(`${API_BASE_URL}/api/scope-generator/modify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ scopeConfig, modificationRequest, history, language }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Modification failed: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  return processSSEStream(reader, onEvent);
}
```

- [ ] **Step 2: Add `parseModifyResponse` function**

Add this below `parseScopeConfig`:

```typescript
/**
 * Parse the AI modification response. Returns either:
 * - { type: 'full', config: GeneratedScopeConfig } for full replacements
 * - { type: 'patch', patches: Array<{op, path, value}> } for incremental changes
 */
export function parseModifyResponse(text: string): 
  | { type: 'full'; config: GeneratedScopeConfig }
  | { type: 'patch'; patches: Array<{ op: string; path: string; value?: unknown }> } {
  let jsonStr = text.trim();

  // Extract from code fence
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1]!.trim();

  // Try parsing as array first (patches)
  if (jsonStr.startsWith('[')) {
    try {
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].op) {
        return { type: 'patch', patches: parsed };
      }
    } catch { /* fall through */ }
  }

  // Try parsing as full config
  try {
    const config = parseScopeConfig(jsonStr);
    return { type: 'full', config };
  } catch { /* fall through */ }

  // Try extracting from full text (brute force)
  try {
    const config = parseScopeConfig(text);
    return { type: 'full', config };
  } catch {
    throw new Error('Could not parse modification response as patches or full config');
  }
}
```

- [ ] **Step 3: Verify types compile**

Run: `cd frontend && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add frontend/src/services/scopeGeneratorService.ts
git commit -m "feat(frontend): add modifyScope() and parseModifyResponse() to scopeGeneratorService"
```

---

### Task 5: Frontend — ScopeCopilot chat component

**Files:**
- Create: `frontend/src/components/ScopeCopilot.tsx`

Right panel chat component modeled on `WorkflowCopilot.tsx`. Handles both generate (first-time) and modify (subsequent) modes.

- [ ] **Step 1: Create the component file**

Create `frontend/src/components/ScopeCopilot.tsx`:

```typescript
import { useState, useCallback, useRef, useEffect } from 'react'
import { Send, Loader2, User, Bot } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import {
  generateScope,
  generateScopeWithDocument,
  modifyScope,
  parseScopeConfig,
  parseModifyResponse,
  type SSEEvent,
  type GeneratedScopeConfig,
} from '@/services/scopeGeneratorService'
import type { AgentDraft, ChatMessageDraft } from '@/hooks/useScopeDraft'
import { useTranslation } from '@/i18n'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScopeCopilotProps {
  hasAgents: boolean
  currentConfig: GeneratedScopeConfig | null
  chatHistory: ChatMessageDraft[]
  onChatHistoryChange: (history: ChatMessageDraft[]) => void
  onApplyFullConfig: (config: GeneratedScopeConfig) => void
  onApplyPatches: (patches: Array<{ op: string; path: string; value?: unknown }>) => void
  onCreateSnapshot: (label: string, source: 'ai-generated' | 'ai-modified') => void
  initialDescription?: string
  sopFile?: File | null
  language?: string
  disabled?: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function msgId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ScopeCopilot({
  hasAgents,
  currentConfig,
  chatHistory,
  onChatHistoryChange,
  onApplyFullConfig,
  onApplyPatches,
  onCreateSnapshot,
  initialDescription,
  sopFile,
  language,
  disabled,
}: ScopeCopilotProps) {
  const [input, setInput] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const autoTriggered = useRef(false)
  const { t } = useTranslation()

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatHistory])

  // Auto-trigger generation when arriving with initial description and no agents
  useEffect(() => {
    if (initialDescription && !autoTriggered.current && !hasAgents && chatHistory.length === 0) {
      autoTriggered.current = true
      void handleSend(initialDescription)
    }
  }, [initialDescription, hasAgents, chatHistory.length])

  const addMessage = useCallback((msg: Omit<ChatMessageDraft, 'id' | 'timestamp'>): string => {
    const id = msgId()
    const newMsg: ChatMessageDraft = { ...msg, id, timestamp: Date.now() }
    onChatHistoryChange([...chatHistory, newMsg])
    return id
  }, [chatHistory, onChatHistoryChange])

  const updateMessage = useCallback((id: string, updates: Partial<ChatMessageDraft>) => {
    onChatHistoryChange(chatHistory.map(m => m.id === id ? { ...m, ...updates } : m))
  }, [chatHistory, onChatHistoryChange])

  const handleSend = useCallback(async (text?: string) => {
    const message = (text ?? input).trim()
    if (!message || isProcessing) return
    if (!text) setInput('')
    setIsProcessing(true)

    const userMsg: ChatMessageDraft = { id: msgId(), role: 'user', content: message, timestamp: Date.now() }
    const assistantMsg: ChatMessageDraft = { id: msgId(), role: 'assistant', content: '', status: 'streaming', timestamp: Date.now() }
    const newHistory = [...chatHistory, userMsg, assistantMsg]
    onChatHistoryChange(newHistory)

    const assistantId = assistantMsg.id
    let accumulated = ''

    const sseHandler = (event: SSEEvent) => {
      if ((event.type === 'assistant' || event.type === 'result') && Array.isArray(event.content)) {
        for (const block of event.content) {
          if (block.type === 'text' && block.text) {
            accumulated += block.text
          }
        }
        onChatHistoryChange(
          newHistory.map(m => m.id === assistantId ? { ...m, content: accumulated } : m)
        )
      }
    }

    try {
      let fullText: string

      if (!hasAgents) {
        // Generate mode
        fullText = sopFile
          ? await generateScopeWithDocument(sopFile, message, sseHandler, undefined, language)
          : await generateScope(message, sseHandler, undefined, language)

        try {
          const config = parseScopeConfig(fullText)
          onApplyFullConfig(config)
          onCreateSnapshot('AI generated', 'ai-generated')
          const summary = `Generated **"${config.scope.name}"** with **${config.agents.length} agents**. Review and edit on the left, then click Save when ready.`
          onChatHistoryChange(
            newHistory.map(m => m.id === assistantId ? { ...m, content: accumulated + '\n\n' + summary, status: 'done' } : m)
          )
        } catch {
          onChatHistoryChange(
            newHistory.map(m => m.id === assistantId ? { ...m, content: accumulated || 'Failed to parse scope configuration.', status: 'error' } : m)
          )
        }
      } else {
        // Modify mode
        const history = chatHistory
          .filter(m => m.role === 'user' || (m.role === 'assistant' && m.status === 'done'))
          .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

        fullText = await modifyScope(
          currentConfig!,
          message,
          sseHandler,
          undefined,
          history,
          language,
        )

        try {
          const result = parseModifyResponse(fullText)
          if (result.type === 'full') {
            onApplyFullConfig(result.config)
          } else {
            onApplyPatches(result.patches)
          }
          onCreateSnapshot('AI modified', 'ai-modified')
          onChatHistoryChange(
            newHistory.map(m => m.id === assistantId ? { ...m, content: accumulated, status: 'done' } : m)
          )
        } catch {
          // Treat as conversational reply (clarifying question, etc.)
          onChatHistoryChange(
            newHistory.map(m => m.id === assistantId ? { ...m, content: accumulated, status: 'done' } : m)
          )
        }
      }
    } catch (err) {
      onChatHistoryChange(
        newHistory.map(m => m.id === assistantId
          ? { ...m, content: err instanceof Error ? err.message : 'An error occurred', status: 'error' }
          : m
        )
      )
    } finally {
      setIsProcessing(false)
      inputRef.current?.focus()
    }
  }, [input, isProcessing, hasAgents, currentConfig, chatHistory, sopFile, language, onChatHistoryChange, onApplyFullConfig, onApplyPatches, onCreateSnapshot])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }, [handleSend])

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-3 pb-2 px-4 pt-4">
        {chatHistory.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-gray-500 text-sm text-center">
            <Bot className="w-8 h-8 mb-2 text-gray-600" />
            <p>{hasAgents ? 'Ask AI to modify your scope' : 'Describe your business scope'}</p>
            <p className="text-xs mt-1 text-gray-600">e.g. "We're an e-commerce fashion brand..."</p>
          </div>
        )}

        {chatHistory.map((msg) => (
          <div key={msg.id} className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {msg.role === 'assistant' && (
              <div className="flex-shrink-0 w-6 h-6 rounded-full bg-purple-500/20 flex items-center justify-center mt-0.5">
                <Bot className="w-3.5 h-3.5 text-purple-400" />
              </div>
            )}
            <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
              msg.role === 'user'
                ? 'bg-blue-600/30 text-blue-100'
                : msg.status === 'error'
                ? 'bg-red-500/10 border border-red-500/20 text-red-300'
                : 'bg-gray-800 text-gray-300'
            }`}>
              {msg.status === 'streaming' && !msg.content && (
                <Loader2 className="w-4 h-4 animate-spin text-purple-400" />
              )}
              {msg.content && (
                <div className="prose prose-invert prose-sm max-w-none
                  prose-p:text-inherit prose-p:text-xs prose-p:my-1 prose-p:leading-relaxed
                  prose-li:text-inherit prose-li:text-xs
                  prose-strong:text-gray-200
                  prose-code:text-purple-300 prose-code:bg-gray-900/50 prose-code:px-1 prose-code:rounded prose-code:text-[11px]">
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
                  {msg.status === 'streaming' && <Loader2 className="w-3 h-3 animate-spin text-purple-400 mt-1" />}
                </div>
              )}
            </div>
            {msg.role === 'user' && (
              <div className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-500/20 flex items-center justify-center mt-0.5">
                <User className="w-3.5 h-3.5 text-blue-400" />
              </div>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-gray-700 p-3">
        <form onSubmit={(e) => { e.preventDefault(); void handleSend() }}>
          <div className="relative">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={hasAgents ? 'Ask AI to modify scope...' : 'Describe your business scope...'}
              disabled={disabled || isProcessing}
              rows={2}
              className="w-full px-3 py-2 pr-12 bg-gray-900 border border-gray-600 rounded-lg resize-none text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500 disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <button
              type="submit"
              disabled={disabled || isProcessing || !input.trim()}
              className="absolute right-2 bottom-2 p-1.5 rounded-md transition-colors text-purple-400 hover:bg-purple-500/20 hover:text-purple-300 disabled:text-gray-600 disabled:cursor-not-allowed"
            >
              {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify types compile**

Run: `cd frontend && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/ScopeCopilot.tsx
git commit -m "feat(frontend): add ScopeCopilot chat component with generate/modify modes"
```

---

### Task 6: Frontend — ScopeWorkspace component

**Files:**
- Create: `frontend/src/components/ScopeWorkspace.tsx`

Left panel showing scope overview card, agent grid, agent detail, and version bar.

- [ ] **Step 1: Create the component file**

Create `frontend/src/components/ScopeWorkspace.tsx`:

```typescript
import { useState } from 'react'
import { Pencil, Plus, Trash2, RefreshCw, ChevronDown, X, Clock } from 'lucide-react'
import type { GeneratedScope } from '@/services/scopeGeneratorService'
import type { AgentDraft, VersionSnapshot } from '@/hooks/useScopeDraft'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScopeWorkspaceProps {
  scope: GeneratedScope
  agents: AgentDraft[]
  activeAgents: AgentDraft[]
  versions: VersionSnapshot[]
  currentVersion: VersionSnapshot | null
  onUpdateScope: (fields: Partial<GeneratedScope>) => void
  onUpdateAgent: (localId: string, fields: Partial<AgentDraft>) => void
  onAddAgent: () => string
  onRemoveAgent: (localId: string) => void
  onRestoreAgent: (localId: string) => void
  onLoadVersion: (version: number) => void
  onStartOver: () => void
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ScopeOverviewCard({
  scope, onUpdate,
}: {
  scope: GeneratedScope
  onUpdate: (fields: Partial<GeneratedScope>) => void
}) {
  const [editing, setEditing] = useState(false)

  if (editing) {
    return (
      <div className="rounded-xl border border-blue-500/40 bg-gray-800/60 p-4 space-y-3">
        <div className="flex justify-between items-center">
          <span className="text-sm font-medium text-gray-300">Edit Scope</span>
          <button onClick={() => setEditing(false)} className="text-xs text-blue-400 hover:text-blue-300">Done</button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-500">Name</label>
            <input value={scope.name} onChange={e => onUpdate({ name: e.target.value })}
              className="w-full mt-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label className="text-xs text-gray-500">Icon (emoji)</label>
            <input value={scope.icon} onChange={e => onUpdate({ icon: e.target.value })}
              className="w-full mt-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
        </div>
        <div>
          <label className="text-xs text-gray-500">Description</label>
          <textarea value={scope.description} onChange={e => onUpdate({ description: e.target.value })} rows={2}
            className="w-full mt-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none" />
        </div>
        <div>
          <label className="text-xs text-gray-500">Color</label>
          <div className="flex items-center gap-2 mt-1">
            <input type="color" value={scope.color} onChange={e => onUpdate({ color: e.target.value })}
              className="w-8 h-8 rounded cursor-pointer border-0" />
            <span className="text-xs text-gray-400">{scope.color}</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-gray-700 bg-gray-800/60 p-4 flex items-center gap-4 group cursor-pointer hover:border-gray-600 transition-colors"
      onClick={() => setEditing(true)}>
      <div className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl" style={{ backgroundColor: `${scope.color}20` }}>
        {scope.icon || '📋'}
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="text-base font-semibold text-white">{scope.name || 'Untitled Scope'}</h3>
        {scope.description && <p className="text-sm text-gray-400 mt-0.5 truncate">{scope.description}</p>}
      </div>
      <Pencil className="w-4 h-4 text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity" />
    </div>
  )
}

function AgentGridCard({
  agent, isSelected, onClick,
}: {
  agent: AgentDraft
  isSelected: boolean
  onClick: () => void
}) {
  const skillCount = agent.skills?.length ?? 0
  return (
    <div
      onClick={onClick}
      className={`p-3 rounded-lg cursor-pointer transition-all ${
        agent._deleted
          ? 'bg-gray-800/30 border border-gray-700/50 opacity-50'
          : isSelected
          ? 'bg-gray-800/80 border-2 border-indigo-500'
          : 'bg-gray-800/60 border border-gray-700 hover:border-gray-600'
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white ${
          agent._deleted ? 'bg-gray-700' : 'bg-gradient-to-br from-blue-500 to-purple-600'
        }`}>
          {agent.displayName.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className={`text-sm font-medium truncate ${agent._deleted ? 'text-gray-500 line-through' : 'text-white'}`}>
            {agent.displayName}
          </div>
          <div className="text-xs text-gray-500">{skillCount} skill{skillCount !== 1 ? 's' : ''}</div>
        </div>
      </div>
    </div>
  )
}

function AgentDetailPanel({
  agent, onUpdate, onRemove, onRestore, onClose,
}: {
  agent: AgentDraft
  onUpdate: (fields: Partial<AgentDraft>) => void
  onRemove: () => void
  onRestore: () => void
  onClose: () => void
}) {
  const [editing, setEditing] = useState(false)

  return (
    <div className="rounded-xl border border-indigo-500/30 bg-gray-800/60 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-700 flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-sm font-bold text-white">
          {agent.displayName.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-white">{agent.displayName}</div>
          <div className="text-xs text-gray-500 font-mono">{agent.name}</div>
        </div>
        {!agent._deleted && (
          <button onClick={() => setEditing(!editing)} className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 transition-colors">
            <Pencil className="w-3.5 h-3.5" />
          </button>
        )}
        <button onClick={agent._deleted ? onRestore : onRemove}
          className={`p-1.5 rounded-lg transition-colors ${agent._deleted ? 'text-green-400 hover:bg-green-500/20' : 'text-red-400 hover:bg-red-500/20'}`}>
          {agent._deleted ? <RefreshCw className="w-3.5 h-3.5" /> : <Trash2 className="w-3.5 h-3.5" />}
        </button>
        <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 transition-colors">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Body */}
      <div className="p-4 space-y-3">
        {editing ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500">Display Name</label>
                <input value={agent.displayName} onChange={e => onUpdate({ displayName: e.target.value })}
                  className="w-full mt-1 px-3 py-1.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" />
              </div>
              <div>
                <label className="text-xs text-gray-500">Role</label>
                <input value={agent.role} onChange={e => onUpdate({ role: e.target.value })}
                  className="w-full mt-1 px-3 py-1.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" />
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500">System Prompt</label>
              <textarea value={agent.systemPrompt} onChange={e => onUpdate({ systemPrompt: e.target.value })} rows={4}
                className="w-full mt-1 px-3 py-1.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none" />
            </div>
            <button onClick={() => setEditing(false)} className="text-xs text-blue-400 hover:text-blue-300">Done editing</button>
          </>
        ) : (
          <>
            <div>
              <div className="text-[10px] uppercase text-gray-500 tracking-wider mb-1">Role</div>
              <div className="text-sm text-gray-300">{agent.role}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-gray-500 tracking-wider mb-1">System Prompt</div>
              <div className="text-xs text-gray-400 bg-gray-900/60 rounded-md p-2 border border-gray-700 max-h-20 overflow-hidden">
                {agent.systemPrompt}
              </div>
            </div>
            {agent.skills && agent.skills.length > 0 && (
              <div>
                <div className="text-[10px] uppercase text-gray-500 tracking-wider mb-2">Skills ({agent.skills.length})</div>
                <div className="space-y-1">
                  {agent.skills.map((skill, i) => (
                    <div key={i} className="flex items-center gap-2 px-2 py-1.5 bg-gray-900/60 border border-gray-700 rounded-md">
                      <span className="text-indigo-400 text-xs">⚡</span>
                      <span className="text-xs text-gray-300 flex-1 font-mono">{skill.name}</span>
                      <span className="text-[10px] text-gray-500 truncate max-w-[40%]">{skill.description}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function VersionBar({
  currentVersion, versions, onLoadVersion, onStartOver,
}: {
  currentVersion: VersionSnapshot | null
  versions: VersionSnapshot[]
  onLoadVersion: (version: number) => void
  onStartOver: () => void
}) {
  const [showHistory, setShowHistory] = useState(false)

  const timeAgo = (ts: number) => {
    const sec = Math.floor((Date.now() - ts) / 1000)
    if (sec < 60) return `${sec}s ago`
    const min = Math.floor(sec / 60)
    if (min < 60) return `${min}min ago`
    const hr = Math.floor(min / 60)
    return `${hr}h ago`
  }

  return (
    <div className="relative">
      {/* Version history panel */}
      {showHistory && (
        <div className="absolute bottom-full left-0 right-0 border-t border-gray-700 bg-gray-900/95 max-h-64 overflow-y-auto rounded-t-lg">
          <div className="p-3 border-b border-gray-700 flex items-center justify-between sticky top-0 bg-gray-900/95 z-10">
            <div className="flex items-center gap-2">
              <Clock className="w-3.5 h-3.5 text-gray-400" />
              <span className="text-sm font-medium text-white">Version History</span>
              <span className="text-xs text-gray-500">({versions.length})</span>
            </div>
            <button onClick={() => setShowHistory(false)} className="text-gray-400 hover:text-white">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="p-2 space-y-1">
            {[...versions].reverse().map(v => (
              <div key={v.version}
                className={`px-3 py-2 rounded-md cursor-pointer transition-colors ${
                  v.version === currentVersion?.version
                    ? 'bg-indigo-500/15 border border-indigo-500/30'
                    : 'bg-gray-800/50 border border-gray-700 hover:bg-gray-800'
                }`}
                onClick={() => { onLoadVersion(v.version); setShowHistory(false) }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-gray-300">v{v.version}</span>
                    <span className="text-xs text-gray-400">{v.label}</span>
                  </div>
                  {v.version === currentVersion?.version && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300">current</span>
                  )}
                </div>
                <div className="text-[10px] text-gray-500 mt-1">{timeAgo(v.timestamp)} · {v.source}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Bar */}
      <div className="px-4 py-3 border-t border-gray-700 flex items-center justify-between bg-gray-900/80">
        <button onClick={() => setShowHistory(!showHistory)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-gray-800 border border-gray-700 hover:border-gray-600 transition-colors">
          <Clock className="w-3.5 h-3.5 text-gray-400" />
          {currentVersion ? (
            <>
              <span className="text-xs font-medium text-gray-300">v{currentVersion.version}</span>
              <span className="text-xs text-gray-500">· {timeAgo(currentVersion.timestamp)}</span>
            </>
          ) : (
            <span className="text-xs text-gray-500">No versions</span>
          )}
          <ChevronDown className={`w-3 h-3 text-gray-500 transition-transform ${showHistory ? 'rotate-180' : ''}`} />
        </button>
        <button onClick={onStartOver} className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors">
          <RefreshCw className="w-3 h-3" />
          Start over
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function ScopeWorkspace({
  scope, agents, activeAgents, versions, currentVersion,
  onUpdateScope, onUpdateAgent, onAddAgent, onRemoveAgent, onRestoreAgent,
  onLoadVersion, onStartOver,
}: ScopeWorkspaceProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selectedAgent = agents.find(a => a._localId === selectedId) ?? null

  return (
    <div className="flex flex-col h-full">
      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {/* Scope Overview */}
        <div className="p-4 border-b border-gray-700">
          <ScopeOverviewCard scope={scope} onUpdate={onUpdateScope} />
        </div>

        {/* Agent Grid + Detail */}
        <div className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-400 font-medium">Agents ({activeAgents.length})</span>
            <button onClick={() => { const id = onAddAgent(); setSelectedId(id) }}
              className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
              <Plus className="w-3.5 h-3.5" /> Add
            </button>
          </div>

          {agents.length === 0 ? (
            <div className="text-center py-12 text-gray-500 text-sm">
              No agents yet. Use the chat to generate your scope configuration.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                {agents.map(agent => (
                  <AgentGridCard
                    key={agent._localId}
                    agent={agent}
                    isSelected={selectedId === agent._localId}
                    onClick={() => setSelectedId(selectedId === agent._localId ? null : agent._localId)}
                  />
                ))}
              </div>

              {selectedAgent && (
                <AgentDetailPanel
                  agent={selectedAgent}
                  onUpdate={(fields) => onUpdateAgent(selectedAgent._localId, fields)}
                  onRemove={() => onRemoveAgent(selectedAgent._localId)}
                  onRestore={() => onRestoreAgent(selectedAgent._localId)}
                  onClose={() => setSelectedId(null)}
                />
              )}
            </>
          )}
        </div>
      </div>

      {/* Version Bar (fixed bottom) */}
      <VersionBar
        currentVersion={currentVersion}
        versions={versions}
        onLoadVersion={onLoadVersion}
        onStartOver={onStartOver}
      />
    </div>
  )
}
```

- [ ] **Step 2: Verify types compile**

Run: `cd frontend && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/ScopeWorkspace.tsx
git commit -m "feat(frontend): add ScopeWorkspace component with dashboard, agent grid, and version bar"
```

---

### Task 7: Frontend — ScopeCopilotPage orchestrator

**Files:**
- Create: `frontend/src/pages/ScopeCopilotPage.tsx`

The main page component that wires together ScopeWorkspace, ScopeCopilot, and useScopeDraft.

- [ ] **Step 1: Create the page file**

Create `frontend/src/pages/ScopeCopilotPage.tsx`:

```typescript
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Sparkles, Save, Loader2 } from 'lucide-react'
import { ScopeWorkspace } from '@/components/ScopeWorkspace'
import { ScopeCopilot } from '@/components/ScopeCopilot'
import { useScopeDraft } from '@/hooks/useScopeDraft'
import { useToast } from '@/components'
import { useTranslation } from '@/i18n'
import type { GeneratedScopeConfig } from '@/services/scopeGeneratorService'
import { consumeSopFile } from '@/services/sopFileStore'

export function ScopeCopilotPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { success: showSuccess, error: showError } = useToast()
  const { t } = useTranslation()

  const scopeId = searchParams.get('scopeId')
  const initialDescription = searchParams.get('description') || undefined
  const language = (searchParams.get('language') as 'en' | 'cn') || 'en'

  const [sopFile] = useState<File | null>(() => consumeSopFile())
  const [isLoading, setIsLoading] = useState(true)

  const {
    draft, chatHistory, setChatHistory,
    isDirty, isSaving, versions, currentVersion, activeAgents,
    initializeFromApi, applyFullConfig, applyPatches,
    updateScope, updateAgent, addAgent, removeAgent, restoreAgent,
    startOver, createSnapshot, loadVersion, save,
  } = useScopeDraft(scopeId)

  // Redirect if no scopeId
  useEffect(() => {
    if (!scopeId) {
      navigate('/create-business-scope')
    }
  }, [scopeId, navigate])

  // Fetch scope from API on mount
  useEffect(() => {
    if (!scopeId) return

    const fetchScope = async () => {
      try {
        const { getAuthToken } = await import('@/services/api/restClient')
        const token = getAuthToken()
        const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000'

        const response = await fetch(`${API_BASE_URL}/api/business-scopes/${scopeId}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })

        if (!response.ok) {
          if (response.status === 404) {
            navigate('/create-business-scope')
            return
          }
          throw new Error(`Failed to fetch scope: ${response.status}`)
        }

        const data = await response.json()
        const scope = data.data ?? data

        // Only initialize from API if no LocalStorage draft exists (useScopeDraft handles LS loading)
        if (!localStorage.getItem(`scopeDraft:${scopeId}`)) {
          initializeFromApi(
            {
              name: scope.name || '',
              description: scope.description || '',
              icon: scope.icon || '📋',
              color: scope.color || '#6366f1',
            },
            [],
          )
          createSnapshot('Empty scope created', 'created')
        }
      } catch (err) {
        console.error('Failed to load scope:', err)
        showError('Error', 'Failed to load scope')
      } finally {
        setIsLoading(false)
      }
    }

    void fetchScope()
  }, [scopeId])

  const handleSave = async () => {
    try {
      await save()
      showSuccess('Saved', 'Scope configuration saved successfully')
    } catch (err) {
      showError('Save Failed', err instanceof Error ? err.message : 'Unknown error')
    }
  }

  const currentConfig: GeneratedScopeConfig | null = activeAgents.length > 0
    ? { scope: draft.scope, agents: activeAgents }
    : null

  if (!scopeId) return null

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 animate-spin text-purple-400" />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800 flex-shrink-0">
        <button onClick={() => navigate('/')} className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <Sparkles className="w-4 h-4 text-purple-400" />
        <span className="text-sm font-semibold text-white">Scope Copilot</span>
        {draft.scope.name && (
          <>
            <span className="text-gray-600">—</span>
            <span className="text-sm text-gray-400">{draft.scope.name}</span>
          </>
        )}
        <div className="flex-1" />
        {isDirty && (
          <span className="px-2 py-1 rounded text-[10px] bg-yellow-500/20 text-yellow-400">● Unsaved</span>
        )}
        <button
          onClick={handleSave}
          disabled={!isDirty || isSaving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-gray-800 border border-gray-700 text-sm text-gray-300 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          Save
        </button>
      </div>

      {/* Split pane */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Workspace */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <ScopeWorkspace
            scope={draft.scope}
            agents={draft.agents}
            activeAgents={activeAgents}
            versions={versions}
            currentVersion={currentVersion}
            onUpdateScope={(fields) => { updateScope(fields); createSnapshot('Manual edit', 'manual-edit') }}
            onUpdateAgent={(id, fields) => { updateAgent(id, fields); createSnapshot('Manual edit', 'manual-edit') }}
            onAddAgent={addAgent}
            onRemoveAgent={removeAgent}
            onRestoreAgent={restoreAgent}
            onLoadVersion={loadVersion}
            onStartOver={startOver}
          />
        </div>

        {/* Right: Chat */}
        <div className="w-96 border-l border-gray-800 bg-gray-900/95 flex flex-col flex-shrink-0">
          <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-purple-400" />
            <span className="text-sm font-medium text-white">AI Chat</span>
          </div>
          <div className="flex-1 min-h-0">
            <ScopeCopilot
              hasAgents={activeAgents.length > 0}
              currentConfig={currentConfig}
              chatHistory={chatHistory}
              onChatHistoryChange={setChatHistory}
              onApplyFullConfig={applyFullConfig}
              onApplyPatches={applyPatches}
              onCreateSnapshot={createSnapshot}
              initialDescription={initialDescription}
              sopFile={sopFile}
              language={language}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify types compile**

Run: `cd frontend && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/ScopeCopilotPage.tsx
git commit -m "feat(frontend): add ScopeCopilotPage with split-pane layout"
```

---

### Task 8: Routing & Integration — Wire everything together

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/pages/CreateBusinessScope.tsx`
- Modify: `frontend/src/components/index.ts`

- [ ] **Step 1: Update App.tsx routing**

In `frontend/src/App.tsx`, add the import at the top with the other page imports:

```typescript
import { ScopeCopilotPage } from '@/pages/ScopeCopilotPage'
```

Then move the `/create-business-scope/ai` route from the full-page section into the AppShell section. Change:

```typescript
<Route path="/create-business-scope/ai" element={<AIScopeGenerator />} />
```

to remove that line from the full-page routes block (lines 23-27), and add this line inside the AppShell `<Routes>` block (after the `/settings` route around line 53):

```typescript
<Route path="/create-business-scope/ai" element={<ScopeCopilotPage />} />
```

Also remove `AIScopeGenerator` from the import on line 3 if it's no longer used elsewhere. The import line currently reads:

```typescript
import { AppShell, ErrorBoundary, ToastProvider, ProtectedRoute, SkillMarketplaceBrowser, AIScopeGenerator, SkillWorkshop } from '@/components'
```

Remove `AIScopeGenerator` from it:

```typescript
import { AppShell, ErrorBoundary, ToastProvider, ProtectedRoute, SkillMarketplaceBrowser, SkillWorkshop } from '@/components'
```

- [ ] **Step 2: Update CreateBusinessScope to create empty scope first**

In `frontend/src/pages/CreateBusinessScope.tsx`, find the `confirmLanguageAndNavigate` function (or the function that calls `navigate('/create-business-scope/ai', ...)`). Replace the navigation logic.

Currently it does something like:

```typescript
navigate('/create-business-scope/ai', {
  state: { description: finalDescription, hasSopFile: pendingNavState.hasSopFile, language: selectedLang },
})
```

Replace with logic that creates an empty scope first, then navigates with query params:

```typescript
// Import at top of file:
import { restClient } from '@/services/api/restClient'

// In the navigation function:
try {
  const scopeName = customName || selectedDepartment || 'New Scope';
  const response = await restClient.post<{ data: { id: string } }>('/api/business-scopes', {
    name: scopeName,
  });
  const scopeId = response.data.id;

  const params = new URLSearchParams({ scopeId });
  if (finalDescription) params.set('description', finalDescription);
  if (selectedLang) params.set('language', selectedLang);
  if (pendingNavState?.hasSopFile) {
    // sopFile is already in ephemeral store via setSopFile()
  }

  navigate(`/create-business-scope/ai?${params.toString()}`);
} catch (err) {
  console.error('Failed to create scope:', err);
  // Show error toast if available
}
```

Note: The exact variable names (`customName`, `selectedDepartment`, `finalDescription`, etc.) depend on the current code. Read the file to match the existing variable names. The key change is: call `POST /api/business-scopes` to create the scope, then navigate with `scopeId` as a query param instead of using React Router state.

- [ ] **Step 3: Update component exports**

In `frontend/src/components/index.ts`, add exports for the new components. Find the line:

```typescript
export { AIScopeGenerator } from './AIScopeGenerator'
```

Add below it (keep the old export for any remaining references):

```typescript
export { ScopeWorkspace } from './ScopeWorkspace'
export { ScopeCopilot } from './ScopeCopilot'
```

- [ ] **Step 4: Verify the full app compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx frontend/src/pages/CreateBusinessScope.tsx frontend/src/components/index.ts
git commit -m "feat(frontend): wire ScopeCopilotPage into routing, create empty scope before AI page"
```

---

### Task 9: Manual Integration Test

**Files:** None (testing only)

- [ ] **Step 1: Start dev environment**

```bash
cd /home/ubuntu/super-agent && docker compose up -d --build
```

Wait for services to be ready, then run migrations if needed:

```bash
docker exec super-agent-backend npx prisma migrate deploy
```

- [ ] **Step 2: Test the happy path**

Open `http://localhost:8080` in a browser. Navigate to create business scope:

1. Go to "Create Business Scope" page
2. Fill in a name and select a strategy
3. Click submit — verify it creates an empty scope and redirects to `/create-business-scope/ai?scopeId=xxx`
4. Verify the split-pane layout appears with AppShell sidebar
5. Type a business description in the chat (e.g. "We're an e-commerce fashion brand with customer support and order fulfillment")
6. Verify the AI streams a response and the left panel populates with scope + agents
7. Click an agent card — verify the detail panel appears below
8. Edit an agent field — verify the "Unsaved" indicator appears
9. Click Save — verify the save completes and indicator clears
10. Refresh the page — verify the draft loads from LocalStorage

- [ ] **Step 3: Test modification flow**

1. In the chat, type "Change the first agent's role to Senior Support Lead"
2. Verify the AI returns a patch or full config and the left panel updates
3. Check version bar shows a new version
4. Click the version indicator — verify the history panel shows versions
5. Load an older version — verify the workspace reverts

- [ ] **Step 4: Test editing an existing scope**

Navigate directly to `/create-business-scope/ai?scopeId=<existing-scope-id>` to verify the page works for editing existing scopes.

- [ ] **Step 5: Commit any fixes needed**

If any issues found during testing, fix and commit individually.
