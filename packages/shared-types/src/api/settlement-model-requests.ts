import { z } from 'zod';

import { PREPAID_FIXED_RESERVE_NPR } from '../domain/constants';

import { nepalPhoneSchema } from '../domain/entities';
import {
  campaignOptInStatusSchema,
  discountKindSchema,
  settlementModelRequestStatusSchema,
  settlementModelSchema,
} from '../domain/enums';

/*
 * Settlement model change requests (Phase 27, SPEC core 5): a vendor asks to move to another
 * settlement model, a Super Admin approves or rejects the request as it was made. Also the
 * vendor's own view of the platform campaigns (SPEC core 7), served under /api/vendor/campaigns.
 */

export const MODEL_CHANGE_REJECTION_REASON_MAX_LENGTH = 500;

/**
 * The body of POST /api/vendor/ledger/settlement-model. The shop is the caller's. Model C
 * (`DIRECT_PREPAID`) can be requested since 2026-10-21; its approval needs the prepaid balance
 * at the Fixed Reserve (409 SETTLEMENT_CHANGE_BLOCKED, BELOW_PREPAID_RESERVE).
 */
export const settlementModelChangeRequestSchema = z.strictObject({
  model: settlementModelSchema,
});
export type SettlementModelChangeRequest = z.infer<typeof settlementModelChangeRequestSchema>;

/** A request as the shop that made it sees it. */
export const vendorModelChangeRequestViewSchema = z.strictObject({
  id: z.uuid(),
  from_model: settlementModelSchema,
  requested_model: settlementModelSchema,
  status: settlementModelRequestStatusSchema,
  requested_at: z.iso.datetime(),
  decided_at: z.iso.datetime().nullable(),
  rejection_reason: z.string().min(1).nullable(),
});
export type VendorModelChangeRequestView = z.infer<typeof vendorModelChangeRequestViewSchema>;

/** 201 from POST /api/vendor/ledger/settlement-model. */
export const vendorModelChangeRequestResponseSchema = z.strictObject({
  request: vendorModelChangeRequestViewSchema,
});
export type VendorModelChangeRequestResponseBody = z.infer<
  typeof vendorModelChangeRequestResponseSchema
>;

/**
 * One request as GET /api/admin/settlement-model-requests lists it. The vendor asked for it from
 * its own account; an admin cannot create one.
 */
export const modelChangeRequestViewSchema = z
  .strictObject({
    id: z.uuid(),
    vendor_id: z.uuid(),
    business_name: z.string().min(1),
    phone: nepalPhoneSchema,
    /** The shop's model now. After an approval it equals `requested_model`. */
    current_model: settlementModelSchema,
    /** The model the shop was on when it asked. */
    from_model: settlementModelSchema,
    requested_model: settlementModelSchema,
    status: settlementModelRequestStatusSchema,
    requested_at: z.iso.datetime(),
    /** What stands in the way of the change taking effect, as the server sees it now. */
    open_order_count: z.number().int().min(0),
    ledger_balance_npr: z.number(),
    active_ad_count: z.number().int().min(0),
    decided_at: z.iso.datetime().nullable(),
    rejection_reason: z.string().min(1).nullable(),
  })
  .refine((request) => request.from_model !== request.requested_model, {
    message: 'A request asks for a different model',
  })
  .refine((request) => (request.status === 'PENDING') === (request.decided_at === null), {
    message: 'Exactly a pending request is undecided',
  })
  .refine((request) => request.rejection_reason === null || request.status === 'REJECTED', {
    message: 'Only a rejected request has a reason',
  });
export type ModelChangeRequestView = z.infer<typeof modelChangeRequestViewSchema>;

export const modelChangeBlockers = [
  'OPEN_ORDERS',
  'NEGATIVE_BALANCE',
  'ACTIVE_AD',
  /** 2026-10-21: a move to Model C needs the prepaid balance at the Fixed Reserve first. */
  'BELOW_PREPAID_RESERVE',
] as const;
export type ModelChangeBlocker = (typeof modelChangeBlockers)[number];

/**
 * Why a change cannot take effect yet (SPEC core 5): a shop changes model only with no open
 * order, a ledger at 0 or above, and no ad running. The server applies the same rule to its own
 * counts under the vendor row lock (409 SETTLEMENT_CHANGE_BLOCKED, `details.blockers`).
 */
export function modelChangeBlockersOf(
  request: Pick<
    ModelChangeRequestView,
    'open_order_count' | 'ledger_balance_npr' | 'active_ad_count' | 'requested_model'
  >,
  prepaidReserveNpr: number = PREPAID_FIXED_RESERVE_NPR,
): ModelChangeBlocker[] {
  const blockers: ModelChangeBlocker[] = [];
  if (request.open_order_count > 0) blockers.push('OPEN_ORDERS');
  if (request.ledger_balance_npr < 0) blockers.push('NEGATIVE_BALANCE');
  if (request.active_ad_count > 0) blockers.push('ACTIVE_AD');
  if (
    request.requested_model === 'DIRECT_PREPAID' &&
    request.ledger_balance_npr < prepaidReserveNpr
  ) {
    blockers.push('BELOW_PREPAID_RESERVE');
  }
  return blockers;
}

/** GET /api/admin/settlement-model-requests?status= */
export const adminModelChangeRequestListQuerySchema = z.strictObject({
  status: settlementModelRequestStatusSchema.optional(),
});

/** Pending requests first (the longest waiting first), then the decided ones, latest first. */
export const adminModelChangeRequestListResponseSchema = z.strictObject({
  requests: z.array(modelChangeRequestViewSchema),
});
export type AdminModelChangeRequestListResponseBody = z.infer<
  typeof adminModelChangeRequestListResponseSchema
>;

/**
 * The optional body of POST …/:id/reject. The reason is shown to the vendor; blank is none.
 * Approve takes no body: **neither decision carries a model**, so an admin decides the request
 * as the vendor made it and cannot choose a model for a shop.
 */
export const adminModelChangeRejectRequestSchema = z.strictObject({
  reason: z
    .string()
    .trim()
    .max(MODEL_CHANGE_REJECTION_REASON_MAX_LENGTH)
    .nullish()
    .transform((reason) =>
      reason === undefined || reason === null || reason === '' ? null : reason,
    ),
});
export type AdminModelChangeRejectRequest = z.infer<typeof adminModelChangeRejectRequestSchema>;

/** 200 from approve and reject, also on a repeat of the same decision. */
export const adminModelChangeDecisionResponseSchema = z.strictObject({
  request: modelChangeRequestViewSchema,
});
export type AdminModelChangeDecisionResponseBody = z.infer<
  typeof adminModelChangeDecisionResponseSchema
>;

// The vendor's view of campaigns -----------------------------------------------------------

/**
 * One campaign as GET /api/vendor/campaigns lists it: the terms the shop would agree to (send
 * `terms_version` back with the opt-in) and where the shop stands on it.
 */
export const vendorCampaignViewSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1),
  kind: discountKindSchema,
  value: z.number().positive(),
  max_discount_npr: z.number().positive().nullable(),
  min_cart_npr: z.number().min(0),
  /** The share of each discount taken from the shop's payout. */
  vendor_share_percent: z.number().min(0).max(100),
  terms_version: z.number().int().min(1),
  starts_at: z.iso.datetime(),
  ends_at: z.iso.datetime(),
  /**
   * The shop's latest opt-in, or null when it never opted in. ACTIVE: the campaign applies to
   * the shop. OPTED_OUT: the shop left. VOIDED: the terms changed after the shop agreed, and the
   * campaign applies again only after a new opt-in to `terms_version`.
   */
  opt_in_status: campaignOptInStatusSchema.nullable(),
  opt_in_terms_version: z.number().int().min(1).nullable(),
  /** When the shop's ACTIVE opt-in was made; null unless `opt_in_status` is ACTIVE. */
  opted_in_at: z.iso.datetime().nullable(),
});
export type VendorCampaignView = z.infer<typeof vendorCampaignViewSchema>;

/** GET /api/vendor/campaigns: published campaigns that have not ended, the soonest to end first. */
export const vendorCampaignListResponseSchema = z.strictObject({
  campaigns: z.array(vendorCampaignViewSchema),
});
export type VendorCampaignListResponseBody = z.infer<typeof vendorCampaignListResponseSchema>;
