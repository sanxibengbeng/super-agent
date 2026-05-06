import { prisma } from '../config/database.js';

export interface CreateExecutionEventInput {
  task_id: string;
  session_id: string;
  type: string;
  payload: Record<string, unknown>;
}

class ExecutionEventRepository {
  async create(data: CreateExecutionEventInput) {
    return prisma.execution_events.create({ data });
  }

  async findAfter(sessionId: string, afterEventId: string | null) {
    if (!afterEventId) {
      return prisma.execution_events.findMany({
        where: { session_id: sessionId },
        orderBy: { created_at: 'asc' },
      });
    }

    const refEvents = await prisma.execution_events.findMany({
      where: { id: afterEventId },
      select: { created_at: true },
    });

    if (refEvents.length === 0) {
      return prisma.execution_events.findMany({
        where: { session_id: sessionId },
        orderBy: { created_at: 'asc' },
      });
    }

    return prisma.execution_events.findMany({
      where: {
        session_id: sessionId,
        created_at: { gt: refEvents[0].created_at },
      },
      orderBy: { created_at: 'asc' },
    });
  }

  async deleteOlderThan(cutoff: Date): Promise<number> {
    const result = await prisma.execution_events.deleteMany({
      where: { created_at: { lt: cutoff } },
    });
    return result.count;
  }
}

export const executionEventRepository = new ExecutionEventRepository();
