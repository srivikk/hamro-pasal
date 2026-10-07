import { toNpr, toPaisa } from '../../lib/money';
import type { OrderReceipt } from '../../store/useOrderReceiptStore';
import { PROMO_MOCKS_ENABLED } from './mock-promotions';

/*
 * TODO: Remove mock pricing when /cart/quote is ready.
 *
 * DEMO ONLY (development builds). The cart shows a mock "Shop Discount" (and, for a "Free
 * delivery" label, a waived delivery fee) that the server knows nothing about, so the order the server creates carries the full total. To keep a demo
 * consistent, the discount the cart displayed is kept on the order's local receipt
 * (useOrderReceiptStore.shopDiscountNpr, deliveryDiscountNpr) and taken off the total wherever the CUSTOMER app shows
 * that order afterwards (Your Orders, the order screen and its Bill Details).
 *
 * It changes what is displayed, never what is charged or owed:
 * - the eSewa / Khalti page is signed by the backend for the real total and shows that amount;
 * - the shop's and the rider's screens (cash to collect) are deliberately not adjusted;
 * - nothing here is sent to the API.
 *
 * Delete this file and its call sites when checkout returns the discounted total.
 */

/** The server's total minus the mock discount the cart showed; never below zero. */
export function demoTotalNpr(serverTotalNpr: number, discountNpr: number | undefined): number {
  if (!PROMO_MOCKS_ENABLED || discountNpr === undefined || !(discountNpr > 0)) {
    return serverTotalNpr;
  }
  return toNpr(Math.max(0, toPaisa(serverTotalNpr) - toPaisa(discountNpr)));
}

/**
 * Everything the cart's mock pricing took off an order: the shop discount plus a delivery fee
 * shown as free. Undefined for an order this phone has no receipt of.
 */
export function receiptMockSavingsNpr(
  receipt: Pick<OrderReceipt, 'shopDiscountNpr' | 'deliveryDiscountNpr'> | undefined,
): number | undefined {
  if (receipt === undefined) return undefined;
  return toNpr(toPaisa(receipt.shopDiscountNpr) + toPaisa(receipt.deliveryDiscountNpr));
}
