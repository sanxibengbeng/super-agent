import { describe, it, expect } from 'vitest';
import {
  buildMcpCatalog,
  buildConnectorCatalog,
  buildDocGroupCatalog,
  buildIntegrationsSnapshot,
  type McpCatalogEntry,
  type ConnectorCatalogEntry,
  type DocGroupCatalogEntry,
} from '../../src/services/scope-copilot-seeder.js';

describe('scope-copilot-seeder', () => {
  describe('buildMcpCatalog', () => {
    it('should return empty notice when no servers provided', () => {
      const result = buildMcpCatalog([]);

      expect(result).toContain('## Available MCP Servers');
      expect(result).toContain('No MCP servers');
    });

    it('should format single MCP server correctly', () => {
      const servers: McpCatalogEntry[] = [
        {
          id: 'mcp-1',
          name: 'github-mcp',
          description: 'GitHub integration for code management',
          host_address: 'https://github.mcp.example.com',
          status: 'active',
        },
      ];

      const result = buildMcpCatalog(servers);

      expect(result).toContain('## Available MCP Servers');
      expect(result).toContain('github-mcp');
      expect(result).toContain('GitHub integration for code management');
      expect(result).toContain('https://github.mcp.example.com');
      expect(result).toContain('active');
    });

    it('should format multiple MCP servers correctly', () => {
      const servers: McpCatalogEntry[] = [
        {
          id: 'mcp-1',
          name: 'github-mcp',
          description: 'GitHub integration',
          host_address: 'https://github.mcp.example.com',
          status: 'active',
        },
        {
          id: 'mcp-2',
          name: 'slack-mcp',
          description: null,
          host_address: 'https://slack.mcp.example.com',
          status: 'inactive',
        },
      ];

      const result = buildMcpCatalog(servers);

      expect(result).toContain('## Available MCP Servers');
      expect(result).toContain('github-mcp');
      expect(result).toContain('slack-mcp');
      expect(result).toContain('GitHub integration');
      expect(result).toContain('inactive');
    });

    it('should handle null description gracefully', () => {
      const servers: McpCatalogEntry[] = [
        {
          id: 'mcp-1',
          name: 'test-mcp',
          description: null,
          host_address: 'https://test.com',
          status: 'active',
        },
      ];

      const result = buildMcpCatalog(servers);

      expect(result).toContain('test-mcp');
      expect(result).not.toContain('null');
    });
  });

  describe('buildConnectorCatalog', () => {
    it('should return empty notice when no connectors provided', () => {
      const result = buildConnectorCatalog([]);

      expect(result).toContain('## Available Data Connectors');
      expect(result).toContain('No data connectors');
    });

    it('should format single connector correctly', () => {
      const connectors: ConnectorCatalogEntry[] = [
        {
          id: 'conn-1',
          name: 'salesforce-connector',
          display_name: 'Salesforce CRM',
          connector_type: 'salesforce',
          status: 'active',
        },
      ];

      const result = buildConnectorCatalog(connectors);

      expect(result).toContain('## Available Data Connectors');
      expect(result).toContain('salesforce-connector');
      expect(result).toContain('Salesforce CRM');
      expect(result).toContain('salesforce');
      expect(result).toContain('active');
    });

    it('should format multiple connectors correctly', () => {
      const connectors: ConnectorCatalogEntry[] = [
        {
          id: 'conn-1',
          name: 'salesforce-connector',
          display_name: 'Salesforce CRM',
          connector_type: 'salesforce',
          status: 'active',
        },
        {
          id: 'conn-2',
          name: 'google-sheets',
          display_name: 'Google Sheets',
          connector_type: 'google',
          status: 'configured',
        },
      ];

      const result = buildConnectorCatalog(connectors);

      expect(result).toContain('## Available Data Connectors');
      expect(result).toContain('salesforce-connector');
      expect(result).toContain('google-sheets');
      expect(result).toContain('Salesforce CRM');
      expect(result).toContain('Google Sheets');
      expect(result).toContain('configured');
    });
  });

  describe('buildDocGroupCatalog', () => {
    it('should return empty notice when no document groups provided', () => {
      const result = buildDocGroupCatalog([]);

      expect(result).toContain('## Available Document Groups');
      expect(result).toContain('No document groups');
    });

    it('should format single document group correctly', () => {
      const groups: DocGroupCatalogEntry[] = [
        {
          id: 'doc-1',
          name: 'product-specs',
          description: 'Product specification documents',
          _count: { files: 12 },
        },
      ];

      const result = buildDocGroupCatalog(groups);

      expect(result).toContain('## Available Document Groups');
      expect(result).toContain('product-specs');
      expect(result).toContain('Product specification documents');
      expect(result).toContain('12');
      expect(result).toMatch(/files?/i);
    });

    it('should format multiple document groups correctly', () => {
      const groups: DocGroupCatalogEntry[] = [
        {
          id: 'doc-1',
          name: 'product-specs',
          description: 'Product specification documents',
          _count: { files: 12 },
        },
        {
          id: 'doc-2',
          name: 'legal-docs',
          description: null,
          _count: { files: 5 },
        },
      ];

      const result = buildDocGroupCatalog(groups);

      expect(result).toContain('## Available Document Groups');
      expect(result).toContain('product-specs');
      expect(result).toContain('legal-docs');
      expect(result).toContain('12');
      expect(result).toContain('5');
    });

    it('should handle zero files correctly', () => {
      const groups: DocGroupCatalogEntry[] = [
        {
          id: 'doc-1',
          name: 'empty-group',
          description: 'Empty document group',
          _count: { files: 0 },
        },
      ];

      const result = buildDocGroupCatalog(groups);

      expect(result).toContain('empty-group');
      expect(result).toContain('0');
    });

    it('should handle null description gracefully', () => {
      const groups: DocGroupCatalogEntry[] = [
        {
          id: 'doc-1',
          name: 'test-group',
          description: null,
          _count: { files: 3 },
        },
      ];

      const result = buildDocGroupCatalog(groups);

      expect(result).toContain('test-group');
      expect(result).not.toContain('null');
    });
  });

  describe('buildIntegrationsSnapshot', () => {
    it('should build empty snapshot when no bindings provided', () => {
      const result = buildIntegrationsSnapshot({
        mcpServers: [],
        documentGroups: [],
        imChannels: [],
        connectors: [],
        plugins: [],
      });

      expect(result).toEqual({
        mcpServers: [],
        documentGroups: [],
        imChannels: [],
        connectors: [],
        plugins: [],
      });
    });

    it('should build snapshot with MCP servers', () => {
      const result = buildIntegrationsSnapshot({
        mcpServers: [
          {
            assignmentId: 'assign-1',
            mcpServerId: 'mcp-1',
            name: 'github-mcp',
            scopeConfig: { repo: 'owner/repo' },
          },
        ],
        documentGroups: [],
        imChannels: [],
        connectors: [],
        plugins: [],
      });

      expect(result.mcpServers).toHaveLength(1);
      expect(result.mcpServers[0]).toEqual({
        assignmentId: 'assign-1',
        mcpServerId: 'mcp-1',
        name: 'github-mcp',
        scopeConfig: { repo: 'owner/repo' },
      });
    });

    it('should build snapshot with document groups', () => {
      const result = buildIntegrationsSnapshot({
        mcpServers: [],
        documentGroups: [
          {
            assignmentId: 'assign-1',
            documentGroupId: 'doc-1',
            name: 'product-specs',
          },
          {
            assignmentId: 'assign-2',
            documentGroupId: 'doc-2',
            name: 'legal-docs',
          },
        ],
        imChannels: [],
        connectors: [],
        plugins: [],
      });

      expect(result.documentGroups).toHaveLength(2);
      expect(result.documentGroups[0].name).toBe('product-specs');
      expect(result.documentGroups[1].name).toBe('legal-docs');
    });

    it('should build snapshot with IM channels', () => {
      const result = buildIntegrationsSnapshot({
        mcpServers: [],
        documentGroups: [],
        imChannels: [
          {
            id: 'im-1',
            channelType: 'slack',
            channelId: 'C123456',
            channelName: '#general',
            isEnabled: true,
          },
          {
            id: 'im-2',
            channelType: 'discord',
            channelId: 'D789012',
            channelName: null,
            isEnabled: false,
          },
        ],
        connectors: [],
        plugins: [],
      });

      expect(result.imChannels).toHaveLength(2);
      expect(result.imChannels[0].channelType).toBe('slack');
      expect(result.imChannels[0].isEnabled).toBe(true);
      expect(result.imChannels[1].isEnabled).toBe(false);
    });

    it('should build snapshot with data connectors', () => {
      const result = buildIntegrationsSnapshot({
        mcpServers: [],
        documentGroups: [],
        imChannels: [],
        connectors: [
          {
            connectorId: 'conn-1',
            name: 'salesforce',
            displayName: 'Salesforce CRM',
            connectorType: 'salesforce',
            scopeConfig: { instance: 'production' },
          },
        ],
        plugins: [],
      });

      expect(result.connectors).toHaveLength(1);
      expect(result.connectors[0].connectorType).toBe('salesforce');
      expect(result.connectors[0].scopeConfig).toEqual({ instance: 'production' });
    });

    it('should build snapshot with plugins', () => {
      const result = buildIntegrationsSnapshot({
        mcpServers: [],
        documentGroups: [],
        imChannels: [],
        connectors: [],
        plugins: [
          {
            id: 'plugin-1',
            name: 'claude-mem',
            gitUrl: 'https://github.com/example/claude-mem.git',
            ref: 'main',
          },
          {
            id: 'plugin-2',
            name: 'code-analyzer',
            gitUrl: 'https://github.com/example/code-analyzer.git',
            ref: 'v1.2.3',
          },
        ],
      });

      expect(result.plugins).toHaveLength(2);
      expect(result.plugins[0].name).toBe('claude-mem');
      expect(result.plugins[1].ref).toBe('v1.2.3');
    });

    it('should build complete snapshot with all integration types', () => {
      const result = buildIntegrationsSnapshot({
        mcpServers: [
          {
            assignmentId: 'assign-1',
            mcpServerId: 'mcp-1',
            name: 'github-mcp',
            scopeConfig: {},
          },
        ],
        documentGroups: [
          {
            assignmentId: 'assign-2',
            documentGroupId: 'doc-1',
            name: 'specs',
          },
        ],
        imChannels: [
          {
            id: 'im-1',
            channelType: 'slack',
            channelId: 'C123',
            channelName: '#dev',
            isEnabled: true,
          },
        ],
        connectors: [
          {
            connectorId: 'conn-1',
            name: 'salesforce',
            displayName: 'Salesforce',
            connectorType: 'salesforce',
            scopeConfig: {},
          },
        ],
        plugins: [
          {
            id: 'plugin-1',
            name: 'plugin',
            gitUrl: 'https://example.com/plugin.git',
            ref: 'main',
          },
        ],
      });

      expect(result.mcpServers).toHaveLength(1);
      expect(result.documentGroups).toHaveLength(1);
      expect(result.imChannels).toHaveLength(1);
      expect(result.connectors).toHaveLength(1);
      expect(result.plugins).toHaveLength(1);
    });
  });
});
