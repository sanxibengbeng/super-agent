/**
 * Queue Configuration for BullMQ
 *
 * Defines queue names, options, and configuration for workflow execution.
 * Uses Redis as the backing store for job queues.
 */

import { QueueOptions, WorkerOptions, JobsOptions } from 'bullmq';
import { config } from './index.js';

// Queue name constants
export const QUEUE_RUN_WORKFLOW = 'run-workflow';
export const QUEUE_POLL_WORKFLOW = 'poll-workflow';

// Polling interval in milliseconds
export const POLL_INTERVAL_MS = 1000;

// Lock TTL for distributed locks (in milliseconds)
export const POLL_LOCK_TTL_MS = 5000;
export const NODE_LOCK_TTL_MS = 30000;

// Execution timeout (30 minutes)
export const EXECUTION_TIMEOUT_MS = 30 * 60 * 1000;

// Per-node execution timeout (5 minutes). Enforced in the processor via
// Promise.race — BullMQ's job-level `timeout` option was removed in v5 and is
// a no-op, so a hung node would otherwise hold a worker slot indefinitely.
export const NODE_EXECUTION_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Redis connection configuration for BullMQ
 */
export const redisConnection = {
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password || undefined,
  db: config.redis.db,
  maxRetriesPerRequest: null, // Required for BullMQ
  ...(config.redis.tls ? { tls: {} } : {}),
};

/**
 * Default queue options shared across all queues
 */
export const defaultQueueOptions: QueueOptions = {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: {
      count: 1000, // Keep last 1000 completed jobs
      age: 24 * 60 * 60, // Keep for 24 hours
    },
    removeOnFail: {
      count: 5000, // Keep last 5000 failed jobs
      age: 7 * 24 * 60 * 60, // Keep for 7 days
    },
  },
};

/**
 * Queue-specific options for run-workflow queue
 */
export const runWorkflowQueueOptions: QueueOptions = {
  ...defaultQueueOptions,
  defaultJobOptions: {
    ...defaultQueueOptions.defaultJobOptions,
    attempts: 3,
    // Note: per-node timeout is enforced in the processor (Promise.race against
    // NODE_EXECUTION_TIMEOUT_MS). BullMQ v5 removed the job-level `timeout`
    // option, so setting it here would do nothing.
  },
};

/**
 * Queue-specific options for poll-workflow queue
 */
export const pollWorkflowQueueOptions: QueueOptions = {
  ...defaultQueueOptions,
  defaultJobOptions: {
    ...defaultQueueOptions.defaultJobOptions,
    attempts: 1, // Polling jobs should not retry
  },
};

/**
 * Worker options for run-workflow processor
 */
export const runWorkflowWorkerOptions: WorkerOptions = {
  connection: redisConnection,
  concurrency: 5, // Process up to 5 nodes concurrently
  limiter: {
    max: 10,
    duration: 1000, // Max 10 jobs per second
  },
};

/**
 * Worker options for poll-workflow processor
 */
export const pollWorkflowWorkerOptions: WorkerOptions = {
  connection: redisConnection,
  concurrency: 10, // Can poll multiple workflows concurrently
};

/**
 * Job options for scheduling poll jobs
 */
export const pollJobOptions: JobsOptions = {
  delay: POLL_INTERVAL_MS,
  attempts: 1,
  removeOnComplete: true,
  removeOnFail: true,
};

export type { QueueOptions, WorkerOptions, JobsOptions };
