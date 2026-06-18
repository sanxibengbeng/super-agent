/**
 * Workflow Workspace Provisioning
 *
 * Shared utility for loading scope data, agents, skills, and provisioning
 * a workspace for workflow execution. Used by WorkflowExecutorV2.
 */

import crypto from 'crypto';
import {
  workspaceManager,
  type ScopeForWorkspace,
  type SkillForWorkspace,
  type McpServerForWorkspace,
  type PluginForWorkspace,
} from './workspace-manager.js';
import { businessScopeService } from './businessScope.service.js';
import { skillService } from './skill.service.js';
import { agentRepository } from '../repositories/agent.repository.js';
import { skillRepository } from '../repositories/skill.repository.js';
import { prisma } from '../config/database.js';

export interface WorkflowWorkspaceResult {
  workspacePath: string;
  pluginPaths: string[];
  agents: Array<{ id: string; name: string; displayName: string; role: string | null }>;
  skills: SkillForWorkspace[];
  scopeSkillNames: string[];
}

/**
 * Provision a workspace for workflow execution.
 *
 * Loads scope data, agents with their skills, scope-level skills,
 * and creates a session workspace with all resources available.
 */
export async function provisionWorkflowWorkspace(
  organizationId: string,
  scopeId: string,
  sessionId?: string
): Promise<WorkflowWorkspaceResult> {
  // Load scope
  const scope = await businessScopeService.getBusinessScopeById(scopeId, organizationId);
  if (!scope) throw new Error('Business scope not found');

  // Load agents, skills, MCP servers, and plugins in parallel
  const agents = await agentRepository.findByBusinessScope(organizationId, scopeId);

  // Batch-load skills for all agents once (was 2 queries per agent before)
  const skillsByAgent = await skillRepository.findByAgentIds(
    organizationId,
    agents.map((a) => a.id)
  );

  const [scopeLevelSkills, mcpServers, plugins] = await Promise.all([
    skillService.getScopeLevelSkills(organizationId, scopeId),
    loadScopeMcpServers(scopeId),
    loadScopePlugins(scopeId),
  ]);

  // Derive both the name map and the full-object map from the single fetch
  const agentSkillsMap = new Map<string, string[]>();
  const skillMap = new Map<string, SkillForWorkspace>();
  for (const agent of agents) {
    const agentSkills = skillsByAgent.get(agent.id) ?? [];
    agentSkillsMap.set(
      agent.id,
      agentSkills.map((s) => s.name)
    );
    for (const s of agentSkills) {
      if (!skillMap.has(s.id)) {
        const meta = s.metadata as Record<string, unknown> | null;
        skillMap.set(s.id, {
          id: s.id,
          name: s.name,
          hashId: s.hash_id,
          s3Bucket: s.s3_bucket,
          s3Prefix: s.s3_prefix,
          localPath: meta?.localPath as string | undefined,
        });
      }
    }
  }
  for (const s of scopeLevelSkills) {
    if (!skillMap.has(s.id)) {
      const meta = s.metadata as Record<string, unknown> | null;
      skillMap.set(s.id, {
        id: s.id,
        name: s.name,
        hashId: s.hash_id,
        s3Bucket: s.s3_bucket,
        s3Prefix: s.s3_prefix,
        localPath: meta?.localPath as string | undefined,
      });
    }
  }

  // Provision or reuse the shared scope workspace.
  // sessionId is used for the chat_session record but workspace is scope-level.
  if (!sessionId) sessionId = crypto.randomUUID();
  const scopeForWorkspace: ScopeForWorkspace = {
    id: scope.id,
    name: scope.name,
    description: scope.description,
    systemPrompt: scope.system_prompt ?? null,
    configVersion: scope.config_version ?? 1,
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      displayName: a.display_name,
      role: a.role,
      systemPrompt: a.system_prompt,
      skillNames: agentSkillsMap.get(a.id) || [],
    })),
    skills: Array.from(skillMap.values()),
    mcpServers,
    plugins,
  };

  const { refreshed, pluginPaths } = await workspaceManager.ensureWorkspaceUpToDate(
    organizationId,
    sessionId,
    scopeForWorkspace,
    null
  );
  const workspacePath = workspaceManager.getScopeWorkspacePath(organizationId, scope.id);
  if (refreshed) {
    console.log(`[workflow-workspace] Provisioned/refreshed scope workspace for ${scope.id}`);
  }

  return {
    workspacePath,
    pluginPaths,
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      displayName: a.display_name,
      role: a.role,
    })),
    skills: Array.from(skillMap.values()),
    scopeSkillNames: scopeLevelSkills.map((s) => s.name),
  };
}

async function loadScopeMcpServers(scopeId: string): Promise<McpServerForWorkspace[]> {
  try {
    const rows = await prisma.$queryRaw<
      Array<{ name: string; host_address: string; config: Record<string, unknown> | null }>
    >`
      SELECT ms.name, ms.host_address, ms.config
      FROM scope_mcp_servers sms
      JOIN mcp_servers ms ON ms.id = sms.mcp_server_id
      WHERE sms.business_scope_id = ${scopeId}::uuid
        AND ms.status = 'active'
    `;
    return rows.map((r) => ({ name: r.name, hostAddress: r.host_address, config: r.config }));
  } catch {
    return [];
  }
}

async function loadScopePlugins(scopeId: string): Promise<PluginForWorkspace[]> {
  try {
    const rows = await prisma.$queryRaw<Array<{ name: string; git_url: string; ref: string }>>`
      SELECT name, git_url, ref
      FROM scope_plugins
      WHERE business_scope_id = ${scopeId}::uuid
    `;
    return rows.map((r) => ({ name: r.name, gitUrl: r.git_url, ref: r.ref }));
  } catch {
    return [];
  }
}
