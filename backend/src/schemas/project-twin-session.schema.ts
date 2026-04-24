/**
 * Zod validation schemas for Project Twin Session entities
 */
import { z } from 'zod';
import { uuidSchema } from './common.schema.js';

/**
 * Schema for creating a new twin session
 */
export const createTwinSessionSchema = z.object({
  agent_id: uuidSchema,
  issue_id: uuidSchema.optional(),
  visibility: z.enum(['private', 'public']).default('private'),
});

/**
 * Schema for updating twin session visibility
 */
export const updateVisibilitySchema = z.object({
  visibility: z.enum(['private', 'public']),
});

/**
 * Schema for listing twin sessions with filters
 */
export const listTwinSessionsSchema = z.object({
  issue_id: uuidSchema.optional(),
  visibility: z.enum(['private', 'public']).optional(),
  mine_only: z.coerce.boolean().optional(),
});

/**
 * Schema for confirming a pending action
 */
export const confirmActionSchema = z.object({
  action_id: z.string(),
});

// Type exports
export type CreateTwinSessionInput = z.infer<typeof createTwinSessionSchema>;
export type UpdateVisibilityInput = z.infer<typeof updateVisibilitySchema>;
export type ListTwinSessionsQuery = z.infer<typeof listTwinSessionsSchema>;
export type ConfirmActionInput = z.infer<typeof confirmActionSchema>;
