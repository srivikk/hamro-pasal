import { z } from 'zod';

/*
 * BullMQ queue contracts shared by the producer (apps/api) and the processor (apps/worker).
 * Timings come from SPEC.md and are not configurable.
 */

export const JOB_QUEUES = {
  /** Vendor flow step 6: no app interaction within 90 s, so the IVR/SMS escalation fires. */
  VENDOR_ACCEPTANCE_TIMEOUT: 'vendor-acceptance-timeout',
  /** Delivery flow step 4: unskippable 8-minute server-side countdown after "Unable to Contact". */
  GHOST_CUSTOMER_TIMER: 'ghost-customer-timer',
  /** Midnight (Nepal time) maintenance crons. */
  MIDNIGHT_MAINTENANCE: 'midnight-maintenance',
} as const;
export type JobQueueName = (typeof JOB_QUEUES)[keyof typeof JOB_QUEUES];

export const VENDOR_ACCEPTANCE_TIMEOUT_MS = 90 * 1000;
export const GHOST_CUSTOMER_TIMER_MS = 8 * 60 * 1000;

/** Nepal Standard Time (UTC+05:45). "Midnight" in SPEC means Kathmandu midnight. */
export const NEPAL_TIMEZONE = 'Asia/Kathmandu';
export const MIDNIGHT_CRON_PATTERN = '0 0 * * *';

export const midnightTasks = [
  /** SPEC §4: apply scheduled subscription-to-commission downgrades at the end of the paid cycle. */
  'SUBSCRIPTION_DOWNGRADE',
] as const;
export const midnightTaskSchema = z.enum(midnightTasks);
export type MidnightTask = z.infer<typeof midnightTaskSchema>;

export const vendorAcceptanceTimeoutJobSchema = z.strictObject({
  order_id: z.uuid(),
  vendor_id: z.uuid(),
});
export type VendorAcceptanceTimeoutJob = z.infer<typeof vendorAcceptanceTimeoutJobSchema>;

export const ghostCustomerTimerJobSchema = z.strictObject({
  order_id: z.uuid(),
  driver_user_id: z.uuid(),
});
export type GhostCustomerTimerJob = z.infer<typeof ghostCustomerTimerJobSchema>;

export const midnightMaintenanceJobSchema = z.strictObject({
  task: midnightTaskSchema,
});
export type MidnightMaintenanceJob = z.infer<typeof midnightMaintenanceJobSchema>;
