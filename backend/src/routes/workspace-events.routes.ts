import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate } from '../middleware/auth.js';
import { recoverQuerySchema } from '../schemas/workspace-events.schema.js';
import { executionEventRepository } from '../repositories/execution-event.repository.js';
import { executionTaskRepository } from '../repositories/execution-task.repository.js';

export async function workspaceEventsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/workspace-events/recover',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = recoverQuerySchema.parse(request.query);
      const { session_id, after_event_id } = query;

      const [missedEvents, currentTasks] = await Promise.all([
        executionEventRepository.findAfter(session_id, after_event_id ?? null),
        executionTaskRepository.findBySessionId(session_id),
      ]);

      const completedAfterDisconnect = missedEvents.filter(e => e.type === 'task_completed');
      const failedAfterDisconnect = missedEvents.filter(e => e.type === 'task_failed' || e.type === 'task_timeout');

      const summary = (completedAfterDisconnect.length > 0 || failedAfterDisconnect.length > 0)
        ? {
            completed_count: completedAfterDisconnect.length,
            failed_count: failedAfterDisconnect.length,
            failed_task_ids: failedAfterDisconnect.map(e => e.task_id),
          }
        : null;

      return reply.send({
        missed_events: missedEvents.map(e => ({
          ...e,
          created_at: e.created_at.toISOString(),
        })),
        current_tasks: currentTasks.map(t => ({
          id: t.id,
          status: t.status,
          source: t.source,
          started_at: t.started_at?.toISOString() ?? null,
          completed_at: t.completed_at?.toISOString() ?? null,
          error_message: t.error_message ?? null,
        })),
        summary,
      });
    }
  );
}
