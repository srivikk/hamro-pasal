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

/** A vendor's own offer that is running now (SPEC core 7): the vendor funds all of it. */
export interface VendorOfferRule {
  readonly offerId: string;
  readonly createdAt: Date;
  /** "Flat Rs. 100 OFF": rendered by the server when the offer was created. */
  readonly label: string;
  readonly kind: 'FLAT' | 'PERCENTAGE';
  /** NPR for FLAT; percent for PERCENTAGE. */
  readonly value: number;
  readonly maxDiscountNpr: number | null;
  readonly minCartNpr: number;
}

/** The vendor offer applied to a cart. */
export interface AppliedVendorOffer {
  readonly offer: VendorOfferRule;
  readonly discountPaisa: number;
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
  /** The vendor's own offer, applied to the subtotal first; null when none applies. */
  readonly vendorOffer: AppliedVendorOffer | null;
  /** The campaign discount, on the subtotal after the vendor offer; null when none applies. */
  readonly promo: AppliedPromo | null;
  /** subtotal − vendor offer − campaign discount + delivery fee: what the customer pays. */
  readonly totalPaisa: number;
}

/** The priced cart's amounts as the quote (and 409 QUOTE_CHANGED) carry them. */
export function pricedCartView(priced: PricedCart) {
  return {
    subtotal_npr: toNpr(priced.subtotalPaisa),
    vendor_offer:
      priced.vendorOffer === null
        ? null
        : {
            id: priced.vendorOffer.offer.offerId,
            label: priced.vendorOffer.offer.label,
            discount_npr: toNpr(priced.vendorOffer.discountPaisa),
          },
    platform_promo:
      priced.promo === null
        ? null
        : {
            id: priced.promo.offer.campaignId,
            label: priced.promo.offer.name,
            discount_npr: toNpr(priced.promo.discountPaisa),
          },
    delivery_fee_npr: toNpr(priced.deliveryFeePaisa),
    total_npr: toNpr(priced.totalPaisa),
  };
}

/** A percentage with two decimals, as whole hundredths of a percent: 12.5% is 1250. */
const hundredths = (percent: number): number => Math.round(percent * 100);

/** The four numbers of a discount rule, the same for a vendor offer and a campaign. */
type DiscountRule = Pick<CampaignOffer, 'kind' | 'value' | 'maxDiscountNpr' | 'minCartNpr'>;

/**
 * What one rule takes off an amount, in paisa (SPEC core 9): nothing below its minimum cart; FLAT
 * its amount; PERCENTAGE its share, half-up to the paisa, up to its cap. Never more than the
 * amount itself.
 */
export function campaignDiscountPaisa(offer: DiscountRule, subtotalPaisa: number): number {
  if (subtotalPaisa < toPaisa(offer.minCartNpr)) return 0;
  if (offer.kind === 'FLAT') return Math.min(toPaisa(offer.value), subtotalPaisa);
  const share = Math.round((subtotalPaisa * hundredths(offer.value)) / 10_000);
  const capped =
    offer.maxDiscountNpr === null ? share : Math.min(share, toPaisa(offer.maxDiscountNpr));
  return Math.min(capped, subtotalPaisa);
}

/**
 * The one vendor offer applied to a cart: the one giving the customer the larger discount;
 * between equal ones, the older offer (SPEC core 7, "Stacking").
 */
export function bestVendorOffer(
  offers: readonly VendorOfferRule[],
  subtotalPaisa: number,
): AppliedVendorOffer | null {
  let best: AppliedVendorOffer | null = null;
  for (const offer of [...offers].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.offerId.localeCompare(b.offerId),
  )) {
    const discountPaisa = campaignDiscountPaisa(offer, subtotalPaisa);
    if (discountPaisa <= 0 || (best !== null && discountPaisa <= best.discountPaisa)) continue;
    best = { offer, discountPaisa };
  }
  return best;
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
 *   Dv         = the shop's best own offer, on the subtotal S (SPEC core 7 and 9)
 *   Dp         = the best platform campaign the shop opted in to, on S − Dv: its minimum cart and
 *                its percentage are both judged on what is left after the vendor offer
 *   Dpv        = the vendor's share of Dp; the platform funds the rest
 *   commission = (S − Dv − Dpv) x vendor rate (0 on SUBSCRIPTION, SPEC §4), rounded to the paisa:
 *                the vendor pays commission on what it sells for, never on the platform's subsidy
 *   total      = S − Dv − Dp + delivery
 * The minimum order value and the free-delivery threshold are judged on the subtotal before any
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
  /** The shop's own offers that run now; none by default. */
  vendorOffers: readonly VendorOfferRule[] = [],
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
  const vendorOffer = bestVendorOffer(vendorOffers, subtotalPaisa);
  const afterOfferPaisa = subtotalPaisa - (vendorOffer?.discountPaisa ?? 0);
  const promo = bestCampaign(campaigns, afterOfferPaisa);
  const commissionBasePaisa = afterOfferPaisa - (promo?.vendorSharePaisa ?? 0);
  const commissionPaisa = Math.round((commissionBasePaisa * rateBasisPoints) / 10_000);
  const deliveryFeePaisa = deliveryFee?.(subtotalPaisa) ?? toPaisa(vendor.base_delivery_fee_npr);

  return {
    lines,
    subtotalPaisa,
    deliveryFeePaisa,
    commissionPaisa,
    vendorOffer,
    promo,
    totalPaisa: afterOfferPaisa - (promo?.discountPaisa ?? 0) + deliveryFeePaisa,
  };
}
