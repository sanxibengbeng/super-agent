import { prisma } from '../config/database.js';

export interface CreateExecutionTaskInput {
  org_id: string;
  session_id: string;
  source: string;
  source_entity_id?: string;
  runtime: string;
  runtime_session_id?: string;
  workspace_bucket?: string;
  workspace_prefix?: string;
  created_by?: string;
}

export interface UpdateExecutionTaskData {
  status?: string;
  started_at?: Date;
  completed_at?: Date;
  error_message?: string;
  runtime_session_id?: string;
  workspace_bucket?: string;
  workspace_prefix?: string;
}

class ExecutionTaskRepository {
  async create(data: CreateExecutionTaskInput) {
    return prisma.execution_tasks.create({ data });
  }

  async findById(id: string) {
    return prisma.execution_tasks.findUnique({ where: { id } });
  }

  async findBySessionId(sessionId: string) {
    return prisma.execution_tasks.findMany({
      where: { session_id: sessionId },
      orderBy: { created_at: 'desc' },
    });
  }

  async findStale(thresholdMs: number) {
    const cutoff = new Date(Date.now() - thresholdMs);
    return prisma.execution_tasks.findMany({
      where: {
        status: 'running',
        updated_at: { lt: cutoff },
      },
    });
  }

  async updateStatusWhere(
    id: string,
    expectedStatus: string,
    data: UpdateExecutionTaskData,
  ): Promise<number> {
    const result = await prisma.execution_tasks.updateMany({
      where: { id, status: expectedStatus },
      data,
    });
    return result.count;
  }

  async update(id: string, data: UpdateExecutionTaskData) {
    return prisma.execution_tasks.update({ where: { id }, data });
  }
}

export const executionTaskRepository = new ExecutionTaskRepository();
