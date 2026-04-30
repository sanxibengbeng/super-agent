/**
 * Scope Copilot Seeder Service
 *
 * Generates workspace seed files that tell the copilot agent what org resources
 * are available. This service provides pure functions for formatting data into
 * markdown catalogs, and database query functions to fetch integration bindings.
 */

import { prisma } from '../config/database.js';
import type { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpCatalogEntry {
  id: string;
  name: string;
  description: string | null;
  host_address: string;
  status: string;
}

export interface ConnectorCatalogEntry {
  id: string;
  name: string;
  display_name: string;
  connector_type: string;
  status: string;
}

export interface DocGroupCatalogEntry {
  id: string;
  name: string;
  description: string | null;
  _count: { files: number };
}

export interface ScopeIntegrations {
  mcpServers: Array<{
    assignmentId: string;
    mcpServerId: string;
    name: string;
    scopeConfig: Record<string, unknown>;
  }>;
  documentGroups: Array<{
    assignmentId: string;
    documentGroupId: string;
    name: string;
  }>;
  imChannels: Array<{
    id: string;
    channelType: string;
    channelId: string;
    channelName: string | null;
    isEnabled: boolean;
  }>;
  connectors: Array<{
    connectorId: string;
    name: string;
    displayName: string;
    connectorType: string;
    scopeConfig: Record<string, unknown>;
  }>;
  plugins: Array<{
    id: string;
    name: string;
    gitUrl: string;
    ref: string;
  }>;
}

export interface OrgCatalogs {
  mcpServers: McpCatalogEntry[];
  connectors: ConnectorCatalogEntry[];
  docGroups: DocGroupCatalogEntry[];
}

// ---------------------------------------------------------------------------
// Pure catalog formatting functions
// ---------------------------------------------------------------------------

/**
 * Build markdown catalog for MCP servers
 */
export function buildMcpCatalog(servers: McpCatalogEntry[]): string {
  const lines: string[] = ['## Available MCP Servers', ''];

  if (servers.length === 0) {
    lines.push('No MCP servers available in this organization.');
    return lines.join('\n');
  }

  for (const server of servers) {
    lines.push(`### ${server.name}`);
    if (server.description) {
      lines.push(`${server.description}`);
    }
    lines.push(`- **Host:** ${server.host_address}`);
    lines.push(`- **Status:** ${server.status}`);
    lines.push(`- **ID:** ${server.id}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build markdown catalog for data connectors
 */
export function buildConnectorCatalog(connectors: ConnectorCatalogEntry[]): string {
  const lines: string[] = ['## Available Data Connectors', ''];

  if (connectors.length === 0) {
    lines.push('No data connectors available in this organization.');
    return lines.join('\n');
  }

  for (const connector of connectors) {
    lines.push(`### ${connector.display_name}`);
    lines.push(`- **Name:** ${connector.name}`);
    lines.push(`- **Type:** ${connector.connector_type}`);
    lines.push(`- **Status:** ${connector.status}`);
    lines.push(`- **ID:** ${connector.id}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build markdown catalog for document groups
 */
export function buildDocGroupCatalog(groups: DocGroupCatalogEntry[]): string {
  const lines: string[] = ['## Available Document Groups', ''];

  if (groups.length === 0) {
    lines.push('No document groups available in this organization.');
    return lines.join('\n');
  }

  for (const group of groups) {
    lines.push(`### ${group.name}`);
    if (group.description) {
      lines.push(`${group.description}`);
    }
    const fileCount = group._count.files;
    const fileLabel = fileCount === 1 ? 'file' : 'files';
    lines.push(`- **Files:** ${fileCount} ${fileLabel}`);
    lines.push(`- **ID:** ${group.id}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build structured snapshot of current scope integration bindings
 */
export function buildIntegrationsSnapshot(bindings: ScopeIntegrations): ScopeIntegrations {
  // Simple passthrough that creates a clean copy
  return {
    mcpServers: bindings.mcpServers.map((s) => ({ ...s })),
    documentGroups: bindings.documentGroups.map((g) => ({ ...g })),
    imChannels: bindings.imChannels.map((c) => ({ ...c })),
    connectors: bindings.connectors.map((c) => ({ ...c })),
    plugins: bindings.plugins.map((p) => ({ ...p })),
  };
}

// ---------------------------------------------------------------------------
// Database query functions
// ---------------------------------------------------------------------------

/**
 * Fetch organization-level catalogs for MCP servers, connectors, and doc groups
 */
export async function fetchOrgCatalogs(organizationId: string): Promise<OrgCatalogs> {
  const [mcpServers, connectors, docGroups] = await Promise.all([
    // Fetch MCP servers
    prisma.mcp_servers.findMany({
      where: { organization_id: organizationId },
      select: {
        id: true,
        name: true,
        description: true,
        host_address: true,
        status: true,
      },
      orderBy: { name: 'asc' },
    }),

    // Fetch data connectors
    prisma.data_connectors.findMany({
      where: { organization_id: organizationId },
      select: {
        id: true,
        name: true,
        display_name: true,
        connector_type: true,
        status: true,
      },
      orderBy: { name: 'asc' },
    }),

    // Fetch document groups with file counts
    prisma.document_groups.findMany({
      where: { organization_id: organizationId },
      select: {
        id: true,
        name: true,
        description: true,
        _count: {
          select: { files: true },
        },
      },
      orderBy: { name: 'asc' },
    }),
  ]);

  return {
    mcpServers,
    connectors,
    docGroups,
  };
}

/**
 * Fetch scope-specific integration bindings
 */
export async function fetchScopeBindings(
  organizationId: string,
  scopeId: string
): Promise<ScopeIntegrations> {
  // Fetch MCP server bindings
  const mcpServerBindings = await prisma.$queryRaw<
    Array<{
      assignment_id: string;
      mcp_server_id: string;
      name: string;
      scope_config: Prisma.JsonValue | null;
    }>
  >`
    SELECT
      sms.id as assignment_id,
      sms.mcp_server_id,
      ms.name,
      sms.scope_config
    FROM scope_mcp_servers sms
    JOIN mcp_servers ms ON ms.id = sms.mcp_server_id
    WHERE sms.business_scope_id = ${scopeId}::uuid
    ORDER BY ms.name ASC
  `;

  // Fetch document group bindings
  const docGroupBindings = await prisma.$queryRaw<
    Array<{
      assignment_id: string;
      document_group_id: string;
      name: string;
    }>
  >`
    SELECT
      sdg.id as assignment_id,
      sdg.document_group_id,
      dg.name
    FROM scope_document_groups sdg
    JOIN document_groups dg ON dg.id = sdg.document_group_id
    WHERE sdg.business_scope_id = ${scopeId}::uuid
    ORDER BY dg.name ASC
  `;

  // Fetch IM channel bindings
  const imChannelBindings = await prisma.im_channel_bindings.findMany({
    where: {
      organization_id: organizationId,
      business_scope_id: scopeId,
    },
    select: {
      id: true,
      channel_type: true,
      channel_id: true,
      channel_name: true,
      is_enabled: true,
    },
    orderBy: { channel_type: 'asc' },
  });

  // Fetch data connector bindings
  const connectorBindings = await prisma.$queryRaw<
    Array<{
      connector_id: string;
      name: string;
      display_name: string;
      connector_type: string;
      scope_config: Prisma.JsonValue | null;
    }>
  >`
    SELECT
      sdc.connector_id,
      dc.name,
      dc.display_name,
      dc.connector_type,
      sdc.scope_config
    FROM scope_data_connectors sdc
    JOIN data_connectors dc ON dc.id = sdc.connector_id
    WHERE sdc.business_scope_id = ${scopeId}::uuid
    ORDER BY dc.name ASC
  `;

  // Fetch plugin bindings
  const pluginBindings = await prisma.scope_plugins.findMany({
    where: { business_scope_id: scopeId },
    select: {
      id: true,
      name: true,
      git_url: true,
      ref: true,
    },
    orderBy: { name: 'asc' },
  });

  // Transform results to ScopeIntegrations format
  return {
    mcpServers: mcpServerBindings.map((row) => ({
      assignmentId: row.assignment_id,
      mcpServerId: row.mcp_server_id,
      name: row.name,
      scopeConfig: (row.scope_config as Record<string, unknown>) || {},
    })),
    documentGroups: docGroupBindings.map((row) => ({
      assignmentId: row.assignment_id,
      documentGroupId: row.document_group_id,
      name: row.name,
    })),
    imChannels: imChannelBindings.map((row) => ({
      id: row.id,
      channelType: row.channel_type,
      channelId: row.channel_id,
      channelName: row.channel_name,
      isEnabled: row.is_enabled,
    })),
    connectors: connectorBindings.map((row) => ({
      connectorId: row.connector_id,
      name: row.name,
      displayName: row.display_name,
      connectorType: row.connector_type,
      scopeConfig: (row.scope_config as Record<string, unknown>) || {},
    })),
    plugins: pluginBindings.map((row) => ({
      id: row.id,
      name: row.name,
      gitUrl: row.git_url,
      ref: row.ref,
    })),
  };
}
