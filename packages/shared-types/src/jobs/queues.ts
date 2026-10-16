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
  /** Step 7.6: queued data exports, built and emailed one job at a time. */
  DATA_EXPORT: 'data-export',
} as const;
export type JobQueueName = (typeof JOB_QUEUES)[keyof typeof JOB_QUEUES];

export const VENDOR_ACCEPTANCE_TIMEOUT_MS = 90 * 1000;
/** Step 7.3 (decided 2026-10-15): the acceptance window; an order still PLACED is cancelled. */
export const VENDOR_ACCEPTANCE_EXPIRY_MS = 5 * 60 * 1000;
export const GHOST_CUSTOMER_TIMER_MS = 8 * 60 * 1000;

/** Nepal Standard Time (UTC+05:45). "Midnight" in SPEC means Kathmandu midnight. */
export const NEPAL_TIMEZONE = 'Asia/Kathmandu';
export const MIDNIGHT_CRON_PATTERN = '0 0 * * *';

export const midnightTasks = [
  /** SPEC §4: apply scheduled subscription-to-commission downgrades at the end of the paid cycle. */
  'SUBSCRIPTION_DOWNGRADE',
  /**
   * SPEC §5 (Phase 12): suspend every vendor whose wallet is below the Super Admin's current
   * suspension limit but who is not SUSPENDED yet. The database trigger suspends only when a row is
   * written, so a vendor already in debt when the limit is tightened is caught here.
   */
  'VENDOR_DEBT_RECONCILIATION',
  /**
   * SPEC §5 (Phase 22): verify the settlement journal of every DELIVERED order not reconciled yet
   * (posting it if it is missing) and stamp `orders.reconciled_at`.
   */
  'ORDER_RECONCILIATION',
  /**
   * SPEC core 10 (Phase 25): move every LIVE vendor without a PAN to SUSPENDED_COMPLIANCE.
   */
  'VENDOR_COMPLIANCE_SWEEP',
  /**
   * SPEC core 4 (Phase 25): start the Billing Cycle of newly LIVE vendors, apply the queued
   * changes of every cycle that has ended, and open the next BS month.
   */
  'BILLING_CYCLE_RENEWAL',
  /** Step 7.6: deletes queued export files whose 7-day link has expired. */
  'EXPORT_FILE_SWEEP',
] as const;
/**
 * Runs every hour on the maintenance queue (Phase 28, SPEC core 8): ends ad purchases whose paid
 * period is over (releasing a held budget) and pauses per-order ads whose budget is used up.
 */
export const MARKETING_STATUS_SWEEP_TASK = 'MARKETING_STATUS_SWEEP';
export const HOURLY_CRON_PATTERN = '0 * * * *';

/**
 * The automated payout run (SPEC core 5, "Payouts"): every Tuesday at 02:00 Nepal Time, on the
 * maintenance queue. It pays each verified Model B vendor what was available at the cut-off (the
 * end of Sunday), less anything debited since, when that is at least the minimum.
 */
export const SETTLEMENT_PAYOUT_RUN_TASK = 'SETTLEMENT_PAYOUT_RUN';
export const SETTLEMENT_PAYOUT_CRON_PATTERN = '0 2 * * 2';
/** A smaller amount is not paid by the run and carries over. A manual payout has no minimum. */
export const SETTLEMENT_PAYOUT_MIN_NPR = 1000;

export const midnightTaskSchema = z.enum(midnightTasks);
export type MidnightTask = z.infer<typeof midnightTaskSchema>;

export const vendorAcceptanceTimeoutJobSchema = z.strictObject({
  order_id: z.uuid(),
  vendor_id: z.uuid(),
  /**
   * Step 7.3: ESCALATE at 90 s (the IVR / SMS alert), EXPIRE at 5 minutes (the order is cancelled
   * and counts as missed). A job from before the field is an escalation.
   */
  kind: z.enum(['ESCALATE', 'EXPIRE']).default('ESCALATE'),
});
export type VendorAcceptanceTimeoutJob = z.infer<typeof vendorAcceptanceTimeoutJobSchema>;
/** What a scheduler is given: `kind` may be left out (an escalation). */
export type VendorAcceptanceTimeoutJobInput = z.input<typeof vendorAcceptanceTimeoutJobSchema>;

/** Step 7.6: one queued export (the export_jobs row holds what to build). */
export const dataExportJobSchema = z.strictObject({
  job_id: z.uuid(),
});
export type DataExportJob = z.infer<typeof dataExportJobSchema>;

export const ghostCustomerTimerJobSchema = z.strictObject({
  order_id: z.uuid(),
  driver_user_id: z.uuid(),
});
export type GhostCustomerTimerJob = z.infer<typeof ghostCustomerTimerJobSchema>;

/**
 * Step 7.4 (SPEC core 11): every 5 minutes on the maintenance queue, the Notify Me requests whose
 * product or shop became orderable without an event (a shop opening by its hours) are used up.
 */
export const NOTIFY_ME_SWEEP_TASK = 'NOTIFY_ME_SWEEP';
export const NOTIFY_ME_SWEEP_CRON_PATTERN = '*/5 * * * *';

/**
 * Step 7.3 (SPEC core 6): hourly on the maintenance queue, a prepaid order held earnings move to
 * the vendor wallet once its 7-day window has closed without an escalation.
 */
export const DISPUTE_HOLD_RELEASE_TASK = 'DISPUTE_HOLD_RELEASE';
/** Hourly, at half past (the marketing sweep runs on the hour). */
export const DISPUTE_HOLD_RELEASE_CRON_PATTERN = '30 * * * *';

export const midnightMaintenanceJobSchema = z.strictObject({
  task: z.enum([
    ...midnightTasks,
    MARKETING_STATUS_SWEEP_TASK,
    SETTLEMENT_PAYOUT_RUN_TASK,
    NOTIFY_ME_SWEEP_TASK,
    DISPUTE_HOLD_RELEASE_TASK,
  ]),
});
export type MidnightMaintenanceJob = z.infer<typeof midnightMaintenanceJobSchema>;
