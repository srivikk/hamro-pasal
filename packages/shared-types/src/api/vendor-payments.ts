import { z } from 'zod';

import {
  gatewayPaymentMethodSchema,
  pricingModelSchema,
  settlementModelSchema,
  shopPaymentMethodSchema,
} from '../domain/enums';
import { billingChangeViewSchema } from './vendor-billing';

/*
 * 2026-10-21 (SPEC core 4, 5 and 9): what a shop sees and sets about how it is paid, served under
 * /api/vendor to the shop's own account.
 */

/** A pricing plan as a shop sees it: the terms, never the vendor count. */
export const offeredPlanViewSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1),
  model: pricingModelSchema,
  commission_rate: z.number().min(0).max(100),
  monthly_fee_npr: z.number().min(0),
  duration_cycles: z.number().int().positive().nullable(),
});
export type OfferedPlanView = z.infer<typeof offeredPlanViewSchema>;

/**
 * GET /api/vendor/billing: the active plan and methods, the cycle, what is queued, and the plans
 * the shop may choose itself. Only Subscription plans are self-selectable (decided 2026-10-21);
 * Commission and Free plans are assigned by a Super Admin.
 */
export const vendorBillingViewSchema = z.strictObject({
  vendor_id: z.uuid(),
  settlement_model: settlementModelSchema,
  pricing_plan: offeredPlanViewSchema.nullable(),
  accepted_payment_methods: z.array(shopPaymentMethodSchema).min(1),
  billing_cycle_started_at: z.iso.datetime().nullable(),
  billing_cycle_ends_at: z.iso.datetime().nullable(),
  pending_changes: z.array(billingChangeViewSchema),
  self_selectable_plans: z.array(offeredPlanViewSchema),
  /** Cycle dues still to clear (SPEC core 4, "Cycle dues"), else null. */
  dues: z
    .strictObject({
      amount_npr: z.number().positive(),
      opened_at: z.iso.datetime(),
      due_at: z.iso.datetime(),
    })
    .nullable(),
  /** Model C only: the Fixed Reserve the prepaid balance must stay at or above. */
  prepaid_reserve_npr: z.number().positive(),
});
export type VendorBillingView = z.infer<typeof vendorBillingViewSchema>;

/**
 * A shop's own eSewa / Khalti merchant account (Model C, SPEC core 9 "Model C credentials"). The
 * secret is stored encrypted and never returned. `verified_at` is set by a Super Admin; a gateway
 * is offered to customers only while it is verified.
 */
export const gatewayAccountViewSchema = z.strictObject({
  gateway: gatewayPaymentMethodSchema,
  merchant_code: z.string().min(1),
  /** The last four characters of the secret, so the vendor can tell which one is stored. */
  secret_hint: z.string().length(4),
  verified_at: z.iso.datetime().nullable(),
  updated_at: z.iso.datetime(),
});
export type GatewayAccountView = z.infer<typeof gatewayAccountViewSchema>;

/** PUT /api/vendor/gateway-accounts/:gateway. A changed secret clears the verification. */
export const gatewayAccountWriteRequestSchema = z.strictObject({
  merchant_code: z
    .string()
    .trim()
    .min(2)
    .max(100)
    .regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, - and _ only'),
  secret_key: z.string().min(8).max(200),
});
export type GatewayAccountWriteRequest = z.infer<typeof gatewayAccountWriteRequestSchema>;

export const gatewayAccountListResponseSchema = z.strictObject({
  accounts: z.array(gatewayAccountViewSchema),
});
export const gatewayAccountResponseSchema = z.strictObject({ account: gatewayAccountViewSchema });
export type GatewayAccountListResponseBody = z.infer<typeof gatewayAccountListResponseSchema>;
export type GatewayAccountResponseBody = z.infer<typeof gatewayAccountResponseSchema>;

/**
 * PUT /api/admin/vendors/:id/pricing-plan (decided 2026-10-21): a Super Admin assigns any offered
 * plan. A shop with a running Billing Cycle gets it at the cycle's end (queued like a vendor's own
 * change); one without a cycle (not LIVE yet) gets it at once.
 */
export const adminPlanAssignRequestSchema = z.strictObject({ pricing_plan_id: z.uuid() });
export type AdminPlanAssignRequest = z.infer<typeof adminPlanAssignRequestSchema>;

export const adminPlanAssignResponseSchema = z.strictObject({
  vendor_id: z.uuid(),
  pricing_plan_id: z.uuid(),
  effective: z.enum(['NOW', 'NEXT_CYCLE']),
  effective_from: z.iso.datetime().nullable(),
});
export type AdminPlanAssignResponseBody = z.infer<typeof adminPlanAssignResponseSchema>;
