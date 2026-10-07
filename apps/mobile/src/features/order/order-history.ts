import type { OrderState } from '@hamro-pasal/shared-types';
import type { TFunction } from 'i18next';

import { useCartStore } from '../../store/useCartStore';
import type { OrderReceipt } from '../../store/useOrderReceiptStore';

/** The code both the customer and the shop see: the last 6 hex digits of the order id. */
export function orderCode(orderId: string): string {
  return orderId.replace(/-/g, '').slice(-6).toUpperCase();
}

/** Delivered is green, cancelled and failed are red, everything still moving is blue or amber. */
export const ORDER_STATE_TONE: Record<OrderState, string> = {
  PENDING_PAYMENT: 'bg-amber-100 text-amber-800',
  PLACED: 'bg-sky-100 text-sky-800',
  PREPARING: 'bg-sky-100 text-sky-800',
  OUT_FOR_DELIVERY: 'bg-sky-100 text-sky-800',
  DELIVERED: 'bg-green-100 text-green-800',
  CANCELED: 'bg-red-100 text-red-700',
  FAILED: 'bg-red-100 text-red-700',
  DISPUTED: 'bg-amber-100 text-amber-800',
};

/** "1x Basmati Rice 5kg", or "1x Basmati Rice 5kg & 2 more" when the order had other items. */
export function itemSummary(items: OrderReceipt['items'], t: TFunction): string {
  const [first, ...rest] = items;
  if (first === undefined) return '';
  const lead = t('orders.itemLine', { quantity: first.quantity, name: first.name });
  return rest.length === 0 ? lead : t('orders.itemLineMore', { line: lead, count: rest.length });
}

export type ReorderOutcome =
  /** The cart now holds the order's items (added to what it had from the same shop). */
  | 'added'
  /** The cart holds another shop's items: ask before replacing them. */
  | 'needs_replace';

/**
 * Puts an earlier order's items back in the cart, as that order had them. Prices and stock are
 * whatever the server says now: the cart shows the remembered price and checkout re-prices.
 * With `replace`, a cart from another shop is emptied first.
 */
export function reorder(receipt: OrderReceipt, replace = false): ReorderOutcome {
  const cart = useCartStore.getState();
  if (cart.vendor !== null && cart.vendor.id !== receipt.vendor.id && cart.lines.length > 0) {
    if (!replace) return 'needs_replace';
    cart.clearCart();
  }
  for (const item of receipt.items) {
    // A line the cart cannot take in full (its 99-per-item or 50-line limit) is simply skipped.
    useCartStore
      .getState()
      .addItem(
        receipt.vendor,
        { id: item.productId, name: item.name, unitPriceNpr: item.unitPriceNpr },
        item.quantity,
      );
  }
  return 'added';
}
