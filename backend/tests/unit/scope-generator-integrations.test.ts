import { describe, it, expect } from 'vitest';
import { computeIntegrationsDiff, type IntegrationsDiff } from '../../src/services/scope-generator.service.js';
import type { ScopeIntegrations } from '../../src/services/scope-copilot-seeder.js';

/**
 * Helper to create an empty ScopeIntegrations object.
 */
function emptyScopeIntegrations(): ScopeIntegrations {
  return {
    mcpServers: [],
    documentGroups: [],
    imChannels: [],
    connectors: [],
    plugins: [],
  };
}

describe('computeIntegrationsDiff', () => {
  // -----------------------------------------------------------------------
  // MCP Servers
  // -----------------------------------------------------------------------
  describe('mcpServers', () => {
    it('should identify new MCP servers to add (in desired, not in current)', () => {
      const current = emptyScopeIntegrations();
      const desired: Partial<ScopeIntegrations> = {
        mcpServers: [
          { assignmentId: '', mcpServerId: 'mcp-1', name: 'github-mcp', scopeConfig: { repo: 'org/repo' } },
          { assignmentId: '', mcpServerId: 'mcp-2', name: 'slack-mcp', scopeConfig: {} },
        ],
      };

      const diff = computeIntegrationsDiff(current, desired);

      expect(diff.mcpServers.toAdd).toHaveLength(2);
      expect(diff.mcpServers.toAdd[0]!.mcpServerId).toBe('mcp-1');
      expect(diff.mcpServers.toAdd[0]!.scopeConfig).toEqual({ repo: 'org/repo' });
      expect(diff.mcpServers.toAdd[1]!.mcpServerId).toBe('mcp-2');
      expect(diff.mcpServers.toRemove).toHaveLength(0);
    });

    it('should identify removed MCP servers (in current, not in desired) with assignmentId', () => {
      const current: ScopeIntegrations = {
        ...emptyScopeIntegrations(),
        mcpServers: [
          { assignmentId: 'assign-1', mcpServerId: 'mcp-1', name: 'github-mcp', scopeConfig: {} },
          { assignmentId: 'assign-2', mcpServerId: 'mcp-2', name: 'slack-mcp', scopeConfig: {} },
        ],
      };
      const desired: Partial<ScopeIntegrations> = {
        mcpServers: [
          { assignmentId: 'assign-1', mcpServerId: 'mcp-1', name: 'github-mcp', scopeConfig: {} },
        ],
      };

      const diff = computeIntegrationsDiff(current, desired);

      expect(diff.mcpServers.toAdd).toHaveLength(0);
      expect(diff.mcpServers.toRemove).toEqual(['assign-2']);
    });
  });

  // -----------------------------------------------------------------------
  // Document Groups
  // -----------------------------------------------------------------------
  describe('documentGroups', () => {
    it('should identify new document groups to add and old ones to remove', () => {
      const current: ScopeIntegrations = {
        ...emptyScopeIntegrations(),
        documentGroups: [
          { assignmentId: 'assign-dg-1', documentGroupId: 'dg-1', name: 'specs' },
        ],
      };
      const desired: Partial<ScopeIntegrations> = {
        documentGroups: [
          { assignmentId: '', documentGroupId: 'dg-2', name: 'legal' },
        ],
      };

      const diff = computeIntegrationsDiff(current, desired);

      expect(diff.documentGroups.toAdd).toHaveLength(1);
      expect(diff.documentGroups.toAdd[0]!.documentGroupId).toBe('dg-2');
      expect(diff.documentGroups.toRemove).toEqual(['assign-dg-1']);
    });
  });

  // -----------------------------------------------------------------------
  // Plugins
  // -----------------------------------------------------------------------
  describe('plugins', () => {
    it('should identify new plugins to add and old ones to remove by name', () => {
      const current: ScopeIntegrations = {
        ...emptyScopeIntegrations(),
        plugins: [
          { id: 'plugin-1', name: 'claude-mem', gitUrl: 'https://example.com/claude-mem.git', ref: 'main' },
        ],
      };
      const desired: Partial<ScopeIntegrations> = {
        plugins: [
          { id: '', name: 'code-analyzer', gitUrl: 'https://example.com/code-analyzer.git', ref: 'v2' },
        ],
      };

      const diff = computeIntegrationsDiff(current, desired);

      expect(diff.plugins.toAdd).toHaveLength(1);
      expect(diff.plugins.toAdd[0]!.name).toBe('code-analyzer');
      expect(diff.plugins.toAdd[0]!.gitUrl).toBe('https://example.com/code-analyzer.git');
      expect(diff.plugins.toAdd[0]!.ref).toBe('v2');
      expect(diff.plugins.toRemove).toEqual(['plugin-1']);
    });
  });

  // -----------------------------------------------------------------------
  // Empty desired = remove all current items
  // -----------------------------------------------------------------------
  describe('empty desired', () => {
    it('should remove all current items when desired lists are empty', () => {
      const current: ScopeIntegrations = {
        mcpServers: [
          { assignmentId: 'assign-1', mcpServerId: 'mcp-1', name: 'github-mcp', scopeConfig: {} },
        ],
        documentGroups: [
          { assignmentId: 'assign-dg-1', documentGroupId: 'dg-1', name: 'specs' },
        ],
        imChannels: [
          { id: 'im-1', channelType: 'slack', channelId: 'C123', channelName: '#general', isEnabled: true },
        ],
        connectors: [
          { connectorId: 'conn-1', name: 'sf', displayName: 'Salesforce', connectorType: 'salesforce', scopeConfig: {} },
        ],
        plugins: [
          { id: 'plugin-1', name: 'claude-mem', gitUrl: 'https://example.com/p.git', ref: 'main' },
        ],
      };
      const desired: Partial<ScopeIntegrations> = {
        mcpServers: [],
        documentGroups: [],
        imChannels: [],
        connectors: [],
        plugins: [],
      };

      const diff = computeIntegrationsDiff(current, desired);

      expect(diff.mcpServers.toAdd).toHaveLength(0);
      expect(diff.mcpServers.toRemove).toEqual(['assign-1']);
      expect(diff.documentGroups.toRemove).toEqual(['assign-dg-1']);
      expect(diff.imChannels.toRemove).toEqual(['im-1']);
      expect(diff.connectors.toRemove).toEqual(['conn-1']);
      expect(diff.plugins.toRemove).toEqual(['plugin-1']);
    });
  });

  // -----------------------------------------------------------------------
  // Unchanged items = no diff
  // -----------------------------------------------------------------------
  describe('unchanged items', () => {
    it('should produce empty diff when current and desired match', () => {
      const integrations: ScopeIntegrations = {
        mcpServers: [
          { assignmentId: 'assign-1', mcpServerId: 'mcp-1', name: 'github-mcp', scopeConfig: {} },
        ],
        documentGroups: [
          { assignmentId: 'assign-dg-1', documentGroupId: 'dg-1', name: 'specs' },
        ],
        imChannels: [
          { id: 'im-1', channelType: 'slack', channelId: 'C123', channelName: '#general', isEnabled: true },
        ],
        connectors: [
          { connectorId: 'conn-1', name: 'sf', displayName: 'Salesforce', connectorType: 'salesforce', scopeConfig: {} },
        ],
        plugins: [
          { id: 'plugin-1', name: 'claude-mem', gitUrl: 'https://example.com/p.git', ref: 'main' },
        ],
      };

      const diff = computeIntegrationsDiff(integrations, integrations);

      expect(diff.mcpServers.toAdd).toHaveLength(0);
      expect(diff.mcpServers.toRemove).toHaveLength(0);
      expect(diff.documentGroups.toAdd).toHaveLength(0);
      expect(diff.documentGroups.toRemove).toHaveLength(0);
      expect(diff.imChannels.toAdd).toHaveLength(0);
      expect(diff.imChannels.toRemove).toHaveLength(0);
      expect(diff.connectors.toAdd).toHaveLength(0);
      expect(diff.connectors.toRemove).toHaveLength(0);
      expect(diff.plugins.toAdd).toHaveLength(0);
      expect(diff.plugins.toRemove).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // IM Channels
  // -----------------------------------------------------------------------
  describe('imChannels', () => {
    it('should identify new IM channels to add (no id or id not in current)', () => {
      const current = emptyScopeIntegrations();
      const desired: Partial<ScopeIntegrations> = {
        imChannels: [
          { id: '', channelType: 'slack', channelId: 'C999', channelName: '#new', isEnabled: true },
        ],
      };

      const diff = computeIntegrationsDiff(current, desired);

      expect(diff.imChannels.toAdd).toHaveLength(1);
      expect(diff.imChannels.toAdd[0]!.channelType).toBe('slack');
      expect(diff.imChannels.toAdd[0]!.channelId).toBe('C999');
      expect(diff.imChannels.toRemove).toHaveLength(0);
    });

    it('should identify removed IM channels (current id not in desired)', () => {
      const current: ScopeIntegrations = {
        ...emptyScopeIntegrations(),
        imChannels: [
          { id: 'im-1', channelType: 'slack', channelId: 'C123', channelName: '#general', isEnabled: true },
          { id: 'im-2', channelType: 'discord', channelId: 'D456', channelName: null, isEnabled: false },
        ],
      };
      const desired: Partial<ScopeIntegrations> = {
        imChannels: [
          { id: 'im-1', channelType: 'slack', channelId: 'C123', channelName: '#general', isEnabled: true },
        ],
      };

      const diff = computeIntegrationsDiff(current, desired);

      expect(diff.imChannels.toAdd).toHaveLength(0);
      expect(diff.imChannels.toRemove).toEqual(['im-2']);
    });
  });

  // -----------------------------------------------------------------------
  // Connectors
  // -----------------------------------------------------------------------
  describe('connectors', () => {
    it('should identify new connectors to add and old ones to remove by connectorId', () => {
      const current: ScopeIntegrations = {
        ...emptyScopeIntegrations(),
        connectors: [
          { connectorId: 'conn-1', name: 'sf', displayName: 'Salesforce', connectorType: 'salesforce', scopeConfig: {} },
        ],
      };
      const desired: Partial<ScopeIntegrations> = {
        connectors: [
          { connectorId: 'conn-2', name: 'gs', displayName: 'Google Sheets', connectorType: 'google', scopeConfig: { sheet: '123' } },
        ],
      };

      const diff = computeIntegrationsDiff(current, desired);

      expect(diff.connectors.toAdd).toHaveLength(1);
      expect(diff.connectors.toAdd[0]!.connectorId).toBe('conn-2');
      expect(diff.connectors.toAdd[0]!.scopeConfig).toEqual({ sheet: '123' });
      expect(diff.connectors.toRemove).toEqual(['conn-1']);
    });
  });

  // -----------------------------------------------------------------------
  // Partial desired (only some keys provided)
  // -----------------------------------------------------------------------
  describe('partial desired', () => {
    it('should not diff resource types not present in desired', () => {
      const current: ScopeIntegrations = {
        mcpServers: [
          { assignmentId: 'assign-1', mcpServerId: 'mcp-1', name: 'github-mcp', scopeConfig: {} },
        ],
        documentGroups: [
          { assignmentId: 'assign-dg-1', documentGroupId: 'dg-1', name: 'specs' },
        ],
        imChannels: [],
        connectors: [],
        plugins: [],
      };
      // Only desired mcpServers — documentGroups should be untouched
      const desired: Partial<ScopeIntegrations> = {
        mcpServers: [
          { assignmentId: '', mcpServerId: 'mcp-2', name: 'new-mcp', scopeConfig: {} },
        ],
      };

      const diff = computeIntegrationsDiff(current, desired);

      // MCP: mcp-1 removed, mcp-2 added
      expect(diff.mcpServers.toAdd).toHaveLength(1);
      expect(diff.mcpServers.toRemove).toEqual(['assign-1']);
      // Document groups: not in desired → no diff
      expect(diff.documentGroups.toAdd).toHaveLength(0);
      expect(diff.documentGroups.toRemove).toHaveLength(0);
    });
  });
});
