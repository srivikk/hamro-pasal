import { z } from 'zod';

import { shopPaymentMethodSchema } from '../domain/enums';

/** What a vendor may queue for its next Billing Cycle (SPEC core 4, "Billing Cycle Lock"). */
export const vendorSettings = ['PRICING_PLAN', 'PAYMENT_METHODS'] as const;
export const vendorSettingSchema = z.enum(vendorSettings);
export type VendorSetting = z.infer<typeof vendorSettingSchema>;

export const settingChangeStatuses = ['PENDING', 'APPLIED', 'WITHDRAWN', 'SUPERSEDED'] as const;
export const settingChangeStatusSchema = z.enum(settingChangeStatuses);
export type SettingChangeStatus = z.infer<typeof settingChangeStatusSchema>;

const pricingPlanValue = z.strictObject({ pricing_plan_id: z.uuid() });
const paymentMethodsValue = z.strictObject({
  methods: z
    .array(shopPaymentMethodSchema)
    .min(1)
    .refine((methods) => new Set(methods).size === methods.length, 'A method is listed once'),
});

/**
 * POST /api/vendor/billing/changes. Nothing changes now: the request is queued and the renewal
 * job applies it at `effective_from`, the first instant of the next BS month.
 */
export const billingChangeRequestSchema = z.discriminatedUnion('setting', [
  z.strictObject({ setting: z.literal('PRICING_PLAN'), value: pricingPlanValue }),
  z.strictObject({ setting: z.literal('PAYMENT_METHODS'), value: paymentMethodsValue }),
]);
export type BillingChangeRequest = z.infer<typeof billingChangeRequestSchema>;

export const billingChangeViewSchema = z.strictObject({
  id: z.uuid(),
  setting: vendorSettingSchema,
  current_value: z.record(z.string(), z.json()),
  requested_value: z.record(z.string(), z.json()),
  status: settingChangeStatusSchema,
  requested_at: z.iso.datetime(),
  effective_from: z.iso.datetime(),
});
export type BillingChangeView = z.infer<typeof billingChangeViewSchema>;

/** 202 with the queued change; `change` is null when the request equals the active value. */
export const billingChangeResponseSchema = z.strictObject({
  change: billingChangeViewSchema.nullable(),
});
export type BillingChangeResponseBody = z.infer<typeof billingChangeResponseSchema>;
