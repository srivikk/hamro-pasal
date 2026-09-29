import {
  checkoutRequestSchema,
  checkoutResponseSchema,
  type CheckoutRequest,
  type CheckoutResponseBody,
  type PaymentMethod,
} from '@hamro-pasal/shared-types';
import { useMutation } from '@tanstack/react-query';

import { useCartStore } from '../store/useCartStore';
import { checkoutFingerprint, useCheckoutStore } from '../store/useCheckoutStore';
import { ApiError, apiRequest } from './http';

export const CHECKOUT_PATH = '/api/cart/checkout';

/**
 * Maps the cart store to the shared-types checkout contract. Only product IDs and quantities are
 * sent: the server prices every line from its own database and never trusts client prices.
 */
export function buildCheckoutRequest(paymentMethod: PaymentMethod): CheckoutRequest {
  const { vendor, lines } = useCartStore.getState();
  if (vendor === null || lines.length === 0) {
    throw new ApiError(400, 'INVALID_CART', 'The cart is empty');
  }
  const items = lines.map((line) => ({ product_id: line.productId, quantity: line.quantity }));
  const idempotency_key = useCheckoutStore
    .getState()
    .idempotencyKeyFor(checkoutFingerprint({ vendorId: vendor.id, paymentMethod, items }));

  const parsed = checkoutRequestSchema.safeParse({
    idempotency_key,
    vendor_id: vendor.id,
    payment_method: paymentMethod,
    items,
  });
  if (!parsed.success) {
    throw new ApiError(
      400,
      'INVALID_CART',
      `Cart does not match the checkout contract: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** POST /api/cart/checkout: locks the cart's stock for 600 s and creates the order (SPEC §3). */
export function submitCheckout(paymentMethod: PaymentMethod): Promise<CheckoutResponseBody> {
  return apiRequest({
    method: 'POST',
    path: CHECKOUT_PATH,
    body: buildCheckoutRequest(paymentMethod),
    schema: checkoutResponseSchema,
  });
}

function onCheckoutError(error: ApiError): void {
  const checkout = useCheckoutStore.getState();
  switch (error.code) {
    case 'RESERVATION_EXPIRED':
      // SPEC §3: the lock lapsed; purge the cart and show "Session Expired".
      checkout.expireSession();
      break;
    case 'IDEMPOTENCY_KEY_REUSED':
      // The key was already used for a different cart; the next attempt must get a new one.
      checkout.discardAttempt();
      break;
    default:
      // Anything else (network, 5xx, CHECKOUT_IN_PROGRESS, stock, MOV...) keeps the key, so a
      // retry of the same cart replays the same attempt instead of creating a second order.
      break;
  }
}

export function useCheckout() {
  return useMutation<CheckoutResponseBody, ApiError, PaymentMethod>({
    mutationKey: ['checkout'],
    mutationFn: submitCheckout,
    onSuccess: (response) => {
      useCheckoutStore.getState().startSession(response);
    },
    onError: onCheckoutError,
  });
}
