import { z } from 'zod';

import {
  adBillingModelSchema,
  adPurchaseStatusSchema,
  adSlotSchema,
  settlementModelSchema,
} from '../domain/enums';

/*
 * The Ad Marketplace as a shop uses it (Phase 28, SPEC core 8), served under /api/vendor/ads to
 * the shop's own account. An ad exists only because the vendor bought it here: no body of this
 * module names a vendor (the shop is the caller's) or a price (it is the product's).
 */

/** The longest a purchase may be booked ahead. */
export const AD_PURCHASE_MAX_START_AHEAD_DAYS = 90;
/** How far in the past `starts_at` may lie: a request sent "now" on a slow connection. */
export const AD_PURCHASE_START_GRACE_SECONDS = 300;
export const MAX_AD_BUDGET_NPR = 1_000_000;

const wholePaisa = (amount: number) => Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6;

/**
 * How a purchase would be collected from this shop (SPEC core 8, "Collection by settlement
 * model"). LEDGER_BALANCE: taken, or held, from the ledger balance at purchase (Models A and C).
 * PAYOUT_DEDUCTION: taken from what the platform holds for the shop, now and as its orders settle
 * (Model B).
 */
export const adCollections = ['LEDGER_BALANCE', 'PAYOUT_DEDUCTION'] as const;
export const adCollectionSchema = z.enum(adCollections);
export type AdCollection = z.infer<typeof adCollectionSchema>;

/** One placement on sale, as GET /api/vendor/ads/products offers it to this shop. */
export const vendorAdProductViewSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1),
  slot: adSlotSchema,
  billing_model: adBillingModelSchema,
  /** FLAT_RATE: the price of the period. PER_ORDER_PREMIUM: the fee per delivered order. */
  price_npr: z.number().positive(),
  duration_days: z.number().int().min(1).max(90),
  collection: adCollectionSchema,
  /**
   * Models A and C: what the shop must add to its ledger before it can buy this (for a per-order
   * ad, before it can hold the smallest budget, one fee). 0 when it can, and always 0 in Model B.
   */
  recharge_required_npr: z.number().min(0),
});
export type VendorAdProductView = z.infer<typeof vendorAdProductViewSchema>;

export const vendorAdProductListResponseSchema = z.strictObject({
  settlement_model: settlementModelSchema,
  /**
   * What the shop can spend on ads now. Model B: balance + pending escrow, less flat fees it
   * already owes. Model A: its balance. Model C: its balance above the Fixed Reserve. Never
   * negative.
   */
  available_for_ads_npr: z.number().min(0),
  products: z.array(vendorAdProductViewSchema),
});
export type VendorAdProductListResponseBody = z.infer<typeof vendorAdProductListResponseSchema>;

/**
 * The body of POST /api/vendor/ads/purchases. Strict: no vendor, price or billing model.
 * `agreed` must be the literal true: the vendor's explicit agreement to the product's price
 * (SPEC core 8, "No unilateral billing"). `budget_npr` is required for a PER_ORDER_PREMIUM product
 * and refused for a FLAT_RATE one (the service checks it against the product).
 */
export const adPurchaseRequestSchema = z.strictObject({
  ad_product_id: z.uuid(),
  starts_at: z.iso.datetime(),
  budget_npr: z
    .number()
    .positive()
    .max(MAX_AD_BUDGET_NPR)
    .refine(wholePaisa, 'Must be a whole number of paisa')
    .nullable()
    .optional(),
  /** New per purchase and kept across retries: resending it never buys twice. */
  idempotency_key: z.string().trim().min(8).max(100),
  agreed: z.literal(true),
});
export type AdPurchaseRequest = z.infer<typeof adPurchaseRequestSchema>;

/** A purchase as the shop that made it sees it. */
export const adPurchaseViewSchema = z.strictObject({
  id: z.uuid(),
  ad_product_id: z.uuid(),
  product_name: z.string().min(1),
  slot: adSlotSchema,
  /** The terms as agreed: copies of the product's at purchase. */
  billing_model: adBillingModelSchema,
  price_npr: z.number().positive(),
  budget_npr: z.number().positive().nullable(),
  /** The shop's model at purchase, which decides how the charge is collected. */
  settlement_model: settlementModelSchema,
  status: adPurchaseStatusSchema,
  starts_at: z.iso.datetime(),
  ends_at: z.iso.datetime(),
  /** Collected so far. */
  amount_paid_npr: z.number().min(0),
  /** A flat fee not collected yet (Model B): it is taken from the shop's payouts. */
  amount_due_npr: z.number().min(0),
  agreed_at: z.iso.datetime(),
});
export type AdPurchaseView = z.infer<typeof adPurchaseViewSchema>;

export const adPurchaseListResponseSchema = z.strictObject({
  purchases: z.array(adPurchaseViewSchema),
});
export type AdPurchaseListResponseBody = z.infer<typeof adPurchaseListResponseSchema>;

/** 201 for a new purchase, 200 for a replay of the same key (then `replayed` is true). */
export const adPurchaseResponseSchema = z.strictObject({
  purchase: adPurchaseViewSchema,
  available_for_ads_npr: z.number().min(0),
  replayed: z.boolean(),
});
export type AdPurchaseResponseBody = z.infer<typeof adPurchaseResponseSchema>;

/** POST /api/vendor/ads/purchases/:id/cancel: 200, also on repeat. */
export const adPurchaseCancelResponseSchema = z.strictObject({
  purchase: adPurchaseViewSchema,
  available_for_ads_npr: z.number().min(0),
});
export type AdPurchaseCancelResponseBody = z.infer<typeof adPurchaseCancelResponseSchema>;

/** Why a named ad purchase cannot sponsor a promotion: `details.reason` of 422 AD_PURCHASE_MISMATCH. */
export const adPurchaseMismatchReasons = [
  'NOT_FOUND',
  'NOT_RUNNING',
  'SLOT',
  'SHOP',
  'DATES',
] as const;
export const adPurchaseMismatchReasonSchema = z.enum(adPurchaseMismatchReasons);
export type AdPurchaseMismatchReason = z.infer<typeof adPurchaseMismatchReasonSchema>;
