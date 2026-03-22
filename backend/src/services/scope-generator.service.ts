/**
 * Scope Generator Service
 *
 * Uses the Claude Agent SDK to generate a business scope + agents
 * from a free-text business description.
 */

import { agentRuntime } from './agent-runtime-factory.js';
import type { AgentConfig, ConversationEvent } from './agent-runtime.js';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GeneratedScope {
  name: string;
  description: string;
  icon: string;
  color: string;
}

export interface GeneratedSkill {
  name: string;
  description: string;
  body: string;
}

export interface GeneratedAgent {
  name: string;
  displayName: string;
  role: string;
  systemPrompt: string;
  skills: GeneratedSkill[];
}

export interface GeneratedScopeConfig {
  scope: GeneratedScope;
  agents: GeneratedAgent[];
}

// ---------------------------------------------------------------------------
// System prompt for scope generation
// ---------------------------------------------------------------------------

const SCOPE_GENERATOR_SYSTEM_PROMPT = `You are a business scope architect for an AI agent platform. Your job is to analyze a business description and generate a structured scope configuration with specialized AI agents, each equipped with domain-specific skills.

IMPORTANT: You must respond with ONLY a valid JSON object. No markdown, no code fences, no explanation text before or after. Just the raw JSON.

The JSON must follow this exact schema:
{
  "scope": {
    "name": "string (short, 2-4 words)",
    "description": "string (1-2 sentences describing the scope)",
    "icon": "string (single emoji that represents the business)",
    "color": "string (hex color code like #3B82F6)"
  },
  "agents": [
    {
      "name": "string (kebab-case identifier, e.g. customer-support)",
      "displayName": "string (human-readable name)",
      "role": "string (brief role description, 5-10 words)",
      "systemPrompt": "string (detailed system prompt for the agent, 2-4 paragraphs)",
      "skills": [
        {
          "name": "string (kebab-case skill name, e.g. ticket-triage)",
          "description": "string (1-2 sentences: what the skill does and when to use it)",
          "body": "string (markdown instructions for the agent when using this skill, 5-20 lines)"
        }
      ]
    }
  ]
}

Guidelines:
- Generate 3-6 agents depending on business complexity
- Each agent should have a distinct, non-overlapping responsibility
- Agent names should be kebab-case (e.g. "hr-assistant", "sales-ops")
- System prompts should be detailed and specific to the agent's role
- System prompts should define the agent's personality, expertise, constraints, and output format
- Choose an icon emoji that best represents the overall business
- Choose a color that feels appropriate for the business domain
- The scope name should be concise but descriptive

Skill guidelines:
- Generate 1-3 skills per agent based on their core responsibilities
- Each skill should represent a distinct, reusable workflow or domain expertise
- Skill names should be kebab-case and action-oriented (e.g. "analyze-risk", "draft-response")
- The description is the primary trigger — be specific about what the skill does and when to use it
- The body should contain concise, actionable instructions (not verbose explanations)
- Prefer examples and step-by-step procedures over general descriptions
- Skills should encode domain knowledge the agent wouldn't inherently have

Remember: Output ONLY the JSON object. Nothing else.`;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ScopeGeneratorService {
  /**
   * Generate a scope configuration by streaming Claude's response.
   * Yields ConversationEvents that can be forwarded as SSE.
   */
  async *generate(businessDescription: string): AsyncGenerator<ConversationEvent> {
      const agentConfig: AgentConfig = {
        id: 'scope-generator',
        name: 'scope-generator',
        displayName: 'Scope Generator',
        organizationId: 'system',
        systemPrompt: SCOPE_GENERATOR_SYSTEM_PROMPT,
        skillIds: [],
        mcpServerIds: [],
      };

      const message = `Analyze this business and generate a scope configuration with specialized AI agents:\n\n${businessDescription}`;

      // Create a fresh temp workspace for each generation to avoid stale state
      const tempWorkspace = await mkdtemp(join(tmpdir(), 'scope-gen-'));

      try {
        yield* agentRuntime.runConversation(
          {
            agentId: 'scope-generator',
            message,
            organizationId: 'system',
            userId: 'system',
            workspacePath: tempWorkspace,
          },
          agentConfig,
          [], // no skills needed for generation
        );
      } finally {
        // Clean up temp workspace
        rm(tempWorkspace, { recursive: true, force: true }).catch(() => {});
      }
    }

  /**
   * Parse the generated JSON from Claude's response content blocks.
   */
  parseGeneratedConfig(contentBlocks: Array<{ type: string; text?: string }>): GeneratedScopeConfig {
    // Concatenate all text blocks
    const fullText = contentBlocks
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text!)
      .join('');

    // Try to extract JSON from the response
    let jsonStr = fullText.trim();

    // Strip markdown code fences if present
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1]!.trim();
    }

    // Try to find JSON object boundaries
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
    }

    const parsed = JSON.parse(jsonStr);

    // Validate structure
    if (!parsed.scope || !parsed.agents || !Array.isArray(parsed.agents)) {
      throw new Error('Invalid generated config: missing scope or agents');
    }

    return parsed as GeneratedScopeConfig;
  }
}

export const scopeGeneratorService = new ScopeGeneratorService();
