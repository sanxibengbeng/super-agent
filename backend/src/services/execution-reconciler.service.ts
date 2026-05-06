/**
 * Execution Reconciler Service
 *
 * Periodically checks for "stale" execution tasks (status='running' but not
 * updated recently) and reconciles them by checking S3 for a status file.
 * If the status file exists, it reads the result and updates the task.
 * If not and the task has been running too long, it marks it as timed out.
 *
 * Uses a distributed Redis lock to ensure only one process runs reconciliation.
 */

import { S3Client, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../config/index.js';
import { executionTaskRepository } from '../repositories/execution-task.repository.js';
import { workspaceEventBus } from './workspace-event-bus.js';
import { redisService } from './redis.service.js';

const RECONCILE_INTERVAL_MS = 60_000;
const STALE_THRESHOLD_MS = 5 * 60_000;
const TIMEOUT_THRESHOLD_MS = 30 * 60_000;
const LOCK_KEY = 'reconciler:execution_tasks';

export class ExecutionReconciler {
  private s3: S3Client;
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor() {
    this.s3 = new S3Client({ region: config.aws?.region ?? 'us-west-2' });
  }

  start(): void {
    this.intervalHandle = setInterval(() => {
      this.reconcile().catch((err) => {
        console.error('[Reconciler] Error:', err.message);
      });
    }, RECONCILE_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  async reconcile(): Promise<void> {
    const releaseLock = await redisService.acquireLock(LOCK_KEY, RECONCILE_INTERVAL_MS);
    if (!releaseLock) return;

    try {
      const staleTasks = await executionTaskRepository.findStale(STALE_THRESHOLD_MS);
      for (const task of staleTasks) {
        await this.reconcileTask(task);
      }
    } finally {
      await releaseLock();
    }
  }

  async reconcileTask(task: {
    id: string;
    session_id: string;
    workspace_bucket: string | null;
    workspace_prefix: string | null;
    status: string;
    created_at: Date;
  }): Promise<void> {
    if (!task.workspace_bucket || !task.workspace_prefix) {
      return;
    }

    const statusKey = `${task.workspace_prefix}__executions__/${task.id}.json`;

    try {
      // Check if the status file exists
      await this.s3.send(
        new HeadObjectCommand({
          Bucket: task.workspace_bucket,
          Key: statusKey,
        }),
      );

      // Status file exists — read and parse it
      const response = await this.s3.send(
        new GetObjectCommand({
          Bucket: task.workspace_bucket,
          Key: statusKey,
        }),
      );

      const body = await response.Body!.transformToString();
      const statusData = JSON.parse(body);

      const newStatus = statusData.status === 'completed' ? 'completed' : 'failed';
      const updated = await executionTaskRepository.updateStatusWhere(task.id, 'running', {
        status: newStatus,
        completed_at: new Date(statusData.finished_at ?? Date.now()),
        error_message: statusData.error ?? null,
      });

      if (updated > 0) {
        await workspaceEventBus.emit({
          task_id: task.id,
          session_id: task.session_id,
          type: newStatus === 'completed' ? 'task_completed' : 'task_failed',
          payload: {
            files_modified: statusData.files_modified ?? [],
            error: statusData.error ?? null,
          },
        });
      }
    } catch (err: any) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        // No status file yet — check if task has exceeded the timeout threshold
        const age = Date.now() - task.created_at.getTime();
        if (age >= TIMEOUT_THRESHOLD_MS) {
          const updated = await executionTaskRepository.updateStatusWhere(task.id, 'running', {
            status: 'timeout',
            completed_at: new Date(),
          });

          if (updated > 0) {
            await workspaceEventBus.emit({
              task_id: task.id,
              session_id: task.session_id,
              type: 'task_timeout',
              payload: {},
            });
          }
        }
        // Otherwise, task is still within acceptable time — skip
      } else {
        console.error(`[Reconciler] Error checking S3 for task ${task.id}:`, err.message);
      }
    }
  }
}

export const executionReconciler = new ExecutionReconciler();
