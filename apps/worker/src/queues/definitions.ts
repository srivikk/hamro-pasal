import {
  GHOST_CUSTOMER_TIMER_MS,
  JOB_QUEUES,
  MIDNIGHT_CRON_PATTERN,
  midnightTasks,
  NEPAL_TIMEZONE,
  VENDOR_ACCEPTANCE_TIMEOUT_MS,
  type GhostCustomerTimerJob,
  type MidnightMaintenanceJob,
  type MidnightTask,
  type VendorAcceptanceTimeoutJob,
} from '@hamro-pasal/shared-types';
import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';

/*
 * Queue contracts and the producer-side helpers (schedule / cancel). The API will call these
 * when an order is placed (90 s vendor timer) or a rider taps "Unable to Contact" (8 min ghost
 * timer). Each timer's job id is the order id, so scheduling is idempotent per order and a
 * vendor acceptance / customer appearance cancels it by id.
 */

/** Keep finished jobs briefly for inspection, and failures for a week of forensics. */
const RETENTION: Pick<JobsOptions, 'removeOnComplete' | 'removeOnFail'> = {
  removeOnComplete: { age: 24 * 60 * 60 },
  removeOnFail: { age: 7 * 24 * 60 * 60 },
};

export interface TimerQueues {
  readonly vendorAcceptance: Queue<VendorAcceptanceTimeoutJob>;
  readonly ghostCustomer: Queue<GhostCustomerTimerJob>;
  readonly midnight: Queue<MidnightMaintenanceJob>;
}

export function createTimerQueues(connection: ConnectionOptions, prefix?: string): TimerQueues {
  const options = prefix === undefined ? { connection } : { connection, prefix };
  return {
    vendorAcceptance: new Queue<VendorAcceptanceTimeoutJob>(
      JOB_QUEUES.VENDOR_ACCEPTANCE_TIMEOUT,
      options,
    ),
    ghostCustomer: new Queue<GhostCustomerTimerJob>(JOB_QUEUES.GHOST_CUSTOMER_TIMER, options),
    midnight: new Queue<MidnightMaintenanceJob>(JOB_QUEUES.MIDNIGHT_MAINTENANCE, options),
  };
}

/** Every timer queue, typed, for lifecycle management (open/close/obliterate). */
export function allTimerQueues(queues: TimerQueues): Queue[] {
  return [queues.vendorAcceptance, queues.ghostCustomer, queues.midnight];
}

export function vendorAcceptanceTimeoutOptions(orderId: string): JobsOptions {
  return { jobId: orderId, delay: VENDOR_ACCEPTANCE_TIMEOUT_MS, attempts: 3, ...RETENTION };
}

export function ghostCustomerTimerOptions(orderId: string): JobsOptions {
  return { jobId: orderId, delay: GHOST_CUSTOMER_TIMER_MS, attempts: 3, ...RETENTION };
}

/** SPEC vendor flow step 6: fires 90 s after the order alarm unless the vendor interacts. */
export async function scheduleVendorAcceptanceTimeout(
  queue: Queue<VendorAcceptanceTimeoutJob>,
  data: VendorAcceptanceTimeoutJob,
): Promise<void> {
  await queue.add(
    JOB_QUEUES.VENDOR_ACCEPTANCE_TIMEOUT,
    data,
    vendorAcceptanceTimeoutOptions(data.order_id),
  );
}

/** Vendor interacted in time. Returns false if the timer already fired or never existed. */
export function cancelVendorAcceptanceTimeout(
  queue: Queue<VendorAcceptanceTimeoutJob>,
  orderId: string,
): Promise<boolean> {
  return cancelPendingTimer(queue, orderId);
}

/** SPEC delivery flow step 4: unskippable 8-minute server-side countdown. */
export async function scheduleGhostCustomerTimer(
  queue: Queue<GhostCustomerTimerJob>,
  data: GhostCustomerTimerJob,
): Promise<void> {
  await queue.add(JOB_QUEUES.GHOST_CUSTOMER_TIMER, data, ghostCustomerTimerOptions(data.order_id));
}

/** Customer reached before the countdown ended. */
export function cancelGhostCustomerTimer(
  queue: Queue<GhostCustomerTimerJob>,
  orderId: string,
): Promise<boolean> {
  return cancelPendingTimer(queue, orderId);
}

const PENDING_STATES = new Set(['delayed', 'waiting', 'prioritized']);

/**
 * Removes a timer that has not fired yet. `Queue.remove` cannot express this: it returns 1 for
 * ids that never existed, and would also delete the record of a timer that already fired.
 */
async function cancelPendingTimer(queue: Queue, jobId: string): Promise<boolean> {
  const job = await queue.getJob(jobId);
  if (job === undefined || !PENDING_STATES.has(await job.getState())) {
    return false;
  }
  try {
    await job.remove();
    return true;
  } catch {
    // Picked up by a worker between the state check and removal: the timer is firing.
    return false;
  }
}

export function midnightSchedulerId(task: MidnightTask): string {
  return task.toLowerCase().replaceAll('_', '-');
}

/** Upserts one cron per midnight task at 00:00 Asia/Kathmandu. Idempotent across restarts. */
export async function registerMidnightJobs(queue: Queue<MidnightMaintenanceJob>): Promise<void> {
  for (const task of midnightTasks) {
    await queue.upsertJobScheduler(
      midnightSchedulerId(task),
      { pattern: MIDNIGHT_CRON_PATTERN, tz: NEPAL_TIMEZONE },
      { name: task, data: { task }, opts: { attempts: 3, ...RETENTION } },
    );
  }
}
