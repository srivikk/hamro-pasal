import {
  GHOST_CUSTOMER_TIMER_MS,
  JOB_QUEUES,
  HOURLY_CRON_PATTERN,
  MARKETING_STATUS_SWEEP_TASK,
  MIDNIGHT_CRON_PATTERN,
  midnightTasks,
  NEPAL_TIMEZONE,
  SETTLEMENT_PAYOUT_CRON_PATTERN,
  SETTLEMENT_PAYOUT_RUN_TASK,
  VENDOR_ACCEPTANCE_EXPIRY_MS,
  VENDOR_ACCEPTANCE_TIMEOUT_MS,
  type GhostCustomerTimerJob,
  type MidnightMaintenanceJob,
  type MidnightTask,
  type VendorAcceptanceTimeoutJob,
  type VendorAcceptanceTimeoutJobInput,
} from '@hamro-pasal/shared-types';
import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';

/*
 * Queue contracts and the producer-side helpers (schedule / cancel). The 90 s vendor timer is
 * scheduled by the worker's own Kafka consumer when an order becomes PLACED
 * (consumers/vendor-sla-scheduler.ts); the 8 min ghost timer will be scheduled when a rider taps
 * "Unable to Contact". Each timer's job id is the order id, so scheduling is idempotent per order
 * and a vendor acceptance / customer appearance can cancel it by id.
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

export function vendorAcceptanceTimeoutOptions(
  orderId: string,
  delayMs: number = VENDOR_ACCEPTANCE_TIMEOUT_MS,
  kind: 'ESCALATE' | 'EXPIRE' = 'ESCALATE',
): JobsOptions {
  // One job of each kind per order; BullMQ refuses ':' in a custom id.
  const jobId = kind === 'EXPIRE' ? `expire-${orderId}` : orderId;
  return { jobId, delay: delayMs, attempts: 3, ...RETENTION };
}

export function ghostCustomerTimerOptions(orderId: string): JobsOptions {
  return { jobId: orderId, delay: GHOST_CUSTOMER_TIMER_MS, attempts: 3, ...RETENTION };
}

/**
 * SPEC vendor flow step 6: fires 90 s after the order alarm unless the vendor interacts. `delayMs`
 * is what is left of the 90 s when the timer is scheduled late (see vendorAcceptanceDelayMs).
 */
export async function scheduleVendorAcceptanceTimeout(
  queue: Queue<VendorAcceptanceTimeoutJob>,
  data: VendorAcceptanceTimeoutJobInput,
  delayMs: number = VENDOR_ACCEPTANCE_TIMEOUT_MS,
): Promise<void> {
  await queue.add(
    JOB_QUEUES.VENDOR_ACCEPTANCE_TIMEOUT,
    { ...data, kind: data.kind ?? 'ESCALATE' },
    vendorAcceptanceTimeoutOptions(data.order_id, delayMs, data.kind ?? 'ESCALATE'),
  );
}

/**
 * Milliseconds until the 90 s acceptance deadline of an order placed at `placedAt`, never
 * negative. The deadline is anchored on the order's `placed_at` (when the alarm started), not on
 * when the worker heard about it, so outbox/Kafka lag does not stretch the SLA.
 */
export function vendorAcceptanceDelayMs(
  placedAt: Date,
  now: Date,
  kind: 'ESCALATE' | 'EXPIRE' = 'ESCALATE',
): number {
  const window = kind === 'EXPIRE' ? VENDOR_ACCEPTANCE_EXPIRY_MS : VENDOR_ACCEPTANCE_TIMEOUT_MS;
  return Math.max(0, placedAt.getTime() + window - now.getTime());
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
  // The one hourly task shares the maintenance queue (Phase 28): on the hour, every hour.
  await queue.upsertJobScheduler(
    MARKETING_SWEEP_SCHEDULER_ID,
    { pattern: HOURLY_CRON_PATTERN, tz: NEPAL_TIMEZONE },
    {
      name: MARKETING_STATUS_SWEEP_TASK,
      data: { task: MARKETING_STATUS_SWEEP_TASK },
      opts: { attempts: 3, ...RETENTION },
    },
  );
  // The weekly payout run (Phase 29, SPEC core 5): Tuesday 02:00 Nepal Time.
  await queue.upsertJobScheduler(
    SETTLEMENT_PAYOUT_SCHEDULER_ID,
    { pattern: SETTLEMENT_PAYOUT_CRON_PATTERN, tz: NEPAL_TIMEZONE },
    {
      name: SETTLEMENT_PAYOUT_RUN_TASK,
      data: { task: SETTLEMENT_PAYOUT_RUN_TASK },
      opts: { attempts: 3, ...RETENTION },
    },
  );
}

export const MARKETING_SWEEP_SCHEDULER_ID = 'marketing-status-sweep';
export const SETTLEMENT_PAYOUT_SCHEDULER_ID = 'settlement-payout-run';
