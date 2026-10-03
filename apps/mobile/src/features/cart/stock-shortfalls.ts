import { z } from 'zod';

import type { StockLevel } from '../../store/useCartStore';

/** `details` of the checkout's 409 INSUFFICIENT_STOCK: every line the server could not cover. */
const insufficientStockDetailsSchema = z.object({
  shortfalls: z.array(
    z.object({
      productId: z.string().min(1),
      /** What is left for this customer (stock, minus other customers' live holds). */
      available: z.number(),
    }),
  ),
});

/**
 * The stock the server reported in a 409 INSUFFICIENT_STOCK, ready for the cart store. Empty when
 * the details are missing or malformed: the cart then only shows the general message.
 */
export function stockLevelsFromDetails(details: unknown): StockLevel[] {
  const parsed = insufficientStockDetailsSchema.safeParse(details);
  if (!parsed.success) return [];
  return parsed.data.shortfalls.map(({ productId, available }) => ({
    productId,
    available: Math.max(0, Math.floor(available)),
  }));
}
