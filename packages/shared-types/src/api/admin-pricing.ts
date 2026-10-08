import { z } from 'zod';

import { pricingModelSchema } from '../domain/enums';

/*
 * Super Admin contracts for the pricing plans vendors may choose (Phase 26, SPEC core 4
 * "Onboarding Models"). Served under /api/admin/pricing-plans to SUPER_ADMIN tokens only.
 */

export const MAX_FREE_PLAN_CYCLES = 36;

const planName = z.string().trim().min(1).max(80);

/**
 * The body of POST /api/admin/pricing-plans. Exactly one of the three terms is set, by the
 * model: a commission rate, a monthly fee, or the number of Billing Cycles a Free plan lasts.
 */
export const pricingPlanCreateRequestSchema = z
  .strictObject({
    name: planName,
    model: pricingModelSchema,
    /** Percent of each order; COMMISSION only, otherwise 0. */
    commission_rate: z.number().multipleOf(0.01).min(0).max(100),
    /** NPR per Billing Cycle (BS month); SUBSCRIPTION only, otherwise 0. */
    monthly_fee_npr: z.number().multipleOf(0.01).min(0).max(1_000_000),
    /** How many Billing Cycles the plan lasts; FREE only, otherwise null. */
    duration_cycles: z.number().int().min(1).max(MAX_FREE_PLAN_CYCLES).nullable(),
    is_offered: z.boolean(),
    is_default: z.boolean(),
  })
  .refine(
    (plan) => (plan.model === 'COMMISSION' ? plan.commission_rate > 0 : plan.commission_rate === 0),
    {
      path: ['commission_rate'],
      message: 'A Commission plan has a rate above 0; no other plan has one',
    },
  )
  .refine(
    (plan) =>
      plan.model === 'SUBSCRIPTION' ? plan.monthly_fee_npr > 0 : plan.monthly_fee_npr === 0,
    {
      path: ['monthly_fee_npr'],
      message: 'A Subscription plan has a fee above 0; no other plan has one',
    },
  )
  .refine((plan) => (plan.model === 'FREE') === (plan.duration_cycles !== null), {
    path: ['duration_cycles'],
    message: 'A Free plan, and only a Free plan, states how many cycles it lasts',
  })
  .refine((plan) => !plan.is_default || (plan.model === 'COMMISSION' && plan.is_offered), {
    path: ['is_default'],
    message: 'The default plan is an offered Commission plan',
  });
export type PricingPlanCreate = z.infer<typeof pricingPlanCreateRequestSchema>;

/**
 * The body of PATCH /api/admin/pricing-plans/:id: the three editable fields, all sent. Strict on
 * purpose: it has no model, rate, fee or duration, so any of them is a 400. A plan's terms never
 * change, because vendors and their orders are accounted under them: a new rate is a new plan,
 * and the old one is withdrawn.
 */
export const pricingPlanUpdateRequestSchema = z
  .strictObject({
    name: planName,
    /** Withdrawn plans cannot be selected; vendors already on one keep it. */
    is_offered: z.boolean(),
    is_default: z.boolean(),
  })
  .refine((plan) => !plan.is_default || plan.is_offered, {
    path: ['is_offered'],
    message: 'The default plan must stay on offer',
  });
export type PricingPlanUpdate = z.infer<typeof pricingPlanUpdateRequestSchema>;

/** One plan as GET /api/admin/pricing-plans lists it. */
export const pricingPlanViewSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1),
  model: pricingModelSchema,
  commission_rate: z.number().min(0).max(100),
  monthly_fee_npr: z.number().min(0),
  duration_cycles: z.number().int().min(1).nullable(),
  is_offered: z.boolean(),
  is_default: z.boolean(),
  /** Vendors whose active plan this is. Read only. */
  vendor_count: z.number().int().min(0),
  created_at: z.iso.datetime(),
});
export type PricingPlanView = z.infer<typeof pricingPlanViewSchema>;

/** GET /api/admin/pricing-plans: every plan, withdrawn ones included, by name. */
export const adminPricingPlanListResponseSchema = z.strictObject({
  plans: z.array(pricingPlanViewSchema),
});
export type AdminPricingPlanListResponseBody = z.infer<typeof adminPricingPlanListResponseSchema>;

/** POST (201) and PATCH (200) /api/admin/pricing-plans. */
export const adminPricingPlanResponseSchema = z.strictObject({ plan: pricingPlanViewSchema });
export type AdminPricingPlanResponseBody = z.infer<typeof adminPricingPlanResponseSchema>;
