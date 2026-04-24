import { prisma } from '../config/database.js';
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
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'get_issue_detail',
      description: 'Get full details of a specific issue including description, acceptance criteria, comments, sub-tasks, and relations.',
      input_schema: {
        type: 'object',
        properties: { issue_number: { type: 'number', description: 'The issue number to look up' } },
        required: ['issue_number'],
      },
    },
    {
      name: 'read_project_context',
      description: 'List all summary/context files in the project workspace context/ directory.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'read_context_file',
      description: 'Read the full content of a specific context file from the project workspace.',
      input_schema: {
        type: 'object',
        properties: { filename: { type: 'string', description: 'Name of the file in the context/ directory' } },
        required: ['filename'],
      },
    },
    {
      name: 'suggest_action',
      description: 'Suggest a project board action for the user to confirm. The action will NOT be executed automatically. Supported: create_issue, update_issue, add_comment, change_status.',
      input_schema: {
        type: 'object',
        properties: {
          action_type: { type: 'string', enum: ['create_issue', 'update_issue', 'add_comment', 'change_status'] },
          payload: { type: 'object', description: 'Action-specific payload.' },
          reason: { type: 'string', description: 'Why you are suggesting this action' },
        },
        required: ['action_type', 'payload', 'reason'],
      },
    },
    {
      name: 'summarize_to_project',
      description: 'Write a summary of the current discussion to the project workspace so other team members can access it.',
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
    case 'get_board_status': return handleGetBoardStatus(ctx);
    case 'get_issue_detail': return handleGetIssueDetail(input as { issue_number: number }, ctx);
    case 'read_project_context': return handleReadProjectContext(ctx);
    case 'read_context_file': return handleReadContextFile(input as { filename: string }, ctx);
    case 'suggest_action': return handleSuggestAction(input as { action_type: string; payload: Record<string, unknown>; reason: string }, ctx);
    case 'summarize_to_project': return handleSummarizeToProject(input as { title: string; content: string }, ctx);
    default: return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }
}

async function handleGetBoardStatus(ctx: ProjectToolContext): Promise<string> {
  const issues = await prisma.project_issues.findMany({
    where: { project_id: ctx.projectId },
    select: { issue_number: true, title: true, status: true, priority: true, estimated_effort: true, labels: true },
    orderBy: [{ status: 'asc' }, { sort_order: 'asc' }],
  });
  return JSON.stringify(issues);
}

async function handleGetIssueDetail(input: { issue_number: number }, ctx: ProjectToolContext): Promise<string> {
  const issue = await prisma.project_issues.findFirst({
    where: { project_id: ctx.projectId, issue_number: input.issue_number },
    include: {
      comments: { orderBy: { created_at: 'asc' }, take: 20 },
      children: { select: { issue_number: true, title: true, status: true } },
      relations_as_source: {
        select: { relation_type: true, confidence: true, reasoning: true, status: true, target_issue: { select: { issue_number: true, title: true } } },
      },
      relations_as_target: {
        select: { relation_type: true, confidence: true, reasoning: true, status: true, source_issue: { select: { issue_number: true, title: true } } },
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

async function handleReadContextFile(input: { filename: string }, ctx: ProjectToolContext): Promise<string> {
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
  try { index = JSON.parse(await fs.readFile(indexPath, 'utf-8')); } catch { /* empty */ }

  const id = String(index.length + 1).padStart(3, '0');
  const action = {
    id, type: 'suggest_action', action_type: input.action_type,
    payload: input.payload, reason: input.reason, status: 'pending',
    created_at: new Date().toISOString(), resolved_at: null, resolved_by: null, result: null,
  };

  const actionFilename = `${id}-suggest-${input.action_type}.json`;
  await fs.writeFile(path.join(actionsDir, actionFilename), JSON.stringify(action, null, 2));

  index.push({
    id, type: 'suggest_action', action_type: input.action_type, status: 'pending',
    reason: input.reason, created_at: action.created_at, resolved_at: null, file: actionFilename,
  });
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2));

  return JSON.stringify({
    suggestion_id: id,
    message: `Suggestion submitted (ID: ${id}). Waiting for user confirmation.`,
    preview: { action_type: input.action_type, payload: input.payload, reason: input.reason },
  });
}

async function handleSummarizeToProject(input: { title: string; content: string }, ctx: ProjectToolContext): Promise<string> {
  const contextDir = path.join(ctx.mainWorkspacePath, 'context');
  await fs.mkdir(contextDir, { recursive: true });

  const user = await prisma.profiles.findUnique({ where: { id: ctx.userId }, select: { username: true, full_name: true } });
  const userName = user?.username ?? user?.full_name ?? 'unknown';
  const date = new Date().toISOString().slice(0, 10);
  const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 40);
  const filename = `${date}-${userName}-${slug}.md`;
  await fs.writeFile(path.join(contextDir, filename), input.content, 'utf-8');

  return JSON.stringify({ written: filename, path: `context/${filename}` });
}
