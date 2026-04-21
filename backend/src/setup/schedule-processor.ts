/**
 * Schedule Processor Setup
 *
 * Initializes the BullMQ-based schedule processor.
 * Replaces the old setInterval polling with distributed repeatable jobs.
 */

import { scheduleQueueService } from '../services/schedule-queue.service.js';

let initialized = false;

/**
 * Start the schedule processor (BullMQ worker)
 */
export async function startScheduleProcessor(): Promise<void> {
  if (initialized) {
    console.log('[SCHEDULE_PROCESSOR] Already initialized');
    return;
  }

  console.log('[SCHEDULE_PROCESSOR] Starting BullMQ schedule processor');

  await scheduleQueueService.initialize();

  initialized = true;
  console.log('[SCHEDULE_PROCESSOR] Started');
}

/**
 * Initialize queue only (for API role - can manage schedules but doesn't process them)
 */
export async function initializeScheduleQueue(): Promise<void> {
  await scheduleQueueService.initializeQueue();
}

/**
 * Stop the schedule processor
 */
export async function stopScheduleProcessor(): Promise<void> {
  if (!initialized) return;

  await scheduleQueueService.shutdown();
  initialized = false;
  console.log('[SCHEDULE_PROCESSOR] Stopped');
}
