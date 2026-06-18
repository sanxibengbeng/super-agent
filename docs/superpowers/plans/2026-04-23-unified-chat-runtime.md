# Unified Chat Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Workflow Copilot and Scope Generator to use `chatService.streamChat()` as universal runtime, with system agents as digital twin scopes and deterministic session IDs.

**Architecture:** Two system copilots (workflow-copilot, scope-copilot) are created as digital twin scopes with seed agents injected at org creation. Both use `chatService.streamChat()` for conversation, gaining persistent message history, session resume, workspace management, and SSE streaming. Frontend components switch from custom endpoints to the standard `/api/chat/stream` endpoint.

**Tech Stack:** Fastify 5, Prisma ORM, PostgreSQL, TypeScript, React 19, uuid v5

**Spec:** `docs/superpowers/specs/2026-04-23-unified-chat-runtime-design.md`

---

## File Structure

### New Files
- `backend/seeds/system-copilots/workflow-copilot.json` — Seed template (scope + agent definition)
- `backend/seeds/system-copilots/scope-copilot.json` — Seed template (scope + agent definition)
- `backend/src/services/seed-copilot.service.ts` — Service to inject/upgrade seed copilots
- `backend/src/utils/deterministic-session.ts` — UUID v5 deterministic session ID generator
- `backend/src/__tests__/services/seed-copilot.service.test.ts` — Tests for seed service
- `backend/src/__tests__/utils/deterministic-session.test.ts` — Tests for session ID generator

### Modified Files
- `backend/src/schemas/agent.schema.ts` — Add `system_seed` to agent origin enum
- `backend/src/schemas/chat.schema.ts` — Add `source` field to session creation schema
- `backend/src/services/chat.service.ts` — Create-or-resume for deterministic session IDs, source field passthrough
- `backend/src/repositories/chat.repository.ts` — Accept optional `id` in `createForUser`
- `backend/src/services/organization.service.ts` — Call seed injection on org creation
- `backend/src/app.ts` — Call seed injection on startup for existing orgs
- `backend/src/routes/workflows.routes.ts` — Replace `/generate`, `/modify`, `/patch` with chat-based routes
- `backend/src/routes/scope-generator.routes.ts` — Replace `/generate`, `/generate-with-document` with chat-based routes
- `backend/src/routes/chat.routes.ts` — Add message history endpoint for copilot sessions
- `frontend/src/components/WorkflowCopilot.tsx` — Switch to `/api/chat/stream`
- `frontend/src/components/AIScopeGenerator.tsx` — Switch to chat-based scope creation/editing

### Removed Files (after migration complete)
- `backend/src/services/workflow-generator.service.ts`
- `backend/src/services/scope-generator.service.ts`

---

## Task 1: Deterministic Session ID Utility

**Files:**
- Create: `backend/src/utils/deterministic-session.ts`
- Create: `backend/src/__tests__/utils/deterministic-session.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// backend/src/__tests__/utils/deterministic-session.test.ts
import { describe, it, expect } from 'vitest';
import {
  computeWorkflowCopilotSessionId,
  computeScopeCopilotSessionId,
} from '../../utils/deterministic-session.js';

describe('deterministic-session', () => {
  describe('computeWorkflowCopilotSessionId', () => {
    it('returns a valid UUID', () => {
      const id = computeWorkflowCopilotSessionId('wf-123', '1.0');
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it('returns the same ID for the same inputs', () => {
      const a = computeWorkflowCopilotSessionId('wf-123', '1.0');
      const b = computeWorkflowCopilotSessionId('wf-123', '1.0');
      expect(a).toBe(b);
    });

    it('returns different IDs for different versions', () => {
      const a = computeWorkflowCopilotSessionId('wf-123', '1.0');
      const b = computeWorkflowCopilotSessionId('wf-123', '2.0');
      expect(a).not.toBe(b);
    });

    it('returns different IDs for different workflows', () => {
      const a = computeWorkflowCopilotSessionId('wf-111', '1.0');
      const b = computeWorkflowCopilotSessionId('wf-222', '1.0');
      expect(a).not.toBe(b);
    });
  });

  describe('computeScopeCopilotSessionId', () => {
    it('returns a valid UUID v5', () => {
      const id = computeScopeCopilotSessionId('scope-abc');
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it('returns the same ID for the same scope', () => {
      const a = computeScopeCopilotSessionId('scope-abc');
      const b = computeScopeCopilotSessionId('scope-abc');
      expect(a).toBe(b);
    });

    it('returns different IDs for different scopes', () => {
      const a = computeScopeCopilotSessionId('scope-aaa');
      const b = computeScopeCopilotSessionId('scope-bbb');
      expect(a).not.toBe(b);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/__tests__/utils/deterministic-session.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// backend/src/utils/deterministic-session.ts
import { v5 as uuidv5 } from 'uuid';

const NAMESPACE = '7a3d4e5f-1b2c-4d5e-8f9a-0b1c2d3e4f5a';

export function computeWorkflowCopilotSessionId(
  workflowId: string,
  version: string,
): string {
  return uuidv5(`workflow_copilot:${workflowId}:${version}`, NAMESPACE);
}

export function computeScopeCopilotSessionId(scopeId: string): string {
  return uuidv5(`scope_copilot:${scopeId}`, NAMESPACE);
}
```

- [ ] **Step 4: Check that `uuid` package is available**

Run: `cd backend && node -e "require('uuid')"`
If it fails, run: `cd backend && npm install uuid && npm install -D @types/uuid`

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/__tests__/utils/deterministic-session.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/utils/deterministic-session.ts backend/src/__tests__/utils/deterministic-session.test.ts
git commit -m "feat: add deterministic session ID utility for copilot sessions"
```

---

## Task 2: Seed Copilot Templates

**Files:**
- Create: `backend/seeds/system-copilots/workflow-copilot.json`
- Create: `backend/seeds/system-copilots/scope-copilot.json`

- [ ] **Step 1: Create the workflow-copilot seed template**

Create `backend/seeds/system-copilots/workflow-copilot.json`. The `systemPrompt` value is the merged content of the existing `WORKFLOW_GENERATOR_SYSTEM_PROMPT` (from `backend/src/services/workflow-generator.service.ts` lines 46-127) and `WORKFLOW_PATCH_SYSTEM_PROMPT` (lines 134-175), combined into a single prompt that:
- Handles both generation and modification in one prompt
- Dynamically determines mode based on whether a workflow definition exists in the workspace
- Includes the JSON schema for workflow plans
- Includes the patch operations schema for modifications
- Includes the task type definitions (agent, action, condition, document, codeArtifact)
- Adds a self-validation instruction: before outputting JSON, verify it is valid and well-formed

```json
{
  "scope": {
    "name": "Workflow Copilot",
    "description": "AI copilot for designing and modifying workflow DAG plans",
    "icon": "🔧",
    "color": "#6366f1",
    "scope_type": "digital_twin"
  },
  "agent": {
    "name": "workflow-copilot",
    "displayName": "Workflow Copilot",
    "role": "Workflow architect that designs and modifies DAG-based workflow plans",
    "origin": "system_seed",
    "systemPrompt": "<MERGE the two existing prompts from workflow-generator.service.ts — WORKFLOW_GENERATOR_SYSTEM_PROMPT (lines 46-127) and WORKFLOW_PATCH_SYSTEM_PROMPT (lines 134-175) — into a single unified prompt. Add: (1) mode detection instruction: 'If the workspace CLAUDE.md contains an existing workflow definition, operate in modification mode using patch operations. Otherwise, operate in generation mode.' (2) self-validation instruction: 'Before outputting JSON, verify it is syntactically valid. Never output raw line breaks inside JSON string values — use \\n instead.'>",
    "modelConfig": {}
  }
}
```

**Important:** Read `backend/src/services/workflow-generator.service.ts` lines 46-175 and copy the actual prompt content into the `systemPrompt` field. The placeholder text above describes what to do — the actual file must contain the full prompt text.

- [ ] **Step 2: Create the scope-copilot seed template**

Create `backend/seeds/system-copilots/scope-copilot.json`. The `systemPrompt` value is the existing `SCOPE_GENERATOR_SYSTEM_PROMPT` from `backend/src/services/scope-generator.service.ts` lines 55-103, enhanced with:
- Language instruction support (merge `LANGUAGE_INSTRUCTIONS` from lines 109-123)
- Self-validation: agent must validate its JSON output before writing `scope-config.json`
- Self-repair: if validation fails, fix and re-write without external intervention
- Support for both creation (empty scope) and editing (existing scope config in CLAUDE.md)

```json
{
  "scope": {
    "name": "Scope Copilot",
    "description": "AI copilot for generating and refining business scope configurations",
    "icon": "🏗️",
    "color": "#8b5cf6",
    "scope_type": "digital_twin"
  },
  "agent": {
    "name": "scope-copilot",
    "displayName": "Scope Copilot",
    "role": "Business scope architect that generates and refines scope configurations with agents and skills",
    "origin": "system_seed",
    "systemPrompt": "<COPY the existing SCOPE_GENERATOR_SYSTEM_PROMPT from scope-generator.service.ts lines 55-103, APPEND the LANGUAGE_INSTRUCTIONS from lines 109-123, and ADD: (1) mode detection: 'If the workspace CLAUDE.md contains an existing scope configuration, operate in editing mode — modify the existing config based on user requests. Otherwise, generate a new scope configuration from scratch.' (2) self-validation: 'After generating scope-config.json, read it back and validate the JSON structure. If invalid, fix and re-write.' (3) editing instructions: 'When editing, preserve fields the user did not ask to change.'>",
    "modelConfig": {}
  }
}
```

**Important:** Read `backend/src/services/scope-generator.service.ts` lines 55-123 and copy the actual prompt content. The placeholder above describes the intent.

- [ ] **Step 3: Commit**

```bash
git add backend/seeds/system-copilots/
git commit -m "feat: add seed templates for workflow-copilot and scope-copilot"
```

---

## Task 3: Seed Copilot Injection Service

**Files:**
- Create: `backend/src/services/seed-copilot.service.ts`
- Create: `backend/src/__tests__/services/seed-copilot.service.test.ts`
- Modify: `backend/src/schemas/agent.schema.ts`

- [ ] **Step 0: Add `system_seed` to agent origin enum**

The plan introduces `origin: 'system_seed'` for seed copilot agents. The Zod enum in `backend/src/schemas/agent.schema.ts` line 36 currently is:

```typescript
origin: z.enum(['scope_generation', 'manual', 'chat_created', 'cloned', 'imported', 'digital_twin']).default('scope_generation'),
```

Add `'system_seed'` to the enum:

```typescript
origin: z.enum(['scope_generation', 'manual', 'chat_created', 'cloned', 'imported', 'digital_twin', 'system_seed']).default('scope_generation'),
```

Even though the seed service creates agents directly via Prisma (bypassing Zod), this ensures the agent API's list/get endpoints can serialize these agents without schema validation errors, and any future admin UI that edits agents will recognize the origin value.

- [ ] **Step 1: Write the failing tests**

```typescript
// backend/src/__tests__/services/seed-copilot.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SeedCopilotService } from '../../services/seed-copilot.service.js';

// Mock prisma
const mockPrisma = {
  business_scopes: {
    findFirst: vi.fn(),
    create: vi.fn(),
  },
  agents: {
    findFirst: vi.fn(),
    create: vi.fn(),
  },
  organizations: {
    findMany: vi.fn(),
  },
  $executeRaw: vi.fn(),
};

vi.mock('../../config/database.js', () => ({
  prisma: mockPrisma,
}));

describe('SeedCopilotService', () => {
  let service: SeedCopilotService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SeedCopilotService();
  });

  describe('ensureSeedCopilots', () => {
    it('creates scope and agent when they do not exist', async () => {
      mockPrisma.business_scopes.findFirst.mockResolvedValue(null);
      mockPrisma.business_scopes.create.mockResolvedValue({ id: 'scope-1' });
      mockPrisma.agents.create.mockResolvedValue({ id: 'agent-1' });

      await service.ensureSeedCopilots('org-1');

      // Should create 2 scopes (workflow-copilot + scope-copilot)
      expect(mockPrisma.business_scopes.create).toHaveBeenCalledTimes(2);
      // Should create 2 agents
      expect(mockPrisma.agents.create).toHaveBeenCalledTimes(2);
    });

    it('skips creation when scopes already exist', async () => {
      mockPrisma.business_scopes.findFirst.mockResolvedValue({ id: 'existing-scope' });

      await service.ensureSeedCopilots('org-1');

      expect(mockPrisma.business_scopes.create).not.toHaveBeenCalled();
      expect(mockPrisma.agents.create).not.toHaveBeenCalled();
    });
  });

  describe('upgradeSeedCopilots', () => {
    it('upgrades agents that have not been customized', async () => {
      mockPrisma.$executeRaw.mockResolvedValue(1);
      mockPrisma.business_scopes.findFirst.mockResolvedValue({ id: 'scope-1' });

      await service.upgradeSeedCopilots('org-1');

      // Should execute raw SQL for each seed template (2 copilots)
      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(2);
    });

    it('skips upgrade when scope does not exist', async () => {
      mockPrisma.business_scopes.findFirst.mockResolvedValue(null);

      await service.upgradeSeedCopilots('org-1');

      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/__tests__/services/seed-copilot.service.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// backend/src/services/seed-copilot.service.ts
import { prisma } from '../config/database.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SEEDS_DIR = join(__dirname, '..', '..', 'seeds', 'system-copilots');

interface SeedTemplate {
  scope: {
    name: string;
    description: string;
    icon: string;
    color: string;
    scope_type: string;
  };
  agent: {
    name: string;
    displayName: string;
    role: string;
    origin: string;
    systemPrompt: string;
    modelConfig: Record<string, unknown>;
  };
}

function loadTemplate(filename: string): SeedTemplate {
  const raw = readFileSync(join(SEEDS_DIR, filename), 'utf-8');
  return JSON.parse(raw);
}

const SEED_FILES = ['workflow-copilot.json', 'scope-copilot.json'];

export class SeedCopilotService {
  async ensureSeedCopilots(organizationId: string): Promise<void> {
    for (const file of SEED_FILES) {
      const template = loadTemplate(file);
      await this.ensureOne(organizationId, template);
    }
  }

  private async ensureOne(
    organizationId: string,
    template: SeedTemplate,
  ): Promise<void> {
    // Check for existing scope (include soft-deleted: no deleted_at filter)
    const existing = await prisma.business_scopes.findFirst({
      where: {
        organization_id: organizationId,
        name: template.scope.name,
      },
    });

    if (existing) return;

    // Use try/catch to handle TOCTOU race: if two concurrent processes
    // both pass the findFirst check, the second create will fail on
    // the unique_scope_name_per_org constraint.
    try {
      const scope = await prisma.business_scopes.create({
        data: {
          organization_id: organizationId,
          name: template.scope.name,
          description: template.scope.description,
          icon: template.scope.icon,
          color: template.scope.color,
          scope_type: 'digital_twin',
        },
      });

      await prisma.agents.create({
        data: {
          organization_id: organizationId,
          business_scope_id: scope.id,
          name: template.agent.name,
          display_name: template.agent.displayName,
          role: template.agent.role,
          system_prompt: template.agent.systemPrompt,
          origin: template.agent.origin,
          status: 'active',
          model_config: template.agent.modelConfig,
        },
      });

      console.log(
        `[seed-copilot] Created "${template.scope.name}" for org ${organizationId}`,
      );
    } catch (err: any) {
      // P2002 = Prisma unique constraint violation — another process already created it
      if (err.code === 'P2002') {
        console.log(`[seed-copilot] "${template.scope.name}" already exists for org ${organizationId} (concurrent creation)`);
        return;
      }
      throw err;
    }
  }

  async upgradeSeedCopilots(organizationId: string): Promise<void> {
    for (const file of SEED_FILES) {
      const template = loadTemplate(file);

      const scope = await prisma.business_scopes.findFirst({
        where: {
          organization_id: organizationId,
          name: template.scope.name,
          scope_type: 'digital_twin',
        },
      });

      if (!scope) continue;

      // Only upgrade agents that have NOT been customized (updated_at == created_at).
      // Prisma doesn't support column-to-column comparison in where clauses,
      // so we use $executeRaw.
      await prisma.$executeRaw`
        UPDATE agents
        SET system_prompt = ${template.agent.systemPrompt},
            role = ${template.agent.role},
            display_name = ${template.agent.displayName},
            model_config = ${JSON.stringify(template.agent.modelConfig)}::jsonb,
            updated_at = NOW()
        WHERE organization_id = ${organizationId}::uuid
          AND business_scope_id = ${scope.id}::uuid
          AND name = ${template.agent.name}
          AND origin = 'system_seed'
          AND updated_at = created_at
      `;
    }
  }

  async ensureAllOrgs(): Promise<void> {
    const orgs = await prisma.organizations.findMany({
      select: { id: true },
    });
    for (const org of orgs) {
      await this.ensureSeedCopilots(org.id);
    }
    console.log(
      `[seed-copilot] Checked ${orgs.length} organizations for seed copilots`,
    );
  }
}

export const seedCopilotService = new SeedCopilotService();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/__tests__/services/seed-copilot.service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/seed-copilot.service.ts backend/src/__tests__/services/seed-copilot.service.test.ts
git commit -m "feat: add seed copilot injection service"
```

---

## Task 4: Hook Seed Injection into Org Creation and App Startup

**Files:**
- Modify: `backend/src/services/organization.service.ts`
- Modify: `backend/src/app.ts`

- [ ] **Step 1: Add seed injection to organization creation**

Read `backend/src/services/organization.service.ts` and find the `createOrganization` method. After the org is created and before the method returns, add:

```typescript
import { seedCopilotService } from './seed-copilot.service.js';

// Inside createOrganization, after the org record is created:
await seedCopilotService.ensureSeedCopilots(organization.id);
```

- [ ] **Step 2: Add seed injection to app startup**

Read `backend/src/app.ts` and find where the server starts listening (look for `fastify.listen` or similar). Add seed injection for existing orgs after the server is ready:

```typescript
import { seedCopilotService } from './services/seed-copilot.service.js';

// After server starts listening, run async:
seedCopilotService.ensureAllOrgs().catch((err) => {
  console.error('[startup] Failed to ensure seed copilots:', err);
});
```

- [ ] **Step 3: Verify the app starts without errors**

Run: `cd backend && npm run build`
Expected: No TypeScript compilation errors

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/organization.service.ts backend/src/app.ts
git commit -m "feat: inject seed copilots on org creation and app startup"
```

---

## Task 5: Add `source` Field and Deterministic Session ID Support

**Files:**
- Modify: `backend/src/schemas/chat.schema.ts`
- Modify: `backend/src/services/chat.service.ts`
- Modify: `backend/src/repositories/chat.repository.ts`

Two problems need fixing before copilot routes can work:

1. **`source` field:** `createSession` hardcodes `source: 'user'`. Copilot sessions need `workflow_copilot` or `scope_copilot`.
2. **Deterministic session IDs:** Copilot routes compute a deterministic `sessionId` and pass it via `options.sessionId`. But `prepareScopeSession` (line 883) does `getSessionById(sessionId)` when `sessionId` is present — which throws `notFound` for a brand-new deterministic ID. We need a **create-or-resume** path.

- [ ] **Step 1: Add `source` to the session creation schema**

In `backend/src/schemas/chat.schema.ts`, add to `createChatSessionSchema`:

```typescript
source: z.string().max(20).optional(),
```

- [ ] **Step 2: Pass `source` through in `createSession`**

In `backend/src/services/chat.service.ts` line 147, change:

```typescript
source: 'user',
```

to:

```typescript
source: data.source ?? 'user',
```

- [ ] **Step 3: Allow `createForUser` to accept a custom `id`**

In `backend/src/repositories/chat.repository.ts`, the `createForUser` method signature is:

```typescript
async createForUser(
  data: Omit<ChatSessionEntity, 'id' | 'organization_id' | 'user_id' | 'created_at' | 'updated_at'>,
  organizationId: string,
  userId: string
): Promise<ChatSessionEntity>
```

Change the type to also accept an optional `id`:

```typescript
async createForUser(
  data: Omit<ChatSessionEntity, 'id' | 'organization_id' | 'user_id' | 'created_at' | 'updated_at'> & { id?: string },
  organizationId: string,
  userId: string
): Promise<ChatSessionEntity> {
  return this.getModel().create({
    data: {
      ...data,
      organization_id: organizationId,
      user_id: userId,
    },
  });
}
```

Prisma's `@default(uuid())` only fires when `id` is not supplied, so passing an explicit `id` uses that value instead.

- [ ] **Step 4: Add create-or-resume logic in `prepareScopeSession`**

In `backend/src/services/chat.service.ts`, the `prepareScopeSession` method (around line 866) has:

```typescript
if (!sessionId) {
  session = await this.createSession(
    { business_scope_id: scopeId, agent_id: selectedAgentId, context: options.context ?? {} },
    organizationId,
    userId,
  );
  sessionId = session.id;
  // ... provision workspace
} else {
  session = await this.getSessionById(sessionId, organizationId);
  // ... refresh workspace
}
```

Change the `else` branch to create-or-resume:

```typescript
} else {
  // Create-or-resume: deterministic session IDs may not exist yet
  const existing = await chatSessionRepository.findById(sessionId, organizationId);
  if (existing) {
    session = existing;
    const refreshResult = await this.workspaceManager.ensureWorkspaceUpToDate(
      organizationId, sessionId, scopeForWorkspace, selectedAgentId,
    );
    pluginPaths = refreshResult.pluginPaths;
  } else {
    // First use of this deterministic session ID — create with the pre-computed ID.
    // Use try/catch for P2002 (duplicate key) in case of concurrent first requests.
    const source = (options.context?.source as string) ?? 'user';
    let isNewSession = false;
    try {
      session = await chatSessionRepository.createForUser(
        {
          id: sessionId,
          business_scope_id: scopeId,
          agent_id: selectedAgentId,
          claude_session_id: null,
          title: null,
          status: 'idle',
          source,
          sop_context: null,
          context: options.context ?? {},
        },
        organizationId,
        userId,
      );
      isNewSession = true;
    } catch (err: any) {
      if (err.code === 'P2002') {
        session = await this.getSessionById(sessionId, organizationId);
      } else {
        throw err;
      }
    }

    if (isNewSession) {
      const provisionResult = await this.workspaceManager.ensureSessionWorkspace(
        organizationId, sessionId, scopeForWorkspace, selectedAgentId,
      );
      pluginPaths = provisionResult.pluginPaths;
    } else {
      const refreshResult = await this.workspaceManager.ensureWorkspaceUpToDate(
        organizationId, sessionId, scopeForWorkspace, selectedAgentId,
      );
      pluginPaths = refreshResult.pluginPaths;
    }
  }
}
```

This ensures that:
- When a deterministic `sessionId` is passed and the session exists → resume it
- When a deterministic `sessionId` is passed and the session doesn't exist → create it with that exact ID
- The `source` value from `options.context.source` is used for the `chat_sessions.source` column

- [ ] **Step 5: Verify build**

Run: `cd backend && npm run build`
Expected: No errors

- [ ] **Step 6: Run existing chat tests**

Run: `cd backend && npx vitest run --reporter=verbose 2>&1 | head -60`
Expected: Existing tests still pass (this change is backward-compatible — when no `id` is passed, behavior is unchanged)

- [ ] **Step 7: Commit**

```bash
git add backend/src/schemas/chat.schema.ts backend/src/services/chat.service.ts backend/src/repositories/chat.repository.ts
git commit -m "feat: support source field and deterministic session IDs for copilot sessions"
```

---

## Task 6: Backend — Workflow Copilot Routes via Chat Service

**Files:**
- Modify: `backend/src/routes/workflows.routes.ts`
- Modify: `backend/src/routes/chat.routes.ts`

- [ ] **Step 1: Add a copilot message history endpoint to chat routes**

Read `backend/src/routes/chat.routes.ts`. Add a new GET endpoint that accepts copilot binding parameters and returns message history:

```typescript
// GET /api/chat/copilot/messages
// Query params: workflow_id, version, source=workflow_copilot
// OR: scope_id, source=scope_copilot
// Backend computes deterministic session_id, returns messages

import {
  computeWorkflowCopilotSessionId,
  computeScopeCopilotSessionId,
} from '../utils/deterministic-session.js';

fastify.get('/copilot/messages', { preHandler: [authenticate] }, async (request, reply) => {
  const { workflow_id, version, scope_id, source } = request.query as {
    workflow_id?: string;
    version?: string;
    scope_id?: string;
    source: string;
  };
  const { organizationId } = request.user;

  let sessionId: string;
  if (source === 'workflow_copilot' && workflow_id && version) {
    sessionId = computeWorkflowCopilotSessionId(workflow_id, version);
  } else if (source === 'scope_copilot' && scope_id) {
    sessionId = computeScopeCopilotSessionId(scope_id);
  } else {
    return reply.status(400).send({ error: 'Invalid copilot parameters' });
  }

  // Session may not exist yet (first open before any messages sent).
  // Use try/catch to return empty array instead of 404.
  try {
    const messages = await chatService.getSessionMessages(organizationId, sessionId, 100);
    return { session_id: sessionId, messages };
  } catch {
    return { session_id: sessionId, messages: [] };
  }
});
```

- [ ] **Step 2: Replace workflow generate/modify/patch routes**

Read `backend/src/routes/workflows.routes.ts` lines 482-902. Replace the three endpoints (`/generate`, `/:id/patch`, `/modify`) with a single new endpoint that routes through `chatService.streamChat()`:

```typescript
// POST /api/workflows/copilot/stream
// Body: { workflow_id: string, version: string, message: string, business_scope_id?: string }

import { computeWorkflowCopilotSessionId } from '../utils/deterministic-session.js';
import { chatService } from '../services/chat.service.js';

fastify.post('/copilot/stream', { preHandler: [authenticate] }, async (request, reply) => {
  const { workflow_id, version, message, business_scope_id } = request.body as {
    workflow_id: string;
    version: string;
    message: string;
    business_scope_id?: string;
  };
  const { organizationId, userId } = request.user;

  const sessionId = computeWorkflowCopilotSessionId(workflow_id, version);

  // Find the workflow-copilot agent for this org
  const copilotScope = await prisma.business_scopes.findFirst({
    where: { organization_id: organizationId, name: 'Workflow Copilot', scope_type: 'digital_twin' },
  });
  if (!copilotScope) {
    return reply.status(404).send({ error: 'Workflow Copilot not configured for this organization' });
  }
  const copilotAgent = await prisma.agents.findFirst({
    where: { business_scope_id: copilotScope.id, name: 'workflow-copilot' },
  });
  if (!copilotAgent) {
    return reply.status(404).send({ error: 'Workflow Copilot agent not found' });
  }

  // TODO: Before calling streamChat, write workflow data (nodes, connections)
  // into the session workspace CLAUDE.md so the copilot has context.
  // This will be done via workspace manager in a follow-up step.

  await chatService.streamChat(reply, organizationId, userId, {
    sessionId,
    businessScopeId: copilotScope.id,
    agentId: copilotAgent.id,
    message,
    context: { source: 'workflow_copilot', workflow_id, version },
  });
});
```

- [ ] **Step 3: Remove the old route handlers**

Delete the three old route handlers from `workflows.routes.ts`:
- POST `/generate` (lines ~482-655)
- POST `/:id/patch` (lines ~658-765)
- POST `/modify` (lines ~768-902)

Keep all other workflow routes (CRUD, execute, etc.) unchanged.

- [ ] **Step 4: Verify build**

Run: `cd backend && npm run build`
Expected: No TypeScript errors

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/workflows.routes.ts backend/src/routes/chat.routes.ts
git commit -m "feat: route workflow copilot through chatService.streamChat()"
```

---

## Task 7: Backend — Scope Copilot Routes via Chat Service

**Files:**
- Modify: `backend/src/routes/scope-generator.routes.ts`
- Modify: `backend/src/routes/businessScopes.routes.ts`

- [ ] **Step 1: Replace scope generator routes with chat-based flow**

Read `backend/src/routes/scope-generator.routes.ts`. Replace the `/generate` and `/generate-with-document` endpoints with a chat-based endpoint:

```typescript
// POST /api/scope-copilot/stream
// Body: { scope_id: string, message: string }

import { computeScopeCopilotSessionId } from '../utils/deterministic-session.js';
import { chatService } from '../services/chat.service.js';

fastify.post('/stream', { preHandler: [authenticate] }, async (request, reply) => {
  const { scope_id, message } = request.body as {
    scope_id: string;
    message: string;
  };
  const { organizationId, userId } = request.user;

  const sessionId = computeScopeCopilotSessionId(scope_id);

  // Find the scope-copilot agent for this org
  const copilotScope = await prisma.business_scopes.findFirst({
    where: { organization_id: organizationId, name: 'Scope Copilot', scope_type: 'digital_twin' },
  });
  if (!copilotScope) {
    return reply.status(404).send({ error: 'Scope Copilot not configured for this organization' });
  }
  const copilotAgent = await prisma.agents.findFirst({
    where: { business_scope_id: copilotScope.id, name: 'scope-copilot' },
  });
  if (!copilotAgent) {
    return reply.status(404).send({ error: 'Scope Copilot agent not found' });
  }

  await chatService.streamChat(reply, organizationId, userId, {
    sessionId,
    businessScopeId: copilotScope.id,
    agentId: copilotAgent.id,
    message,
    context: { source: 'scope_copilot', scope_id },
  });
});
```

- [ ] **Step 2: Add SOP document upload endpoint**

For document-based scope generation, add an endpoint that uploads the document to the workspace before starting the chat:

```typescript
// POST /api/scope-copilot/upload-document
// Multipart form: file + scope_id
// Places the document in the session workspace, returns confirmation

fastify.post('/upload-document', { preHandler: [authenticate] }, async (request, reply) => {
  const data = await request.file();
  if (!data) return reply.status(400).send({ error: 'No file uploaded' });

  const scopeId = (data.fields.scope_id as any)?.value as string;
  if (!scopeId) return reply.status(400).send({ error: 'scope_id required' });

  const { organizationId } = request.user;
  const sessionId = computeScopeCopilotSessionId(scopeId);

  // Find the copilot scope to get workspace path
  const copilotScope = await prisma.business_scopes.findFirst({
    where: { organization_id: organizationId, name: 'Scope Copilot', scope_type: 'digital_twin' },
  });
  if (!copilotScope) return reply.status(404).send({ error: 'Scope Copilot not configured' });

  // Build workspace path and write file
  const workspacePath = workspaceManager.getSessionWorkspacePath(
    organizationId, copilotScope.id, sessionId,
  );
  await mkdir(workspacePath, { recursive: true });
  const filePath = join(workspacePath, data.filename);
  await writeFile(filePath, await data.toBuffer());

  return { uploaded: true, filename: data.filename };
});
```

- [ ] **Step 3: Remove old scope generator endpoints**

Remove from `scope-generator.routes.ts`:
- POST `/api/business-scopes/generate`
- POST `/api/scope-generator/generate-with-document`
- POST `/api/business-scopes/generate/confirm`

Keep the digital twin generation endpoints (`/generate-twin`, `/generate-twin/confirm`) for now — they can be migrated separately.

- [ ] **Step 4: Modify scope creation route to support empty scope creation**

Read `backend/src/routes/businessScopes.routes.ts` POST `/api/business-scopes` handler. Ensure it can create an empty scope (name required, other fields optional) so the frontend can create a scope first, then use copilot to configure it.

The current handler at `businessScopes.routes.ts` already supports this — `description`, `icon`, `color` are optional in `createBusinessScopeSchema`. No code change needed, just verify.

- [ ] **Step 5: Verify build**

Run: `cd backend && npm run build`
Expected: No TypeScript errors

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/scope-generator.routes.ts backend/src/routes/businessScopes.routes.ts
git commit -m "feat: route scope copilot through chatService.streamChat()"
```

---

## Task 8: Remove Old Services

**Files:**
- Remove: `backend/src/services/workflow-generator.service.ts`
- Remove: `backend/src/services/scope-generator.service.ts`

- [ ] **Step 1: Check for remaining references**

Run:
```bash
cd backend && grep -rn "workflowGeneratorService\|workflow-generator\.service\|WorkflowGeneratorService" src/ --include="*.ts" | grep -v ".test." | grep -v "__tests__"
```

```bash
cd backend && grep -rn "scopeGeneratorService\|scope-generator\.service\|ScopeGeneratorService" src/ --include="*.ts" | grep -v ".test." | grep -v "__tests__"
```

Remove or update any remaining imports. The routes should have been updated in Tasks 6 and 7. If any other files import these services, update them.

- [ ] **Step 2: Delete the old service files**

```bash
rm backend/src/services/workflow-generator.service.ts
rm backend/src/services/scope-generator.service.ts
```

- [ ] **Step 3: Verify build**

Run: `cd backend && npm run build`
Expected: No TypeScript errors. If there are errors, fix remaining import references.

- [ ] **Step 4: Run existing tests**

Run: `cd backend && npm run test`
Expected: Existing tests pass (some test files for the removed services may need to be deleted or updated)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove workflow-generator and scope-generator services"
```

---

## Task 9: Frontend — Workflow Copilot Migration

**Files:**
- Modify: `frontend/src/components/WorkflowCopilot.tsx`

- [ ] **Step 1: Read the current implementation**

Read `frontend/src/components/WorkflowCopilot.tsx` to understand:
- The `streamSSE()` function (lines ~92-160) — this is the SSE client
- How messages are stored in state (`messages` useState)
- How it calls `/api/workflows/generate` and `/api/workflows/modify`
- How it parses workflow JSON from responses

- [ ] **Step 2: Add chat history loading on mount**

Add a `useEffect` that loads existing message history when the copilot panel opens:

```typescript
useEffect(() => {
  if (!workflowId || !version) return;

  const loadHistory = async () => {
    try {
      const res = await fetch(
        `/api/chat/copilot/messages?workflow_id=${workflowId}&version=${version}&source=workflow_copilot`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return;
      const data = await res.json();
      if (data.messages && data.messages.length > 0) {
        // Convert chat_messages records to the component's ChatMessage format
        setMessages(data.messages.map(convertDbMessageToChatMessage));
      }
    } catch (err) {
      console.error('Failed to load copilot history:', err);
    }
  };

  loadHistory();
}, [workflowId, version]);
```

- [ ] **Step 3: Replace SSE calls to use /api/chat/stream**

Replace the `handleSend` function's API calls. Instead of calling `/api/workflows/generate` or `/api/workflows/modify`, call `/api/workflows/copilot/stream` (which routes through chatService):

```typescript
const response = await fetch('/api/workflows/copilot/stream', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    workflow_id: workflowId,
    version,
    message: input,
    business_scope_id: businessScopeId,
  }),
});
```

The SSE event parsing logic stays the same — `chatService.streamChat()` emits the same event format that the component already handles.

- [ ] **Step 4: Remove generation/modify mode distinction**

Remove the mode toggle between "generate" and "modify". The copilot agent now decides automatically based on workspace context. The frontend just sends messages and parses workflow JSON from responses.

- [ ] **Step 5: Test in browser**

Run: `cd frontend && npm run dev`
- Open a workflow editor
- Verify the copilot panel loads
- Send a message and verify streaming works
- Refresh the page and verify message history loads

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/WorkflowCopilot.tsx
git commit -m "feat: migrate WorkflowCopilot to use chat service"
```

---

## Task 10: Frontend — Scope Copilot Migration

**Files:**
- Modify: `frontend/src/components/AIScopeGenerator.tsx`
- Modify: `frontend/src/pages/` (whichever page renders the scope creation flow)

- [ ] **Step 1: Read the current implementation**

Read `frontend/src/components/AIScopeGenerator.tsx` to understand:
- How it calls `generateScope()` / `generateScopeWithDocument()`
- How it calls `confirmScopeGeneration()`
- The UI structure (steps/wizard pattern)

- [ ] **Step 2: Redesign as chat + config panel layout**

Replace the wizard/step-based UI with a two-panel layout:
- Left panel: Chat interface (reuse existing chat components from `frontend/src/components/chat/`)
- Right panel: Scope configuration preview (read-only display of the current config, updated as agent generates/modifies)

The chat panel:
- On mount, load history from `GET /api/chat/copilot/messages?scope_id={id}&source=scope_copilot`
- Send messages to `POST /api/scope-copilot/stream` with `{ scope_id, message }`
- Parse scope config JSON from assistant messages to update the right panel

- [ ] **Step 3: Support both creation and editing flows**

The component should work for both:
- **Creation:** receives a newly created scope_id with empty config → right panel starts empty
- **Editing:** receives an existing scope_id → loads history, right panel shows current config

The entry point (page/route) determines which mode based on whether the scope already has agents configured.

- [ ] **Step 4: Update scope creation flow**

Modify the "Create Scope" button handler to:
1. Create an empty scope via `POST /api/business-scopes` with just the name
2. Navigate to the scope copilot page with the new scope_id

- [ ] **Step 5: Add "Save" functionality**

Add a "Save" button on the right panel that takes the current config preview and calls `PATCH /api/business-scopes/{id}` to persist changes.

- [ ] **Step 6: Test in browser**

Run: `cd frontend && npm run dev`
- Create a new scope — verify chat + config panel appears
- Describe a business — verify config appears in right panel
- Iterate ("add another agent") — verify config updates
- Refresh — verify history loads and config is preserved
- Open an existing scope for editing — verify it loads with history

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/AIScopeGenerator.tsx frontend/src/pages/
git commit -m "feat: migrate scope generator to chat-based copilot"
```

---

## Task 11: Workspace Context for Copilot Sessions

**Files:**
- Modify: `backend/src/routes/workflows.routes.ts` (the copilot/stream handler from Task 6)
- Modify: `backend/src/routes/scope-generator.routes.ts` (the scope-copilot/stream handler from Task 7)

**Important note on CLAUDE.md:** Do NOT write directly to `CLAUDE.md`. The workspace manager's `generateScopeClaudeMd()` (called during `ensureSessionWorkspace` and `ensureWorkspaceUpToDate`) owns that file and would overwrite any content you write there. Instead, write copilot context to **separate files** in the workspace that the agent's system prompt references.

- [ ] **Step 1: Write workflow data into workspace before chat**

In the workflow copilot stream handler (Task 6), **after** computing `sessionId` and **before** calling `chatService.streamChat()`, write the current workflow definition to a dedicated context file:

```typescript
import { workspaceManager } from '../services/workspace-manager.js';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

// Load the workflow to get nodes/connections
const workflow = await prisma.workflows.findUnique({
  where: { id: workflow_id },
  select: { name: true, nodes: true, connections: true, version: true },
});

if (workflow) {
  const workspacePath = workspaceManager.getSessionWorkspacePath(
    organizationId, copilotScope.id, sessionId,
  );
  await mkdir(workspacePath, { recursive: true });

  // Write workflow context to a separate file (NOT CLAUDE.md — that's owned by workspace manager)
  const context = [
    `# Workflow: ${workflow.name}`,
    `Version: ${workflow.version}`,
    '',
    '## Current Workflow Definition',
    '```json',
    JSON.stringify({ nodes: workflow.nodes, connections: workflow.connections }, null, 2),
    '```',
  ].join('\n');

  await writeFile(join(workspacePath, 'workflow-context.md'), context);
}

// Also load available agents list for the copilot
const agents = await prisma.agents.findMany({
  where: { organization_id: organizationId },
  select: { name: true, display_name: true, role: true },
});
if (agents.length > 0) {
  const agentList = agents.map(a => `- **${a.display_name ?? a.name}** (\`${a.name}\`): ${a.role ?? 'General agent'}`).join('\n');
  await writeFile(join(workspacePath, 'available-agents.md'), `# Available Agents\n\n${agentList}\n`);
}
```

The workflow-copilot seed agent's `systemPrompt` (Task 2) must reference this file: "Read `workflow-context.md` in the workspace to understand the current workflow state. Read `available-agents.md` for the list of available agents."

- [ ] **Step 2: Write scope config into workspace before chat**

In the scope copilot stream handler (Task 7), write the current scope configuration to a dedicated context file:

```typescript
// Load the target scope and its agents
const targetScope = await prisma.business_scopes.findUnique({
  where: { id: scope_id },
  include: { agents: { include: { agent_skills: true } } },
});

if (targetScope) {
  const workspacePath = workspaceManager.getSessionWorkspacePath(
    organizationId, copilotScope.id, sessionId,
  );
  await mkdir(workspacePath, { recursive: true });

  const config = JSON.stringify({
    scope: {
      name: targetScope.name,
      description: targetScope.description,
      icon: targetScope.icon,
      color: targetScope.color,
    },
    agents: targetScope.agents.map(a => ({
      name: a.name,
      displayName: a.display_name,
      role: a.role,
      systemPrompt: a.system_prompt,
    })),
  }, null, 2);

  // Write to a separate file (NOT CLAUDE.md — that's owned by workspace manager)
  const context = [
    `# Scope: ${targetScope.name}`,
    `Description: ${targetScope.description ?? 'Not set'}`,
    '',
    '## Current Configuration',
    '```json',
    config,
    '```',
  ].join('\n');

  await writeFile(join(workspacePath, 'scope-context.md'), context);
}
```

The scope-copilot seed agent's `systemPrompt` (Task 2) must reference: "Read `scope-context.md` in the workspace to understand the current scope configuration."

- [ ] **Step 3: Update seed template system prompts to reference context files**

Verify that the seed templates from Task 2 include instructions to read the context files:
- `workflow-copilot.json` system prompt: "On each turn, read `workflow-context.md` and `available-agents.md` from the workspace for current state."
- `scope-copilot.json` system prompt: "On each turn, read `scope-context.md` from the workspace for the current scope configuration."

If not already present in Task 2, add them now.

- [ ] **Step 4: Verify build**

Run: `cd backend && npm run build`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/workflows.routes.ts backend/src/routes/scope-generator.routes.ts
git commit -m "feat: write workspace context for copilot sessions"
```

---

## Task 12: End-to-End Verification

- [ ] **Step 1: Start the full stack**

```bash
docker compose up -d --build
docker exec super-agent-backend npx prisma migrate deploy
```

- [ ] **Step 2: Verify seed copilots are created**

```bash
docker exec super-agent-backend npx tsx -e "
  import { prisma } from './src/config/database.js';
  const scopes = await prisma.business_scopes.findMany({
    where: { scope_type: 'digital_twin', name: { in: ['Workflow Copilot', 'Scope Copilot'] } },
    include: { agents: true },
  });
  console.log(JSON.stringify(scopes, null, 2));
  await prisma.\$disconnect();
"
```

Expected: Two digital twin scopes, each with one agent (origin = 'system_seed')

- [ ] **Step 3: Test Workflow Copilot end-to-end**

In the browser:
1. Open a workflow editor
2. Open the copilot panel
3. Type "Create a workflow that processes customer feedback and routes it to the right team"
4. Verify streaming response appears
5. Verify workflow JSON is generated and can be applied to canvas
6. Refresh the page — verify chat history persists

- [ ] **Step 4: Test Scope Copilot end-to-end**

In the browser:
1. Click "Create Scope"
2. In the chat panel, describe a business
3. Verify scope config appears in the right panel
4. Iterate: "add a data analyst agent"
5. Click Save
6. Re-open scope settings — verify chat history and config are preserved

- [ ] **Step 5: Verify existing chat is unaffected**

1. Open an existing scope chat
2. Send a message — verify normal chat works
3. Verify no regressions in IM, Project, or other chat consumers

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "test: verify unified chat runtime end-to-end"
```
