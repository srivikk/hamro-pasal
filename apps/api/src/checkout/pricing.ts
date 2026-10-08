import type { PricingModel } from '@hamro-pasal/shared-types';

import { toNpr, toPaisa } from '../ledger/money';

/** Checkout was refused for a business reason (HTTP 422 unless stated otherwise). */
export class CheckoutRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly httpStatus = 422,
  ) {
    super(message);
    this.name = 'CheckoutRejectedError';
  }
}

export interface PricingVendor {
  readonly pricing_model: PricingModel | null;
  readonly commission_rate: number;
  readonly min_order_value: number;
  readonly base_delivery_fee_npr: number;
}

export interface PricingProduct {
  readonly id: string;
  readonly name: string;
  readonly price_npr: number;
}

export interface PricedLine {
  readonly productId: string;
  readonly productName: string;
  readonly unitPricePaisa: number;
  readonly quantity: number;
}

/** A platform campaign the shop has itself opted in to and that is running now (SPEC core 7). */
export interface CampaignOffer {
  readonly campaignId: string;
  /** The vendor's own opt-in: what makes the discount chargeable to it. */
  readonly optInId: string;
  readonly optedInAt: Date;
  readonly name: string;
  readonly kind: 'FLAT' | 'PERCENTAGE';
  /** NPR for FLAT; percent for PERCENTAGE. */
  readonly value: number;
  readonly maxDiscountNpr: number | null;
  readonly minCartNpr: number;
  readonly vendorSharePercent: number;
  readonly termsVersion: number;
}

/** The campaign discount applied to a cart. */
export interface AppliedPromo {
  readonly offer: CampaignOffer;
  /** What the customer gets off the goods. */
  readonly discountPaisa: number;
  /** The part the vendor bears; the platform funds the rest. */
  readonly vendorSharePaisa: number;
}

export interface PricedCart {
  readonly lines: readonly PricedLine[];
  readonly subtotalPaisa: number;
  readonly deliveryFeePaisa: number;
  readonly commissionPaisa: number;
  /** The platform campaign discount, or null when none applies. */
  readonly promo: AppliedPromo | null;
  /** subtotal − campaign discount + delivery fee: what the customer pays. */
  readonly totalPaisa: number;
}

/** A percentage with two decimals, as whole hundredths of a percent: 12.5% is 1250. */
const hundredths = (percent: number): number => Math.round(percent * 100);

/**
 * What one campaign takes off a subtotal, in paisa (SPEC core 9): nothing below its minimum cart;
 * FLAT its amount; PERCENTAGE its share, half-up to the paisa, up to its cap. Never more than the
 * goods cost.
 */
export function campaignDiscountPaisa(offer: CampaignOffer, subtotalPaisa: number): number {
  if (subtotalPaisa < toPaisa(offer.minCartNpr)) return 0;
  if (offer.kind === 'FLAT') return Math.min(toPaisa(offer.value), subtotalPaisa);
  const share = Math.round((subtotalPaisa * hundredths(offer.value)) / 10_000);
  const capped =
    offer.maxDiscountNpr === null ? share : Math.min(share, toPaisa(offer.maxDiscountNpr));
  return Math.min(capped, subtotalPaisa);
}

/**
 * The one campaign applied to a cart: the one giving the customer the larger discount; between
 * equal ones, the opt-in the shop made first (SPEC core 7, "Stacking"). The vendor's share is
 * rounded half-up to the paisa once; the platform's share is the remainder, so the two always
 * add up to the discount.
 */
export function bestCampaign(
  offers: readonly CampaignOffer[],
  subtotalPaisa: number,
): AppliedPromo | null {
  let best: AppliedPromo | null = null;
  for (const offer of [...offers].sort(
    (a, b) => a.optedInAt.getTime() - b.optedInAt.getTime() || a.optInId.localeCompare(b.optInId),
  )) {
    const discountPaisa = campaignDiscountPaisa(offer, subtotalPaisa);
    if (discountPaisa <= 0 || (best !== null && discountPaisa <= best.discountPaisa)) continue;
    best = {
      offer,
      discountPaisa,
      vendorSharePaisa: Math.round((discountPaisa * hundredths(offer.vendorSharePercent)) / 10_000),
    };
  }
  return best;
}

/**
 * Prices a cart from database prices only; client-sent prices are never trusted.
 *   subtotal   = sum(unit price x qty)
 *   delivery   = vendor base delivery fee
 *   discount   = the best platform campaign the shop opted in to, on the subtotal (SPEC core 9)
 *   commission = (subtotal − the vendor's share of that discount) x vendor rate (0 on
 *                SUBSCRIPTION, SPEC §4), rounded to the paisa: the vendor pays commission on what
 *                it sells for, never on the platform's subsidy
 *   total      = subtotal − discount + delivery
 * The minimum order value and the free-delivery threshold are judged on the subtotal before the
 * discount, and a discount never reduces the delivery fee.
 * A subtotal below the vendor's MOV is rejected (SPEC journey step 5). SPEC names a "Small Cart
 * Surcharge" for that case but does not define its amount, so none is invented here.
 */
export function priceCart(
  vendor: PricingVendor,
  products: ReadonlyMap<string, PricingProduct>,
  items: readonly { readonly productId: string; readonly quantity: number }[],
  /** The delivery charge for this subtotal (`deliveryFeePaisa`); the base fee when not given. */
  deliveryFee?: (subtotalPaisa: number) => number,
  /** The campaigns the shop is opted in to that run now; none by default. */
  campaigns: readonly CampaignOffer[] = [],
): PricedCart {
  const lines = items.map((item): PricedLine => {
    const product = products.get(item.productId);
    if (product === undefined) {
      throw new Error(`Product ${item.productId} was not loaded for pricing`);
    }
    return {
      productId: product.id,
      productName: product.name,
      unitPricePaisa: toPaisa(product.price_npr),
      quantity: item.quantity,
    };
  });

  const subtotalPaisa = lines.reduce((sum, line) => sum + line.unitPricePaisa * line.quantity, 0);
  const minimumPaisa = toPaisa(vendor.min_order_value);
  if (subtotalPaisa < minimumPaisa) {
    throw new CheckoutRejectedError(
      'BELOW_MINIMUM_ORDER_VALUE',
      `Order subtotal is below this vendor's minimum of ${String(vendor.min_order_value)} NPR`,
      { minimum_npr: vendor.min_order_value, subtotal_npr: toNpr(subtotalPaisa) },
    );
  }

  // Rate as integer basis points keeps the product exact; the result rounds half-up to the paisa.
  const rateBasisPoints =
    vendor.pricing_model === 'SUBSCRIPTION' ? 0 : Math.round(vendor.commission_rate * 10_000);
  const promo = bestCampaign(campaigns, subtotalPaisa);
  const commissionBasePaisa = subtotalPaisa - (promo?.vendorSharePaisa ?? 0);
  const commissionPaisa = Math.round((commissionBasePaisa * rateBasisPoints) / 10_000);
  const deliveryFeePaisa = deliveryFee?.(subtotalPaisa) ?? toPaisa(vendor.base_delivery_fee_npr);

  return {
    lines,
    subtotalPaisa,
    deliveryFeePaisa,
    commissionPaisa,
    promo,
    totalPaisa: subtotalPaisa - (promo?.discountPaisa ?? 0) + deliveryFeePaisa,
  };
}
