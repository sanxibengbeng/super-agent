# Scope Copilot Expanded Coverage — Hybrid Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the Scope Copilot from managing only scope metadata + agents + skills (config-file mode) to also managing MCP servers, knowledge base (document groups), IM channels, data connectors, plugins, and workflows via a hybrid config-file + tool-use architecture.

**Architecture:** The existing config-file approach (`scope-config.json`) remains for core entities (scope, agents, skills). A new `scope-integrations.json` file is added for integration configuration (MCP servers, document groups, IM channels, connectors, plugins). The copilot workspace is seeded with an inventory of the organization's available resources (MCP catalog, connector catalog, document groups). The copilot agent's system prompt is extended with new sections describing these resources and how to configure them. On the backend, the save endpoint is extended to process `scope-integrations.json` in addition to `scope-config.json`. On the frontend, the ScopeWorkspace component gets new panels to display and manage integrations alongside agents.

**Tech Stack:** Fastify 5, TypeScript, Prisma, React 19, Tailwind CSS 4, Claude Agent SDK

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `backend/src/services/scope-copilot-seeder.ts` | Seed copilot workspace with org resource catalogs |
| `frontend/src/components/IntegrationWorkspace.tsx` | Display/edit integration config (MCP, docs, IM, connectors, plugins) |

### Modified Files

| File | Changes |
|------|---------|
| `backend/seeds/system-copilots/scope-copilot.json` | Extend system prompt with integration management instructions |
| `backend/src/routes/scope-generator.routes.ts` | Seed integrations catalog; extend save to process integrations; add `scope-integrations` read endpoint |
| `backend/src/services/scope-generator.service.ts` | Add `saveIntegrations()` method; extend `GeneratedScopeConfig` type |
| `frontend/src/services/scopeGeneratorService.ts` | Add integration types; add `fetchScopeIntegrations` API call |
| `frontend/src/hooks/useScopeDraft.ts` | Add `integrations` state to draft; add `applyIntegrations` method |
| `frontend/src/components/ScopeWorkspace.tsx` | Add integrations tab/section rendering |
| `frontend/src/components/ScopeCopilot.tsx` | Detect `scope-integrations.json` writes alongside `scope-config.json` |
| `frontend/src/pages/ScopeCopilotPage.tsx` | Wire integration state between workspace and copilot |

### Test Files

| File | Coverage |
|------|----------|
| `backend/src/services/__tests__/scope-copilot-seeder.test.ts` | Catalog generation, workspace seeding |
| `backend/src/services/__tests__/scope-generator-integrations.test.ts` | Integration save logic |
| `frontend/src/components/__tests__/IntegrationWorkspace.test.tsx` | Render, edit, remove integrations |
| `frontend/src/hooks/__tests__/useScopeDraft-integrations.test.ts` | Integration draft state management |

---

## Task 1: Backend — Create Scope Copilot Seeder Service

**Files:**
- Create: `backend/src/services/scope-copilot-seeder.ts`
- Test: `backend/src/services/__tests__/scope-copilot-seeder.test.ts`

This service generates the workspace seed files that tell the copilot agent what org resources are available. It queries the database for the org's MCP servers, document groups, data connectors, and existing scope integrations, then writes catalog files into the workspace.

- [ ] **Step 1: Write the failing test for `buildMcpCatalog`**

```typescript
// backend/src/services/__tests__/scope-copilot-seeder.test.ts
import { describe, it, expect } from 'vitest';
import { buildMcpCatalog, buildConnectorCatalog, buildDocGroupCatalog, buildIntegrationsSnapshot } from '../scope-copilot-seeder.js';

describe('scope-copilot-seeder', () => {
  describe('buildMcpCatalog', () => {
    it('formats MCP servers into a markdown catalog', () => {
      const servers = [
        { id: 'mcp-1', name: 'postgres-query', description: 'Query PostgreSQL databases', host_address: 'http://localhost:5433', status: 'active' },
        { id: 'mcp-2', name: 'github-tools', description: 'GitHub API integration', host_address: 'https://github-mcp.example.com', status: 'active' },
      ];
      const result = buildMcpCatalog(servers);
      expect(result).toContain('postgres-query');
      expect(result).toContain('mcp-1');
      expect(result).toContain('github-tools');
      expect(result).toContain('## Available MCP Servers');
    });

    it('returns empty notice when no servers exist', () => {
      const result = buildMcpCatalog([]);
      expect(result).toContain('No MCP servers');
    });
  });

  describe('buildConnectorCatalog', () => {
    it('formats connectors into a markdown catalog', () => {
      const connectors = [
        { id: 'conn-1', name: 'salesforce', display_name: 'Salesforce CRM', connector_type: 'saas', status: 'connected' },
      ];
      const result = buildConnectorCatalog(connectors);
      expect(result).toContain('salesforce');
      expect(result).toContain('conn-1');
    });
  });

  describe('buildDocGroupCatalog', () => {
    it('formats document groups into a markdown catalog', () => {
      const groups = [
        { id: 'dg-1', name: 'HR Policies', description: 'Company HR documentation', _count: { files: 12 } },
      ];
      const result = buildDocGroupCatalog(groups);
      expect(result).toContain('HR Policies');
      expect(result).toContain('12 files');
    });
  });

  describe('buildIntegrationsSnapshot', () => {
    it('creates scope-integrations.json from current scope bindings', () => {
      const bindings = {
        mcpServers: [{ assignmentId: 'a1', mcpServerId: 'mcp-1', name: 'postgres-query', scopeConfig: {} }],
        documentGroups: [{ assignmentId: 'a2', documentGroupId: 'dg-1', name: 'HR Policies' }],
        imChannels: [],
        connectors: [],
        plugins: [{ id: 'p1', name: 'my-plugin', gitUrl: 'https://github.com/org/plugin.git', ref: 'main' }],
      };
      const result = buildIntegrationsSnapshot(bindings);
      expect(result.mcpServers).toHaveLength(1);
      expect(result.mcpServers[0].mcpServerId).toBe('mcp-1');
      expect(result.documentGroups).toHaveLength(1);
      expect(result.plugins).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/ubuntu/super-agent/backend && npx vitest run src/services/__tests__/scope-copilot-seeder.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the seeder service**

```typescript
// backend/src/services/scope-copilot-seeder.ts
import { prisma } from '../config/database.js';

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
  mcpServers: Array<{ assignmentId: string; mcpServerId: string; name: string; scopeConfig: Record<string, unknown> }>;
  documentGroups: Array<{ assignmentId: string; documentGroupId: string; name: string }>;
  imChannels: Array<{ id: string; channelType: string; channelId: string; channelName: string | null; isEnabled: boolean }>;
  connectors: Array<{ connectorId: string; name: string; displayName: string; connectorType: string; scopeConfig: Record<string, unknown> }>;
  plugins: Array<{ id: string; name: string; gitUrl: string; ref: string }>;
}

export function buildMcpCatalog(servers: McpCatalogEntry[]): string {
  if (servers.length === 0) {
    return '## Available MCP Servers\n\nNo MCP servers configured for this organization. Skip MCP configuration.\n';
  }
  const lines = ['## Available MCP Servers\n', 'These MCP tool servers are available in your organization. Reference them by `id` in scope-integrations.json.\n'];
  for (const s of servers) {
    lines.push(`- **${s.name}** (id: \`${s.id}\`): ${s.description ?? 'No description'} — status: ${s.status}`);
  }
  return lines.join('\n') + '\n';
}

export function buildConnectorCatalog(connectors: ConnectorCatalogEntry[]): string {
  if (connectors.length === 0) {
    return '## Available Data Connectors\n\nNo data connectors configured. Skip connector configuration.\n';
  }
  const lines = ['## Available Data Connectors\n', 'Reference by `id` in scope-integrations.json.\n'];
  for (const c of connectors) {
    lines.push(`- **${c.display_name}** (id: \`${c.id}\`, type: ${c.connector_type}): status ${c.status}`);
  }
  return lines.join('\n') + '\n';
}

export function buildDocGroupCatalog(groups: DocGroupCatalogEntry[]): string {
  if (groups.length === 0) {
    return '## Available Document Groups\n\nNo document groups exist. Skip knowledge base configuration.\n';
  }
  const lines = ['## Available Document Groups\n', 'Reference by `id` in scope-integrations.json.\n'];
  for (const g of groups) {
    lines.push(`- **${g.name}** (id: \`${g.id}\`): ${g.description ?? 'No description'} — ${g._count.files} files`);
  }
  return lines.join('\n') + '\n';
}

export function buildIntegrationsSnapshot(bindings: {
  mcpServers: Array<{ assignmentId: string; mcpServerId: string; name: string; scopeConfig: Record<string, unknown> }>;
  documentGroups: Array<{ assignmentId: string; documentGroupId: string; name: string }>;
  imChannels: Array<{ id: string; channelType: string; channelId: string; channelName: string | null; isEnabled: boolean }>;
  connectors: Array<{ connectorId: string; name: string; displayName: string; connectorType: string; scopeConfig: Record<string, unknown> }>;
  plugins: Array<{ id: string; name: string; gitUrl: string; ref: string }>;
}): ScopeIntegrations {
  return {
    mcpServers: bindings.mcpServers.map(s => ({
      assignmentId: s.assignmentId,
      mcpServerId: s.mcpServerId,
      name: s.name,
      scopeConfig: s.scopeConfig,
    })),
    documentGroups: bindings.documentGroups.map(d => ({
      assignmentId: d.assignmentId,
      documentGroupId: d.documentGroupId,
      name: d.name,
    })),
    imChannels: bindings.imChannels.map(ch => ({
      id: ch.id,
      channelType: ch.channelType,
      channelId: ch.channelId,
      channelName: ch.channelName,
      isEnabled: ch.isEnabled,
    })),
    connectors: bindings.connectors.map(c => ({
      connectorId: c.connectorId,
      name: c.name,
      displayName: c.displayName,
      connectorType: c.connectorType,
      scopeConfig: c.scopeConfig,
    })),
    plugins: bindings.plugins.map(p => ({
      id: p.id,
      name: p.name,
      gitUrl: p.gitUrl,
      ref: p.ref,
    })),
  };
}

export async function fetchOrgCatalogs(organizationId: string) {
  const [mcpServers, connectors, docGroups] = await Promise.all([
    prisma.mcp_servers.findMany({
      where: { organization_id: organizationId },
      select: { id: true, name: true, description: true, host_address: true, status: true },
    }),
    prisma.data_connectors.findMany({
      where: { organization_id: organizationId },
      select: { id: true, name: true, display_name: true, connector_type: true, status: true },
    }),
    prisma.document_groups.findMany({
      where: { organization_id: organizationId },
      select: { id: true, name: true, description: true, _count: { select: { files: true } } },
    }),
  ]);
  return { mcpServers, connectors, docGroups };
}

export async function fetchScopeBindings(organizationId: string, scopeId: string): Promise<ScopeIntegrations> {
  const [mcpRows, docGroupRows, imRows, connectorRows, pluginRows] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string; mcp_server_id: string; name: string; scope_config: unknown }>>`
      SELECT sms.id, sms.mcp_server_id, ms.name, sms.scope_config
      FROM scope_mcp_servers sms
      JOIN mcp_servers ms ON ms.id = sms.mcp_server_id
      WHERE sms.business_scope_id = ${scopeId}::uuid
    `,
    prisma.$queryRaw<Array<{ id: string; document_group_id: string; name: string }>>`
      SELECT sdg.id, sdg.document_group_id, dg.name
      FROM scope_document_groups sdg
      JOIN document_groups dg ON dg.id = sdg.document_group_id
      WHERE sdg.business_scope_id = ${scopeId}::uuid
    `,
    prisma.im_channel_bindings.findMany({
      where: { business_scope_id: scopeId, organization_id: organizationId },
      select: { id: true, channel_type: true, channel_id: true, channel_name: true, is_enabled: true },
    }),
    prisma.$queryRaw<Array<{ connector_id: string; name: string; display_name: string; connector_type: string; scope_config: unknown }>>`
      SELECT sdc.connector_id, dc.name, dc.display_name, dc.connector_type, sdc.scope_config
      FROM scope_data_connectors sdc
      JOIN data_connectors dc ON dc.id = sdc.connector_id
      WHERE sdc.business_scope_id = ${scopeId}::uuid
    `,
    prisma.$queryRaw<Array<{ id: string; name: string; git_url: string; ref: string }>>`
      SELECT id, name, git_url, ref FROM scope_plugins WHERE business_scope_id = ${scopeId}::uuid
    `,
  ]);

  return buildIntegrationsSnapshot({
    mcpServers: mcpRows.map(r => ({ assignmentId: r.id, mcpServerId: r.mcp_server_id, name: r.name, scopeConfig: (r.scope_config ?? {}) as Record<string, unknown> })),
    documentGroups: docGroupRows.map(r => ({ assignmentId: r.id, documentGroupId: r.document_group_id, name: r.name })),
    imChannels: imRows.map(r => ({ id: r.id, channelType: r.channel_type, channelId: r.channel_id, channelName: r.channel_name, isEnabled: r.is_enabled })),
    connectors: connectorRows.map(r => ({ connectorId: r.connector_id, name: r.name, displayName: r.display_name, connectorType: r.connector_type, scopeConfig: (r.scope_config ?? {}) as Record<string, unknown> })),
    plugins: pluginRows.map(r => ({ id: r.id, name: r.name, gitUrl: r.git_url, ref: r.ref })),
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/ubuntu/super-agent/backend && npx vitest run src/services/__tests__/scope-copilot-seeder.test.ts`
Expected: PASS (4 tests — pure functions, no DB needed)

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/scope-copilot-seeder.ts backend/src/services/__tests__/scope-copilot-seeder.test.ts
git commit -m "feat(scope-copilot): add seeder service for org resource catalogs"
```

---

## Task 2: Backend — Extend Workspace Seeding with Integration Catalogs

**Files:**
- Modify: `backend/src/routes/scope-generator.routes.ts:586-678` (copilot/stream handler)
- Reference: `backend/src/services/scope-copilot-seeder.ts` (from Task 1)

The `/copilot/stream` endpoint already seeds `CLAUDE.md`, `scope-config.json`, and `CHANGELOG.md`. We need to also seed:
1. `catalogs/mcp-servers.md` — org-level MCP catalog
2. `catalogs/connectors.md` — org-level connector catalog  
3. `catalogs/document-groups.md` — org-level doc group catalog
4. `scope-integrations.json` — current scope integration bindings

- [ ] **Step 1: Add catalog seeding after existing workspace setup**

In `backend/src/routes/scope-generator.routes.ts`, inside the `if (targetScope)` block (around line 621), after the CHANGELOG seeding (line 667), add:

```typescript
        // Seed organization resource catalogs for the copilot to reference
        const catalogDir = join(workspacePath, 'catalogs');
        await mkdir(catalogDir, { recursive: true });

        const { fetchOrgCatalogs, fetchScopeBindings, buildMcpCatalog, buildConnectorCatalog, buildDocGroupCatalog } = await import('../services/scope-copilot-seeder.js');
        const catalogs = await fetchOrgCatalogs(orgId);
        await Promise.all([
          writeFile(join(catalogDir, 'mcp-servers.md'), buildMcpCatalog(catalogs.mcpServers)),
          writeFile(join(catalogDir, 'connectors.md'), buildConnectorCatalog(catalogs.connectors)),
          writeFile(join(catalogDir, 'document-groups.md'), buildDocGroupCatalog(catalogs.docGroups)),
        ]);

        // Seed scope-integrations.json (current bindings) — only if not already present
        const integrationsPath = join(workspacePath, 'scope-integrations.json');
        try {
          await import('fs/promises').then(fs => fs.access(integrationsPath));
        } catch {
          const integrations = await fetchScopeBindings(orgId, scope_id);
          await writeFile(integrationsPath, JSON.stringify(integrations, null, 2));
        }
```

- [ ] **Step 2: Update CLAUDE.md seeding to mention catalogs and integrations**

In the same handler, replace the `claudeLines` array (lines 637-647) with:

```typescript
        const claudeLines: string[] = [
          `# Scope: ${targetScope.name}`,
          `Scope ID: ${scope_id}`,
          `Description: ${targetScope.description ?? 'Not set'}`,
          '',
          hasAgents
            ? `Status: Existing scope with ${targetAgents.length} agent(s) — operate in EDITING mode.`
            : 'Status: Empty scope — operate in GENERATION mode.',
          '',
          '## Configuration Files',
          '- `scope-config.json` — Scope metadata, agents, and skills (read/write)',
          '- `scope-integrations.json` — MCP servers, document groups, IM channels, connectors, plugins (read/write)',
          '',
          '## Organization Resource Catalogs',
          '- `catalogs/mcp-servers.md` — Available MCP servers (read-only reference)',
          '- `catalogs/connectors.md` — Available data connectors (read-only reference)',
          '- `catalogs/document-groups.md` — Available document groups (read-only reference)',
          '',
          'Read scope-config.json and scope-integrations.json for the current configuration.',
          'Read catalogs/*.md to see what resources are available to assign.',
        ];
```

- [ ] **Step 3: Test manually — start dev server and verify workspace seeding**

Run: `cd /home/ubuntu/super-agent/backend && npm run dev`

Then in a separate terminal:
```bash
# Check that the workspace gets created with catalog files
ls -la /tmp/workspaces/*/*/sessions/*/catalogs/
cat /tmp/workspaces/*/*/sessions/*/scope-integrations.json
```

Expected: `catalogs/` directory with 3 .md files, `scope-integrations.json` with current bindings.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/scope-generator.routes.ts
git commit -m "feat(scope-copilot): seed workspace with org resource catalogs and integration bindings"
```

---

## Task 3: Backend — Extend Scope Copilot System Prompt

**Files:**
- Modify: `backend/seeds/system-copilots/scope-copilot.json`

The copilot agent needs instructions on how to manage integrations. We extend the system prompt to describe `scope-integrations.json` schema, the catalog files, and the workflow for recommending and configuring integrations.

- [ ] **Step 1: Update the system prompt in the seed file**

Add the following sections to the `systemPrompt` field in `backend/seeds/system-copilots/scope-copilot.json`, appended after the existing "# Workflow for Each Turn" section:

```text
\n\n# Integration Management\n\nBeyond scope metadata, agents, and skills, you also manage the scope's integrations with external tools and resources. These are stored in `scope-integrations.json`.\n\n## scope-integrations.json Schema\n\n```json\n{\n  \"mcpServers\": [\n    {\n      \"mcpServerId\": \"uuid (from catalogs/mcp-servers.md)\",\n      \"name\": \"string (server name for display)\",\n      \"scopeConfig\": {} \n    }\n  ],\n  \"documentGroups\": [\n    {\n      \"documentGroupId\": \"uuid (from catalogs/document-groups.md)\",\n      \"name\": \"string (group name for display)\"\n    }\n  ],\n  \"imChannels\": [\n    {\n      \"channelType\": \"slack | discord | telegram | feishu | dingtalk | whatsapp\",\n      \"channelId\": \"string (platform-specific channel identifier)\",\n      \"channelName\": \"string (human-readable name)\",\n      \"isEnabled\": true\n    }\n  ],\n  \"connectors\": [\n    {\n      \"connectorId\": \"uuid (from catalogs/connectors.md)\",\n      \"name\": \"string\",\n      \"displayName\": \"string\",\n      \"connectorType\": \"saas | database | aws_service | internal_api\",\n      \"scopeConfig\": {}\n    }\n  ],\n  \"plugins\": [\n    {\n      \"name\": \"string (plugin name)\",\n      \"gitUrl\": \"string (git repository URL)\",\n      \"ref\": \"string (branch/tag, default: main)\"\n    }\n  ]\n}\n```\n\n## Integration Workflow\n\n1. Read `catalogs/*.md` to see what resources exist in the organization.\n2. Read `scope-integrations.json` to see what's currently assigned to this scope.\n3. Based on the business context and user requests, recommend integrations:\n   - MCP servers that provide relevant tools (e.g., database query for data teams)\n   - Document groups that contain relevant knowledge\n   - IM channels for deployment (ask user which platforms they use)\n   - Data connectors for external data access\n4. Write updated `scope-integrations.json` using the Write tool.\n5. For IM channels, ask the user for platform-specific credentials (bot tokens, webhook URLs) — these are interactive and cannot be auto-determined.\n6. Log integration changes in CHANGELOG.md alongside config changes.\n\n## Integration Rules\n\n- Only reference MCP servers and connectors that exist in the catalogs. Never invent IDs.\n- For document groups, only assign existing groups from the catalog.\n- For IM channels, the channelType must be one of: slack, discord, telegram, feishu, dingtalk, whatsapp.\n- For plugins, a valid gitUrl is required. Default ref to 'main'.\n- Keep existing integrations unless the user explicitly asks to remove them.\n- When generating a scope from scratch, proactively recommend relevant integrations based on the business description.
```

- [ ] **Step 2: Verify JSON is valid after edit**

Run: `cd /home/ubuntu/super-agent/backend && node -e "const s = require('./seeds/system-copilots/scope-copilot.json'); console.log('systemPrompt length:', s.agent.systemPrompt.length); console.log('OK')"`
Expected: prints length and "OK" without parse errors.

- [ ] **Step 3: Commit**

```bash
git add backend/seeds/system-copilots/scope-copilot.json
git commit -m "feat(scope-copilot): extend system prompt with integration management instructions"
```

---

## Task 4: Backend — Add Integration Read Endpoint + Extend Save

**Files:**
- Modify: `backend/src/routes/scope-generator.routes.ts`
- Modify: `backend/src/services/scope-generator.service.ts`
- Test: `backend/src/services/__tests__/scope-generator-integrations.test.ts`

We need:
1. A `GET /api/scope-generator/copilot/scope-integrations` endpoint to read `scope-integrations.json` from workspace
2. An extension to `POST /api/scope-generator/save` to accept and process integration data

- [ ] **Step 1: Write failing test for `saveIntegrations`**

```typescript
// backend/src/services/__tests__/scope-generator-integrations.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// We test the pure logic of mapping integration JSON to API calls
describe('saveIntegrations mapping', () => {
  it('identifies new MCP servers to add (present in integrations, absent from current)', () => {
    const current = { mcpServers: [], documentGroups: [], imChannels: [], connectors: [], plugins: [] };
    const desired = {
      mcpServers: [{ mcpServerId: 'mcp-1', name: 'postgres', scopeConfig: {} }],
      documentGroups: [],
      imChannels: [],
      connectors: [],
      plugins: [],
    };
    const diff = computeIntegrationsDiff(current, desired);
    expect(diff.mcpServers.toAdd).toEqual([{ mcpServerId: 'mcp-1', scopeConfig: {} }]);
    expect(diff.mcpServers.toRemove).toEqual([]);
  });

  it('identifies MCP servers to remove (present in current, absent from desired)', () => {
    const current = {
      mcpServers: [{ assignmentId: 'a1', mcpServerId: 'mcp-1', name: 'postgres', scopeConfig: {} }],
      documentGroups: [], imChannels: [], connectors: [], plugins: [],
    };
    const desired = { mcpServers: [], documentGroups: [], imChannels: [], connectors: [], plugins: [] };
    const diff = computeIntegrationsDiff(current, desired);
    expect(diff.mcpServers.toAdd).toEqual([]);
    expect(diff.mcpServers.toRemove).toEqual(['a1']);
  });

  it('identifies document groups to add and remove', () => {
    const current = {
      mcpServers: [], connectors: [], plugins: [], imChannels: [],
      documentGroups: [{ assignmentId: 'a1', documentGroupId: 'dg-1', name: 'Old Docs' }],
    };
    const desired = {
      mcpServers: [], connectors: [], plugins: [], imChannels: [],
      documentGroups: [{ documentGroupId: 'dg-2', name: 'New Docs' }],
    };
    const diff = computeIntegrationsDiff(current, desired);
    expect(diff.documentGroups.toAdd).toEqual([{ documentGroupId: 'dg-2' }]);
    expect(diff.documentGroups.toRemove).toEqual(['a1']);
  });

  it('identifies plugins to add and remove by name', () => {
    const current = {
      mcpServers: [], documentGroups: [], imChannels: [], connectors: [],
      plugins: [{ id: 'p1', name: 'old-plugin', gitUrl: 'https://example.com/old.git', ref: 'main' }],
    };
    const desired = {
      mcpServers: [], documentGroups: [], imChannels: [], connectors: [],
      plugins: [{ name: 'new-plugin', gitUrl: 'https://example.com/new.git', ref: 'main' }],
    };
    const diff = computeIntegrationsDiff(current, desired);
    expect(diff.plugins.toAdd).toEqual([{ name: 'new-plugin', gitUrl: 'https://example.com/new.git', ref: 'main' }]);
    expect(diff.plugins.toRemove).toEqual(['p1']);
  });
});

// Import after defining tests so the test file is valid even before implementation
import { computeIntegrationsDiff } from '../scope-generator.service.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/super-agent/backend && npx vitest run src/services/__tests__/scope-generator-integrations.test.ts`
Expected: FAIL — `computeIntegrationsDiff` not exported

- [ ] **Step 3: Implement `computeIntegrationsDiff` in scope-generator.service.ts**

Add to `backend/src/services/scope-generator.service.ts` near the bottom, before the class closing brace:

```typescript
export interface IntegrationsDiff {
  mcpServers: { toAdd: Array<{ mcpServerId: string; scopeConfig: Record<string, unknown> }>; toRemove: string[] };
  documentGroups: { toAdd: Array<{ documentGroupId: string }>; toRemove: string[] };
  imChannels: { toAdd: Array<{ channelType: string; channelId: string; channelName: string | null; isEnabled: boolean }>; toRemove: string[] };
  connectors: { toAdd: Array<{ connectorId: string; scopeConfig: Record<string, unknown> }>; toRemove: string[] };
  plugins: { toAdd: Array<{ name: string; gitUrl: string; ref: string }>; toRemove: string[] };
}

export function computeIntegrationsDiff(
  current: import('./scope-copilot-seeder.js').ScopeIntegrations,
  desired: Partial<import('./scope-copilot-seeder.js').ScopeIntegrations>,
): IntegrationsDiff {
  const desiredMcp = desired.mcpServers ?? [];
  const currentMcpIds = new Set(current.mcpServers.map(s => s.mcpServerId));
  const desiredMcpIds = new Set(desiredMcp.map(s => s.mcpServerId));

  const desiredDg = desired.documentGroups ?? [];
  const currentDgIds = new Set(current.documentGroups.map(d => d.documentGroupId));
  const desiredDgIds = new Set(desiredDg.map(d => d.documentGroupId));

  const desiredIm = desired.imChannels ?? [];
  const currentImIds = new Set(current.imChannels.map(ch => ch.id));
  const desiredImIds = new Set(desiredIm.filter(ch => ch.id).map(ch => ch.id));

  const desiredConn = desired.connectors ?? [];
  const currentConnIds = new Set(current.connectors.map(c => c.connectorId));
  const desiredConnIds = new Set(desiredConn.map(c => c.connectorId));

  const desiredPlug = desired.plugins ?? [];
  const currentPlugNames = new Set(current.plugins.map(p => p.name));
  const desiredPlugNames = new Set(desiredPlug.map(p => p.name));

  return {
    mcpServers: {
      toAdd: desiredMcp.filter(s => !currentMcpIds.has(s.mcpServerId)).map(s => ({ mcpServerId: s.mcpServerId, scopeConfig: s.scopeConfig ?? {} })),
      toRemove: current.mcpServers.filter(s => !desiredMcpIds.has(s.mcpServerId)).map(s => s.assignmentId),
    },
    documentGroups: {
      toAdd: desiredDg.filter(d => !currentDgIds.has(d.documentGroupId)).map(d => ({ documentGroupId: d.documentGroupId })),
      toRemove: current.documentGroups.filter(d => !desiredDgIds.has(d.documentGroupId)).map(d => d.assignmentId),
    },
    imChannels: {
      toAdd: desiredIm.filter(ch => !ch.id || !currentImIds.has(ch.id)).map(ch => ({
        channelType: ch.channelType, channelId: ch.channelId, channelName: ch.channelName, isEnabled: ch.isEnabled,
      })),
      toRemove: current.imChannels.filter(ch => !desiredImIds.has(ch.id)).map(ch => ch.id),
    },
    connectors: {
      toAdd: desiredConn.filter(c => !currentConnIds.has(c.connectorId)).map(c => ({ connectorId: c.connectorId, scopeConfig: c.scopeConfig ?? {} })),
      toRemove: current.connectors.filter(c => !desiredConnIds.has(c.connectorId)).map(c => c.connectorId),
    },
    plugins: {
      toAdd: desiredPlug.filter(p => !currentPlugNames.has(p.name)).map(p => ({ name: p.name, gitUrl: p.gitUrl, ref: p.ref })),
      toRemove: current.plugins.filter(p => !desiredPlugNames.has(p.name)).map(p => p.id),
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ubuntu/super-agent/backend && npx vitest run src/services/__tests__/scope-generator-integrations.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Add `GET /copilot/scope-integrations` endpoint**

In `backend/src/routes/scope-generator.routes.ts`, add after the existing `/copilot/scope-config` route (find it first by searching for `scope-config`):

```typescript
  /**
   * GET /api/scope-generator/copilot/scope-integrations
   * Read scope-integrations.json from the copilot workspace.
   */
  fastify.get<{
    Querystring: { scope_id: string };
  }>(
    '/copilot/scope-integrations',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { scope_id } = request.query;
      const orgId = request.user!.orgId;
      if (!scope_id) return reply.status(400).send({ error: 'scope_id is required' });

      const sessionId = computeScopeCopilotSessionId(scope_id);
      const copilotScope = await prisma.business_scopes.findFirst({
        where: { organization_id: orgId, name: 'Scope Copilot', scope_type: 'digital_twin', deleted_at: null },
      });
      if (!copilotScope) return reply.status(404).send({ error: 'Scope Copilot not found' });

      const cfgModule = await import('../config/index.js');
      const workspaceBase = cfgModule.config.claude?.workspaceBaseDir ?? '/tmp/workspaces';
      const filePath = join(workspaceBase, orgId, copilotScope.id, 'sessions', sessionId, 'scope-integrations.json');

      try {
        const content = await readFile(filePath, 'utf-8');
        return reply.send({ data: JSON.parse(content) });
      } catch {
        return reply.send({ data: null });
      }
    },
  );
```

- [ ] **Step 6: Extend `POST /save` to accept and apply integrations**

In the existing `/save` handler (line 344), extend the body type and add integration processing after `scopeGeneratorService.saveFullConfig()`:

Change the save handler to:

```typescript
  fastify.post<SaveBody>('/save', { preHandler: [authenticate] }, async (request: FastifyRequest<SaveBody>, reply: FastifyReply) => {
    const { scopeId, config, integrations } = request.body;
    const orgId = request.user!.orgId;

    if (!scopeId || !config?.scope || !config?.agents) {
      return reply.status(400).send({ error: 'scopeId and config (scope + agents) are required', code: 'INVALID_INPUT' });
    }

    try {
      const result = await scopeGeneratorService.saveFullConfig(scopeId, config, orgId);

      // Process integrations if provided
      let integrationsResult = null;
      if (integrations) {
        const { fetchScopeBindings, type ScopeIntegrations } = await import('../services/scope-copilot-seeder.js');
        const { computeIntegrationsDiff } = await import('../services/scope-generator.service.js');

        const current = await fetchScopeBindings(orgId, scopeId);
        const diff = computeIntegrationsDiff(current, integrations);
        integrationsResult = await applyIntegrationsDiff(orgId, scopeId, request.user!.id, diff);
      }

      return reply.status(200).send({ data: { ...result, integrations: integrationsResult } });
    } catch (error) {
      console.error('[scope-generator] Save error:', error);
      return reply.status(500).send({
        error: error instanceof Error ? error.message : 'Save failed',
        code: 'SAVE_ERROR',
      });
    }
  });
```

Also add the `applyIntegrationsDiff` helper function at the top of the route file (inside the plugin function, before the routes):

```typescript
  async function applyIntegrationsDiff(
    orgId: string,
    scopeId: string,
    userId: string,
    diff: import('../services/scope-generator.service.js').IntegrationsDiff,
  ) {
    const results = { added: 0, removed: 0, errors: [] as string[] };

    // MCP Servers
    for (const mcp of diff.mcpServers.toAdd) {
      try {
        await prisma.$executeRaw`
          INSERT INTO scope_mcp_servers (id, business_scope_id, mcp_server_id, assigned_by)
          VALUES (gen_random_uuid(), ${scopeId}::uuid, ${mcp.mcpServerId}::uuid, ${userId}::uuid)
          ON CONFLICT (business_scope_id, mcp_server_id) DO NOTHING
        `;
        results.added++;
      } catch (e) { results.errors.push(`MCP add ${mcp.mcpServerId}: ${e}`); }
    }
    for (const id of diff.mcpServers.toRemove) {
      try {
        await prisma.$executeRaw`DELETE FROM scope_mcp_servers WHERE id = ${id}::uuid`;
        results.removed++;
      } catch (e) { results.errors.push(`MCP remove ${id}: ${e}`); }
    }

    // Document Groups
    for (const dg of diff.documentGroups.toAdd) {
      try {
        await prisma.$executeRaw`
          INSERT INTO scope_document_groups (id, business_scope_id, document_group_id, assigned_by)
          VALUES (gen_random_uuid(), ${scopeId}::uuid, ${dg.documentGroupId}::uuid, ${userId}::uuid)
          ON CONFLICT (business_scope_id, document_group_id) DO NOTHING
        `;
        results.added++;
      } catch (e) { results.errors.push(`DocGroup add ${dg.documentGroupId}: ${e}`); }
    }
    for (const id of diff.documentGroups.toRemove) {
      try {
        await prisma.$executeRaw`DELETE FROM scope_document_groups WHERE id = ${id}::uuid`;
        results.removed++;
      } catch (e) { results.errors.push(`DocGroup remove ${id}: ${e}`); }
    }

    // IM Channels
    for (const ch of diff.imChannels.toAdd) {
      try {
        await prisma.im_channel_bindings.create({
          data: {
            organization_id: orgId,
            business_scope_id: scopeId,
            channel_type: ch.channelType,
            channel_id: ch.channelId,
            channel_name: ch.channelName,
            is_enabled: ch.isEnabled,
            created_by: userId,
            config: {},
          },
        });
        results.added++;
      } catch (e) { results.errors.push(`IM add ${ch.channelType}/${ch.channelId}: ${e}`); }
    }
    for (const id of diff.imChannels.toRemove) {
      try {
        await prisma.im_channel_bindings.delete({ where: { id } });
        results.removed++;
      } catch (e) { results.errors.push(`IM remove ${id}: ${e}`); }
    }

    // Data Connectors
    for (const conn of diff.connectors.toAdd) {
      try {
        await prisma.$executeRaw`
          INSERT INTO scope_data_connectors (id, business_scope_id, connector_id, scope_config, assigned_by)
          VALUES (gen_random_uuid(), ${scopeId}::uuid, ${conn.connectorId}::uuid, ${JSON.stringify(conn.scopeConfig)}::jsonb, ${userId}::uuid)
          ON CONFLICT (business_scope_id, connector_id) DO NOTHING
        `;
        results.added++;
      } catch (e) { results.errors.push(`Connector add ${conn.connectorId}: ${e}`); }
    }
    for (const id of diff.connectors.toRemove) {
      try {
        await prisma.$executeRaw`DELETE FROM scope_data_connectors WHERE business_scope_id = ${scopeId}::uuid AND connector_id = ${id}::uuid`;
        results.removed++;
      } catch (e) { results.errors.push(`Connector remove ${id}: ${e}`); }
    }

    // Plugins
    for (const plug of diff.plugins.toAdd) {
      try {
        await prisma.$executeRaw`
          INSERT INTO scope_plugins (id, business_scope_id, name, git_url, ref, assigned_by)
          VALUES (gen_random_uuid(), ${scopeId}::uuid, ${plug.name}, ${plug.gitUrl}, ${plug.ref}, ${userId}::uuid)
          ON CONFLICT (business_scope_id, name) DO UPDATE SET git_url = ${plug.gitUrl}, ref = ${plug.ref}
        `;
        results.added++;
      } catch (e) { results.errors.push(`Plugin add ${plug.name}: ${e}`); }
    }
    for (const id of diff.plugins.toRemove) {
      try {
        await prisma.$executeRaw`DELETE FROM scope_plugins WHERE id = ${id}::uuid`;
        results.removed++;
      } catch (e) { results.errors.push(`Plugin remove ${id}: ${e}`); }
    }

    // Bump scope config version to trigger workspace refresh
    await prisma.business_scopes.update({
      where: { id: scopeId },
      data: { config_version: { increment: 1 } },
    });

    return results;
  }
```

Update the `SaveBody` type to include `integrations`:

Find the `SaveBody` type definition and add `integrations` as optional. Search for `interface SaveBody` or the type definition near the top of the file.

```typescript
interface SaveBody {
  Body: {
    scopeId: string;
    config: GeneratedScopeConfig;
    integrations?: Partial<ScopeIntegrations>;
  };
}
```

- [ ] **Step 7: Run tests and verify**

Run: `cd /home/ubuntu/super-agent/backend && npx vitest run src/services/__tests__/scope-generator-integrations.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add backend/src/routes/scope-generator.routes.ts backend/src/services/scope-generator.service.ts backend/src/services/__tests__/scope-generator-integrations.test.ts
git commit -m "feat(scope-copilot): add integration read endpoint and diff-based save logic"
```

---

## Task 5: Frontend — Add Integration Types and API Calls

**Files:**
- Modify: `frontend/src/services/scopeGeneratorService.ts`
- Modify: `frontend/src/hooks/useScopeDraft.ts`

- [ ] **Step 1: Add integration types to `scopeGeneratorService.ts`**

Add after the existing `GeneratedScopeConfig` interface (around line 38):

```typescript
export interface ScopeIntegrations {
  mcpServers: Array<{
    assignmentId?: string;
    mcpServerId: string;
    name: string;
    scopeConfig: Record<string, unknown>;
  }>;
  documentGroups: Array<{
    assignmentId?: string;
    documentGroupId: string;
    name: string;
  }>;
  imChannels: Array<{
    id?: string;
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
    id?: string;
    name: string;
    gitUrl: string;
    ref: string;
  }>;
}

export const EMPTY_INTEGRATIONS: ScopeIntegrations = {
  mcpServers: [],
  documentGroups: [],
  imChannels: [],
  connectors: [],
  plugins: [],
};

export async function fetchScopeIntegrations(scopeId: string): Promise<ScopeIntegrations | null> {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE_URL}/api/scope-generator/copilot/scope-integrations?scope_id=${scopeId}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json.data ?? null;
}

export function parseIntegrations(text: string): ScopeIntegrations | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && ('mcpServers' in parsed || 'documentGroups' in parsed || 'imChannels' in parsed)) {
      return { ...EMPTY_INTEGRATIONS, ...parsed };
    }
    return null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Extend `useScopeDraft` with integrations state**

In `frontend/src/hooks/useScopeDraft.ts`:

Add import at the top:
```typescript
import type { ScopeIntegrations } from '@/services/scopeGeneratorService'
import { EMPTY_INTEGRATIONS } from '@/services/scopeGeneratorService'
```

Extend `ScopeDraft` interface:
```typescript
export interface ScopeDraft {
  scope: GeneratedScope
  agents: AgentDraft[]
  integrations: ScopeIntegrations
}
```

Update `EMPTY_SCOPE` usage — where the initial draft is `{ scope: EMPTY_SCOPE, agents: [] }`, add `integrations: EMPTY_INTEGRATIONS`:
```typescript
return stored ? stored.draft : { scope: EMPTY_SCOPE, agents: [], integrations: EMPTY_INTEGRATIONS }
```

Add `applyIntegrations` callback:
```typescript
  const applyIntegrations = useCallback((integrations: ScopeIntegrations) => {
    setDraft(prev => ({ ...prev, integrations }))
    setIsDirty(true)
  }, [])
```

Update the `save` function to include integrations in the POST body:
```typescript
body: JSON.stringify({
  scopeId,
  config: {
    scope: draft.scope,
    agents: draft.agents.map(a => ({
      ...(a.id ? { id: a.id } : {}),
      name: a.name,
      displayName: a.displayName,
      role: a.role,
      systemPrompt: a.systemPrompt,
      skills: a.skills,
      _deleted: a._deleted,
    })),
  },
  integrations: draft.integrations,
}),
```

Add `applyIntegrations` to the returned object.

- [ ] **Step 3: Run frontend type-check**

Run: `cd /home/ubuntu/super-agent/frontend && npx tsc --noEmit`
Expected: No errors (or only pre-existing ones)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/services/scopeGeneratorService.ts frontend/src/hooks/useScopeDraft.ts
git commit -m "feat(scope-copilot): add integration types, API, and draft state management"
```

---

## Task 6: Frontend — Create IntegrationWorkspace Component

**Files:**
- Create: `frontend/src/components/IntegrationWorkspace.tsx`
- Test: `frontend/src/components/__tests__/IntegrationWorkspace.test.tsx`

This component renders the integration config in a read/edit view similar to how agents are shown in ScopeWorkspace.

- [ ] **Step 1: Write a basic render test**

```tsx
// frontend/src/components/__tests__/IntegrationWorkspace.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { IntegrationWorkspace } from '../IntegrationWorkspace'
import { EMPTY_INTEGRATIONS } from '@/services/scopeGeneratorService'

describe('IntegrationWorkspace', () => {
  it('renders empty state when no integrations configured', () => {
    render(
      <IntegrationWorkspace
        integrations={EMPTY_INTEGRATIONS}
        onUpdate={vi.fn()}
      />
    )
    expect(screen.getByText(/no integrations/i)).toBeInTheDocument()
  })

  it('renders MCP servers section when servers present', () => {
    const integrations = {
      ...EMPTY_INTEGRATIONS,
      mcpServers: [{ mcpServerId: 'mcp-1', name: 'PostgreSQL Query', scopeConfig: {} }],
    }
    render(
      <IntegrationWorkspace
        integrations={integrations}
        onUpdate={vi.fn()}
      />
    )
    expect(screen.getByText('PostgreSQL Query')).toBeInTheDocument()
  })

  it('renders document groups', () => {
    const integrations = {
      ...EMPTY_INTEGRATIONS,
      documentGroups: [{ documentGroupId: 'dg-1', name: 'HR Policies' }],
    }
    render(
      <IntegrationWorkspace
        integrations={integrations}
        onUpdate={vi.fn()}
      />
    )
    expect(screen.getByText('HR Policies')).toBeInTheDocument()
  })

  it('renders IM channels with type badges', () => {
    const integrations = {
      ...EMPTY_INTEGRATIONS,
      imChannels: [{ channelType: 'slack', channelId: 'C123', channelName: '#general', isEnabled: true }],
    }
    render(
      <IntegrationWorkspace
        integrations={integrations}
        onUpdate={vi.fn()}
      />
    )
    expect(screen.getByText('#general')).toBeInTheDocument()
    expect(screen.getByText('slack')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/super-agent/frontend && npx vitest run src/components/__tests__/IntegrationWorkspace.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `IntegrationWorkspace`**

```tsx
// frontend/src/components/IntegrationWorkspace.tsx
import { Server, FileText, MessageSquare, Database, Plug, Trash2 } from 'lucide-react'
import type { ScopeIntegrations } from '@/services/scopeGeneratorService'

interface IntegrationWorkspaceProps {
  integrations: ScopeIntegrations
  onUpdate: (integrations: ScopeIntegrations) => void
}

function SectionHeader({ icon: Icon, title, count }: { icon: React.ElementType; title: string; count: number }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <Icon className="w-4 h-4 text-gray-400" />
      <span className="text-sm font-medium text-gray-300">{title}</span>
      <span className="text-xs text-gray-500">({count})</span>
    </div>
  )
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="opacity-0 group-hover:opacity-100 p-1 text-gray-500 hover:text-red-400 transition-all">
      <Trash2 className="w-3.5 h-3.5" />
    </button>
  )
}

export function IntegrationWorkspace({ integrations, onUpdate }: IntegrationWorkspaceProps) {
  const hasAny = integrations.mcpServers.length > 0
    || integrations.documentGroups.length > 0
    || integrations.imChannels.length > 0
    || integrations.connectors.length > 0
    || integrations.plugins.length > 0

  if (!hasAny) {
    return (
      <div className="rounded-xl border border-dashed border-gray-700 p-6 text-center">
        <p className="text-sm text-gray-500">No integrations configured yet.</p>
        <p className="text-xs text-gray-600 mt-1">Ask the copilot to recommend MCP servers, knowledge bases, or IM channels.</p>
      </div>
    )
  }

  function removeMcp(idx: number) {
    onUpdate({ ...integrations, mcpServers: integrations.mcpServers.filter((_, i) => i !== idx) })
  }
  function removeDocGroup(idx: number) {
    onUpdate({ ...integrations, documentGroups: integrations.documentGroups.filter((_, i) => i !== idx) })
  }
  function removeImChannel(idx: number) {
    onUpdate({ ...integrations, imChannels: integrations.imChannels.filter((_, i) => i !== idx) })
  }
  function removeConnector(idx: number) {
    onUpdate({ ...integrations, connectors: integrations.connectors.filter((_, i) => i !== idx) })
  }
  function removePlugin(idx: number) {
    onUpdate({ ...integrations, plugins: integrations.plugins.filter((_, i) => i !== idx) })
  }

  return (
    <div className="space-y-4">
      {integrations.mcpServers.length > 0 && (
        <div>
          <SectionHeader icon={Server} title="MCP Servers" count={integrations.mcpServers.length} />
          <div className="space-y-1.5">
            {integrations.mcpServers.map((s, i) => (
              <div key={s.mcpServerId} className="group flex items-center justify-between px-3 py-2 bg-gray-800/60 rounded-lg border border-gray-700/50">
                <div className="flex items-center gap-2">
                  <Server className="w-3.5 h-3.5 text-blue-400" />
                  <span className="text-sm text-gray-200">{s.name}</span>
                </div>
                <RemoveButton onClick={() => removeMcp(i)} />
              </div>
            ))}
          </div>
        </div>
      )}

      {integrations.documentGroups.length > 0 && (
        <div>
          <SectionHeader icon={FileText} title="Knowledge Base" count={integrations.documentGroups.length} />
          <div className="space-y-1.5">
            {integrations.documentGroups.map((g, i) => (
              <div key={g.documentGroupId} className="group flex items-center justify-between px-3 py-2 bg-gray-800/60 rounded-lg border border-gray-700/50">
                <div className="flex items-center gap-2">
                  <FileText className="w-3.5 h-3.5 text-green-400" />
                  <span className="text-sm text-gray-200">{g.name}</span>
                </div>
                <RemoveButton onClick={() => removeDocGroup(i)} />
              </div>
            ))}
          </div>
        </div>
      )}

      {integrations.imChannels.length > 0 && (
        <div>
          <SectionHeader icon={MessageSquare} title="IM Channels" count={integrations.imChannels.length} />
          <div className="space-y-1.5">
            {integrations.imChannels.map((ch, i) => (
              <div key={`${ch.channelType}-${ch.channelId}`} className="group flex items-center justify-between px-3 py-2 bg-gray-800/60 rounded-lg border border-gray-700/50">
                <div className="flex items-center gap-2">
                  <MessageSquare className="w-3.5 h-3.5 text-purple-400" />
                  <span className="text-xs px-1.5 py-0.5 rounded bg-gray-700 text-gray-300">{ch.channelType}</span>
                  <span className="text-sm text-gray-200">{ch.channelName ?? ch.channelId}</span>
                  {!ch.isEnabled && <span className="text-xs text-yellow-500">disabled</span>}
                </div>
                <RemoveButton onClick={() => removeImChannel(i)} />
              </div>
            ))}
          </div>
        </div>
      )}

      {integrations.connectors.length > 0 && (
        <div>
          <SectionHeader icon={Database} title="Data Connectors" count={integrations.connectors.length} />
          <div className="space-y-1.5">
            {integrations.connectors.map((c, i) => (
              <div key={c.connectorId} className="group flex items-center justify-between px-3 py-2 bg-gray-800/60 rounded-lg border border-gray-700/50">
                <div className="flex items-center gap-2">
                  <Database className="w-3.5 h-3.5 text-amber-400" />
                  <span className="text-sm text-gray-200">{c.displayName}</span>
                  <span className="text-xs text-gray-500">{c.connectorType}</span>
                </div>
                <RemoveButton onClick={() => removeConnector(i)} />
              </div>
            ))}
          </div>
        </div>
      )}

      {integrations.plugins.length > 0 && (
        <div>
          <SectionHeader icon={Plug} title="Plugins" count={integrations.plugins.length} />
          <div className="space-y-1.5">
            {integrations.plugins.map((p, i) => (
              <div key={p.name} className="group flex items-center justify-between px-3 py-2 bg-gray-800/60 rounded-lg border border-gray-700/50">
                <div className="flex items-center gap-2">
                  <Plug className="w-3.5 h-3.5 text-cyan-400" />
                  <span className="text-sm text-gray-200">{p.name}</span>
                  <span className="text-xs text-gray-500 truncate max-w-[200px]">{p.gitUrl}</span>
                </div>
                <RemoveButton onClick={() => removePlugin(i)} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/ubuntu/super-agent/frontend && npx vitest run src/components/__tests__/IntegrationWorkspace.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/IntegrationWorkspace.tsx frontend/src/components/__tests__/IntegrationWorkspace.test.tsx
git commit -m "feat(scope-copilot): add IntegrationWorkspace component for displaying integration config"
```

---

## Task 7: Frontend — Wire Integrations into ScopeWorkspace and ScopeCopilot

**Files:**
- Modify: `frontend/src/components/ScopeWorkspace.tsx`
- Modify: `frontend/src/components/ScopeCopilot.tsx`
- Modify: `frontend/src/pages/ScopeCopilotPage.tsx`

This task connects everything: the workspace shows integrations, the copilot detects integration file writes, and the page orchestrates the data flow.

- [ ] **Step 1: Add integrations tab to ScopeWorkspace**

In `frontend/src/components/ScopeWorkspace.tsx`, add import:
```typescript
import { IntegrationWorkspace } from './IntegrationWorkspace'
import type { ScopeIntegrations } from '@/services/scopeGeneratorService'
```

Extend `ScopeWorkspaceProps`:
```typescript
interface ScopeWorkspaceProps {
  // ...existing props...
  integrations: ScopeIntegrations
  onUpdateIntegrations: (integrations: ScopeIntegrations) => void
}
```

Add a tab-based view. Inside the component, add a `view` state:
```typescript
const [view, setView] = useState<'agents' | 'integrations'>('agents')
```

Add tab buttons below the ScopeOverviewCard and above the agent/integration content:
```tsx
<div className="flex gap-1 p-1 bg-gray-800/40 rounded-lg">
  <button
    onClick={() => setView('agents')}
    className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
      view === 'agents' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-300'
    }`}
  >
    Agents ({activeAgents.length})
  </button>
  <button
    onClick={() => setView('integrations')}
    className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
      view === 'integrations' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-300'
    }`}
  >
    Integrations
  </button>
</div>
```

Then conditionally render based on `view`:
```tsx
{view === 'agents' ? (
  /* existing agent grid + detail panel */
) : (
  <IntegrationWorkspace
    integrations={integrations}
    onUpdate={onUpdateIntegrations}
  />
)}
```

- [ ] **Step 2: Extend ScopeCopilot to detect `scope-integrations.json` writes**

In `frontend/src/components/ScopeCopilot.tsx`, add to props:
```typescript
interface ScopeCopilotProps {
  // ...existing props...
  onApplyIntegrations?: (integrations: ScopeIntegrations) => void
}
```

In the SSE processing loop where Write tool_use blocks are detected (search for `scope-config` in the component), add a parallel check for `scope-integrations`:

```typescript
// After the existing scope-config.json detection block:
if (toolInput.file_path?.includes('scope-integrations') && toolInput.content) {
  const parsed = parseIntegrations(toolInput.content)
  if (parsed && onApplyIntegrations) {
    onApplyIntegrations(parsed)
    onCreateSnapshot('AI updated integrations', 'ai-modified')
  }
}
```

Add the import at the top:
```typescript
import { parseScopeConfig, parseIntegrations, type GeneratedScopeConfig, type ScopeIntegrations } from '@/services/scopeGeneratorService'
```

- [ ] **Step 3: Wire everything in ScopeCopilotPage**

In `frontend/src/pages/ScopeCopilotPage.tsx`:

Pass new props down to ScopeWorkspace:
```tsx
<ScopeWorkspace
  // ...existing props...
  integrations={draft.integrations}
  onUpdateIntegrations={applyIntegrations}
/>
```

Pass new prop to ScopeCopilot:
```tsx
<ScopeCopilot
  // ...existing props...
  onApplyIntegrations={applyIntegrations}
/>
```

On page load, also fetch existing integrations from the workspace:
```typescript
// In the useEffect that loads scope data, add:
fetchScopeIntegrations(scopeId).then(data => {
  if (data) applyIntegrations(data)
})
```

Add the import:
```typescript
import { fetchScopeIntegrations } from '@/services/scopeGeneratorService'
```

- [ ] **Step 4: Run type check and dev server**

Run: `cd /home/ubuntu/super-agent/frontend && npx tsc --noEmit`
Expected: No new type errors.

Run: `cd /home/ubuntu/super-agent/frontend && npm run dev`
Test: Navigate to the Scope Copilot page, verify the Integrations tab appears and renders correctly.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ScopeWorkspace.tsx frontend/src/components/ScopeCopilot.tsx frontend/src/pages/ScopeCopilotPage.tsx
git commit -m "feat(scope-copilot): wire integration config into workspace and copilot UI"
```

---

## Task 8: End-to-End Manual Testing

**Files:** No new files — manual verification

Test the complete flow in the browser at `http://localhost:8080`.

- [ ] **Step 1: Start the dev environment**

Run: `docker compose up -d --build`
Wait for backend and frontend to be ready.

- [ ] **Step 2: Test scope generation with integrations**

1. Navigate to an existing scope's copilot page
2. Send a message like: "这个 scope 需要什么 MCP 工具和知识库？请帮我推荐"
3. Verify the copilot reads `catalogs/*.md` and recommends integrations
4. Verify the copilot writes `scope-integrations.json`
5. Verify the frontend auto-loads the integration config in the Integrations tab
6. Click Save and verify the integrations are persisted to the database

- [ ] **Step 3: Test integration editing**

1. In the Integrations tab, remove an MCP server by clicking the trash icon
2. Verify the item disappears and the draft becomes dirty
3. Click Save and verify the removal is persisted
4. Refresh the page and verify the removed integration is gone

- [ ] **Step 4: Test with empty scope**

1. Create a new empty scope
2. Open the copilot and describe a business
3. Verify the copilot generates both `scope-config.json` (agents) and `scope-integrations.json` (integrations)
4. Save and verify both are persisted

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix(scope-copilot): address integration e2e issues"
```

---

## Task 9: Upgrade Existing Scope Copilots

**Files:**
- Modify: `backend/src/services/seed-copilot.service.ts`

Existing organizations already have a scope copilot with the old system prompt. We need to upgrade them.

- [ ] **Step 1: Add a targeted upgrade for scope-copilot system prompt**

In `backend/src/services/seed-copilot.service.ts`, in the `upgradeSeedCopilots` method, add logic to detect if the scope-copilot agent's system prompt is missing the `# Integration Management` section and update it:

```typescript
// After existing upgrade logic:
const scopeCopilotAgent = await prisma.agents.findFirst({
  where: {
    organization_id: organizationId,
    name: 'scope-copilot',
    origin: 'system_seed',
  },
});

if (scopeCopilotAgent && !scopeCopilotAgent.system_prompt?.includes('# Integration Management')) {
  const seedData = JSON.parse(
    await readFile(join(__dirname, '../../seeds/system-copilots/scope-copilot.json'), 'utf-8')
  );
  await prisma.agents.update({
    where: { id: scopeCopilotAgent.id },
    data: { system_prompt: seedData.agent.systemPrompt },
  });
  console.log(`[seed-copilot] Upgraded scope-copilot system prompt for org ${organizationId}`);
}
```

- [ ] **Step 2: Test the upgrade**

Run the dev server and trigger the seed upgrade:
```bash
curl -X POST http://localhost:3000/api/organizations/seed-check \
  -H "Authorization: Bearer <your-token>"
```

Verify in the database that the scope-copilot agent's system_prompt now includes the integration management section.

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/seed-copilot.service.ts
git commit -m "feat(scope-copilot): auto-upgrade existing scope-copilot prompts with integration management"
```
