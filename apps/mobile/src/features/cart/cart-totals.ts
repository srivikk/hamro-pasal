import { toNpr, toPaisa } from '../../lib/money';
import type { CartLine, CartVendor } from '../../store/useCartStore';
import { mockFreeDelivery, mockShopDiscountPaisa, vendorExtras } from '../promo/mock-promotions';
import type { VendorExtras } from '../promo/promo-model';
import { computeCartSummary, type CartSummary } from './cart-summary';

export interface CartTotals {
  summary: CartSummary;
  /** The shop's mock extras (offer label, neighbourhood). */
  shopExtras: VendorExtras;
  shopOffer: string | null;
  /** MOCK: what the "Shop Discount" line shows. 0 outside development builds. */
  shopDiscountNpr: number;
  /** MOCK: the delivery fee waived by a "Free delivery" offer label. 0 without one. */
  deliveryDiscountNpr: number;
  /** The delivery fee the bill shows: the shop's, or 0 when the mock offer waives it. */
  displayedDeliveryFeeNpr: number;
  /** Everything the mock pricing takes off: the shop discount plus a waived delivery fee. */
  savedNpr: number;
  /** What the customer is shown as the amount to pay: the estimate minus the mock savings. */
  displayedTotalNpr: number;
}

/**
 * The figures both checkout steps show: the Cart's bill and "Proceed to Pay • Rs. …", and the
 * Payment Options screen's amount. One function, so the two can never disagree.
 */
export function cartTotals(
  vendor: CartVendor,
  lines: readonly Pick<CartLine, 'unitPriceNpr' | 'quantity'>[],
): CartTotals {
  const summary = computeCartSummary(vendor, lines);

  // TODO: Replace with backend /cart/quote response.
  // MOCK MATH, FOR DISPLAY ONLY (development builds): the shop's mock offer label is turned into
  // a "Shop Discount" line and taken off the total shown to the customer, and a "Free delivery"
  // label shows the delivery fee as free. The server does not
  // know about it: POST /api/cart/checkout still charges subtotal + delivery fee, so the amount
  // on the gateway's page is the full one. When the quote endpoint exists (STATE_HANDOFF §8Z.5),
  // return its vendor_offer / platform_promo / total_npr from here instead and delete
  // mockShopDiscountPaisa.
  const shopExtras = vendorExtras({ id: vendor.id, business_name: vendor.name });
  const shopOffer = shopExtras.top_offer;
  const shopDiscountNpr = toNpr(mockShopDiscountPaisa(shopOffer, toPaisa(summary.subtotalNpr)));
  const deliveryDiscountNpr = mockFreeDelivery(shopOffer) ? summary.deliveryFeeNpr : 0;
  const savedPaisa = toPaisa(shopDiscountNpr) + toPaisa(deliveryDiscountNpr);
  const displayedTotalNpr = toNpr(toPaisa(summary.totalNpr) - savedPaisa);

  return {
    summary,
    shopExtras,
    shopOffer,
    shopDiscountNpr,
    deliveryDiscountNpr,
    displayedDeliveryFeeNpr: toNpr(toPaisa(summary.deliveryFeeNpr) - toPaisa(deliveryDiscountNpr)),
    savedNpr: toNpr(savedPaisa),
    displayedTotalNpr,
  };
}
