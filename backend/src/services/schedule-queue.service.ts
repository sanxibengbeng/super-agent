/**
 * Schedule Queue Service
 *
 * Manages BullMQ repeatable jobs for workflow scheduling.
 * Replaces setInterval polling with distributed, fault-tolerant scheduling.
 */

import { Queue, Worker, Job } from 'bullmq';
import { redisConnection } from '../config/queue.js';
import { scheduleService } from './schedule.service.js';

const QUEUE_NAME = 'workflow-schedule';

export interface ScheduleJobData {
  scheduleId: string;
  workflowId: string;
  organizationId: string;
}

class ScheduleQueueService {
  private queue: Queue<ScheduleJobData> | null = null;
  private worker: Worker<ScheduleJobData> | null = null;
  private initialized = false;

  /**
   * Initialize queue only (for API role that just needs to manage repeatable jobs)
   */
  async initializeQueue(): Promise<void> {
    if (this.queue) return;

    this.queue = new Queue<ScheduleJobData>(QUEUE_NAME, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 1000, age: 24 * 60 * 60 },
        removeOnFail: { count: 5000, age: 7 * 24 * 60 * 60 },
      },
    });

    console.log('[SCHEDULE_QUEUE] Queue initialized');
  }

  /**
   * Initialize queue and worker (for worker role)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.initializeQueue();

    this.worker = new Worker<ScheduleJobData>(
      QUEUE_NAME,
      async (job: Job<ScheduleJobData>) => {
        await this.processScheduleJob(job);
      },
      {
        connection: redisConnection,
        concurrency: 5,
        lockDuration: 60000, // 60 seconds lock
        stalledInterval: 30000, // Check stalled jobs every 30s
        maxStalledCount: 2, // Retry stalled job up to 2 times
      }
    );

    this.worker.on('completed', (job) => {
      console.log(`[SCHEDULE_QUEUE] Job ${job.id} completed for schedule ${job.data.scheduleId}`);
    });

    this.worker.on('failed', (job, err) => {
      console.error(`[SCHEDULE_QUEUE] Job ${job?.id} failed:`, err.message);
    });

    this.worker.on('stalled', (jobId) => {
      console.warn(`[SCHEDULE_QUEUE] Job ${jobId} stalled, will be retried`);
    });

    // Sync existing schedules from DB to BullMQ on startup
    await this.syncSchedulesFromDB();

    this.initialized = true;
    console.log('[SCHEDULE_QUEUE] Worker initialized');
  }

  /**
   * Add or update a repeatable job for a schedule
   */
  async upsertRepeatableJob(
    scheduleId: string,
    workflowId: string,
    organizationId: string,
    cronExpression: string,
    timezone: string,
    isEnabled: boolean
  ): Promise<void> {
    if (!this.queue) {
      throw new Error('Schedule queue not initialized');
    }

    const jobKey = `schedule:${scheduleId}`;

    // Remove existing repeatable job if any
    await this.removeRepeatableJob(scheduleId);

    if (!isEnabled) {
      console.log(`[SCHEDULE_QUEUE] Schedule ${scheduleId} disabled, not creating repeatable job`);
      return;
    }

    // Add new repeatable job
    await this.queue.add(
      'trigger',
      { scheduleId, workflowId, organizationId },
      {
        repeat: {
          pattern: cronExpression,
          tz: timezone,
        },
        jobId: jobKey,
      }
    );

    console.log(
      `[SCHEDULE_QUEUE] Created repeatable job for schedule ${scheduleId}: ${cronExpression} (${timezone})`
    );
  }

  /**
   * Remove a repeatable job
   */
  async removeRepeatableJob(scheduleId: string): Promise<boolean> {
    if (!this.queue) {
      throw new Error('Schedule queue not initialized');
    }

    const repeatableJobs = await this.queue.getRepeatableJobs();
    const jobKey = `schedule:${scheduleId}`;

    for (const job of repeatableJobs) {
      if (job.id === jobKey || job.key.includes(scheduleId)) {
        await this.queue.removeRepeatableByKey(job.key);
        console.log(`[SCHEDULE_QUEUE] Removed repeatable job for schedule ${scheduleId}`);
        return true;
      }
    }

    return false;
  }

  /**
   * Process a schedule job (triggered by BullMQ)
   */
  private async processScheduleJob(job: Job<ScheduleJobData>): Promise<void> {
    const { scheduleId, organizationId } = job.data;

    console.log(`[SCHEDULE_QUEUE] Processing schedule ${scheduleId}`);

    try {
      // Delegate to scheduleService.executeScheduleById
      await scheduleService.executeScheduleById(scheduleId, organizationId);
    } catch (error: any) {
      console.error(`[SCHEDULE_QUEUE] Failed to execute schedule ${scheduleId}:`, error.message);
      throw error; // Let BullMQ handle retry
    }
  }

  /**
   * Sync all enabled schedules from DB to BullMQ on startup
   */
  private async syncSchedulesFromDB(): Promise<void> {
    try {
      const { prisma } = await import('../config/database.js');

      const enabledSchedules = await prisma.workflow_schedules.findMany({
        where: {
          is_enabled: true,
          deleted_at: null,
        },
        select: {
          id: true,
          workflow_id: true,
          organization_id: true,
          cron_expression: true,
          timezone: true,
        },
      });

      console.log(`[SCHEDULE_QUEUE] Syncing ${enabledSchedules.length} schedules from DB`);

      for (const schedule of enabledSchedules) {
        try {
          await this.upsertRepeatableJob(
            schedule.id,
            schedule.workflow_id,
            schedule.organization_id,
            schedule.cron_expression,
            schedule.timezone,
            true
          );
        } catch (err: any) {
          console.error(`[SCHEDULE_QUEUE] Failed to sync schedule ${schedule.id}:`, err.message);
        }
      }

      console.log(`[SCHEDULE_QUEUE] Sync completed`);
    } catch (error: any) {
      console.error('[SCHEDULE_QUEUE] Failed to sync schedules from DB:', error.message);
    }
  }

  /**
   * Get all repeatable jobs (for debugging/monitoring)
   */
  async getRepeatableJobs(): Promise<any[]> {
    if (!this.queue) return [];
    return this.queue.getRepeatableJobs();
  }

  /**
   * Shutdown gracefully
   */
  async shutdown(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
    if (this.queue) {
      await this.queue.close();
      this.queue = null;
    }
    this.initialized = false;
    console.log('[SCHEDULE_QUEUE] Shutdown complete');
  }
}

export const scheduleQueueService = new ScheduleQueueService();
