import { z } from 'zod';

import {
  ADMIN_DISPUTE_LIST_DEFAULT_LIMIT,
  ESCALATION_REASON_MAX_LENGTH,
  ESCALATION_REASON_MIN_LENGTH,
  RESOLUTION_NOTE_MAX_LENGTH,
  RESOLUTION_NOTE_MIN_LENGTH,
} from '../domain/constants';
import { disputeStatusSchema, orderStateSchema, paymentMethodSchema } from '../domain/enums';

/*
 * Step 7.3 (SPEC core 6): an order conversation, its escalation to Hamro Pasal, the 7-day hold
 * of a prepaid order earnings, and the Super Admin resolution.
 */

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);

/** POST /api/orders/:id/escalate and POST /api/vendors/orders/:id/escalate. */
export const escalationRequestSchema = z.strictObject({
  reason: trimmed(ESCALATION_REASON_MIN_LENGTH, ESCALATION_REASON_MAX_LENGTH),
});
export type EscalationRequest = z.infer<typeof escalationRequestSchema>;

/** What a party sees of its order conversation. */
export const conversationViewSchema = z.strictObject({
  dispute_id: z.uuid(),
  order_id: z.uuid(),
  status: disputeStatusSchema,
  escalated_at: z.iso.datetime().nullable(),
  escalation_reason: z.string().nullable(),
  /** When the conversation closes (7 days after delivery); null before delivery. */
  window_ends_at: z.iso.datetime().nullable(),
});
export type ConversationView = z.infer<typeof conversationViewSchema>;

export const escalationResponseSchema = z.strictObject({
  conversation: conversationViewSchema,
});
export type EscalationResponseBody = z.infer<typeof escalationResponseSchema>;

export const resolutionOutcomes = ['RELEASE', 'REFUND', 'PARTIAL_REFUND'] as const;
export const resolutionOutcomeSchema = z.enum(resolutionOutcomes);
export type ResolutionOutcome = z.infer<typeof resolutionOutcomeSchema>;

/**
 * POST /api/admin/disputes/:id/resolve. RELEASE pays the held amount to the vendor; REFUND gives
 * the customer everything it paid; PARTIAL_REFUND gives it `refund_npr` (more than 0, less than it
 * paid) and releases the rest.
 */
export const resolutionRequestSchema = z
  .strictObject({
    outcome: resolutionOutcomeSchema,
    refund_npr: z.number().positive().multipleOf(0.01).optional(),
    note: trimmed(RESOLUTION_NOTE_MIN_LENGTH, RESOLUTION_NOTE_MAX_LENGTH),
  })
  .refine((body) => (body.outcome === 'PARTIAL_REFUND') === (body.refund_npr !== undefined), {
    path: ['refund_npr'],
    message: 'refund_npr is given for PARTIAL_REFUND only',
  });
export type ResolutionRequest = z.infer<typeof resolutionRequestSchema>;

/** One escalated (or resolved) order in the Super Admin list. */
export const adminDisputeViewSchema = z.strictObject({
  dispute_id: z.uuid(),
  order_id: z.uuid(),
  order_state: orderStateSchema,
  payment_method: paymentMethodSchema,
  status: disputeStatusSchema,
  vendor_id: z.uuid(),
  business_name: z.string(),
  customer_first_name: z.string().nullable(),
  /** What the customer paid. */
  order_total_npr: z.number().nonnegative(),
  /** What is held for this order now (0 for cash, or once resolved). */
  held_npr: z.number().nonnegative(),
  escalated_by: z.enum(['CUSTOMER', 'VENDOR']).nullable(),
  escalation_reason: z.string().nullable(),
  escalated_at: z.iso.datetime().nullable(),
  delivered_at: z.iso.datetime().nullable(),
  refund_npr: z.number().nonnegative().nullable(),
  resolution_note: z.string().nullable(),
  resolved_at: z.iso.datetime().nullable(),
});
export type AdminDisputeView = z.infer<typeof adminDisputeViewSchema>;

/** GET /api/admin/disputes?status=&cursor=&limit=, oldest escalation first. */
export const adminDisputeListQuerySchema = z.strictObject({
  status: z.enum(['ESCALATED', 'RESOLVED']).default('ESCALATED'),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(ADMIN_DISPUTE_LIST_DEFAULT_LIMIT),
});
export type AdminDisputeListQuery = z.infer<typeof adminDisputeListQuerySchema>;

export const adminDisputeListResponseSchema = z.strictObject({
  disputes: z.array(adminDisputeViewSchema),
  next_cursor: z.uuid().nullable(),
});
export type AdminDisputeListResponseBody = z.infer<typeof adminDisputeListResponseSchema>;

export const adminDisputeResponseSchema = z.strictObject({
  dispute: adminDisputeViewSchema,
});
export type AdminDisputeResponseBody = z.infer<typeof adminDisputeResponseSchema>;
