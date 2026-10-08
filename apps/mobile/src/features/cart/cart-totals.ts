import type { CartQuoteResponseBody } from '@hamro-pasal/shared-types';

import { toNpr, toPaisa } from '../../lib/money';
import type { CartLine, CartVendor } from '../../store/useCartStore';
import { computeCartSummary, type CartSummary } from './cart-summary';

/** One discount line of the bill, as the server applied it. */
export interface BillDiscount {
  label: string;
  discountNpr: number;
}

export interface CartTotals {
  /** The device's own sums: used for the minimum-order check, which needs no server. */
  summary: CartSummary;
  /** True once the figures below are the server's quote; false while they are an estimate. */
  quoted: boolean;
  subtotalNpr: number;
  /** The shop's own offer, applied to the subtotal first. Null without one (or without a quote). */
  vendorOffer: BillDiscount | null;
  /** The platform campaign, applied to what is left after the shop's offer. */
  platformPromo: BillDiscount | null;
  /** Never discounted. The shop's base fee until the server has priced the distance. */
  deliveryFeeNpr: number;
  /** Both discounts together. */
  savedNpr: number;
  /** What the customer pays: subtotal - shop offer - campaign + delivery fee. */
  totalNpr: number;
}

/**
 * The figures both checkout steps show: the Cart's bill and "Proceed to Pay • Rs. …", and the
 * Payment Options screen's amount. One function, so the two can never disagree.
 *
 * With a quote (POST /api/cart/quote) every figure is the server's: the app computes no discount.
 * Without one (a guest, no address yet, or the quote still loading) it is the device's estimate
 * of subtotal + the shop's base delivery fee, with no discount lines.
 */
export function cartTotals(
  vendor: CartVendor,
  lines: readonly Pick<CartLine, 'unitPriceNpr' | 'quantity'>[],
  quote: CartQuoteResponseBody | null | undefined,
): CartTotals {
  const summary = computeCartSummary(vendor, lines);
  if (quote === null || quote === undefined) {
    return {
      summary,
      quoted: false,
      subtotalNpr: summary.subtotalNpr,
      vendorOffer: null,
      platformPromo: null,
      deliveryFeeNpr: summary.deliveryFeeNpr,
      savedNpr: 0,
      totalNpr: summary.totalNpr,
    };
  }
  const line = (discount: CartQuoteResponseBody['vendor_offer']): BillDiscount | null =>
    discount === null ? null : { label: discount.label, discountNpr: discount.discount_npr };
  return {
    summary,
    quoted: true,
    subtotalNpr: quote.subtotal_npr,
    vendorOffer: line(quote.vendor_offer),
    platformPromo: line(quote.platform_promo),
    deliveryFeeNpr: quote.delivery_fee_npr,
    savedNpr: toNpr(
      toPaisa(quote.vendor_offer?.discount_npr ?? 0) +
        toPaisa(quote.platform_promo?.discount_npr ?? 0),
    ),
    totalNpr: quote.total_npr,
  };
}
