import { sql, type SQL } from 'drizzle-orm';

import { products } from './schema';

/*
 * Decided 2026-10-21 (Task 5): three product flags, each with one owner.
 *
 *   is_active    the Super Admin's moderation (hide / show). A vendor never writes it.
 *   archived_at  the vendor removed the product from its catalogue (DELETE). Never shown again.
 *   in_stock     the vendor's In Stock / Out of Stock switch. An out-of-stock product stays
 *                listed, marked out of stock, and cannot be ordered; stock_quantity is untouched.
 *
 * Every customer-facing query asks the same two questions through these helpers, so the API and
 * the worker cannot disagree.
 */

/** Customers may see the product (lists, menus, search, a cart line). */
export function productListed(): SQL {
  return sql`(${products.is_active} AND ${products.archived_at} IS NULL)`;
}

/**
 * The stock a customer may order now: the counted quantity while the vendor says it is in stock,
 * else 0. Checkout compares the cart against this, so a switched-off product is refused with
 * 409 INSUFFICIENT_STOCK while its count stays as the vendor left it.
 */
export function orderableStock(): SQL<number> {
  return sql<number>`(CASE WHEN ${products.in_stock} THEN ${products.stock_quantity} ELSE 0 END)`.mapWith(
    Number,
  );
}

/** A product row's own answer to both questions (the same rules, in TypeScript). */
export function isProductOrderable(product: {
  readonly is_active: boolean;
  readonly archived_at: Date | null;
  readonly in_stock: boolean;
  readonly stock_quantity: number;
}): boolean {
  return (
    product.is_active &&
    product.archived_at === null &&
    product.in_stock &&
    product.stock_quantity > 0
  );
}
