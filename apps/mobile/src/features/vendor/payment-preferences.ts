import {
  gatewayPaymentMethods,
  shopPaymentMethodSchema,
  type BillingChangeView,
  type GatewayAccountView,
  type GatewayPaymentMethod,
  type ShopPaymentMethod,
  type VendorBillingView,
  type VendorSetting,
} from '@hamro-pasal/shared-types';
import { z } from 'zod';

/*
 * Pure rules of the Seller App's Payments screen (2026-10-21), kept free of React so they are
 * unit-tested on their own.
 *
 * The screen offers two switches: Cash on Delivery and Prepayment. Prepayment is eSewa and Khalti
 * together (the customer's wallet follows them on the server and is never stored). At least one
 * switch stays on: a shop must take some payment.
 */

export interface PaymentChoice {
  cod: boolean;
  prepayment: boolean;
}

const methodsValueSchema = z.object({ methods: z.array(shopPaymentMethodSchema).min(1) });

export function choiceOf(methods: readonly ShopPaymentMethod[]): PaymentChoice {
  return {
    cod: methods.includes('COD'),
    prepayment: methods.some((method) => method === 'ESEWA' || method === 'KHALTI'),
  };
}

/** The methods to request for a choice, eSewa and Khalti first; null when both are off. */
export function methodsOf(choice: PaymentChoice): ShopPaymentMethod[] | null {
  const methods: ShopPaymentMethod[] = [
    ...(choice.prepayment ? gatewayPaymentMethods : []),
    ...(choice.cod ? (['COD'] as const) : []),
  ];
  return methods.length === 0 ? null : methods;
}

/** Flips one switch, unless that would leave the shop with no way to be paid. */
export function toggle(choice: PaymentChoice, key: keyof PaymentChoice): PaymentChoice {
  const next = { ...choice, [key]: !choice[key] };
  return methodsOf(next) === null ? choice : next;
}

export function sameChoice(a: PaymentChoice, b: PaymentChoice): boolean {
  return a.cod === b.cod && a.prepayment === b.prepayment;
}

/** The change of this setting still waiting for the next Billing Cycle, if any. */
export function pendingChangeOf(
  billing: VendorBillingView,
  setting: VendorSetting,
): BillingChangeView | null {
  return (
    billing.pending_changes.find(
      (change) => change.setting === setting && change.status === 'PENDING',
    ) ?? null
  );
}

/** What the shop will accept from the next cycle on: the queued methods, else today's. */
export function upcomingChoice(billing: VendorBillingView): PaymentChoice {
  const pending = pendingChangeOf(billing, 'PAYMENT_METHODS');
  const queued = methodsValueSchema.safeParse(pending?.requested_value);
  return choiceOf(queued.success ? queued.data.methods : billing.accepted_payment_methods);
}

/** The plan id a queued PRICING_PLAN change asks for, if any. */
export function upcomingPlanId(billing: VendorBillingView): string | null {
  const pending = pendingChangeOf(billing, 'PRICING_PLAN');
  const value = z.object({ pricing_plan_id: z.string() }).safeParse(pending?.requested_value);
  return value.success ? value.data.pricing_plan_id : null;
}

/** Model C: customers pay the shop's own eSewa / Khalti merchant account directly. */
export function takesDirectPayments(billing: VendorBillingView): boolean {
  return billing.settlement_model === 'DIRECT_PREPAID';
}

export type MerchantAccountState = 'MISSING' | 'AWAITING_VERIFICATION' | 'VERIFIED';

/** A gateway is offered to customers only once a Super Admin has verified its account. */
export function merchantAccountState(
  account: GatewayAccountView | undefined,
): MerchantAccountState {
  if (account === undefined) return 'MISSING';
  return account.verified_at === null ? 'AWAITING_VERIFICATION' : 'VERIFIED';
}

export function accountFor(
  accounts: readonly GatewayAccountView[],
  gateway: GatewayPaymentMethod,
): GatewayAccountView | undefined {
  return accounts.find((account) => account.gateway === gateway);
}
