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
  | { readonly type: 'REFUND_CLEARING' }
  | { readonly type: 'VENDOR_DISPUTE_HOLD'; readonly vendorId: string }
  | { readonly type: 'GATEWAY_CLEARING'; readonly gateway: 'ESEWA' | 'KHALTI' }
  | { readonly type: 'VENDOR_WALLET'; readonly vendorId: string }
  | { readonly type: 'CUSTOMER_WALLET'; readonly customerUserId: string }
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
  | 'customer_id'
  | 'driver_user_id'
  | 'subtotal'
  | 'delivery_fee'
  | 'platform_commission_amount'
  | 'fulfillment_locked'
  | 'payment_method'
> &
  // Absent on an order read before settlement models existed: Model B.
  Partial<Pick<Order, 'settlement_model_locked'>> &
  // Absent on an order read before the discount columns existed: no discount.
  Partial<
    Pick<
      Order,
      | 'vendor_offer_discount_npr'
      | 'platform_promo_discount_npr'
      | 'platform_promo_vendor_share_npr'
      | 'platform_delivery_subsidy_npr'
    >
  >;

/** Both discounts on an order's goods, in paisa: the vendor's own offer and the campaign. */
export function orderDiscountPaisa(
  order: Pick<SettlementOrder, 'vendor_offer_discount_npr' | 'platform_promo_discount_npr'>,
): number {
  return (
    toPaisa(order.vendor_offer_discount_npr ?? 0) + toPaisa(order.platform_promo_discount_npr ?? 0)
  );
}

/**
 * What the customer pays for an order, in paisa:
 * subtotal − vendor offer − campaign discount + delivery fee (SPEC core 9).
 */
export function orderTotalPaisa(
  order: Pick<
    SettlementOrder,
    'subtotal' | 'delivery_fee' | 'vendor_offer_discount_npr' | 'platform_promo_discount_npr'
  >,
): number {
  return toPaisa(order.subtotal) - orderDiscountPaisa(order) + toPaisa(order.delivery_fee);
}

const ESCROW: AccountRef = { type: 'SYSTEM_ESCROW' };
const REVENUE: AccountRef = { type: 'PLATFORM_REVENUE' };
const PROMO: AccountRef = { type: 'PROMO_EXPENSE' };

/** The settlement model an order was placed under; an order older than the column is Model B. */
export function isDirectPrepaid(order: Pick<SettlementOrder, 'settlement_model_locked'>): boolean {
  return order.settlement_model_locked === 'DIRECT_PREPAID';
}

/** Where a prepaid order's money came from: a gateway's clearing account, or the customer's wallet. */
function paymentSource(order: SettlementOrder): AccountRef {
  if (order.payment_method === 'COD') {
    throw new SettlementPlanError(`Order ${order.id} is COD; there is no payment to capture`);
  }
  return order.payment_method === 'WALLET'
    ? { type: 'CUSTOMER_WALLET', customerUserId: order.customer_id }
    : { type: 'GATEWAY_CLEARING', gateway: order.payment_method };
}

/**
 * Prepaid capture (SPEC §5): the whole payment lands in SYSTEM_ESCROW, from the gateway's clearing
 * account or (2026-10-21) the customer's own wallet. A Model C order's payment never passes through
 * the platform: a gateway paid the shop's own merchant account (nothing to post), and a wallet
 * payment goes straight to the shop's prepaid balance.
 */
export function planPaymentCapture(order: SettlementOrder): PlannedPosting[] {
  const source = paymentSource(order);
  // What the gateway was asked for and confirmed: the discounted total.
  const total = orderTotalPaisa(order);
  if (isDirectPrepaid(order)) {
    if (order.payment_method !== 'WALLET') return [];
    return balanced([
      { account: source, amountPaisa: -total },
      {
        account: { type: 'VENDOR_WALLET', vendorId: order.vendor_id },
        amountPaisa: total,
        lineType: 'ORDER_PROCEEDS',
      },
    ]);
  }
  return balanced([
    { account: source, amountPaisa: -total },
    { account: ESCROW, amountPaisa: total },
  ]);
}

/** The payment capture undone, posting for posting: a paid order that could not be placed. */
export function planPaymentReversal(order: SettlementOrder): PlannedPosting[] {
  return planPaymentCapture(order).map((posting) => ({
    ...posting,
    amountPaisa: -posting.amountPaisa,
    lineType: 'REFUND' as const,
  }));
}

/**
 * Model C (2026-10-21, SPEC core 5): every platform fee is debited from the shop's prepaid balance
 * the moment the order is placed. Today that is the commission (the per-order ad premium is still
 * charged at delivery). Empty for any other model, or a 0% commission.
 */
export function planOrderFee(order: SettlementOrder): PlannedPosting[] {
  if (!isDirectPrepaid(order)) return [];
  const commission = toPaisa(order.platform_commission_amount);
  return balanced([
    {
      account: { type: 'VENDOR_WALLET', vendorId: order.vendor_id },
      amountPaisa: -commission,
      lineType: 'PLATFORM_COMMISSION',
    },
    { account: REVENUE, amountPaisa: commission, lineType: 'PLATFORM_COMMISSION' },
  ]);
}

/**
 * A placed order cancelled (customer, vendor reject, 5-minute auto-cancel): the money that moves
 * back, in one journal (2026-10-21).
 *  - Model B wallet order: escrow -T, customer wallet +T (refunded at once, nothing to pay by hand).
 *  - Model B gateway order: nothing moves; the payment waits in escrow with `refund_required`.
 *  - Model C: the fee debited at PLACED goes back to the shop (revenue -C, shop +C). A wallet
 *    payment goes back from the shop's balance to the customer's wallet; a gateway payment (which
 *    the shop received directly) is owed to the customer: shop -T, REFUND_CLEARING +T, paid by
 *    hand like every recorded refund (decided 2026-10-15).
 * Empty when nothing moves.
 */
export function planCancellationRefund(
  order: SettlementOrder & Pick<Order, 'payment_status'>,
): PlannedPosting[] {
  const paid = order.payment_status === 'PAID' && order.payment_method !== 'COD';
  const total = orderTotalPaisa(order);
  const vendor: AccountRef = { type: 'VENDOR_WALLET', vendorId: order.vendor_id };
  if (!isDirectPrepaid(order)) {
    if (!paid || order.payment_method !== 'WALLET') return [];
    return balanced([
      { account: ESCROW, amountPaisa: -total },
      { account: paymentSource(order), amountPaisa: total, lineType: 'REFUND' },
    ]);
  }
  const commission = toPaisa(order.platform_commission_amount);
  const postings: PlannedPosting[] = [
    { account: REVENUE, amountPaisa: -commission, lineType: 'PLATFORM_COMMISSION' },
    { account: vendor, amountPaisa: commission, lineType: 'PLATFORM_COMMISSION' },
  ];
  if (paid) {
    postings.push(
      { account: vendor, amountPaisa: -total, lineType: 'REFUND' },
      {
        account:
          order.payment_method === 'WALLET' ? paymentSource(order) : { type: 'REFUND_CLEARING' },
        amountPaisa: total,
        lineType: 'REFUND',
      },
    );
  }
  return balanced(postings);
}

/**
 * Settlement after DELIVERED (SPEC §5).
 *   S = subtotal, F = delivery fee, C = platform commission (order snapshot)
 *   Vendor earns S - C. The delivery fee goes to whoever delivered: the vendor on SELF_DELIVERY,
 *   the platform rider on PLATFORM_FLEET / EMERGENCY_FLEET.
 *
 *   Prepaid:      escrow -(S+F) -> vendor +(S-C) [+F], driver [+F], platform +C
 *                 Step 7.3 (SPEC core 6): the vendor's part goes to its VENDOR_DISPUTE_HOLD, not
 *                 its wallet, until the 7-day window has closed (DISPUTE_HOLD line).
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
 * With the vendor's own offer Dv as well (it is applied first; Dp is on S - Dv, and C was charged
 * on S - Dv - Dpv): the vendor funds all of Dv, so it comes off both what the customer paid and
 * what the vendor earns, and no other account moves for it.
 *
 *   Prepaid:      escrow -(S-Dv-Dp+F) -> vendor +(S-Dv-Dpv-C) [+F], driver [+F], platform +C, promo -Dpp
 *   COD self:     the vendor holds S-Dv-Dp+F in cash and is owed S-Dv-Dpv-C+F -> vendor +(Dpp-C)
 *   COD fleet:    driver -(S-Dv-Dp+F), vendor +(S-Dv-Dpv-C), platform +C, driver +F, promo -Dpp
 *
 * With a platform delivery subsidy W (2026-10-21, SPEC core 9: the platform's own free-delivery
 * threshold made the customer's fee 0): whoever delivered earns W all the same, paid by the
 * platform, in every model and for every payment method. Two more lines:
 *
 *   rider +W (fleet) or vendor wallet +W (self delivery), PROMO_EXPENSE -W (DELIVERY_SUBSIDY)
 *
 * Zero-amount lines are dropped (e.g. 0% subscription commission). An empty plan means nothing
 * moves.
 */
export function planSettlement(order: SettlementOrder): PlannedPosting[] {
  const postings = planGoodsAndFee(order);
  const subsidy = toPaisa(order.platform_delivery_subsidy_npr ?? 0);
  if (subsidy === 0) return postings;
  if (subsidy < 0 || toPaisa(order.delivery_fee) !== 0) {
    throw new SettlementPlanError(`Order ${order.id} has an impossible delivery subsidy`);
  }
  const earner: AccountRef =
    order.fulfillment_locked === 'SELF_DELIVERY'
      ? { type: 'VENDOR_WALLET', vendorId: order.vendor_id }
      : { type: 'DRIVER_WALLET', driverUserId: requireDriver(order) };
  return balanced([
    ...postings,
    { account: earner, amountPaisa: subsidy, lineType: 'DELIVERY_SUBSIDY' },
    { account: PROMO, amountPaisa: -subsidy, lineType: 'DELIVERY_SUBSIDY' },
  ]);
}

function requireDriver(order: SettlementOrder): string {
  if (order.driver_user_id === null) {
    throw new SettlementPlanError(`Fleet order ${order.id} has no driver to pay`);
  }
  return order.driver_user_id;
}

/** The settlement of the goods and of the fee the customer paid (everything but a subsidy). */
function planGoodsAndFee(order: SettlementOrder): PlannedPosting[] {
  const subtotal = toPaisa(order.subtotal);
  const fee = toPaisa(order.delivery_fee);
  const commission = toPaisa(order.platform_commission_amount);
  if (subtotal < 0 || fee < 0 || commission < 0) {
    throw new SettlementPlanError(`Order ${order.id} has negative amounts`);
  }
  const discount = toPaisa(order.platform_promo_discount_npr ?? 0);
  const vendorDiscount = toPaisa(order.platform_promo_vendor_share_npr ?? 0);
  const offerDiscount = toPaisa(order.vendor_offer_discount_npr ?? 0);
  if (
    discount < 0 ||
    offerDiscount < 0 ||
    vendorDiscount < 0 ||
    vendorDiscount > discount ||
    offerDiscount + discount > subtotal
  ) {
    throw new SettlementPlanError(`Order ${order.id} has an impossible discount`);
  }
  const platformDiscount = discount - vendorDiscount;
  if (commission > subtotal - offerDiscount - vendorDiscount) {
    throw new SettlementPlanError(
      `Order ${order.id} commission exceeds its subtotal (net of the discount the vendor bears)`,
    );
  }

  const vendor: AccountRef = { type: 'VENDOR_WALLET', vendorId: order.vendor_id };
  const selfDelivered = order.fulfillment_locked === 'SELF_DELIVERY';
  const driver: AccountRef | null = selfDelivered
    ? null
    : { type: 'DRIVER_WALLET', driverUserId: requireDriver(order) };
  const vendorShare = subtotal - offerDiscount - vendorDiscount - commission;
  const paid = subtotal - offerDiscount - discount + fee;

  if (isDirectPrepaid(order)) {
    // Model C (2026-10-21): the shop already received what the customer paid (its own merchant
    // account, its prepaid balance for a wallet payment, or cash), and the commission was debited
    // at PLACED. What is left: the platform's share of a campaign discount is owed to the shop,
    // and a platform rider is owed the delivery fee the shop collected.
    if (order.payment_method !== 'COD' || driver === null) {
      return balanced([
        { account: vendor, amountPaisa: platformDiscount - (driver === null ? 0 : fee) },
        ...(driver === null ? [] : [{ account: driver, amountPaisa: fee }]),
        { account: PROMO, amountPaisa: -platformDiscount },
      ]);
    }
    // Cash on a fleet delivery: the rider holds it and owes it to the shop, less its fee.
    return balanced([
      { account: driver, amountPaisa: -paid },
      { account: vendor, amountPaisa: paid - fee + platformDiscount },
      { account: driver, amountPaisa: fee },
      { account: PROMO, amountPaisa: -platformDiscount },
    ]);
  }

  if (order.payment_method !== 'COD') {
    return balanced([
      { account: ESCROW, amountPaisa: -paid },
      {
        account: { type: 'VENDOR_DISPUTE_HOLD', vendorId: order.vendor_id },
        amountPaisa: vendorShare + (selfDelivered ? fee : 0),
        lineType: 'DISPUTE_HOLD',
      },
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
