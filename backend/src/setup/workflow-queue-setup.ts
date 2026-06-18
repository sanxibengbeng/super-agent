/**
 * Workflow Queue Setup
 *
 * Initializes BullMQ queues and registers processors for workflow execution.
 * This module connects the WorkflowQueueService with the WorkflowExecutionService.
 *
 * Requirements:
 * - 1.1: Create execution session and return execution ID
 * - 2.2: Execute nodes in topological order
 */

import { workflowQueueService } from '../services/workflow-queue.service.js';
import { workflowExecutionService } from '../services/workflow-execution.service.js';
import { redisService } from '../services/redis.service.js';
import type { Job } from 'bullmq';
import type {
  RunWorkflowJobData,
  PollWorkflowJobData,
} from '../services/workflow-queue.service.js';
import { tracedProcessor } from '../middleware/otel-bullmq.js';
import {
  QUEUE_RUN_WORKFLOW,
  QUEUE_POLL_WORKFLOW,
  NODE_EXECUTION_TIMEOUT_MS,
} from '../config/queue.js';

/**
 * Run a promise with a hard deadline. BullMQ v5 removed the job-level `timeout`
 * option, so we enforce the per-node timeout here — otherwise a hung node would
 * hold its worker slot forever and starve the rest of the DAG.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let initialized = false;

/**
 * Initialize workflow queues and register processors
 *
 * This function:
 * 1. Initializes the Redis service for distributed locks
 * 2. Initializes the BullMQ queues
 * 3. Registers the run-workflow processor
 * 4. Registers the poll-workflow processor
 */
export async function initializeWorkflowQueues(): Promise<void> {
  if (initialized) {
    console.log('⚠️ Workflow queues already initialized');
    return;
  }

  try {
    // 1. Initialize Redis service for distributed locks
    await redisService.initialize();

    // 2. Initialize queues
    await workflowQueueService.initialize();

    // 3. Register run-workflow processor (with trace propagation)
    workflowQueueService.registerRunWorkflowProcessor(
      tracedProcessor(QUEUE_RUN_WORKFLOW, async (job: Job<RunWorkflowJobData>) => {
        console.log(`🔄 Processing run-workflow job: ${job.id}`, job.data);
        await withTimeout(
          workflowExecutionService.runWorkflow(job.data),
          NODE_EXECUTION_TIMEOUT_MS,
          `Node execution (job ${job.id})`
        );
      })
    );

    // 4. Register poll-workflow processor (with trace propagation)
    workflowQueueService.registerPollWorkflowProcessor(
      tracedProcessor(QUEUE_POLL_WORKFLOW, async (job: Job<PollWorkflowJobData>) => {
        console.log(`🔄 Processing poll-workflow job: ${job.id}`, job.data);
        await workflowExecutionService.pollWorkflow(job.data);
      })
    );

    initialized = true;
    console.log('✅ Workflow queues and processors initialized');
  } catch (error) {
    console.error('❌ Failed to initialize workflow queues:', error);
    throw error;
  }
}

/**
 * Shutdown workflow queues gracefully
 */
export async function shutdownWorkflowQueues(): Promise<void> {
  if (!initialized) {
    return;
  }

  await workflowQueueService.shutdown();
  await redisService.shutdown();
  initialized = false;
  console.log('✅ Workflow queues shut down');
}

/**
 * Check if workflow queues are initialized
 */
export function isWorkflowQueuesInitialized(): boolean {
  return initialized;
}
