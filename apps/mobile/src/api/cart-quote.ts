import {
  cartQuoteRequestSchema,
  cartQuoteResponseSchema,
  type CartQuoteRequest,
  type CartQuoteResponseBody,
  type NepalAddress,
} from '@hamro-pasal/shared-types';

import type { CartLine } from '../store/useCartStore';
import { ApiError, apiRequest } from './http';

export const CART_QUOTE_PATH = '/api/cart/quote';

/** What a quote is asked for: the shop, what is in the cart and where it goes. No amounts. */
export interface QuoteCart {
  readonly vendorId: string;
  readonly lines: readonly Pick<CartLine, 'productId' | 'quantity'>[];
  readonly deliveryAddress: NepalAddress;
}

export function buildQuoteRequest(cart: QuoteCart): CartQuoteRequest {
  const parsed = cartQuoteRequestSchema.safeParse({
    vendor_id: cart.vendorId,
    items: cart.lines.map((line) => ({ product_id: line.productId, quantity: line.quantity })),
    delivery_address: cart.deliveryAddress,
  });
  if (!parsed.success) {
    throw new ApiError(400, 'INVALID_CART', `Cart does not match the quote contract`);
  }
  return parsed.data;
}

/**
 * POST /api/cart/quote (SPEC core 9): the cart exactly as checkout will price it. The shop's own
 * offer comes off the subtotal first, then the platform campaign off what is left; the delivery
 * fee is never discounted. Also which payment methods checkout will accept. It reserves nothing.
 */
export function fetchCartQuote(cart: QuoteCart): Promise<CartQuoteResponseBody> {
  return apiRequest({
    method: 'POST',
    path: CART_QUOTE_PATH,
    body: buildQuoteRequest(cart),
    schema: cartQuoteResponseSchema,
  });
}
