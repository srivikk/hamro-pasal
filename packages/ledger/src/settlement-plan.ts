import type { LedgerLineType, Order } from '@hamro-pasal/shared-types';

import { toPaisa } from './money';

/** A ledger account addressed by role; resolved to an account row by LedgerService. */
export type AccountRef =
  | { readonly type: 'SYSTEM_ESCROW' }
  | { readonly type: 'PLATFORM_REVENUE' }
  | { readonly type: 'PAYOUT_CLEARING' }
  | { readonly type: 'AD_REVENUE' }
  | { readonly type: 'AD_BUDGET_CLEARING' }
  | { readonly type: 'PROMO_EXPENSE' }
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
> &
  // Absent on an order read before the discount columns existed: no discount.
  Partial<Pick<Order, 'platform_promo_discount_npr' | 'platform_promo_vendor_share_npr'>>;

/** What the customer pays for an order, in paisa: subtotal − campaign discount + delivery fee. */
export function orderTotalPaisa(
  order: Pick<SettlementOrder, 'subtotal' | 'delivery_fee' | 'platform_promo_discount_npr'>,
): number {
  return (
    toPaisa(order.subtotal) -
    toPaisa(order.platform_promo_discount_npr ?? 0) +
    toPaisa(order.delivery_fee)
  );
}

const ESCROW: AccountRef = { type: 'SYSTEM_ESCROW' };
const REVENUE: AccountRef = { type: 'PLATFORM_REVENUE' };
const PROMO: AccountRef = { type: 'PROMO_EXPENSE' };

/** Prepaid capture (SPEC §5): the whole payment lands in SYSTEM_ESCROW. */
export function planPaymentCapture(order: SettlementOrder): PlannedPosting[] {
  if (order.payment_method === 'COD') {
    throw new SettlementPlanError(
      `Order ${order.id} is COD; there is no gateway payment to capture`,
    );
  }
  // What the gateway was asked for and confirmed: the discounted total.
  const total = orderTotalPaisa(order);
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
 * With a platform campaign discount Dp, of which the vendor bears Dpv and the platform Dpp
 * (SPEC core 9; C was already charged on S - Dpv at checkout): the customer paid S - Dp + F, the
 * vendor earns S - Dpv - C, and the platform's share is its marketing cost, PROMO_EXPENSE -Dpp.
 *
 *   Prepaid:      escrow -(S-Dp+F) -> vendor +(S-Dpv-C) [+F], driver [+F], platform +C, promo -Dpp
 *   COD self:     the vendor holds S-Dp+F in cash -> vendor +(Dpp-C), platform +C, promo -Dpp
 *                 (the platform owes the vendor its share of the discount, less the commission)
 *   COD fleet:    driver -(S-Dp+F), vendor +(S-Dpv-C), platform +C, driver +F, promo -Dpp
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
  const discount = toPaisa(order.platform_promo_discount_npr ?? 0);
  const vendorDiscount = toPaisa(order.platform_promo_vendor_share_npr ?? 0);
  if (discount < 0 || vendorDiscount < 0 || vendorDiscount > discount || discount > subtotal) {
    throw new SettlementPlanError(`Order ${order.id} has an impossible discount`);
  }
  const platformDiscount = discount - vendorDiscount;
  if (commission > subtotal - vendorDiscount) {
    throw new SettlementPlanError(
      `Order ${order.id} commission exceeds its subtotal (net of the discount the vendor bears)`,
    );
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
  const vendorShare = subtotal - vendorDiscount - commission;
  const paid = subtotal - discount + fee;

  if (order.payment_method !== 'COD') {
    return balanced([
      { account: ESCROW, amountPaisa: -paid },
      { account: vendor, amountPaisa: vendorShare + (selfDelivered ? fee : 0) },
      ...(driver === null ? [] : [{ account: driver, amountPaisa: fee }]),
      { account: REVENUE, amountPaisa: commission },
      { account: PROMO, amountPaisa: -platformDiscount },
    ]);
  }

  if (driver === null) {
    return balanced([
      { account: vendor, amountPaisa: platformDiscount - commission },
      { account: REVENUE, amountPaisa: commission },
      { account: PROMO, amountPaisa: -platformDiscount },
    ]);
  }

  return balanced([
    { account: driver, amountPaisa: -paid },
    { account: vendor, amountPaisa: vendorShare },
    { account: REVENUE, amountPaisa: commission },
    { account: driver, amountPaisa: fee },
    { account: PROMO, amountPaisa: -platformDiscount },
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
