import { prisma } from '../config/database.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { AppError } from '../middleware/errorHandler.js';

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
        source: 'twin_session',
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
    _orgId: string,
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

  async getById(_orgId: string, projectId: string, twinSessionId: string, userId: string) {
    const ts = await prisma.project_twin_sessions.findFirst({
      where: { id: twinSessionId, project_id: projectId },
      include: {
        agent: { select: { id: true, name: true, display_name: true, avatar: true, role: true } },
        creator: { select: { id: true, username: true, full_name: true, avatar_url: true } },
        issue: { select: { id: true, issue_number: true, title: true, description: true, status: true, priority: true } },
        session: { select: { id: true, status: true, claude_session_id: true, business_scope_id: true } },
      },
    });
    if (!ts) throw AppError.notFound('Twin session not found');
    if (ts.visibility === 'private' && ts.created_by !== userId) {
      throw AppError.forbidden('This session is private');
    }
    return ts;
  }

  async updateVisibility(
    _orgId: string,
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

  async delete(_orgId: string, projectId: string, twinSessionId: string, userId: string) {
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
    _orgId: string,
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
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { issue_number: _, ...fields } = payload;
        await projectService.updateIssue(projectId, issue.id, fields);
        return { updated: true, issue_number: issueNumber };
      }
      case 'add_comment': {
        const issueNumber = payload.issue_number as number;
        const issue = await prisma.project_issues.findFirst({
          where: { project_id: projectId, issue_number: issueNumber },
        });
        if (!issue) throw AppError.notFound(`Issue #${issueNumber} not found`);
        await projectService.addComment(orgId, issue.id, userId, {
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
        await projectService.changeIssueStatus(projectId, issue.id, payload.new_status as string);
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
