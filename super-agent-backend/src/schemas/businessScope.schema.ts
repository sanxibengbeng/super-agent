/**
 * Zod validation schemas for Business Scope entity
 */
import { z } from 'zod';
import { uuidSchema } from './common.schema.js';

/**
 * Schema for creating a new business scope
 */
export const createBusinessScopeSchema = z.object({
  name: z
    .string()
    .min(1, 'Business scope name is required')
    .max(255, 'Business scope name must be 255 characters or less'),
  description: z.string().max(1000).optional().nullable(),
  icon: z.string().max(100).optional().nullable(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Color must be a valid hex color (e.g., #FF5733)')
    .optional()
    .nullable(),
  is_default: z.boolean().default(false),
});

/**
 * Schema for updating a business scope
 */
export const updateBusinessScopeSchema = createBusinessScopeSchema.partial();

/**
 * Schema for business scope query filters
 */
export const businessScopeFilterSchema = z.object({
  name: z.string().optional(),
  is_default: z.coerce.boolean().optional(),
});

/**
 * Schema for business scope response (includes all fields)
 */
export const businessScopeResponseSchema = z.object({
  id: uuidSchema,
  organization_id: uuidSchema,
  name: z.string(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  is_default: z.boolean(),
  created_at: z.date(),
  updated_at: z.date(),
});

/**
 * Schema for generating agent roles from documents (legacy)
 */
export const generateAgentRolesSchema = z.object({
  document_ids: z.array(uuidSchema).min(1, 'At least one document is required'),
  business_scope_id: uuidSchema.optional(),
});

/**
 * Schema for suggesting agent roles (AI-powered, no persistence)
 */
export const suggestAgentRolesSchema = z.object({
  business_scope_name: z
    .string()
    .min(1, 'Business scope name is required')
    .max(255, 'Business scope name must be 255 characters or less'),
  business_scope_description: z.string().max(1000).optional(),
  document_contents: z.array(z.string()).optional(),
  agent_count: z.number().int().min(1).max(10).default(5),
});

// Type exports
export type CreateBusinessScopeInput = z.infer<typeof createBusinessScopeSchema>;
export type UpdateBusinessScopeInput = z.infer<typeof updateBusinessScopeSchema>;
export type BusinessScopeFilter = z.infer<typeof businessScopeFilterSchema>;
export type BusinessScopeResponse = z.infer<typeof businessScopeResponseSchema>;
export type GenerateAgentRolesInput = z.infer<typeof generateAgentRolesSchema>;
export type SuggestAgentRolesInput = z.infer<typeof suggestAgentRolesSchema>;
