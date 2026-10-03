import type { AdminProductListResponseBody, AdminProductView } from '@hamro-pasal/shared-types';

import { ApiError } from '../../api/client';

export interface ProductVisibility {
  /** Whether customers can see and order the product right now. */
  readonly visible: boolean;
  readonly label: string;
}

/**
 * Customers see a product only when it is active AND its vendor is LIVE; the label says which of
 * the two is hiding it.
 */
export function productVisibility(product: AdminProductView): ProductVisibility {
  if (!product.is_active) return { visible: false, label: 'Hidden' };
  if (product.vendor.status !== 'LIVE') {
    return { visible: false, label: `Vendor is ${product.vendor.status}` };
  }
  return { visible: true, label: 'Visible' };
}

/** "12 pack", or "Out of stock" at zero. */
export function stockLabel(product: AdminProductView): string {
  return product.stock_quantity === 0
    ? 'Out of stock'
    : `${product.stock_quantity.toLocaleString('en-IN')} ${product.unit}`;
}

/** The toggle of one row: what pressing it does. */
export function activeToggle(product: AdminProductView): {
  readonly label: string;
  readonly next: boolean;
} {
  return product.is_active ? { label: 'Hide', next: false } : { label: 'Show', next: true };
}

/** The loaded pages with one product replaced by its updated view (after a toggle). */
export function replaceProduct(
  pages: readonly AdminProductListResponseBody[],
  updated: AdminProductView,
): AdminProductListResponseBody[] {
  return pages.map((page) => ({
    ...page,
    products: page.products.map((product) => (product.id === updated.id ? updated : product)),
  }));
}

export function toggleErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'PRODUCT_NOT_FOUND':
        return 'This product no longer exists. The list has been refreshed.';
      case 'NETWORK_ERROR':
        return 'The API cannot be reached. Try again.';
      default:
        break;
    }
  }
  return 'The change could not be saved. Try again.';
}
