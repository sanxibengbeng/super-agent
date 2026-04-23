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
    const existing = await prisma.business_scopes.findFirst({
      where: {
        organization_id: organizationId,
        name: template.scope.name,
        scope_type: 'digital_twin',
        deleted_at: null,
      },
    });

    if (existing) return;

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
        model_config: template.agent.modelConfig as object,
      },
    });

    console.log(`[seed-copilot] Created "${template.scope.name}" for org ${organizationId}`);
  }

  async upgradeSeedCopilots(organizationId: string): Promise<void> {
    for (const file of SEED_FILES) {
      const template = loadTemplate(file);

      const scope = await prisma.business_scopes.findFirst({
        where: {
          organization_id: organizationId,
          name: template.scope.name,
          scope_type: 'digital_twin',
          deleted_at: null,
        },
      });

      if (!scope) continue;

      // Only upgrade agents that have NOT been customized (updated_at == created_at)
      await prisma.agents.updateMany({
        where: {
          organization_id: organizationId,
          business_scope_id: scope.id,
          name: template.agent.name,
          origin: 'system_seed',
          updated_at: { equals: prisma.agents.fields.created_at },
        },
        data: {
          system_prompt: template.agent.systemPrompt,
          role: template.agent.role,
          display_name: template.agent.displayName,
          model_config: template.agent.modelConfig as object,
        },
      });
    }
  }

  async ensureAllOrgs(): Promise<void> {
    const orgs = await prisma.organizations.findMany({ select: { id: true } });
    for (const org of orgs) {
      await this.ensureSeedCopilots(org.id);
    }
    console.log(`[seed-copilot] Checked ${orgs.length} organizations for seed copilots`);
  }
}

export const seedCopilotService = new SeedCopilotService();
