import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config/database.js', () => ({
  prisma: {
    business_scopes: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    agents: {
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      fields: { created_at: 'created_at' },
    },
    organizations: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(() =>
    JSON.stringify({
      scope: {
        name: 'Test Copilot',
        description: 'Test description',
        icon: '🤖',
        color: '#000000',
        scope_type: 'digital_twin',
      },
      agent: {
        name: 'test-copilot',
        displayName: 'Test Copilot',
        role: 'Test role',
        origin: 'system_seed',
        systemPrompt: 'Test system prompt',
        modelConfig: {},
      },
    }),
  ),
}));

import { prisma } from '../../src/config/database.js';
import { SeedCopilotService } from '../../src/services/seed-copilot.service.js';

const mockScopes = prisma.business_scopes as unknown as {
  findFirst: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
};
const mockAgents = prisma.agents as unknown as {
  findFirst: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
};
const mockOrgs = prisma.organizations as unknown as {
  findMany: ReturnType<typeof vi.fn>;
};

describe('SeedCopilotService', () => {
  let service: SeedCopilotService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SeedCopilotService();
  });

  describe('ensureSeedCopilots', () => {
    it('creates scope and agent when they do not exist', async () => {
      mockScopes.findFirst.mockResolvedValue(null);
      mockScopes.create.mockResolvedValue({ id: 'scope-1' });
      mockAgents.create.mockResolvedValue({ id: 'agent-1' });

      await service.ensureSeedCopilots('org-1');

      // 2 seed files → 2 scope creates, 2 agent creates
      expect(mockScopes.create).toHaveBeenCalledTimes(2);
      expect(mockAgents.create).toHaveBeenCalledTimes(2);
    });

    it('skips creation when scopes already exist', async () => {
      mockScopes.findFirst.mockResolvedValue({ id: 'existing-scope' });

      await service.ensureSeedCopilots('org-1');

      expect(mockScopes.create).not.toHaveBeenCalled();
      expect(mockAgents.create).not.toHaveBeenCalled();
    });

    it('creates agent under the created scope', async () => {
      mockScopes.findFirst.mockResolvedValue(null);
      mockScopes.create.mockResolvedValue({ id: 'scope-new' });
      mockAgents.create.mockResolvedValue({ id: 'agent-new' });

      await service.ensureSeedCopilots('org-1');

      const agentCall = mockAgents.create.mock.calls[0][0];
      expect(agentCall.data.business_scope_id).toBe('scope-new');
      expect(agentCall.data.origin).toBe('system_seed');
    });
  });

  describe('upgradeSeedCopilots', () => {
    it('calls updateMany with origin=system_seed filter', async () => {
      mockScopes.findFirst.mockResolvedValue({ id: 'scope-1' });
      mockAgents.updateMany.mockResolvedValue({ count: 1 });

      await service.upgradeSeedCopilots('org-1');

      expect(mockAgents.updateMany).toHaveBeenCalled();
      const call = mockAgents.updateMany.mock.calls[0][0];
      expect(call.where.origin).toBe('system_seed');
    });

    it('skips upgrade when scope does not exist', async () => {
      mockScopes.findFirst.mockResolvedValue(null);

      await service.upgradeSeedCopilots('org-1');

      expect(mockAgents.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('ensureAllOrgs', () => {
    it('calls ensureSeedCopilots for each org', async () => {
      mockOrgs.findMany.mockResolvedValue([{ id: 'org-1' }, { id: 'org-2' }]);
      mockScopes.findFirst.mockResolvedValue({ id: 'existing' });

      await service.ensureAllOrgs();

      // findFirst called once per seed file per org = 2 files × 2 orgs = 4
      expect(mockScopes.findFirst).toHaveBeenCalledTimes(4);
    });
  });
});
