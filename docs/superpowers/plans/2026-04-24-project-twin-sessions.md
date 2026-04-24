# Project Twin Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-member AI twin sessions to the Project Board, allowing team members to independently chat with chosen agents while sharing context through project tools and workspace summaries.

**Architecture:** New `project_twin_sessions` Prisma model as a thin association layer between `projects` and `chat_sessions` — zero changes to existing chat infrastructure. Six internal project tools injected at session preparation time give twin agents read/write access to board state. Frontend adds a collapsible sidebar panel to ProjectBoard plus a pop-out full-page route.

**Tech Stack:** Prisma (migration + model), Fastify routes, Zod validation, existing ChatService streaming, React components with Tailwind CSS, SSE for real-time.

**Spec:** `docs/superpowers/specs/2026-04-24-project-twin-sessions-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `backend/prisma/migrations/YYYYMMDD_add_project_twin_sessions/migration.sql` | DB migration |
| `backend/src/services/project-twin-session.service.ts` | Twin session CRUD, workspace prep, action confirm/reject |
| `backend/src/services/project-tools.ts` | 6 internal tool definitions + execution handlers |
| `backend/src/routes/project-twin-sessions.routes.ts` | REST API endpoints |
| `backend/src/schemas/project-twin-session.schema.ts` | Zod request/response schemas |
| `frontend/src/services/api/restTwinSessionService.ts` | API client |
| `frontend/src/components/TwinSessionPanel.tsx` | Sidebar chat panel (reuses existing message components) |
| `frontend/src/components/CreateTwinSessionModal.tsx` | Agent selection + issue binding modal |
| `frontend/src/components/SuggestionCard.tsx` | Action confirm/reject card in chat stream |
| `frontend/src/pages/TwinSessionPage.tsx` | Pop-out full page route |

### Modified Files

| File | Change |
|------|--------|
| `backend/prisma/schema.prisma` | Add `project_twin_sessions` model |
| `backend/src/services/chat.service.ts` | In `prepareScopeSession`, detect twin session and inject project tools |
| `backend/src/routes/projects.routes.ts` | Register twin session sub-routes |
| `frontend/src/pages/ProjectBoard.tsx` | Add sidebar toggle, twin session panel, issue card indicators |
| `frontend/src/App.tsx` | Add pop-out route |
| `frontend/src/i18n/translations.ts` | Add twin session i18n strings |
| `frontend/src/services/api/restProjectService.ts` | Add twin session type exports |

---

## Task 1: Prisma Model + Migration

**Files:**
- Modify: `backend/prisma/schema.prisma` (after line ~1345, after `project_triage_reports`)
- Create: migration via `npx prisma migrate dev`

- [ ] **Step 1: Add Prisma model**

Add to `backend/prisma/schema.prisma` after the `project_triage_reports` model:

```prisma
model project_twin_sessions {
  id             String          @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  project_id     String          @db.Uuid
  session_id     String          @db.Uuid
  issue_id       String?         @db.Uuid
  created_by     String          @db.Uuid
  agent_id       String          @db.Uuid
  visibility     String          @default("private") @db.VarChar(10)
  created_at     DateTime        @default(now()) @db.Timestamptz(6)

  project        projects        @relation(fields: [project_id], references: [id], onDelete: Cascade)
  session        chat_sessions   @relation(fields: [session_id], references: [id], onDelete: Cascade)
  issue          project_issues? @relation(fields: [issue_id], references: [id], onDelete: SetNull)
  creator        profiles        @relation(fields: [created_by], references: [id])
  agent          agents          @relation(fields: [agent_id], references: [id])

  @@index([project_id, created_by])
  @@index([project_id, issue_id])
  @@index([project_id, visibility])
}
```

Also add the reverse relation fields to existing models:

In `projects` model, add:
```prisma
twin_sessions  project_twin_sessions[]
```

In `chat_sessions` model, add:
```prisma
twin_session   project_twin_sessions?
```

In `project_issues` model, add:
```prisma
twin_sessions  project_twin_sessions[]
```

In `profiles` model, add:
```prisma
twin_sessions  project_twin_sessions[]
```

In `agents` model, add:
```prisma
twin_sessions  project_twin_sessions[]
```

- [ ] **Step 2: Generate migration**

```bash
cd backend && npx prisma migrate dev --name add_project_twin_sessions
```

Expected: Migration created successfully, Prisma Client regenerated.

- [ ] **Step 3: Verify generated client**

```bash
cd backend && npx prisma generate
```

Expected: `✔ Generated Prisma Client`

- [ ] **Step 4: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/
git commit -m "feat(db): add project_twin_sessions model and migration"
```

---

## Task 2: Zod Schemas

**Files:**
- Create: `backend/src/schemas/project-twin-session.schema.ts`

- [ ] **Step 1: Create schema file**

```typescript
import { z } from 'zod';

const uuidSchema = z.string().uuid();

export const createTwinSessionSchema = z.object({
  agent_id: uuidSchema,
  issue_id: uuidSchema.optional(),
  visibility: z.enum(['private', 'public']).default('private'),
});

export const updateVisibilitySchema = z.object({
  visibility: z.enum(['private', 'public']),
});

export const listTwinSessionsSchema = z.object({
  issue_id: uuidSchema.optional(),
  visibility: z.enum(['private', 'public']).optional(),
  mine_only: z.coerce.boolean().optional(),
});

export const confirmActionSchema = z.object({
  action_id: z.string(),
});

export type CreateTwinSessionInput = z.infer<typeof createTwinSessionSchema>;
export type UpdateVisibilityInput = z.infer<typeof updateVisibilitySchema>;
export type ListTwinSessionsQuery = z.infer<typeof listTwinSessionsSchema>;
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/schemas/project-twin-session.schema.ts
git commit -m "feat: add Zod schemas for project twin sessions"
```

---

## Task 3: Project Tools Definition

**Files:**
- Create: `backend/src/services/project-tools.ts`

- [ ] **Step 1: Define tool schemas and handlers**

```typescript
import { prisma } from '../config/database.js';
import type { Prisma } from '@prisma/client';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface ProjectToolContext {
  projectId: string;
  organizationId: string;
  userId: string;
  issueId?: string;
  twinWorkspacePath: string;
  mainWorkspacePath: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export function getProjectToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'get_board_status',
      description: 'Get the current status of all issues on the project board. Returns issue number, title, status, priority, effort, and labels.',
      input_schema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'get_issue_detail',
      description: 'Get full details of a specific issue including description, acceptance criteria, comments, sub-tasks, and relations.',
      input_schema: {
        type: 'object',
        properties: {
          issue_number: { type: 'number', description: 'The issue number to look up' },
        },
        required: ['issue_number'],
      },
    },
    {
      name: 'read_project_context',
      description: 'List all summary/context files in the project workspace context/ directory. Returns filenames, creation time, and first-line preview.',
      input_schema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'read_context_file',
      description: 'Read the full content of a specific context file from the project workspace.',
      input_schema: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Name of the file in the context/ directory' },
        },
        required: ['filename'],
      },
    },
    {
      name: 'suggest_action',
      description: 'Suggest a project board action for the user to confirm. The action will NOT be executed automatically — the user must approve it first. Supported actions: create_issue, update_issue, add_comment, change_status.',
      input_schema: {
        type: 'object',
        properties: {
          action_type: {
            type: 'string',
            enum: ['create_issue', 'update_issue', 'add_comment', 'change_status'],
          },
          payload: {
            type: 'object',
            description: 'Action-specific payload. For create_issue: {title, description, priority, status}. For update_issue: {issue_number, title?, description?, priority?}. For add_comment: {issue_number, content}. For change_status: {issue_number, new_status}.',
          },
          reason: { type: 'string', description: 'Why you are suggesting this action' },
        },
        required: ['action_type', 'payload', 'reason'],
      },
    },
    {
      name: 'summarize_to_project',
      description: 'Write a summary of the current discussion to the project workspace so other team members and their twins can access it.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title for the summary file' },
          content: { type: 'string', description: 'Markdown content of the summary' },
        },
        required: ['title', 'content'],
      },
    },
  ];
}

export async function executeProjectTool(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ProjectToolContext,
): Promise<string> {
  switch (toolName) {
    case 'get_board_status':
      return handleGetBoardStatus(ctx);
    case 'get_issue_detail':
      return handleGetIssueDetail(input as { issue_number: number }, ctx);
    case 'read_project_context':
      return handleReadProjectContext(ctx);
    case 'read_context_file':
      return handleReadContextFile(input as { filename: string }, ctx);
    case 'suggest_action':
      return handleSuggestAction(
        input as { action_type: string; payload: Record<string, unknown>; reason: string },
        ctx,
      );
    case 'summarize_to_project':
      return handleSummarizeToProject(input as { title: string; content: string }, ctx);
    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }
}

async function handleGetBoardStatus(ctx: ProjectToolContext): Promise<string> {
  const issues = await prisma.project_issues.findMany({
    where: { project_id: ctx.projectId },
    select: {
      issue_number: true,
      title: true,
      status: true,
      priority: true,
      estimated_effort: true,
      labels: true,
    },
    orderBy: [{ status: 'asc' }, { sort_order: 'asc' }],
  });
  return JSON.stringify(issues);
}

async function handleGetIssueDetail(
  input: { issue_number: number },
  ctx: ProjectToolContext,
): Promise<string> {
  const issue = await prisma.project_issues.findFirst({
    where: { project_id: ctx.projectId, issue_number: input.issue_number },
    include: {
      comments: { orderBy: { created_at: 'asc' }, take: 20 },
      children: { select: { issue_number: true, title: true, status: true } },
      relations_as_source: {
        select: {
          relation_type: true,
          confidence: true,
          reasoning: true,
          status: true,
          target_issue: { select: { issue_number: true, title: true } },
        },
      },
      relations_as_target: {
        select: {
          relation_type: true,
          confidence: true,
          reasoning: true,
          status: true,
          source_issue: { select: { issue_number: true, title: true } },
        },
      },
    },
  });
  if (!issue) return JSON.stringify({ error: `Issue #${input.issue_number} not found` });
  return JSON.stringify(issue);
}

async function handleReadProjectContext(ctx: ProjectToolContext): Promise<string> {
  const contextDir = path.join(ctx.mainWorkspacePath, 'context');
  try {
    const files = await fs.readdir(contextDir);
    const entries = await Promise.all(
      files.filter(f => f.endsWith('.md')).map(async (filename) => {
        const filePath = path.join(contextDir, filename);
        const stat = await fs.stat(filePath);
        const content = await fs.readFile(filePath, 'utf-8');
        const firstLine = content.split('\n').find(l => l.trim()) ?? '';
        return { filename, created_at: stat.birthtime.toISOString(), preview: firstLine.slice(0, 100) };
      }),
    );
    return JSON.stringify(entries);
  } catch {
    return JSON.stringify([]);
  }
}

async function handleReadContextFile(
  input: { filename: string },
  ctx: ProjectToolContext,
): Promise<string> {
  const safeName = path.basename(input.filename);
  const filePath = path.join(ctx.mainWorkspacePath, 'context', safeName);
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return JSON.stringify({ error: `File not found: ${safeName}` });
  }
}

async function handleSuggestAction(
  input: { action_type: string; payload: Record<string, unknown>; reason: string },
  ctx: ProjectToolContext,
): Promise<string> {
  const actionsDir = path.join(ctx.twinWorkspacePath, 'actions');
  await fs.mkdir(actionsDir, { recursive: true });

  const indexPath = path.join(actionsDir, 'index.json');
  let index: Array<Record<string, unknown>> = [];
  try {
    index = JSON.parse(await fs.readFile(indexPath, 'utf-8'));
  } catch { /* empty index */ }

  const id = String(index.length + 1).padStart(3, '0');
  const action = {
    id,
    type: 'suggest_action',
    action_type: input.action_type,
    payload: input.payload,
    reason: input.reason,
    status: 'pending',
    created_at: new Date().toISOString(),
    resolved_at: null,
    resolved_by: null,
    result: null,
  };

  const actionFilename = `${id}-suggest-${input.action_type}.json`;
  await fs.writeFile(path.join(actionsDir, actionFilename), JSON.stringify(action, null, 2));

  index.push({
    id,
    type: 'suggest_action',
    action_type: input.action_type,
    status: 'pending',
    reason: input.reason,
    created_at: action.created_at,
    resolved_at: null,
    file: actionFilename,
  });
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2));

  return JSON.stringify({
    suggestion_id: id,
    message: `Suggestion submitted (ID: ${id}). Waiting for user confirmation.`,
    preview: { action_type: input.action_type, payload: input.payload, reason: input.reason },
  });
}

async function handleSummarizeToProject(
  input: { title: string; content: string },
  ctx: ProjectToolContext,
): Promise<string> {
  const contextDir = path.join(ctx.mainWorkspacePath, 'context');
  await fs.mkdir(contextDir, { recursive: true });

  const user = await prisma.profiles.findUnique({
    where: { id: ctx.userId },
    select: { username: true, full_name: true },
  });
  const userName = user?.username ?? user?.full_name ?? 'unknown';
  const date = new Date().toISOString().slice(0, 10);
  const slug = input.title.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').substring(0, 40);
  const filename = `${date}-${userName}-${slug}.md`;
  const filePath = path.join(contextDir, filename);

  await fs.writeFile(filePath, input.content, 'utf-8');

  return JSON.stringify({ written: filename, path: `context/${filename}` });
}
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/services/project-tools.ts
git commit -m "feat: add project tool definitions and execution handlers"
```

---

## Task 4: Twin Session Service

**Files:**
- Create: `backend/src/services/project-twin-session.service.ts`

- [ ] **Step 1: Create the service**

```typescript
import { prisma } from '../config/database.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { AppError } from '../middleware/errors.js';
import { executeProjectTool, type ProjectToolContext } from './project-tools.js';

const WORKSPACE_BASE = process.env.AGENT_WORKSPACE_BASE_DIR ?? '/tmp/workspaces';

export class ProjectTwinSessionService {
  async create(
    orgId: string,
    projectId: string,
    userId: string,
    input: { agent_id: string; issue_id?: string; visibility?: string },
  ) {
    const project = await prisma.projects.findFirst({
      where: { id: projectId, organization_id: orgId },
    });
    if (!project) throw AppError.notFound('Project not found');

    const member = await prisma.project_members.findFirst({
      where: { project_id: projectId, user_id: userId },
    });
    if (!member) throw AppError.forbidden('Not a project member');

    const agent = await prisma.agents.findFirst({
      where: { id: input.agent_id, organization_id: orgId },
    });
    if (!agent) throw AppError.notFound('Agent not found');

    const issue = input.issue_id
      ? await prisma.project_issues.findFirst({
          where: { id: input.issue_id, project_id: projectId },
        })
      : null;

    if (input.issue_id && !issue) throw AppError.notFound('Issue not found');

    const scopeId = agent.business_scope_id ?? project.business_scope_id;

    const chatSession = await prisma.chat_sessions.create({
      data: {
        organization_id: orgId,
        user_id: userId,
        business_scope_id: scopeId,
        agent_id: input.agent_id,
        title: issue
          ? `Twin: ${agent.display_name ?? agent.name} on #${issue.issue_number}`
          : `Twin: ${agent.display_name ?? agent.name} - ${project.name}`,
        status: 'idle',
        room_mode: 'single',
        routing_strategy: 'auto',
        context: {
          twin_session: true,
          project_id: projectId,
          issue_id: input.issue_id ?? null,
        },
      },
    });

    const twinSession = await prisma.project_twin_sessions.create({
      data: {
        project_id: projectId,
        session_id: chatSession.id,
        issue_id: input.issue_id ?? null,
        created_by: userId,
        agent_id: input.agent_id,
        visibility: input.visibility ?? 'private',
      },
    });

    await this.prepareWorkspace(chatSession.id, project, agent, issue);

    return {
      ...twinSession,
      chat_session_id: chatSession.id,
      agent_name: agent.display_name ?? agent.name,
      agent_avatar: agent.avatar,
    };
  }

  private async prepareWorkspace(
    sessionId: string,
    project: { id: string; name: string; repo_url: string | null; description: string | null },
    agent: { name: string; display_name: string | null; role: string | null },
    issue: { issue_number: number; title: string } | null,
  ) {
    const workspacePath = path.join(WORKSPACE_BASE, sessionId);
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.mkdir(path.join(workspacePath, 'actions'), { recursive: true });
    await fs.mkdir(path.join(workspacePath, 'notes'), { recursive: true });

    const focusSection = issue
      ? `\n## Current Focus\nIssue #${issue.issue_number}: ${issue.title}\n`
      : '';

    const claudeMd = `# Twin Session

## Project
- Name: ${project.name}
- Repository: ${project.repo_url ?? 'N/A'}
- Description: ${project.description ?? 'N/A'}
- Your role: Assist the user from the perspective of ${agent.display_name ?? agent.name} (${agent.role ?? 'assistant'})
${focusSection}
## Capabilities
You have tools to query the project board, read issue details, read historical discussion summaries, suggest actions (which require user confirmation), and write summaries back to the project.

Before answering questions, proactively use tools to get the latest information.
When the user asks you to make changes to the board, use the suggest_action tool — never claim you have made changes directly.
`;

    await fs.writeFile(path.join(workspacePath, 'CLAUDE.md'), claudeMd);

    await fs.writeFile(
      path.join(workspacePath, 'actions', 'index.json'),
      JSON.stringify([], null, 2),
    );
  }

  async list(
    orgId: string,
    projectId: string,
    userId: string,
    query: { issue_id?: string; visibility?: string; mine_only?: boolean },
  ) {
    const where: Record<string, unknown> = { project_id: projectId };

    if (query.issue_id) where.issue_id = query.issue_id;

    if (query.mine_only) {
      where.created_by = userId;
    } else {
      where.OR = [
        { created_by: userId },
        { visibility: 'public' },
      ];
    }

    const sessions = await prisma.project_twin_sessions.findMany({
      where,
      include: {
        agent: { select: { id: true, name: true, display_name: true, avatar: true } },
        creator: { select: { id: true, username: true, full_name: true, avatar_url: true } },
        issue: { select: { id: true, issue_number: true, title: true } },
        session: { select: { id: true, status: true } },
      },
      orderBy: { created_at: 'desc' },
    });

    return sessions;
  }

  async getById(orgId: string, projectId: string, twinSessionId: string, userId: string) {
    const ts = await prisma.project_twin_sessions.findFirst({
      where: { id: twinSessionId, project_id: projectId },
      include: {
        agent: { select: { id: true, name: true, display_name: true, avatar: true, role: true } },
        creator: { select: { id: true, username: true, full_name: true, avatar_url: true } },
        issue: { select: { id: true, issue_number: true, title: true, description: true, status: true, priority: true } },
        session: { select: { id: true, status: true, claude_session_id: true } },
      },
    });
    if (!ts) throw AppError.notFound('Twin session not found');
    if (ts.visibility === 'private' && ts.created_by !== userId) {
      throw AppError.forbidden('This session is private');
    }
    return ts;
  }

  async updateVisibility(
    orgId: string,
    projectId: string,
    twinSessionId: string,
    userId: string,
    visibility: string,
  ) {
    const ts = await prisma.project_twin_sessions.findFirst({
      where: { id: twinSessionId, project_id: projectId },
    });
    if (!ts) throw AppError.notFound('Twin session not found');
    if (ts.created_by !== userId) throw AppError.forbidden('Only the creator can change visibility');

    return prisma.project_twin_sessions.update({
      where: { id: twinSessionId },
      data: { visibility },
    });
  }

  async delete(orgId: string, projectId: string, twinSessionId: string, userId: string) {
    const ts = await prisma.project_twin_sessions.findFirst({
      where: { id: twinSessionId, project_id: projectId },
    });
    if (!ts) throw AppError.notFound('Twin session not found');
    if (ts.created_by !== userId) throw AppError.forbidden('Only the creator can delete');

    await prisma.project_twin_sessions.delete({ where: { id: twinSessionId } });
    await prisma.chat_sessions.delete({ where: { id: ts.session_id } }).catch(() => {});
  }

  async confirmAction(
    orgId: string,
    projectId: string,
    twinSessionId: string,
    actionId: string,
    userId: string,
  ) {
    const ts = await prisma.project_twin_sessions.findFirst({
      where: { id: twinSessionId, project_id: projectId },
    });
    if (!ts) throw AppError.notFound('Twin session not found');
    if (ts.created_by !== userId) throw AppError.forbidden('Only the session owner can confirm actions');

    const workspacePath = path.join(WORKSPACE_BASE, ts.session_id);
    const indexPath = path.join(workspacePath, 'actions', 'index.json');
    const index: Array<Record<string, unknown>> = JSON.parse(await fs.readFile(indexPath, 'utf-8'));

    const entry = index.find(e => e.id === actionId);
    if (!entry) throw AppError.notFound('Action not found');
    if (entry.status !== 'pending') throw AppError.validation('Action is not pending');

    const actionFile = path.join(workspacePath, 'actions', entry.file as string);
    const action = JSON.parse(await fs.readFile(actionFile, 'utf-8'));

    const result = await this.executeAction(orgId, projectId, userId, action);

    action.status = 'confirmed';
    action.resolved_at = new Date().toISOString();
    action.resolved_by = userId;
    action.result = result;
    await fs.writeFile(actionFile, JSON.stringify(action, null, 2));

    entry.status = 'confirmed';
    entry.resolved_at = action.resolved_at;
    await fs.writeFile(indexPath, JSON.stringify(index, null, 2));

    return result;
  }

  async rejectAction(
    orgId: string,
    projectId: string,
    twinSessionId: string,
    actionId: string,
    userId: string,
  ) {
    const ts = await prisma.project_twin_sessions.findFirst({
      where: { id: twinSessionId, project_id: projectId },
    });
    if (!ts) throw AppError.notFound('Twin session not found');

    const workspacePath = path.join(WORKSPACE_BASE, ts.session_id);
    const indexPath = path.join(workspacePath, 'actions', 'index.json');
    const index: Array<Record<string, unknown>> = JSON.parse(await fs.readFile(indexPath, 'utf-8'));

    const entry = index.find(e => e.id === actionId);
    if (!entry) throw AppError.notFound('Action not found');

    const actionFile = path.join(workspacePath, 'actions', entry.file as string);
    const action = JSON.parse(await fs.readFile(actionFile, 'utf-8'));

    action.status = 'rejected';
    action.resolved_at = new Date().toISOString();
    action.resolved_by = userId;
    await fs.writeFile(actionFile, JSON.stringify(action, null, 2));

    entry.status = 'rejected';
    entry.resolved_at = action.resolved_at;
    await fs.writeFile(indexPath, JSON.stringify(index, null, 2));

    return { status: 'rejected', action_id: actionId };
  }

  private async executeAction(
    orgId: string,
    projectId: string,
    userId: string,
    action: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const payload = action.payload as Record<string, unknown>;
    const { projectService } = await import('./project.service.js');

    switch (action.action_type) {
      case 'create_issue': {
        const issue = await projectService.createIssue(orgId, projectId, userId, {
          title: payload.title as string,
          description: (payload.description as string) ?? '',
          priority: (payload.priority as string) ?? 'medium',
          status: (payload.status as string) ?? 'backlog',
        });
        return { issue_number: issue.issue_number, issue_id: issue.id };
      }
      case 'update_issue': {
        const issueNumber = payload.issue_number as number;
        const issue = await prisma.project_issues.findFirst({
          where: { project_id: projectId, issue_number: issueNumber },
        });
        if (!issue) throw AppError.notFound(`Issue #${issueNumber} not found`);
        const { issue_number: _, ...fields } = payload;
        const updated = await projectService.updateIssue(orgId, projectId, issue.id, userId, fields);
        return { updated: true, issue_number: issueNumber };
      }
      case 'add_comment': {
        const issueNumber = payload.issue_number as number;
        const issue = await prisma.project_issues.findFirst({
          where: { project_id: projectId, issue_number: issueNumber },
        });
        if (!issue) throw AppError.notFound(`Issue #${issueNumber} not found`);
        await projectService.addComment(orgId, projectId, issue.id, userId, {
          content: payload.content as string,
        });
        return { commented: true, issue_number: issueNumber };
      }
      case 'change_status': {
        const issueNumber = payload.issue_number as number;
        const issue = await prisma.project_issues.findFirst({
          where: { project_id: projectId, issue_number: issueNumber },
        });
        if (!issue) throw AppError.notFound(`Issue #${issueNumber} not found`);
        await projectService.changeIssueStatus(orgId, projectId, issue.id, userId, payload.new_status as string);
        return { status_changed: true, issue_number: issueNumber, new_status: payload.new_status };
      }
      default:
        throw AppError.validation(`Unknown action type: ${action.action_type}`);
    }
  }

  async getActiveSessionsForIssue(projectId: string, issueId: string) {
    return prisma.project_twin_sessions.findMany({
      where: {
        project_id: projectId,
        issue_id: issueId,
        session: { status: { not: 'error' } },
      },
      include: {
        agent: { select: { id: true, display_name: true, avatar: true } },
        creator: { select: { id: true, username: true, full_name: true } },
      },
    });
  }

  async getActiveSessionsForProject(projectId: string) {
    return prisma.project_twin_sessions.findMany({
      where: {
        project_id: projectId,
        session: { status: { not: 'error' } },
      },
      include: {
        agent: { select: { id: true, display_name: true, avatar: true } },
        creator: { select: { id: true, username: true, full_name: true } },
        issue: { select: { id: true, issue_number: true, title: true } },
      },
    });
  }
}

export const projectTwinSessionService = new ProjectTwinSessionService();
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/services/project-twin-session.service.ts
git commit -m "feat: add ProjectTwinSessionService with CRUD and action confirm/reject"
```

---

## Task 5: Twin Session Routes

**Files:**
- Create: `backend/src/routes/project-twin-sessions.routes.ts`
- Modify: `backend/src/routes/projects.routes.ts` (register sub-routes)

- [ ] **Step 1: Create route file**

```typescript
import type { FastifyInstance } from 'fastify';
import { authenticate } from '../middleware/auth.js';
import { projectTwinSessionService } from '../services/project-twin-session.service.js';
import {
  createTwinSessionSchema,
  updateVisibilitySchema,
  listTwinSessionsSchema,
} from '../schemas/project-twin-session.schema.js';

export async function projectTwinSessionRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Params: { id: string } }>(
    '/',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const body = createTwinSessionSchema.parse(request.body);
      const result = await projectTwinSessionService.create(
        request.user!.orgId,
        request.params.id,
        request.user!.id,
        body,
      );
      return reply.status(201).send(result);
    },
  );

  fastify.get<{ Params: { id: string } }>(
    '/',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const query = listTwinSessionsSchema.parse(request.query);
      const sessions = await projectTwinSessionService.list(
        request.user!.orgId,
        request.params.id,
        request.user!.id,
        query,
      );
      return reply.send({ data: sessions });
    },
  );

  fastify.get<{ Params: { id: string; twinSessionId: string } }>(
    '/:twinSessionId',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const ts = await projectTwinSessionService.getById(
        request.user!.orgId,
        request.params.id,
        request.params.twinSessionId,
        request.user!.id,
      );
      return reply.send(ts);
    },
  );

  fastify.patch<{ Params: { id: string; twinSessionId: string } }>(
    '/:twinSessionId/visibility',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const body = updateVisibilitySchema.parse(request.body);
      const result = await projectTwinSessionService.updateVisibility(
        request.user!.orgId,
        request.params.id,
        request.params.twinSessionId,
        request.user!.id,
        body.visibility,
      );
      return reply.send(result);
    },
  );

  fastify.delete<{ Params: { id: string; twinSessionId: string } }>(
    '/:twinSessionId',
    { preHandler: [authenticate] },
    async (request, reply) => {
      await projectTwinSessionService.delete(
        request.user!.orgId,
        request.params.id,
        request.params.twinSessionId,
        request.user!.id,
      );
      return reply.status(204).send();
    },
  );

  fastify.post<{ Params: { id: string; twinSessionId: string; actionId: string } }>(
    '/:twinSessionId/actions/:actionId/confirm',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const result = await projectTwinSessionService.confirmAction(
        request.user!.orgId,
        request.params.id,
        request.params.twinSessionId,
        request.params.actionId,
        request.user!.id,
      );
      return reply.send(result);
    },
  );

  fastify.post<{ Params: { id: string; twinSessionId: string; actionId: string } }>(
    '/:twinSessionId/actions/:actionId/reject',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const result = await projectTwinSessionService.rejectAction(
        request.user!.orgId,
        request.params.id,
        request.params.twinSessionId,
        request.params.actionId,
        request.user!.id,
      );
      return reply.send(result);
    },
  );

  fastify.get<{ Params: { id: string } }>(
    '/active',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const sessions = await projectTwinSessionService.getActiveSessionsForProject(
        request.params.id,
      );
      return reply.send({ data: sessions });
    },
  );
}
```

- [ ] **Step 2: Register sub-routes in projects.routes.ts**

In `backend/src/routes/projects.routes.ts`, add at the top of the file:

```typescript
import { projectTwinSessionRoutes } from './project-twin-sessions.routes.js';
```

And inside the `projectRoutes` function body, add:

```typescript
fastify.register(projectTwinSessionRoutes, { prefix: '/:id/twin-sessions' });
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/project-twin-sessions.routes.ts backend/src/routes/projects.routes.ts
git commit -m "feat: add REST routes for project twin sessions"
```

---

## Task 6: Inject Project Tools into Chat Service

**Files:**
- Modify: `backend/src/services/chat.service.ts`

This is the most delicate change — we add a hook in `prepareScopeSession` so that when the chat session is a twin session, the project tools get injected.

- [ ] **Step 1: Add import at top of chat.service.ts**

```typescript
import { getProjectToolDefinitions, executeProjectTool, type ProjectToolContext } from './project-tools.js';
```

- [ ] **Step 2: Add twin session detection method to ChatService class**

Add this method to the `ChatService` class:

```typescript
private async getTwinSessionContext(sessionId: string, orgId: string): Promise<ProjectToolContext | null> {
  const twinSession = await prisma.project_twin_sessions.findFirst({
    where: { session_id: sessionId },
    include: {
      project: { select: { id: true, workspace_session_id: true } },
    },
  });
  if (!twinSession) return null;

  const mainWorkspacePath = twinSession.project.workspace_session_id
    ? path.join(process.env.AGENT_WORKSPACE_BASE_DIR ?? '/tmp/workspaces', twinSession.project.workspace_session_id)
    : '';

  return {
    projectId: twinSession.project_id,
    organizationId: orgId,
    userId: twinSession.created_by,
    issueId: twinSession.issue_id ?? undefined,
    twinWorkspacePath: path.join(process.env.AGENT_WORKSPACE_BASE_DIR ?? '/tmp/workspaces', sessionId),
    mainWorkspacePath,
  };
}
```

- [ ] **Step 3: Hook into prepareScopeSession**

In the `prepareScopeSession` method, after the agent config is built (after the `agentConfig` object is created, around line 961), add:

```typescript
const twinCtx = await this.getTwinSessionContext(sessionId, organizationId);
if (twinCtx) {
  const projectToolDefs = getProjectToolDefinitions();
  agentConfig.projectTools = projectToolDefs;
  agentConfig.projectToolContext = twinCtx;
}
```

This requires adding `projectTools` and `projectToolContext` to the `AgentConfig` type. In `backend/src/services/agent-runtime.ts`, extend `AgentConfig`:

```typescript
export interface AgentConfig {
  // ... existing fields
  projectTools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  projectToolContext?: import('./project-tools.js').ProjectToolContext;
}
```

- [ ] **Step 4: Handle project tool execution in the agent runtime**

In `backend/src/services/agent-runtime-claude.ts` (or wherever tool results are processed), add handling for project tool calls. When the Claude agent calls a tool whose name matches one of the project tools, intercept it and call `executeProjectTool` instead of passing it to the Claude Code subprocess.

The exact location depends on how `claudeAgentService.runConversation` dispatches tool calls. Add a tool result interceptor:

```typescript
if (agentConfig.projectTools && agentConfig.projectToolContext) {
  const projectToolNames = new Set(agentConfig.projectTools.map(t => t.name));
  // When a tool_use event comes in with a name in projectToolNames,
  // call executeProjectTool(toolName, toolInput, agentConfig.projectToolContext)
  // and yield the result back as a tool_result event
}
```

The exact integration point varies by how the claude agent service processes tool calls. Look for the tool execution loop and add the project tool dispatch there.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/chat.service.ts backend/src/services/agent-runtime.ts backend/src/services/agent-runtime-claude.ts
git commit -m "feat: inject project tools into twin session chat pipeline"
```

---

## Task 7: Frontend API Client

**Files:**
- Create: `frontend/src/services/api/restTwinSessionService.ts`

- [ ] **Step 1: Create the API service**

```typescript
import { restClient } from './restClient';

export interface TwinSessionSummary {
  id: string;
  project_id: string;
  session_id: string;
  issue_id: string | null;
  created_by: string;
  agent_id: string;
  visibility: 'private' | 'public';
  created_at: string;
  agent: { id: string; name: string; display_name: string | null; avatar: string | null };
  creator: { id: string; username: string | null; full_name: string | null; avatar_url: string | null };
  issue: { id: string; issue_number: number; title: string } | null;
  session: { id: string; status: string };
}

export interface TwinSessionDetail extends TwinSessionSummary {
  agent: TwinSessionSummary['agent'] & { role: string | null };
  issue: (TwinSessionSummary['issue'] & { description: string | null; status: string; priority: string }) | null;
  session: TwinSessionSummary['session'] & { claude_session_id: string | null };
}

export interface ActionEntry {
  id: string;
  type: string;
  action_type: string;
  status: 'pending' | 'confirmed' | 'rejected';
  reason: string;
  created_at: string;
  resolved_at: string | null;
  file: string;
}

export const RestTwinSessionService = {
  async create(
    projectId: string,
    input: { agent_id: string; issue_id?: string; visibility?: string },
  ): Promise<TwinSessionSummary & { chat_session_id: string }> {
    return restClient.post(`/api/projects/${projectId}/twin-sessions`, input);
  },

  async list(
    projectId: string,
    query?: { issue_id?: string; visibility?: string; mine_only?: boolean },
  ): Promise<TwinSessionSummary[]> {
    const params = new URLSearchParams();
    if (query?.issue_id) params.set('issue_id', query.issue_id);
    if (query?.visibility) params.set('visibility', query.visibility);
    if (query?.mine_only) params.set('mine_only', 'true');
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await restClient.get<{ data: TwinSessionSummary[] }>(
      `/api/projects/${projectId}/twin-sessions${qs}`,
    );
    return res.data;
  },

  async getById(projectId: string, twinSessionId: string): Promise<TwinSessionDetail> {
    return restClient.get(`/api/projects/${projectId}/twin-sessions/${twinSessionId}`);
  },

  async updateVisibility(
    projectId: string,
    twinSessionId: string,
    visibility: 'private' | 'public',
  ) {
    return restClient.patch(`/api/projects/${projectId}/twin-sessions/${twinSessionId}/visibility`, {
      visibility,
    });
  },

  async delete(projectId: string, twinSessionId: string): Promise<void> {
    return restClient.delete(`/api/projects/${projectId}/twin-sessions/${twinSessionId}`);
  },

  async confirmAction(projectId: string, twinSessionId: string, actionId: string) {
    return restClient.post(
      `/api/projects/${projectId}/twin-sessions/${twinSessionId}/actions/${actionId}/confirm`,
    );
  },

  async rejectAction(projectId: string, twinSessionId: string, actionId: string) {
    return restClient.post(
      `/api/projects/${projectId}/twin-sessions/${twinSessionId}/actions/${actionId}/reject`,
    );
  },

  async getActiveSessions(projectId: string): Promise<TwinSessionSummary[]> {
    const res = await restClient.get<{ data: TwinSessionSummary[] }>(
      `/api/projects/${projectId}/twin-sessions/active`,
    );
    return res.data;
  },
};
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/services/api/restTwinSessionService.ts
git commit -m "feat: add frontend API client for twin sessions"
```

---

## Task 8: i18n Translations

**Files:**
- Modify: `frontend/src/i18n/translations.ts`

- [ ] **Step 1: Add twin session translation keys**

Add after the existing project-related translations:

```typescript
'twinSession.title': { en: 'Twin Sessions', cn: '分身会话' },
'twinSession.new': { en: 'New Twin Session', cn: '新建分身会话' },
'twinSession.selectAgent': { en: 'Select Agent', cn: '选择智能体' },
'twinSession.bindIssue': { en: 'Bind to Issue (optional)', cn: '绑定 Issue（可选）' },
'twinSession.bindIssue.none': { en: 'Project-level (no specific issue)', cn: '项目级别（不绑定 Issue）' },
'twinSession.visibility': { en: 'Visibility', cn: '可见性' },
'twinSession.visibility.private': { en: 'Private', cn: '私密' },
'twinSession.visibility.public': { en: 'Public', cn: '公开' },
'twinSession.emptyState': { en: 'Start a conversation with your twin', cn: '开始与分身对话' },
'twinSession.noSessions': { en: 'No twin sessions yet', cn: '暂无分身会话' },
'twinSession.discussIssue': { en: 'Discuss with Twin', cn: '与分身讨论' },
'twinSession.popOut': { en: 'Open in full page', cn: '全页面打开' },
'twinSession.privateNotice': { en: 'This session is private and cannot be viewed', cn: '该会话为私密，无法查看' },
'twinSession.active': { en: 'Active', cn: '进行中' },
'twinSession.suggestion': { en: 'Suggestion', cn: '操作建议' },
'twinSession.suggestion.confirm': { en: 'Confirm', cn: '确认执行' },
'twinSession.suggestion.reject': { en: 'Reject', cn: '拒绝' },
'twinSession.suggestion.confirmed': { en: 'Confirmed', cn: '已确认' },
'twinSession.suggestion.rejected': { en: 'Rejected', cn: '已拒绝' },
'twinSession.suggestion.pending': { en: 'Pending', cn: '待确认' },
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/i18n/translations.ts
git commit -m "feat: add i18n translations for twin sessions"
```

---

## Task 9: SuggestionCard Component

**Files:**
- Create: `frontend/src/components/SuggestionCard.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useState } from 'react';
import { Check, X, Loader2, AlertCircle } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { RestTwinSessionService } from '@/services/api/restTwinSessionService';

interface SuggestionCardProps {
  projectId: string;
  twinSessionId: string;
  suggestion: {
    suggestion_id: string;
    preview: {
      action_type: string;
      payload: Record<string, unknown>;
      reason: string;
    };
  };
  onResolved?: (actionId: string, status: 'confirmed' | 'rejected') => void;
}

const ACTION_LABELS: Record<string, { en: string; cn: string }> = {
  create_issue: { en: 'Create Issue', cn: '创建 Issue' },
  update_issue: { en: 'Update Issue', cn: '更新 Issue' },
  add_comment: { en: 'Add Comment', cn: '添加评论' },
  change_status: { en: 'Change Status', cn: '变更状态' },
};

export function SuggestionCard({ projectId, twinSessionId, suggestion, onResolved }: SuggestionCardProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<'pending' | 'confirming' | 'rejecting' | 'confirmed' | 'rejected'>('pending');

  const { preview } = suggestion;
  const actionLabel = ACTION_LABELS[preview.action_type]?.en ?? preview.action_type;

  const handleConfirm = async () => {
    setStatus('confirming');
    try {
      await RestTwinSessionService.confirmAction(projectId, twinSessionId, suggestion.suggestion_id);
      setStatus('confirmed');
      onResolved?.(suggestion.suggestion_id, 'confirmed');
    } catch {
      setStatus('pending');
    }
  };

  const handleReject = async () => {
    setStatus('rejecting');
    try {
      await RestTwinSessionService.rejectAction(projectId, twinSessionId, suggestion.suggestion_id);
      setStatus('rejected');
      onResolved?.(suggestion.suggestion_id, 'rejected');
    } catch {
      setStatus('pending');
    }
  };

  const isResolved = status === 'confirmed' || status === 'rejected';

  return (
    <div className={`border rounded-lg p-3 my-2 ${
      status === 'confirmed' ? 'border-green-500/30 bg-green-500/5' :
      status === 'rejected' ? 'border-red-500/30 bg-red-500/5' :
      'border-yellow-500/30 bg-yellow-500/5'
    }`}>
      <div className="flex items-center gap-2 mb-2">
        <AlertCircle size={14} className="text-yellow-400" />
        <span className="text-xs font-medium text-yellow-300">{t('twinSession.suggestion')}: {actionLabel}</span>
        {isResolved && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${
            status === 'confirmed' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
          }`}>
            {status === 'confirmed' ? t('twinSession.suggestion.confirmed') : t('twinSession.suggestion.rejected')}
          </span>
        )}
      </div>

      <p className="text-xs text-gray-300 mb-2">{preview.reason}</p>

      <pre className="text-[10px] text-gray-400 bg-gray-800/50 rounded p-2 mb-2 overflow-x-auto">
        {JSON.stringify(preview.payload, null, 2)}
      </pre>

      {!isResolved && (
        <div className="flex gap-2">
          <button
            onClick={handleConfirm}
            disabled={status !== 'pending'}
            className="flex items-center gap-1 px-2.5 py-1 text-xs bg-green-600/20 hover:bg-green-600/30 text-green-400 border border-green-500/30 rounded transition-colors disabled:opacity-50"
          >
            {status === 'confirming' ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            {t('twinSession.suggestion.confirm')}
          </button>
          <button
            onClick={handleReject}
            disabled={status !== 'pending'}
            className="flex items-center gap-1 px-2.5 py-1 text-xs bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-500/30 rounded transition-colors disabled:opacity-50"
          >
            {status === 'rejecting' ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
            {t('twinSession.suggestion.reject')}
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/SuggestionCard.tsx
git commit -m "feat: add SuggestionCard component for twin session action confirm/reject"
```

---

## Task 10: CreateTwinSessionModal Component

**Files:**
- Create: `frontend/src/components/CreateTwinSessionModal.tsx`

- [ ] **Step 1: Create the modal component**

```tsx
import { useState, useEffect } from 'react';
import { X, Loader2 } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { restClient } from '@/services/api/restClient';
import type { ProjectIssue } from '@/services/api/restProjectService';

interface Agent {
  id: string;
  name: string;
  display_name: string | null;
  avatar: string | null;
  role: string | null;
}

interface CreateTwinSessionModalProps {
  projectId: string;
  scopeId: string | null;
  issues: ProjectIssue[];
  preSelectedIssueId?: string;
  onClose: () => void;
  onCreate: (input: { agent_id: string; issue_id?: string; visibility?: string }) => Promise<void>;
}

export function CreateTwinSessionModal({
  projectId,
  scopeId,
  issues,
  preSelectedIssueId,
  onClose,
  onCreate,
}: CreateTwinSessionModalProps) {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [selectedIssueId, setSelectedIssueId] = useState<string>(preSelectedIssueId ?? '');
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    async function loadAgents() {
      setIsLoading(true);
      try {
        const res = await restClient.get<Agent[]>('/api/agents');
        setAgents(res);
      } catch {
        setAgents([]);
      } finally {
        setIsLoading(false);
      }
    }
    loadAgents();
  }, [scopeId]);

  const handleCreate = async () => {
    if (!selectedAgentId) return;
    setIsCreating(true);
    try {
      await onCreate({
        agent_id: selectedAgentId,
        issue_id: selectedIssueId || undefined,
        visibility,
      });
      onClose();
    } catch {
      // error handled by parent
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-white">{t('twinSession.new')}</h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-800 rounded">
            <X size={16} className="text-gray-400" />
          </button>
        </div>

        <div className="space-y-4">
          {/* Agent selector */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">{t('twinSession.selectAgent')}</label>
            {isLoading ? (
              <Loader2 size={16} className="animate-spin text-gray-500" />
            ) : (
              <select
                value={selectedAgentId}
                onChange={(e) => setSelectedAgentId(e.target.value)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white"
              >
                <option value="">--</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.display_name ?? a.name} {a.role ? `(${a.role})` : ''}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Issue selector */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">{t('twinSession.bindIssue')}</label>
            <select
              value={selectedIssueId}
              onChange={(e) => setSelectedIssueId(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white"
            >
              <option value="">{t('twinSession.bindIssue.none')}</option>
              {issues.map((issue) => (
                <option key={issue.id} value={issue.id}>
                  #{issue.issue_number} {issue.title}
                </option>
              ))}
            </select>
          </div>

          {/* Visibility */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">{t('twinSession.visibility')}</label>
            <div className="flex gap-3">
              <label className="flex items-center gap-1.5 text-xs text-gray-300">
                <input
                  type="radio"
                  value="private"
                  checked={visibility === 'private'}
                  onChange={() => setVisibility('private')}
                  className="accent-blue-500"
                />
                {t('twinSession.visibility.private')}
              </label>
              <label className="flex items-center gap-1.5 text-xs text-gray-300">
                <input
                  type="radio"
                  value="public"
                  checked={visibility === 'public'}
                  onChange={() => setVisibility('public')}
                  className="accent-blue-500"
                />
                {t('twinSession.visibility.public')}
              </label>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-gray-400 hover:text-white transition-colors"
          >
            {t('common.cancel') ?? 'Cancel'}
          </button>
          <button
            onClick={handleCreate}
            disabled={!selectedAgentId || isCreating}
            className="px-4 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg transition-colors"
          >
            {isCreating ? <Loader2 size={14} className="animate-spin" /> : t('twinSession.new')}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/CreateTwinSessionModal.tsx
git commit -m "feat: add CreateTwinSessionModal for agent selection and issue binding"
```

---

## Task 11: TwinSessionPanel (Sidebar Chat)

**Files:**
- Create: `frontend/src/components/TwinSessionPanel.tsx`

This is the core chat panel that gets embedded as a sidebar in ProjectBoard and also used by the pop-out page. It reuses the existing Chat page's SSE streaming pattern.

- [ ] **Step 1: Create the panel component**

```tsx
import { useState, useEffect, useRef, useCallback } from 'react';
import { Send, Loader2, Maximize2, Eye, EyeOff, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { getAuthToken } from '@/services/api/restClient';
import { RestTwinSessionService, type TwinSessionDetail } from '@/services/api/restTwinSessionService';
import { SuggestionCard } from './SuggestionCard';

interface ChatMessage {
  id: string;
  type: 'user' | 'agent' | 'ai' | 'system';
  content: string;
  agent_id: string | null;
  created_at: string;
  metadata?: Record<string, unknown>;
}

interface TwinSessionPanelProps {
  projectId: string;
  twinSessionId: string;
  isFullPage?: boolean;
  onClose?: () => void;
}

export function TwinSessionPanel({ projectId, twinSessionId, isFullPage, onClose }: TwinSessionPanelProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<TwinSessionDetail | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    async function load() {
      setIsLoading(true);
      try {
        const [ts, history] = await Promise.all([
          RestTwinSessionService.getById(projectId, twinSessionId),
          loadHistory(),
        ]);
        setDetail(ts);
        setMessages(history);
      } catch {
        // handle error
      } finally {
        setIsLoading(false);
      }
    }

    async function loadHistory(): Promise<ChatMessage[]> {
      const d = await RestTwinSessionService.getById(projectId, twinSessionId);
      const res = await fetch(
        `${import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000'}/api/chat/history/${d.session_id}?limit=50`,
        {
          headers: { Authorization: `Bearer ${await getAuthToken()}` },
        },
      );
      if (!res.ok) return [];
      const data = await res.json();
      return data.messages ?? data ?? [];
    }

    load();
  }, [projectId, twinSessionId]);

  useEffect(scrollToBottom, [messages, scrollToBottom]);

  const handleSend = async () => {
    if (!input.trim() || isSending || !detail) return;
    const content = input.trim();
    setInput('');

    const userMsg: ChatMessage = {
      id: `temp-${Date.now()}`,
      type: 'user',
      content,
      agent_id: null,
      created_at: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);

    const aiMsgId = `temp-ai-${Date.now()}`;
    const aiMsg: ChatMessage = {
      id: aiMsgId,
      type: 'ai',
      content: '',
      agent_id: detail.agent_id,
      created_at: new Date().toISOString(),
    };
    setMessages(prev => [...prev, aiMsg]);
    setIsSending(true);

    try {
      const token = await getAuthToken();
      const baseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
      const response = await fetch(`${baseUrl}/api/chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          session_id: detail.session.id,
          business_scope_id: undefined,
          message: content,
        }),
      });

      if (!response.ok) throw new Error(`Request failed: ${response.status}`);

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'assistant' && Array.isArray(parsed.content)) {
              const textBlocks = parsed.content.filter((b: { type: string }) => b.type === 'text');
              fullText = textBlocks.map((b: { text: string }) => b.text).join('\n');
              setMessages(prev =>
                prev.map(m => (m.id === aiMsgId ? { ...m, content: fullText } : m)),
              );
            }
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      setMessages(prev =>
        prev.map(m =>
          m.id === aiMsgId
            ? { ...m, content: err instanceof Error ? err.message : 'Failed to send' }
            : m,
        ),
      );
    } finally {
      setIsSending(false);
    }
  };

  const handleToggleVisibility = async () => {
    if (!detail) return;
    const newVis = detail.visibility === 'private' ? 'public' : 'private';
    await RestTwinSessionService.updateVisibility(projectId, twinSessionId, newVis);
    setDetail({ ...detail, visibility: newVis });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 text-blue-500 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-gray-950">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {detail?.agent.avatar ? (
            <img src={detail.agent.avatar} alt="" className="w-6 h-6 rounded-full object-cover" />
          ) : (
            <div className="w-6 h-6 rounded-full bg-purple-600 flex items-center justify-center text-[10px] text-white">
              {(detail?.agent.display_name ?? detail?.agent.name ?? 'T')[0]}
            </div>
          )}
          <div className="min-w-0">
            <p className="text-xs font-medium text-white truncate">
              {detail?.agent.display_name ?? detail?.agent.name}
            </p>
            {detail?.issue && (
              <p className="text-[10px] text-gray-500 truncate">
                #{detail.issue.issue_number} {detail.issue.title}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleToggleVisibility}
            className="p-1 text-gray-500 hover:text-white rounded transition-colors"
            title={detail?.visibility === 'private' ? 'Make public' : 'Make private'}
          >
            {detail?.visibility === 'private' ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
          {!isFullPage && (
            <button
              onClick={() => navigate(`/projects/${projectId}/twin-session/${twinSessionId}`)}
              className="p-1 text-gray-500 hover:text-white rounded transition-colors"
              title={t('twinSession.popOut')}
            >
              <Maximize2 size={14} />
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 text-gray-500 hover:text-white rounded transition-colors"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-600 text-xs">
            {t('twinSession.emptyState')}
          </div>
        ) : (
          messages.map((msg) => {
            if (msg.metadata && (msg.metadata as Record<string, unknown>).suggestion_id) {
              return (
                <SuggestionCard
                  key={msg.id}
                  projectId={projectId}
                  twinSessionId={twinSessionId}
                  suggestion={{
                    suggestion_id: (msg.metadata as Record<string, unknown>).suggestion_id as string,
                    preview: (msg.metadata as Record<string, unknown>).preview as {
                      action_type: string;
                      payload: Record<string, unknown>;
                      reason: string;
                    },
                  }}
                />
              );
            }

            return (
              <div
                key={msg.id}
                className={`flex gap-2 ${msg.type === 'user' ? 'flex-row-reverse' : ''}`}
              >
                <div
                  className={`max-w-[80%] px-3 py-2 rounded-xl text-xs ${
                    msg.type === 'user'
                      ? 'bg-blue-600/15 border border-blue-500/20 text-white rounded-br-sm'
                      : 'bg-gray-800 text-gray-100 rounded-bl-sm'
                  }`}
                >
                  <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-gray-800 px-3 py-2 flex-shrink-0">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={t('twinSession.emptyState')}
            className="flex-1 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-xs text-white placeholder-gray-600 outline-none focus:border-blue-500"
            disabled={isSending}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isSending}
            className="px-2.5 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg transition-colors"
          >
            {isSending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/TwinSessionPanel.tsx
git commit -m "feat: add TwinSessionPanel with SSE streaming and suggestion cards"
```

---

## Task 12: TwinSessionPage (Pop-out Route)

**Files:**
- Create: `frontend/src/pages/TwinSessionPage.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Create the page component**

```tsx
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { TwinSessionPanel } from '@/components/TwinSessionPanel';

export function TwinSessionPage() {
  const { id: projectId, twinSessionId } = useParams<{ id: string; twinSessionId: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();

  if (!projectId || !twinSessionId) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        Invalid session
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-gray-950">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800">
        <button
          onClick={() => navigate(`/projects/${projectId}`)}
          className="p-1.5 hover:bg-gray-800 rounded-lg transition-colors"
        >
          <ArrowLeft size={18} className="text-gray-400" />
        </button>
        <h1 className="text-sm font-semibold text-white">{t('twinSession.title')}</h1>
      </div>
      <div className="flex-1 overflow-hidden">
        <TwinSessionPanel
          projectId={projectId}
          twinSessionId={twinSessionId}
          isFullPage
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add route to App.tsx**

Import at top of `frontend/src/App.tsx`:

```typescript
import { TwinSessionPage } from '@/pages/TwinSessionPage';
```

Add route after the existing `/projects/:id` route:

```tsx
<Route path="/projects/:id/twin-session/:twinSessionId" element={<TwinSessionPage />} />
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/TwinSessionPage.tsx frontend/src/App.tsx
git commit -m "feat: add TwinSessionPage with pop-out route"
```

---

## Task 13: Integrate into ProjectBoard

**Files:**
- Modify: `frontend/src/pages/ProjectBoard.tsx`

This is the largest frontend change. We add: twin session sidebar toggle, session list, issue card active indicators, and the "Discuss with Twin" button in issue detail modal.

- [ ] **Step 1: Add imports**

At the top of `ProjectBoard.tsx`, add:

```typescript
import { MessageSquare } from 'lucide-react';
import { TwinSessionPanel } from '@/components/TwinSessionPanel';
import { CreateTwinSessionModal } from '@/components/CreateTwinSessionModal';
import { RestTwinSessionService, type TwinSessionSummary } from '@/services/api/restTwinSessionService';
```

- [ ] **Step 2: Add state variables**

After the existing state declarations (around line 100), add:

```typescript
const [twinSessions, setTwinSessions] = useState<TwinSessionSummary[]>([]);
const [activeTwinSessionId, setActiveTwinSessionId] = useState<string | null>(null);
const [showTwinPanel, setShowTwinPanel] = useState(false);
const [showCreateTwinModal, setShowCreateTwinModal] = useState(false);
const [createTwinPreselectedIssueId, setCreateTwinPreselectedIssueId] = useState<string | undefined>();
```

- [ ] **Step 3: Add data loading**

After the existing `loadData` function, add:

```typescript
const loadTwinSessions = useCallback(async () => {
  if (!projectId) return;
  try {
    const sessions = await RestTwinSessionService.getActiveSessions(projectId);
    setTwinSessions(sessions);
  } catch {
    console.error('Failed to load twin sessions');
  }
}, [projectId]);

useEffect(() => {
  loadTwinSessions();
}, [loadTwinSessions]);
```

- [ ] **Step 4: Add Twin Sessions button to header toolbar**

In the header area (around line 433-480), next to existing buttons like settings and triage, add:

```tsx
<button
  onClick={() => setShowTwinPanel(!showTwinPanel)}
  className={`p-1.5 rounded-lg transition-colors ${
    showTwinPanel
      ? 'text-purple-400 bg-purple-600/20'
      : 'text-gray-400 hover:text-white hover:bg-gray-800'
  }`}
  title={t('twinSession.title')}
>
  <MessageSquare size={18} />
</button>
```

- [ ] **Step 5: Add twin session sidebar to board layout**

In the board view flex container (around line 484-517), after the WorkspaceExplorer, add:

```tsx
{showTwinPanel && (
  <div className="border-l border-gray-800 flex flex-col flex-shrink-0" style={{ width: 360 }}>
    {activeTwinSessionId ? (
      <TwinSessionPanel
        projectId={projectId!}
        twinSessionId={activeTwinSessionId}
        onClose={() => setActiveTwinSessionId(null)}
      />
    ) : (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
          <span className="text-xs font-medium text-gray-300">{t('twinSession.title')}</span>
          <button
            onClick={() => {
              setCreateTwinPreselectedIssueId(undefined);
              setShowCreateTwinModal(true);
            }}
            className="text-[10px] px-2 py-0.5 bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
          >
            + {t('twinSession.new')}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
          {twinSessions.length === 0 ? (
            <p className="text-xs text-gray-600 py-4 text-center">{t('twinSession.noSessions')}</p>
          ) : (
            twinSessions.map((ts) => (
              <button
                key={ts.id}
                onClick={() => setActiveTwinSessionId(ts.id)}
                className="w-full px-2 py-2 rounded-lg text-left hover:bg-gray-800 transition-colors"
              >
                <div className="flex items-center gap-2">
                  {ts.agent.avatar ? (
                    <img src={ts.agent.avatar} alt="" className="w-5 h-5 rounded-full object-cover" />
                  ) : (
                    <div className="w-5 h-5 rounded-full bg-purple-600 flex items-center justify-center text-[10px] text-white">
                      {(ts.agent.display_name ?? ts.agent.name)[0]}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-white truncate">{ts.agent.display_name ?? ts.agent.name}</p>
                    <p className="text-[10px] text-gray-500 truncate">
                      {ts.creator.full_name ?? ts.creator.username}
                      {ts.issue ? ` · #${ts.issue.issue_number}` : ''}
                    </p>
                  </div>
                  <span className={`text-[10px] px-1 py-0.5 rounded ${
                    ts.visibility === 'public' ? 'bg-green-500/20 text-green-400' : 'bg-gray-700 text-gray-400'
                  }`}>
                    {ts.visibility === 'public' ? '🟢' : '🔒'}
                  </span>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    )}
  </div>
)}
```

- [ ] **Step 6: Add active twin indicators to IssueCard**

In the `IssueCard` component, add a prop for active sessions and render indicators. Pass filtered `twinSessions` to each card:

```tsx
// In IssueCard props, add:
activeTwinSessions?: TwinSessionSummary[]

// In IssueCard JSX, after the footer section, add:
{activeTwinSessions && activeTwinSessions.length > 0 && (
  <div className="flex flex-wrap gap-1 mt-1.5">
    {activeTwinSessions.map((ts) => (
      <span
        key={ts.id}
        className="inline-flex items-center gap-0.5 px-1 py-0.5 bg-purple-500/10 border border-purple-500/20 rounded text-[10px] text-purple-300 cursor-pointer"
        onClick={(e) => {
          e.stopPropagation();
          if (ts.visibility === 'public' || ts.created_by === request.user?.id) {
            setActiveTwinSessionId(ts.id);
            setShowTwinPanel(true);
          } else {
            alert(t('twinSession.privateNotice'));
          }
        }}
      >
        🟢 {ts.creator.full_name ?? ts.creator.username}·{ts.agent.display_name ?? ts.agent.name}
      </span>
    ))}
  </div>
)}
```

When rendering IssueCard, pass filtered sessions:

```tsx
<IssueCard
  issue={issue}
  relations={relations}
  onDragStart={() => setDragIssueId(issue.id)}
  onClick={() => handleOpenIssue(issue)}
  activeTwinSessions={twinSessions.filter(ts => ts.issue?.id === issue.id)}
/>
```

- [ ] **Step 7: Add "Discuss with Twin" button to issue detail modal**

In the issue detail modal (around line 1069-1078, after the Project Agent section), add:

```tsx
<div className="mt-3">
  <button
    onClick={() => {
      setCreateTwinPreselectedIssueId(selectedIssue?.id);
      setShowCreateTwinModal(true);
    }}
    className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-purple-600/20 hover:bg-purple-600/30 text-purple-300 border border-purple-500/30 rounded-lg transition-colors"
  >
    <MessageSquare size={12} />
    {t('twinSession.discussIssue')}
  </button>
</div>
```

- [ ] **Step 8: Add CreateTwinSessionModal render**

At the end of the component, before the closing `</div>`, add:

```tsx
{showCreateTwinModal && (
  <CreateTwinSessionModal
    projectId={projectId!}
    scopeId={project?.business_scope_id ?? null}
    issues={issues}
    preSelectedIssueId={createTwinPreselectedIssueId}
    onClose={() => setShowCreateTwinModal(false)}
    onCreate={async (input) => {
      const ts = await RestTwinSessionService.create(projectId!, input);
      await loadTwinSessions();
      setActiveTwinSessionId(ts.id);
      setShowTwinPanel(true);
    }}
  />
)}
```

- [ ] **Step 9: Commit**

```bash
git add frontend/src/pages/ProjectBoard.tsx
git commit -m "feat: integrate twin sessions into ProjectBoard with sidebar, indicators, and issue modal"
```

---

## Task 14: End-to-End Verification

- [ ] **Step 1: Run backend build**

```bash
cd backend && npm run build
```

Expected: No TypeScript errors.

- [ ] **Step 2: Run backend lint**

```bash
cd backend && npm run lint
```

Expected: No lint errors (or only pre-existing ones).

- [ ] **Step 3: Run frontend build**

```bash
cd frontend && npm run build
```

Expected: No TypeScript errors.

- [ ] **Step 4: Run frontend lint**

```bash
cd frontend && npm run lint
```

Expected: No lint errors (or only pre-existing ones).

- [ ] **Step 5: Start dev servers and test manually**

```bash
cd backend && npm run dev &
cd frontend && npm run dev &
```

Test flow:
1. Navigate to a project board
2. Click Twin Sessions button in toolbar
3. Click "+ New Twin Session"
4. Select an agent and optionally bind an issue
5. Start chatting — verify SSE streaming works
6. Verify project tools are available (ask the twin about the board status)
7. Test suggest_action flow — twin suggests an action, confirm/reject it
8. Test pop-out mode — click the maximize button
9. Test visibility toggle — switch between private/public
10. Verify issue card indicators show active sessions

- [ ] **Step 6: Final commit**

```bash
git add -A && git commit -m "feat: complete project twin sessions implementation"
```
