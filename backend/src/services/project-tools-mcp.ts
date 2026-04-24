/**
 * Project Tools MCP Server Factory
 *
 * Creates an in-process MCP server that exposes project tools (board status,
 * issue details, context files, etc.) to Claude via the MCP protocol.
 * The returned config can be merged into the mcpServers map passed to the
 * agent runtime, so twins sessions get project-aware tooling automatically.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeProjectTool, type ProjectToolContext } from './project-tools.js';
import type { MCPServerInProcessConfig } from './claude-agent.service.js';
import { z } from 'zod';

export function createProjectToolsMcpServer(
  ctx: ProjectToolContext,
): MCPServerInProcessConfig {
  const server = new McpServer({ name: 'project-tools', version: '1.0.0' });

  // ── get_board_status ────────────────────────────────────────────────────
  server.tool(
    'get_board_status',
    'Get the current status of all issues on the project board. Returns issue number, title, status, priority, effort, and labels.',
    {},
    async () => {
      const result = await executeProjectTool('get_board_status', {}, ctx);
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  // ── get_issue_detail ────────────────────────────────────────────────────
  server.tool(
    'get_issue_detail',
    'Get full details of a specific issue including description, acceptance criteria, comments, sub-tasks, and relations.',
    { issue_number: z.number().describe('The issue number to look up') },
    async ({ issue_number }) => {
      const result = await executeProjectTool('get_issue_detail', { issue_number }, ctx);
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  // ── read_project_context ────────────────────────────────────────────────
  server.tool(
    'read_project_context',
    'List all summary/context files in the project workspace context/ directory.',
    {},
    async () => {
      const result = await executeProjectTool('read_project_context', {}, ctx);
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  // ── read_context_file ───────────────────────────────────────────────────
  server.tool(
    'read_context_file',
    'Read the full content of a specific context file from the project workspace.',
    { filename: z.string().describe('Name of the file in the context/ directory') },
    async ({ filename }) => {
      const result = await executeProjectTool('read_context_file', { filename }, ctx);
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  // ── suggest_action ──────────────────────────────────────────────────────
  server.tool(
    'suggest_action',
    'Suggest a project board action for the user to confirm. The action will NOT be executed automatically. Supported: create_issue, update_issue, add_comment, change_status.',
    {
      action_type: z.enum(['create_issue', 'update_issue', 'add_comment', 'change_status']),
      payload: z.record(z.string(), z.unknown()).describe('Action-specific payload'),
      reason: z.string().describe('Why you are suggesting this action'),
    },
    async ({ action_type, payload, reason }) => {
      const result = await executeProjectTool('suggest_action', { action_type, payload, reason }, ctx);
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  // ── summarize_to_project ────────────────────────────────────────────────
  server.tool(
    'summarize_to_project',
    'Write a summary of the current discussion to the project workspace so other team members can access it.',
    {
      title: z.string().describe('Short title for the summary file'),
      content: z.string().describe('Markdown content of the summary'),
    },
    async ({ title, content }) => {
      const result = await executeProjectTool('summarize_to_project', { title, content }, ctx);
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  return { type: 'sdk', name: 'project-tools', instance: server };
}
