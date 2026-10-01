import { z } from 'zod';

import { nepalPhoneSchema } from '../domain/entities';
import {
  deadLetterStatusSchema,
  pricingModelSchema,
  vendorFulfillmentModeSchema,
  vendorStatusSchema,
} from '../domain/enums';

/*
 * Super Admin contracts (Phase 15): the dead-letter monitor and the vendor standing overrides,
 * served under /api/admin to SUPER_ADMIN tokens only and consumed by apps/admin.
 */

/** Page sizes of GET /api/admin/dlq. */
export const ADMIN_DEAD_LETTER_DEFAULT_LIMIT = 50;
export const ADMIN_DEAD_LETTER_MAX_LIMIT = 100;

/**
 * GET /api/admin/dlq?status=&limit=&cursor=: stored dead letters, newest failure first. `cursor`
 * is the `next_cursor` of the previous page (the id of its last row).
 */
export const adminDeadLetterListQuerySchema = z.strictObject({
  status: deadLetterStatusSchema.optional(),
  limit: z
    .string()
    .trim()
    .regex(/^\d{1,3}$/, 'limit must be a whole number')
    .transform(Number)
    .pipe(z.number().int().min(1).max(ADMIN_DEAD_LETTER_MAX_LIMIT))
    .optional(),
  cursor: z.uuid().optional(),
});
export type AdminDeadLetterListQuery = z.output<typeof adminDeadLetterListQuerySchema>;

/** One message the worker gave up on, as stored in `dead_letter_events`. */
export const deadLetterViewSchema = z.strictObject({
  id: z.uuid(),
  status: deadLetterStatusSchema,
  /** The consumer that failed, e.g. `vendor-notifications`. */
  consumer: z.string().min(1),
  /** Where the message came from, and where a retry republishes it. */
  source_topic: z.string().min(1),
  source_partition: z.number().int().nonnegative(),
  source_offset: z.string().regex(/^\d+$/),
  /** The Kafka topic the copy was also published to (e.g. `notifications.dlq`). */
  dead_letter_topic: z.string().min(1),
  /** The Kafka key as UTF-8 (the aggregate id for domain events). */
  message_key: z.string().nullable(),
  /** From the message's `event_id` / `event_type` headers; null for a message without them. */
  event_id: z.string().nullable(),
  event_type: z.string().nullable(),
  /** The value parsed as JSON, or null when it is not JSON (a poison pill) or empty. */
  payload: z.json().nullable(),
  /** The value as UTF-8 text, exactly as received (null for an empty value). */
  raw_value: z.string().nullable(),
  /** The message's own headers (the `dlq_*` bookkeeping headers are the columns here). */
  headers: z.record(z.string(), z.string()),
  /** Handler attempts before it was dead-lettered (1 for a poison pill). */
  attempts: z.number().int().positive(),
  error_name: z.string(),
  error_message: z.string(),
  failed_at: z.iso.datetime(),
  retry_requested_at: z.iso.datetime().nullable(),
  retry_requested_by: z.uuid().nullable(),
  replayed_at: z.iso.datetime().nullable(),
  /** Failed republish attempts by the worker's replayer. */
  replay_attempts: z.number().int().nonnegative(),
  last_replay_error: z.string().nullable(),
  /** Set when this message was itself a retry of an earlier dead letter that failed again. */
  replay_of_id: z.uuid().nullable(),
});
export type DeadLetterView = z.infer<typeof deadLetterViewSchema>;

/** GET /api/admin/dlq: one page; `next_cursor` is null on the last page. */
export const adminDeadLetterListResponseSchema = z.strictObject({
  dead_letters: z.array(deadLetterViewSchema),
  next_cursor: z.uuid().nullable(),
});
export type AdminDeadLetterListResponseBody = z.infer<typeof adminDeadLetterListResponseSchema>;

/**
 * POST /api/admin/dlq/:id/retry: 202, the row is RETRY_REQUESTED and the worker republishes it to
 * `source_topic` shortly (then REPLAYED). Asking again before that answers 202 with the same row.
 */
export const adminDeadLetterRetryResponseSchema = z.strictObject({
  dead_letter: deadLetterViewSchema,
});
export type AdminDeadLetterRetryResponseBody = z.infer<typeof adminDeadLetterRetryResponseSchema>;

/**
 * Why a vendor is (or is not) suspended:
 * - NONE: not suspended.
 * - DEBT: the wallet went below the limit (SPEC §5); paying the dues lifts it.
 * - ADMIN: a Super Admin suspended the shop; only an admin Restore lifts it.
 * - UNSPECIFIED: SUSPENDED with no remembered status (set outside the app): cannot be restored
 *   from the dashboard.
 */
export const adminVendorSuspensions = ['NONE', 'DEBT', 'ADMIN', 'UNSPECIFIED'] as const;
export const adminVendorSuspensionSchema = z.enum(adminVendorSuspensions);
export type AdminVendorSuspension = z.infer<typeof adminVendorSuspensionSchema>;

export const adminVendorViewSchema = z.strictObject({
  id: z.uuid(),
  business_name: z.string().min(1),
  phone: nepalPhoneSchema,
  status: vendorStatusSchema,
  suspension: adminVendorSuspensionSchema,
  /** The status a Restore returns the vendor to; null unless suspended for DEBT or by ADMIN. */
  restore_status: vendorStatusSchema.exclude(['SUSPENDED']).nullable(),
  wallet_balance_npr: z.number(),
  pricing_model: pricingModelSchema.nullable(),
  fulfillment_mode: vendorFulfillmentModeSchema,
  municipality_palika_string: z.string().min(1),
  created_at: z.iso.datetime(),
});
export type AdminVendorView = z.infer<typeof adminVendorViewSchema>;

/** Most vendors GET /api/admin/vendors returns (sorted by business name). */
export const ADMIN_VENDOR_LIST_LIMIT = 500;

/** GET /api/admin/vendors: every vendor with its wallet and standing. */
export const adminVendorListResponseSchema = z.strictObject({
  vendors: z.array(adminVendorViewSchema),
  /** platform_settings.vendor_wallet_suspension_limit_npr: a Restore needs a balance at or above it. */
  suspension_limit_npr: z.number().max(0),
});
export type AdminVendorListResponseBody = z.infer<typeof adminVendorListResponseSchema>;

/** POST /api/admin/vendors/:id/suspend and /restore: the vendor after the override. */
export const adminVendorOverrideResponseSchema = z.strictObject({
  vendor: adminVendorViewSchema,
  previous_status: vendorStatusSchema,
});
export type AdminVendorOverrideResponseBody = z.infer<typeof adminVendorOverrideResponseSchema>;
