import type { LedgerLineType, Order } from '@hamro-pasal/shared-types';

import { toPaisa } from './money';

/** A ledger account addressed by role; resolved to an account row by LedgerService. */
export type AccountRef =
  | { readonly type: 'SYSTEM_ESCROW' }
  | { readonly type: 'PLATFORM_REVENUE' }
  | { readonly type: 'PAYOUT_CLEARING' }
  | { readonly type: 'AD_REVENUE' }
  | { readonly type: 'AD_BUDGET_CLEARING' }
  | { readonly type: 'GATEWAY_CLEARING'; readonly gateway: 'ESEWA' | 'KHALTI' }
  | { readonly type: 'VENDOR_WALLET'; readonly vendorId: string }
  | { readonly type: 'DRIVER_WALLET'; readonly driverUserId: string };

export interface PlannedPosting {
  readonly account: AccountRef;
  /** Signed change to the account balance, in paisa. */
  readonly amountPaisa: number;
  /** What the posting is; a journal that names none is stored as ADJUSTMENT (the column default). */
  readonly lineType?: LedgerLineType;
  /** Required with an AD_* line: the vendor's own purchase the charge belongs to. */
  readonly adPurchaseId?: string;
}

export class SettlementPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementPlanError';
  }
}

type SettlementOrder = Pick<
  Order,
  | 'id'
  | 'vendor_id'
  | 'driver_user_id'
  | 'subtotal'
  | 'delivery_fee'
  | 'platform_commission_amount'
  | 'fulfillment_locked'
  | 'payment_method'
>;

const ESCROW: AccountRef = { type: 'SYSTEM_ESCROW' };
const REVENUE: AccountRef = { type: 'PLATFORM_REVENUE' };

/** Prepaid capture (SPEC §5): the whole payment lands in SYSTEM_ESCROW. */
export function planPaymentCapture(order: SettlementOrder): PlannedPosting[] {
  if (order.payment_method === 'COD') {
    throw new SettlementPlanError(
      `Order ${order.id} is COD; there is no gateway payment to capture`,
    );
  }
  const total = toPaisa(order.subtotal) + toPaisa(order.delivery_fee);
  return balanced([
    { account: { type: 'GATEWAY_CLEARING', gateway: order.payment_method }, amountPaisa: -total },
    { account: ESCROW, amountPaisa: total },
  ]);
}

/**
 * Settlement after DELIVERED (SPEC §5).
 *   S = subtotal, F = delivery fee, C = platform commission (order snapshot)
 *   Vendor earns S - C. The delivery fee goes to whoever delivered: the vendor on SELF_DELIVERY,
 *   the platform rider on PLATFORM_FLEET / EMERGENCY_FLEET.
 *
 *   Prepaid:      escrow -(S+F) -> vendor +(S-C) [+F], driver [+F], platform +C
 *   COD self:     the vendor already holds all the cash -> vendor -C, platform +C
 *                 (may push the wallet negative; the DB suspends it beyond the limit)
 *   COD fleet:    the rider holds the cash -> driver -(S+F), vendor +(S-C), platform +C,
 *                 driver +F (net: rider owes S to the platform, SPEC's negative float)
 *
 * Zero-amount lines are dropped (e.g. 0% subscription commission). An empty plan means nothing
 * moves.
 */
export function planSettlement(order: SettlementOrder): PlannedPosting[] {
  const subtotal = toPaisa(order.subtotal);
  const fee = toPaisa(order.delivery_fee);
  const commission = toPaisa(order.platform_commission_amount);
  if (subtotal < 0 || fee < 0 || commission < 0) {
    throw new SettlementPlanError(`Order ${order.id} has negative amounts`);
  }
  if (commission > subtotal) {
    throw new SettlementPlanError(`Order ${order.id} commission exceeds its subtotal`);
  }

  const vendor: AccountRef = { type: 'VENDOR_WALLET', vendorId: order.vendor_id };
  const selfDelivered = order.fulfillment_locked === 'SELF_DELIVERY';
  let driver: AccountRef | null = null;
  if (!selfDelivered) {
    if (order.driver_user_id === null) {
      throw new SettlementPlanError(`Fleet order ${order.id} has no driver to pay`);
    }
    driver = { type: 'DRIVER_WALLET', driverUserId: order.driver_user_id };
  }
  const vendorShare = subtotal - commission;

  if (order.payment_method !== 'COD') {
    return balanced([
      { account: ESCROW, amountPaisa: -(subtotal + fee) },
      { account: vendor, amountPaisa: vendorShare + (selfDelivered ? fee : 0) },
      ...(driver === null ? [] : [{ account: driver, amountPaisa: fee }]),
      { account: REVENUE, amountPaisa: commission },
    ]);
  }

  if (driver === null) {
    return balanced([
      { account: vendor, amountPaisa: -commission },
      { account: REVENUE, amountPaisa: commission },
    ]);
  }

  return balanced([
    { account: driver, amountPaisa: -(subtotal + fee) },
    { account: vendor, amountPaisa: vendorShare },
    { account: REVENUE, amountPaisa: commission },
    { account: driver, amountPaisa: fee },
  ]);
}

function balanced(postings: PlannedPosting[]): PlannedPosting[] {
  const nonZero = postings.filter((p) => p.amountPaisa !== 0);
  const sum = nonZero.reduce((total, p) => total + p.amountPaisa, 0);
  if (sum !== 0) {
    throw new SettlementPlanError(`Planned postings are unbalanced by ${String(sum)} paisa`);
  }
  return nonZero.length >= 2 ? nonZero : [];
}
