/**
 * Schedule Service
 * Manages cron-based workflow scheduling.
 */

import { prisma } from '../config/database.js';
import { workflowExecutionService } from './workflow-execution.service.js';
import { workflowRepository } from '../repositories/workflow.repository.js';
import { workflowQueueService } from './workflow-queue.service.js';
import cronParser from 'cron-parser';

export interface ScheduleConfig {
  id: string;
  organizationId: string;
  workflowId: string;
  name: string;
  cronExpression: string;
  timezone: string;
  isEnabled: boolean;
  variables: any[];
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  runCount: number;
  failureCount: number;
  maxRetries: number;
  createdAt: Date;
}

export interface ScheduleExecutionRecord {
  id: string;
  scheduleId: string;
  executionId: string | null;
  scheduledAt: Date;
  triggeredAt: Date | null;
  completedAt: Date | null;
  status: string;
  errorMessage: string | null;
  retryCount: number;
}

class ScheduleService {
  /**
   * Validate cron expression
   */
  validateCronExpression(cronExpression: string, timezone?: string): Date {
    try {
      const interval = cronParser.parseExpression(cronExpression, {
        tz: timezone || 'UTC',
      });
      return interval.next().toDate();
    } catch (error) {
      throw new Error('Invalid cron expression');
    }
  }

  /**
   * Create a schedule for a workflow
   */
  async createSchedule(
    organizationId: string,
    workflowId: string,
    options: {
      name: string;
      cronExpression: string;
      timezone?: string;
      variables?: any[];
      isEnabled?: boolean;
      maxRetries?: number;
      createdBy?: string;
    }
  ): Promise<ScheduleConfig> {
    // Verify workflow exists
    const workflow = await workflowRepository.findById(workflowId, organizationId);
    if (!workflow) {
      throw new Error('Workflow not found');
    }

    // Validate cron expression and calculate next run
    const nextRunAt = options.isEnabled 
      ? this.validateCronExpression(options.cronExpression, options.timezone)
      : null;

    const schedule = await prisma.workflow_schedules.create({
      data: {
        organization_id: organizationId,
        workflow_id: workflowId,
        name: options.name,
        cron_expression: options.cronExpression,
        timezone: options.timezone || 'UTC',
        variables: options.variables || [],
        is_enabled: options.isEnabled || false,
        next_run_at: nextRunAt,
        max_retries: options.maxRetries || 3,
        created_by: options.createdBy,
      },
    });

    // If enabled, create the first scheduled record
    if (options.isEnabled && nextRunAt) {
      await this.createScheduledRecord(schedule.id, organizationId, nextRunAt);
    }

    return this.mapToScheduleConfig(schedule);
  }

  /**
   * Update a schedule
   */
  async updateSchedule(
    scheduleId: string,
    organizationId: string,
    updates: {
      name?: string;
      cronExpression?: string;
      timezone?: string;
      variables?: any[];
      isEnabled?: boolean;
      maxRetries?: number;
    }
  ): Promise<ScheduleConfig> {
    const schedule = await prisma.workflow_schedules.findFirst({
      where: { id: scheduleId, organization_id: organizationId, deleted_at: null },
    });

    if (!schedule) {
      throw new Error('Schedule not found');
    }

    // Calculate new next run time if cron or enabled status changed
    let nextRunAt = schedule.next_run_at;
    const newCron = updates.cronExpression || schedule.cron_expression;
    const newTimezone = updates.timezone || schedule.timezone;
    const newEnabled = updates.isEnabled !== undefined ? updates.isEnabled : schedule.is_enabled;

    if (newEnabled) {
      nextRunAt = this.validateCronExpression(newCron, newTimezone);
    } else {
      nextRunAt = null;
    }

    const updated = await prisma.workflow_schedules.update({
      where: { id: scheduleId },
      data: {
        name: updates.name,
        cron_expression: updates.cronExpression,
        timezone: updates.timezone,
        variables: updates.variables,
        is_enabled: updates.isEnabled,
        max_retries: updates.maxRetries,
        next_run_at: nextRunAt,
      },
    });

    // Update or create scheduled record
    if (newEnabled && nextRunAt) {
      await this.createOrUpdateScheduledRecord(scheduleId, organizationId, nextRunAt);
    } else {
      await this.deleteScheduledRecords(scheduleId);
    }

    return this.mapToScheduleConfig(updated);
  }

  /**
   * Delete a schedule (soft delete)
   */
  async deleteSchedule(scheduleId: string, organizationId: string): Promise<void> {
    const schedule = await prisma.workflow_schedules.findFirst({
      where: { id: scheduleId, organization_id: organizationId, deleted_at: null },
    });

    if (!schedule) {
      throw new Error('Schedule not found');
    }

    await prisma.workflow_schedules.update({
      where: { id: scheduleId },
      data: {
        deleted_at: new Date(),
        is_enabled: false,
        next_run_at: null,
      },
    });

    // Delete pending scheduled records
    await this.deleteScheduledRecords(scheduleId);
  }

  /**
   * Get a schedule by ID
   */
  async getSchedule(scheduleId: string, organizationId: string): Promise<ScheduleConfig | null> {
    const schedule = await prisma.workflow_schedules.findFirst({
      where: { id: scheduleId, organization_id: organizationId, deleted_at: null },
    });

    return schedule ? this.mapToScheduleConfig(schedule) : null;
  }

  /**
   * List schedules for a workflow
   */
  async listSchedules(workflowId: string, organizationId: string): Promise<ScheduleConfig[]> {
    const schedules = await prisma.workflow_schedules.findMany({
      where: {
        workflow_id: workflowId,
        organization_id: organizationId,
        deleted_at: null,
      },
      orderBy: { created_at: 'desc' },
    });

    return schedules.map(this.mapToScheduleConfig);
  }

  /**
   * Manually trigger a schedule
   */
  async triggerSchedule(
    scheduleId: string,
    organizationId: string
  ): Promise<{ executionId: string; triggeredAt: Date }> {
    const schedule = await prisma.workflow_schedules.findFirst({
      where: { id: scheduleId, organization_id: organizationId, deleted_at: null },
    });

    if (!schedule) {
      throw new Error('Schedule not found');
    }

    const workflow = await workflowRepository.findById(schedule.workflow_id, organizationId);
    if (!workflow) {
      throw new Error('Workflow not found');
    }

    const triggeredAt = new Date();

    // Create execution record
    const record = await prisma.schedule_execution_records.create({
      data: {
        schedule_id: scheduleId,
        organization_id: organizationId,
        scheduled_at: triggeredAt,
        triggered_at: triggeredAt,
        status: 'running',
      },
    });

    // Start execution
    const executionId = await workflowExecutionService.initializeWorkflowExecution(
      {
        id: 'system',
        organizationId,
      },
      schedule.workflow_id,
      {
        canvasData: {
          nodes: workflow.nodes as any[],
          edges: workflow.connections as any[],
        },
        variables: schedule.variables as any[],
        triggerType: 'schedule',
        triggerId: scheduleId,
      }
    );

    // Update record with execution ID
    await prisma.schedule_execution_records.update({
      where: { id: record.id },
      data: { execution_id: executionId },
    });

    // Update schedule stats
    await prisma.workflow_schedules.update({
      where: { id: scheduleId },
      data: {
        last_run_at: triggeredAt,
        run_count: { increment: 1 },
      },
    });

    return { executionId, triggeredAt };
  }

  /**
   * Get execution records for a schedule
   */
  async getExecutionRecords(
    scheduleId: string,
    organizationId: string,
    pagination: { page: number; limit: number }
  ): Promise<{ records: ScheduleExecutionRecord[]; total: number }> {
    const schedule = await prisma.workflow_schedules.findFirst({
      where: { id: scheduleId, organization_id: organizationId, deleted_at: null },
    });

    if (!schedule) {
      throw new Error('Schedule not found');
    }

    const [records, total] = await Promise.all([
      prisma.schedule_execution_records.findMany({
        where: { schedule_id: scheduleId },
        orderBy: { scheduled_at: 'desc' },
        skip: (pagination.page - 1) * pagination.limit,
        take: pagination.limit,
      }),
      prisma.schedule_execution_records.count({
        where: { schedule_id: scheduleId },
      }),
    ]);

    return {
      records: records.map(this.mapToExecutionRecord),
      total,
    };
  }

  /**
   * Process due schedules (called by cron job)
   */
  async processDueSchedules(): Promise<number> {
    const now = new Date();

    // Find all enabled schedules that are due
    const dueSchedules = await prisma.workflow_schedules.findMany({
      where: {
        is_enabled: true,
        deleted_at: null,
        next_run_at: { lte: now },
      },
    });

    let processedCount = 0;

    for (const schedule of dueSchedules) {
      try {
        await this.executeSchedule(schedule);
        processedCount++;
      } catch (error: any) {
        console.error(`[SCHEDULE_ERROR] scheduleId=${schedule.id} error=${error.message}`);
        
        // Update failure count
        await prisma.workflow_schedules.update({
          where: { id: schedule.id },
          data: { failure_count: { increment: 1 } },
        });
      }
    }

    return processedCount;
  }

  /**
   * Execute a schedule
   */
  private async executeSchedule(schedule: any): Promise<void> {
    const workflow = await workflowRepository.findById(
      schedule.workflow_id,
      schedule.organization_id
    );

    if (!workflow) {
      throw new Error('Workflow not found');
    }

    const triggeredAt = new Date();

    // Create execution record
    const record = await prisma.schedule_execution_records.create({
      data: {
        schedule_id: schedule.id,
        organization_id: schedule.organization_id,
        scheduled_at: schedule.next_run_at,
        triggered_at: triggeredAt,
        status: 'running',
      },
    });

    try {
      // Start execution
      const executionId = await workflowExecutionService.initializeWorkflowExecution(
        {
          id: 'system',
          organizationId: schedule.organization_id,
        },
        schedule.workflow_id,
        {
          canvasData: {
            nodes: workflow.nodes as any[],
            edges: workflow.connections as any[],
          },
          variables: schedule.variables as any[],
          triggerType: 'schedule',
          triggerId: schedule.id,
        }
      );

      // Update record
      await prisma.schedule_execution_records.update({
        where: { id: record.id },
        data: { execution_id: executionId },
      });

      // Calculate next run time
      const nextRunAt = this.validateCronExpression(
        schedule.cron_expression,
        schedule.timezone
      );

      // Update schedule
      await prisma.workflow_schedules.update({
        where: { id: schedule.id },
        data: {
          last_run_at: triggeredAt,
          next_run_at: nextRunAt,
          run_count: { increment: 1 },
        },
      });
    } catch (error: any) {
      // Update record with error
      await prisma.schedule_execution_records.update({
        where: { id: record.id },
        data: {
          status: 'failed',
          error_message: error.message,
          completed_at: new Date(),
        },
      });

      throw error;
    }
  }

  /**
   * Create a scheduled record for future execution
   */
  private async createScheduledRecord(
    scheduleId: string,
    organizationId: string,
    scheduledAt: Date
  ): Promise<void> {
    await prisma.schedule_execution_records.create({
      data: {
        schedule_id: scheduleId,
        organization_id: organizationId,
        scheduled_at: scheduledAt,
        status: 'scheduled',
      },
    });
  }

  /**
   * Create or update scheduled record
   */
  private async createOrUpdateScheduledRecord(
    scheduleId: string,
    organizationId: string,
    scheduledAt: Date
  ): Promise<void> {
    const existing = await prisma.schedule_execution_records.findFirst({
      where: {
        schedule_id: scheduleId,
        status: 'scheduled',
      },
    });

    if (existing) {
      await prisma.schedule_execution_records.update({
        where: { id: existing.id },
        data: { scheduled_at: scheduledAt },
      });
    } else {
      await this.createScheduledRecord(scheduleId, organizationId, scheduledAt);
    }
  }

  /**
   * Delete pending scheduled records
   */
  private async deleteScheduledRecords(scheduleId: string): Promise<void> {
    await prisma.schedule_execution_records.deleteMany({
      where: {
        schedule_id: scheduleId,
        status: 'scheduled',
      },
    });
  }

  private mapToScheduleConfig(schedule: any): ScheduleConfig {
    return {
      id: schedule.id,
      organizationId: schedule.organization_id,
      workflowId: schedule.workflow_id,
      name: schedule.name,
      cronExpression: schedule.cron_expression,
      timezone: schedule.timezone,
      isEnabled: schedule.is_enabled,
      variables: schedule.variables as any[],
      nextRunAt: schedule.next_run_at,
      lastRunAt: schedule.last_run_at,
      runCount: schedule.run_count,
      failureCount: schedule.failure_count,
      maxRetries: schedule.max_retries,
      createdAt: schedule.created_at,
    };
  }

  private mapToExecutionRecord(record: any): ScheduleExecutionRecord {
    return {
      id: record.id,
      scheduleId: record.schedule_id,
      executionId: record.execution_id,
      scheduledAt: record.scheduled_at,
      triggeredAt: record.triggered_at,
      completedAt: record.completed_at,
      status: record.status,
      errorMessage: record.error_message,
      retryCount: record.retry_count,
    };
  }
}

export const scheduleService = new ScheduleService();
