import { z } from 'zod';

export const recoverQuerySchema = z.object({
  session_id: z.string().uuid(),
  after_event_id: z.string().uuid().nullable().optional(),
});

export const recoverResponseSchema = z.object({
  missed_events: z.array(z.object({
    id: z.string().uuid(),
    task_id: z.string().uuid(),
    session_id: z.string().uuid(),
    type: z.string(),
    payload: z.record(z.string(), z.unknown()),
    created_at: z.string(),
  })),
  current_tasks: z.array(z.object({
    id: z.string().uuid(),
    status: z.string(),
    source: z.string(),
    started_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    error_message: z.string().nullable(),
  })),
  summary: z.object({
    completed_count: z.number(),
    failed_count: z.number(),
    failed_task_ids: z.array(z.string().uuid()),
  }).nullable(),
});

export type RecoverQuery = z.infer<typeof recoverQuerySchema>;
export type RecoverResponse = z.infer<typeof recoverResponseSchema>;
