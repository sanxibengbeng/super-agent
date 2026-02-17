/**
 * Workshop Service
 *
 * Manages the Skill Workshop — a live testing environment where users
 * can temporarily equip/unequip skills on an agent and test them via chat.
 *
 * Workshop sessions are ephemeral (in-memory). Equipped skills are only
 * persisted to the agent when the user explicitly saves.
 */

import { skillRepository } from '../repositories/skill.repository.js';
import { agentRepository } from '../repositories/agent.repository.js';
import { skillMarketplaceService, type MarketplaceSkillResult } from './skill-marketplace.service.js';
import { AppError } from '../middleware/errorHandler.js';
import type { SkillForWorkspace } from './workspace-manager.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkshopSession {
  agentId: string;
  organizationId: string;
  /** Skill IDs currently equipped in this workshop session */
  equippedSkillIds: Set<string>;
  /** Timestamp of last activity */
  lastActivity: number;
}

export interface EquippedSkillInfo {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  version: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class WorkshopService {
  /** In-memory workshop sessions keyed by `{orgId}:{agentId}` */
  private sessions = new Map<string, WorkshopSession>();

  private sessionKey(orgId: string, agentId: string): string {
    return `${orgId}:${agentId}`;
  }

  /**
   * Get or create a workshop session for an agent.
   * Initializes with the agent's currently persisted skills.
   */
  async getOrCreateSession(
    organizationId: string,
    agentId: string,
  ): Promise<WorkshopSession> {
    const key = this.sessionKey(organizationId, agentId);
    let session = this.sessions.get(key);

    if (!session) {
      // Verify agent exists
      const agent = await agentRepository.findById(agentId, organizationId);
      if (!agent) throw AppError.notFound(`Agent ${agentId} not found`);

      // Load currently assigned skills
      const assignedSkills = await skillRepository.findByAgentId(organizationId, agentId);

      session = {
        agentId,
        organizationId,
        equippedSkillIds: new Set(assignedSkills.map(s => s.id)),
        lastActivity: Date.now(),
      };
      this.sessions.set(key, session);
    }

    session.lastActivity = Date.now();
    return session;
  }

  /**
   * Equip a skill to the workshop session (temporary, not persisted).
   */
  async equipSkill(
    organizationId: string,
    agentId: string,
    skillId: string,
  ): Promise<EquippedSkillInfo> {
    const session = await this.getOrCreateSession(organizationId, agentId);

    // Verify skill exists
    const skill = await skillRepository.findById(skillId, organizationId);
    if (!skill) throw AppError.notFound(`Skill ${skillId} not found`);

    session.equippedSkillIds.add(skillId);
    session.lastActivity = Date.now();

    return {
      id: skill.id,
      name: skill.name,
      displayName: skill.display_name,
      description: skill.description,
      version: skill.version,
    };
  }

  /**
   * Unequip a skill from the workshop session.
   */
  async unequipSkill(
    organizationId: string,
    agentId: string,
    skillId: string,
  ): Promise<void> {
    const session = await this.getOrCreateSession(organizationId, agentId);
    session.equippedSkillIds.delete(skillId);
    session.lastActivity = Date.now();
  }

  /**
   * Get all currently equipped skills for the workshop session.
   */
  async getEquippedSkills(
    organizationId: string,
    agentId: string,
  ): Promise<EquippedSkillInfo[]> {
    const session = await this.getOrCreateSession(organizationId, agentId);
    const skillIds = Array.from(session.equippedSkillIds);

    if (skillIds.length === 0) return [];

    const skills = await skillRepository.findByIds(organizationId, skillIds);
    return skills.map(s => ({
      id: s.id,
      name: s.name,
      displayName: s.display_name,
      description: s.description,
      version: s.version,
    }));
  }

  /**
   * Get skills as SkillForWorkspace[] for use with chat streaming.
   * This is what gets passed to chatService.streamChat as skillsOverride.
   */
  async getEquippedSkillsForWorkspace(
    organizationId: string,
    agentId: string,
  ): Promise<SkillForWorkspace[]> {
    const session = await this.getOrCreateSession(organizationId, agentId);
    const skillIds = Array.from(session.equippedSkillIds);

    if (skillIds.length === 0) return [];

    const skills = await skillRepository.findByIds(organizationId, skillIds);
    return skills.map(s => ({
      id: s.id,
      name: s.name,
      hashId: s.hash_id,
      s3Bucket: s.s3_bucket,
      s3Prefix: s.s3_prefix,
      localPath: (s.metadata as Record<string, unknown>)?.localPath as string | undefined,
    }));
  }

  /**
   * Get skill suggestions based on the agent's role.
   * Searches the marketplace using the agent's role as query.
   */
  async getSuggestions(
    organizationId: string,
    agentId: string,
  ): Promise<MarketplaceSkillResult[]> {
    const agent = await agentRepository.findById(agentId, organizationId);
    if (!agent) throw AppError.notFound(`Agent ${agentId} not found`);

    // Build search query from agent role and display name
    const query = agent.role || agent.display_name || agent.name;

    try {
      return await skillMarketplaceService.search(query);
    } catch {
      // Marketplace search can fail (CLI not available, etc.)
      return [];
    }
  }

  /**
   * Save the current workshop equipped skills to the agent permanently.
   * Replaces all agent skills with the workshop set.
   */
  async saveEquippedSkills(
    organizationId: string,
    agentId: string,
    userId?: string,
  ): Promise<{ savedCount: number }> {
    const session = await this.getOrCreateSession(organizationId, agentId);
    const skillIds = Array.from(session.equippedSkillIds);

    await skillRepository.replaceAgentSkills(agentId, skillIds, userId);

    return { savedCount: skillIds.length };
  }

  /**
   * Close a workshop session (cleanup).
   */
  closeSession(organizationId: string, agentId: string): void {
    const key = this.sessionKey(organizationId, agentId);
    this.sessions.delete(key);
  }

  /**
   * Get all installed skills for the organization (for the "equip from installed" list).
   */
  async getInstalledSkills(organizationId: string): Promise<EquippedSkillInfo[]> {
    const skills = await skillRepository.findActiveSkills(organizationId);
    return skills.map(s => ({
      id: s.id,
      name: s.name,
      displayName: s.display_name,
      description: s.description,
      version: s.version,
    }));
  }
}

export const workshopService = new WorkshopService();
