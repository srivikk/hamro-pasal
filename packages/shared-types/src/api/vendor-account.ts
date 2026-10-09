import { z } from 'zod';

/**
 * Why a shop cannot be deactivated yet (SPEC vendor flow step 23). Each is money or goods still
 * in motion: closing the account under them would strand a customer, a rider or the ledger.
 */
export const vendorDeactivationBlockers = [
  /** The wallet is below 0: the shop owes the platform. */
  'NEGATIVE_BALANCE',
  /** An order is not finished: unpaid and still payable, placed, preparing, on the road or disputed. */
  'ACTIVE_ORDERS',
  /** A payout was requested or is with the bank and has not been settled. */
  'PENDING_PAYOUT',
  /** A flat-rate ad fee is still owed after everything the wallet holds was taken for it. */
  'AD_FEES_DUE',
] as const;
export const vendorDeactivationBlockerSchema = z.enum(vendorDeactivationBlockers);
export type VendorDeactivationBlocker = z.infer<typeof vendorDeactivationBlockerSchema>;

/**
 * POST /api/vendor/account/deactivate. The confirmation is part of the body, like an ad
 * purchase's `agreed`: the route cannot be triggered by an empty request. Nothing names a shop:
 * it is always the caller's own.
 */
export const vendorDeactivateRequestSchema = z.strictObject({ confirm: z.literal(true) });
export type VendorDeactivateRequest = z.infer<typeof vendorDeactivateRequestSchema>;

export const vendorDeactivateResponseSchema = z.strictObject({
  vendor_id: z.uuid(),
  status: z.literal('DEACTIVATED'),
  deactivated_at: z.iso.datetime(),
  /** Ads that were running or paused and are now CANCELLED. */
  cancelled_ad_count: z.number().int().min(0),
  /** Held ad budget and refundable flat fees returned to the wallet by those cancellations. */
  returned_npr: z.number().min(0),
  /** Campaign opt-ins that were live and are now closed. */
  closed_opt_in_count: z.number().int().min(0),
  /** What the platform still holds for the shop; a Super Admin pays it out. */
  wallet_balance_npr: z.number().min(0),
});
export type VendorDeactivateResponseBody = z.infer<typeof vendorDeactivateResponseSchema>;
