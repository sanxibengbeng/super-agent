/**
 * Scope Generator Routes
 * AI-powered business scope generation using Claude Agent SDK.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { scopeGeneratorService, type GeneratedScopeConfig } from '../services/scope-generator.service.js';
import { businessScopeService } from '../services/businessScope.service.js';
import { agentService } from '../services/agent.service.js';
import { skillService } from '../services/skill.service.js';
import { avatarService } from '../services/avatarService.js';
import { authenticate } from '../middleware/auth.js';
import type { ConversationEvent } from '../services/claude-agent.service.js';
import { chatService } from '../services/chat.service.js';
import { prisma } from '../config/database.js';
import { computeScopeCopilotSessionId } from '../utils/deterministic-session.js';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

function formatSSEEvent(payload: { event?: string; data: string }): string {
  let result = '';
  if (payload.event) result += `event: ${payload.event}\n`;
  result += `data: ${payload.data}\n\n`;
  return result;
}

interface GenerateBody {
  Body: { description: string; language?: string };
}

interface ConfirmBody {
  Body: {
    config: GeneratedScopeConfig;
    isDefault?: boolean;
  };
}

interface SaveBody {
  Body: {
    scopeId: string;
    config: GeneratedScopeConfig;
  };
}

interface ModifyBody {
  Body: {
    scopeConfig: GeneratedScopeConfig;
    modificationRequest: string;
    history?: Array<{ role: 'user' | 'assistant'; content: string }>;
    language?: string;
  };
}

export async function scopeGeneratorRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /api/business-scopes/generate
   * Stream AI-generated scope configuration via SSE.
   */
  fastify.post<GenerateBody>('/generate', { preHandler: [authenticate] }, async (request: FastifyRequest<GenerateBody>, reply: FastifyReply) => {
    const { description, language } = request.body;
    if (!description || description.trim().length === 0) {
      return reply.status(400).send({ error: 'Business description is required', code: 'MISSING_DESCRIPTION' });
    }

    // Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });

    let clientDisconnected = false;
    reply.raw.on('close', () => { clientDisconnected = true; });

    const heartbeat = setInterval(() => {
      if (!clientDisconnected) {
        try { reply.raw.write(formatSSEEvent({ data: JSON.stringify({ type: 'heartbeat' }) })); }
        catch { /* disconnected */ }
      }
    }, 15_000);

    try {
      const generator = scopeGeneratorService.generate(description.trim(), undefined, language);

      for await (const event of generator) {
        if (clientDisconnected) break;

        // Forward conversation events as SSE
        const sseData: Record<string, unknown> = { type: event.type };

        if (event.type === 'session_start') {
          sseData.sessionId = event.sessionId;
        } else if (event.type === 'assistant' || event.type === 'result') {
          sseData.content = (event as ConversationEvent & { content?: unknown }).content;
        } else if ((event as unknown as Record<string, unknown>).type === 'scope_config') {
          sseData.content = (event as unknown as Record<string, unknown>).content;
        } else if (event.type === 'error') {
          sseData.code = (event as ConversationEvent & { code?: string }).code;
          sseData.message = (event as ConversationEvent & { message?: string }).message;
        }

        reply.raw.write(formatSSEEvent({ data: JSON.stringify(sseData) }));
      }
    } catch (error) {
      console.error('[scope-generator] SSE stream error:', error);
      if (!clientDisconnected) {
        reply.raw.write(formatSSEEvent({
          data: JSON.stringify({
            type: 'error',
            code: 'GENERATION_ERROR',
            message: error instanceof Error ? error.message : 'Generation failed',
          }),
        }));
      }
    } finally {
      clearInterval(heartbeat);
      if (!clientDisconnected) {
        try {
          reply.raw.write(formatSSEEvent({ data: '[DONE]' }));
          reply.raw.end();
        } catch { /* disconnected */ }
      }
    }
  });

  /**
   * POST /api/scope-generator/generate-with-document
   * Upload a SOP document and stream AI-generated scope configuration via SSE.
   * The document is placed in the agent's workspace so the agent can read/parse it autonomously.
   */
  fastify.post('/generate-with-document', { preHandler: [authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: 'No file uploaded', code: 'MISSING_FILE' });
    }

    // Collect the file buffer
    const chunks: Buffer[] = [];
    for await (const chunk of data.file) {
      chunks.push(chunk);
    }
    const fileBuffer = Buffer.concat(chunks);

    // Extract the description field from multipart fields
    const descriptionField = data.fields?.description;
    let description = '';
    if (descriptionField && 'value' in descriptionField) {
      description = (descriptionField as { value: string }).value;
    }
    if (!description.trim()) {
      description = `Create a business scope based on the uploaded SOP document.`;
    }

    // Extract the language field from multipart fields
    const languageField = data.fields?.language;
    let language: string | undefined;
    if (languageField && 'value' in languageField) {
      language = (languageField as { value: string }).value;
    }

    // Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });

    let clientDisconnected = false;
    reply.raw.on('close', () => { clientDisconnected = true; });

    const heartbeat = setInterval(() => {
      if (!clientDisconnected) {
        try { reply.raw.write(formatSSEEvent({ data: JSON.stringify({ type: 'heartbeat' }) })); }
        catch { /* disconnected */ }
      }
    }, 15_000);

    try {
      const generator = scopeGeneratorService.generate(description.trim(), {
        buffer: fileBuffer,
        fileName: data.filename || 'document',
      }, language);

      for await (const event of generator) {
        if (clientDisconnected) break;

        const sseData: Record<string, unknown> = { type: event.type };

        if (event.type === 'session_start') {
          sseData.sessionId = event.sessionId;
        } else if (event.type === 'assistant' || event.type === 'result') {
          sseData.content = (event as ConversationEvent & { content?: unknown }).content;
        } else if ((event as unknown as Record<string, unknown>).type === 'scope_config') {
          sseData.content = (event as unknown as Record<string, unknown>).content;
        } else if (event.type === 'error') {
          sseData.code = (event as ConversationEvent & { code?: string }).code;
          sseData.message = (event as ConversationEvent & { message?: string }).message;
        }

        reply.raw.write(formatSSEEvent({ data: JSON.stringify(sseData) }));
      }
    } catch (error) {
      console.error('[scope-generator] Document SSE stream error:', error);
      if (!clientDisconnected) {
        reply.raw.write(formatSSEEvent({
          data: JSON.stringify({
            type: 'error',
            code: 'GENERATION_ERROR',
            message: error instanceof Error ? error.message : 'Generation failed',
          }),
        }));
      }
    } finally {
      clearInterval(heartbeat);
      if (!clientDisconnected) {
        try {
          reply.raw.write(formatSSEEvent({ data: '[DONE]' }));
          reply.raw.end();
        } catch { /* disconnected */ }
      }
    }
  });

  /**
   * POST /api/business-scopes/generate/confirm
   * Create scope + agents from the generated configuration.
   */
  fastify.post<ConfirmBody>('/generate/confirm', { preHandler: [authenticate] }, async (request: FastifyRequest<ConfirmBody>, reply: FastifyReply) => {
    const { config, isDefault } = request.body;
    const orgId = request.user!.orgId;

    if (!config?.scope || !config?.agents || !Array.isArray(config.agents)) {
      return reply.status(400).send({ error: 'Invalid config: scope and agents are required', code: 'INVALID_CONFIG' });
    }

    // 1. Create the business scope
    const scope = await businessScopeService.createBusinessScope({
      name: config.scope.name,
      description: config.scope.description,
      icon: config.scope.icon,
      color: config.scope.color,
      is_default: isDefault ?? false,
      scope_type: 'business',
    }, orgId);

    // 2. Create agents (with generated skills stored in model_config)
    const createdAgents = [];
    for (const agentDef of config.agents) {
      try {
        const agent = await agentService.createAgent({
          name: agentDef.name,
          display_name: agentDef.displayName,
          role: agentDef.role,
          business_scope_id: scope.id,
          system_prompt: agentDef.systemPrompt,
          status: 'active',
          metrics: {},
          tools: [],
          scope: [],
          model_config: {
            generatedSkills: (agentDef.skills ?? []).map(s => ({
              name: s.name,
              description: s.description,
              body: s.body,
            })),
          },
          origin: 'scope_generation',
          is_shared: false,
        }, orgId);

        // 3. Create skill records and assign them to the agent
        const agentSkills = agentDef.skills ?? [];
        for (const skillDef of agentSkills) {
          try {
            const skill = await skillService.createSkill(orgId, {
              name: skillDef.name,
              display_name: skillDef.name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
              description: skillDef.description,
              metadata: { body: skillDef.body, generatedBy: 'scope-generator' },
            });
            await skillService.assignSkillToAgent(orgId, agent.id, skill.id);
          } catch (skillErr) {
            console.warn(`Failed to create/assign skill "${skillDef.name}" for agent "${agentDef.name}":`, skillErr);
          }
        }

        createdAgents.push({
          id: agent.id,
          name: agent.name,
          displayName: agent.display_name,
          role: agent.role,
          avatar: null as string | null,
        });
      } catch (err) {
        console.warn(`Failed to create agent "${agentDef.name}":`, err);
      }
    }

    // 4. Generate avatars in parallel and update agents
    try {
      const rolesToGenerate = createdAgents
        .map(a => a.displayName || a.role)
        .filter((role): role is string => role != null);
      const avatarResults = await avatarService.generateAvatarsBatch(rolesToGenerate);

      for (let i = 0; i < createdAgents.length; i++) {
        const result = avatarResults[i];
        const createdAgent = createdAgents[i];
        if (result?.avatarKey && createdAgent) {
          try {
            await agentService.updateAgent(createdAgent.id, { avatar: result.avatarKey }, orgId);
            createdAgent.avatar = result.avatarKey;
          } catch (err) {
            console.warn(`Failed to update avatar for agent "${createdAgent.name}":`, err);
          }
        }
      }
    } catch (err) {
      console.warn('Avatar batch generation failed (non-fatal):', err);
    }

    return reply.status(201).send({
      data: {
        scope: {
          id: scope.id,
          name: scope.name,
          description: scope.description,
          icon: scope.icon,
          color: scope.color,
        },
        agents: createdAgents,
      },
    });
  });

  /**
   * POST /api/scope-generator/save
   * Save the full scope + agents + skills configuration to the database.
   */
  fastify.post<SaveBody>('/save', { preHandler: [authenticate] }, async (request: FastifyRequest<SaveBody>, reply: FastifyReply) => {
    const { scopeId, config } = request.body;
    const orgId = request.user!.orgId;

    if (!scopeId || !config?.scope || !config?.agents) {
      return reply.status(400).send({ error: 'scopeId and config (scope + agents) are required', code: 'INVALID_INPUT' });
    }

    try {
      const result = await scopeGeneratorService.saveFullConfig(scopeId, config, orgId);
      return reply.status(200).send({ data: result });
    } catch (error) {
      console.error('[scope-generator] Save error:', error);
      return reply.status(500).send({
        error: error instanceof Error ? error.message : 'Save failed',
        code: 'SAVE_ERROR',
      });
    }
  });

  /**
   * POST /api/scope-generator/modify
   * Modify an existing scope configuration via AI agent.
   * Streams SSE responses with either JSON patch or full config.
   */
  fastify.post<ModifyBody>('/modify', { preHandler: [authenticate] }, async (request: FastifyRequest<ModifyBody>, reply: FastifyReply) => {
    const { scopeConfig, modificationRequest, history, language } = request.body;

    if (!scopeConfig || !modificationRequest?.trim()) {
      return reply.status(400).send({ error: 'scopeConfig and modificationRequest are required', code: 'INVALID_INPUT' });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });

    let clientDisconnected = false;
    reply.raw.on('close', () => { clientDisconnected = true; });

    const heartbeat = setInterval(() => {
      if (!clientDisconnected) {
        try { reply.raw.write(formatSSEEvent({ data: JSON.stringify({ type: 'heartbeat' }) })); }
        catch { /* disconnected */ }
      }
    }, 15_000);

    try {
      const generator = scopeGeneratorService.modify(scopeConfig, modificationRequest.trim(), history, language);

      for await (const event of generator) {
        if (clientDisconnected) break;

        const sseData: Record<string, unknown> = { type: event.type };

        if (event.type === 'session_start') {
          sseData.sessionId = event.sessionId;
        } else if (event.type === 'assistant' || event.type === 'result') {
          sseData.content = event.content;
        } else if (event.type === 'error') {
          sseData.code = (event as ConversationEvent & { code?: string }).code;
          sseData.message = (event as ConversationEvent & { message?: string }).message;
        }

        reply.raw.write(formatSSEEvent({ data: JSON.stringify(sseData) }));
      }
    } catch (error) {
      console.error('[scope-generator] Modify SSE error:', error);
      if (!clientDisconnected) {
        reply.raw.write(formatSSEEvent({
          data: JSON.stringify({
            type: 'error',
            code: 'MODIFY_ERROR',
            message: error instanceof Error ? error.message : 'Modification failed',
          }),
        }));
      }
    } finally {
      clearInterval(heartbeat);
      if (!clientDisconnected) {
        try {
          reply.raw.write(formatSSEEvent({ data: '[DONE]' }));
          reply.raw.end();
        } catch { /* disconnected */ }
      }
    }
  });

  // ==========================================================================
  // Digital Twin Generation
  // ==========================================================================

  /**
   * POST /api/scope-generator/generate-twin
   * Upload documents and stream AI-generated digital twin configuration via SSE.
   */
  fastify.post('/generate-twin', { preHandler: [authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    // Try multipart first (when file is attached), fall back to JSON body
    let displayName = 'Digital Twin';
    let role = '';
    let description = '';
    let documents: Array<{ buffer: Buffer; fileName: string }> | undefined;

    try {
      const data = await request.file();
      if (data) {
        const fields = data.fields ?? {};
        displayName = (fields.displayName as { value: string } | undefined)?.value ?? displayName;
        role = (fields.role as { value: string } | undefined)?.value ?? role;
        description = (fields.description as { value: string } | undefined)?.value ?? description;

        if (data.file) {
          const chunks: Buffer[] = [];
          for await (const chunk of data.file) chunks.push(chunk);
          documents = [{ buffer: Buffer.concat(chunks), fileName: data.filename || 'document' }];
        }
      }
    } catch {
      // Not multipart — try JSON body
      const body = request.body as Record<string, string> | undefined;
      if (body) {
        displayName = body.displayName ?? displayName;
        role = body.role ?? role;
        description = body.description ?? description;
      }
    }

    // Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });

    let clientDisconnected = false;
    reply.raw.on('close', () => { clientDisconnected = true; });

    const heartbeat = setInterval(() => {
      if (!clientDisconnected) {
        try { reply.raw.write(formatSSEEvent({ data: JSON.stringify({ type: 'heartbeat' }) })); }
        catch { /* disconnected */ }
      }
    }, 15_000);

    try {
      const generator = scopeGeneratorService.generateTwin(
        { displayName, role, description },
        documents,
      );

      for await (const event of generator) {
        if (clientDisconnected) break;
        const sseData: Record<string, unknown> = { type: event.type };
        if (event.type === 'session_start') sseData.sessionId = event.sessionId;
        else if (event.type === 'assistant' || event.type === 'result') sseData.content = (event as ConversationEvent & { content?: unknown }).content;
        else if ((event as unknown as Record<string, unknown>).type === 'scope_config') sseData.content = (event as unknown as Record<string, unknown>).content;
        else if (event.type === 'error') { sseData.code = (event as ConversationEvent & { code?: string }).code; sseData.message = (event as ConversationEvent & { message?: string }).message; }
        reply.raw.write(formatSSEEvent({ data: JSON.stringify(sseData) }));
      }
    } catch (error) {
      if (!clientDisconnected) {
        reply.raw.write(formatSSEEvent({ data: JSON.stringify({ type: 'error', code: 'GENERATION_ERROR', message: error instanceof Error ? error.message : 'Generation failed' }) }));
      }
    } finally {
      clearInterval(heartbeat);
      if (!clientDisconnected) {
        try { reply.raw.write(formatSSEEvent({ data: '[DONE]' })); reply.raw.end(); } catch { /* disconnected */ }
      }
    }
  });

  /**
   * POST /api/scope-generator/generate-twin/confirm
   * Create digital twin scope + skills from the generated configuration.
   */
  fastify.post<{ Body: { config: { scope: { name: string; description: string; icon: string; color: string }; systemPrompt: string; skills: Array<{ name: string; description: string; body: string }> }; avatar?: string; documentGroupId?: string } }>(
    '/generate-twin/confirm',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { config, avatar, documentGroupId } = request.body;
      const orgId = request.user!.orgId;

      if (!config?.scope || !config?.systemPrompt) {
        return reply.status(400).send({ error: 'Invalid config: scope and systemPrompt are required', code: 'INVALID_CONFIG' });
      }

      // 1. Create the digital twin scope
      const scope = await businessScopeService.createBusinessScope({
        name: config.scope.name,
        description: config.scope.description,
        icon: config.scope.icon,
        color: config.scope.color,
        is_default: false,
        scope_type: 'digital_twin',
        avatar: avatar ?? null,
        system_prompt: config.systemPrompt,
      }, orgId);

      // 2. Create scope-level skills
      const createdSkills = [];
      for (const skillDef of config.skills ?? []) {
        try {
          const skill = await skillService.createScopeLevelSkill(orgId, scope.id, {
            name: skillDef.name,
            display_name: skillDef.name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            description: skillDef.description,
            metadata: { body: skillDef.body, generatedBy: 'twin-generator' },
          });
          createdSkills.push({ id: skill.id, name: skill.name });
        } catch (err) {
          console.warn(`Failed to create skill "${skillDef.name}":`, err);
        }
      }

      // 3. Link document group if provided
      if (documentGroupId) {
        try {
          const { documentGroupRepository } = await import('../repositories/document-group.repository.js');
          await documentGroupRepository.assignToScope(orgId, scope.id, documentGroupId);
        } catch (err) {
          console.warn('Failed to link document group:', err);
        }
      }

      return reply.status(201).send({
        data: {
          scope: { id: scope.id, name: scope.name, description: scope.description },
          skills: createdSkills,
        },
      });
    },
  );

  /**
   * POST /api/scope-generator/copilot/stream
   * Stream scope copilot conversation through chatService (persistent sessions).
   */
  fastify.post<{
    Body: { scope_id: string; message: string };
  }>(
    '/copilot/stream',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { scope_id, message } = request.body;
      const orgId = request.user!.orgId;
      const userId = request.user!.id;

      if (!scope_id || !message?.trim()) {
        return reply.status(400).send({ error: 'scope_id and message are required' });
      }

      const sessionId = computeScopeCopilotSessionId(scope_id);

      const copilotScope = await prisma.business_scopes.findFirst({
        where: { organization_id: orgId, name: 'Scope Copilot', scope_type: 'digital_twin', deleted_at: null },
        include: { agents: { where: { name: 'scope-copilot' } } },
      });

      if (!copilotScope || copilotScope.agents.length === 0) {
        return reply.status(404).send({ error: 'Scope Copilot not configured for this organization' });
      }

      // Write current scope config into workspace CLAUDE.md for copilot context
      const targetScope = await prisma.business_scopes.findFirst({
        where: { id: scope_id, organization_id: orgId, deleted_at: null },
      });
      const targetAgents = targetScope
        ? await prisma.agents.findMany({
            where: { business_scope_id: scope_id, organization_id: orgId },
            select: { name: true, display_name: true, role: true, system_prompt: true },
          })
        : [];
      if (targetScope) {
        const cfgModule = await import('../config/index.js');
        const workspaceBase = cfgModule.config.claude?.workspaceBaseDir ?? '/tmp/workspaces';
        const workspacePath = join(workspaceBase, orgId, copilotScope.id, 'sessions', sessionId);
        await mkdir(workspacePath, { recursive: true });
        const hasAgents = targetAgents.length > 0;
        const claudeLines: string[] = [
          `# Scope: ${targetScope.name}`,
          `Description: ${targetScope.description ?? 'Not set'}`,
          '',
        ];
        if (hasAgents) {
          claudeLines.push('## Current Configuration', '```json');
          claudeLines.push(JSON.stringify({
            scope: { name: targetScope.name, description: targetScope.description, icon: targetScope.icon, color: targetScope.color },
            agents: targetAgents.map((a: { name: string; display_name: string; role: string | null; system_prompt: string | null }) => ({
              name: a.name, displayName: a.display_name, role: a.role, systemPrompt: a.system_prompt,
            })),
          }, null, 2));
          claudeLines.push('```');
        } else {
          claudeLines.push('## Status: Empty scope — generate from scratch');
        }
        await writeFile(join(workspacePath, 'CLAUDE.md'), claudeLines.join('\n'));
      }

      await chatService.streamChat(reply, orgId, userId, {
        sessionId,
        businessScopeId: copilotScope.id,
        agentId: copilotScope.agents[0]!.id,
        message: message.trim(),
        source: 'scope_copilot',
        context: { scope_id },
      });
    },
  );

  /**
   * GET /api/scope-generator/copilot/messages
   * Load scope copilot chat history for a scope.
   */
  fastify.get<{
    Querystring: { scope_id: string };
  }>(
    '/copilot/messages',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { scope_id } = request.query;
      const orgId = request.user!.orgId;

      if (!scope_id) {
        return reply.status(400).send({ error: 'scope_id is required' });
      }

      const sessionId = computeScopeCopilotSessionId(scope_id);
      const messages = await chatService.getChatHistory(orgId, { sessionId, limit: 200 });

      return reply.send({ session_id: sessionId, messages: messages ?? [] });
    },
  );

  /**
   * POST /api/scope-generator/copilot/upload-document
   * Upload a SOP document to the scope copilot workspace before starting chat.
   */
  fastify.post(
    '/copilot/upload-document',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const data = await request.file();
      if (!data) return reply.status(400).send({ error: 'No file uploaded' });

      const scopeId = (data.fields.scope_id as { value: string } | undefined)?.value;
      if (!scopeId) return reply.status(400).send({ error: 'scope_id required' });

      const orgId = request.user!.orgId;
      const sessionId = computeScopeCopilotSessionId(scopeId);

      const copilotScope = await prisma.business_scopes.findFirst({
        where: { organization_id: orgId, name: 'Scope Copilot', scope_type: 'digital_twin', deleted_at: null },
      });
      if (!copilotScope) return reply.status(404).send({ error: 'Scope Copilot not configured' });

      const config = await import('../config/index.js');
      const workspaceBase = config.config.claude?.workspaceBaseDir ?? '/tmp/workspaces';
      const workspacePath = join(workspaceBase, orgId, copilotScope.id, 'sessions', sessionId);
      await mkdir(workspacePath, { recursive: true });

      const chunks: Buffer[] = [];
      for await (const chunk of data.file) chunks.push(chunk);
      const fileBuffer = Buffer.concat(chunks);
      await writeFile(join(workspacePath, data.filename || 'document'), fileBuffer);

      return reply.send({ uploaded: true, filename: data.filename });
    },
  );
}
