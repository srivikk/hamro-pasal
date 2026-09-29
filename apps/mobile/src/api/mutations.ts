import {
  checkoutRequestSchema,
  checkoutResponseSchema,
  type CheckoutRequest,
  type CheckoutResponseBody,
  type PaymentMethod,
} from '@hamro-pasal/shared-types';
import { useMutation } from '@tanstack/react-query';

import { useAddressStore } from '../store/useAddressStore';
import { useCartStore } from '../store/useCartStore';
import { useDeliveryOtpStore } from '../store/useDeliveryOtpStore';
import { checkoutFingerprint, useCheckoutStore } from '../store/useCheckoutStore';
import { ApiError, apiRequest } from './http';

export const CHECKOUT_PATH = '/api/cart/checkout';

/** Client-side code: checkout was attempted without a saved delivery address. */
export const NO_DELIVERY_ADDRESS = 'NO_DELIVERY_ADDRESS';

/**
 * Maps the cart store and the saved delivery address to the shared-types checkout contract. Only
 * product IDs and quantities are sent: the server prices every line from its own database and
 * never trusts client prices.
 */
export function buildCheckoutRequest(paymentMethod: PaymentMethod): CheckoutRequest {
  const { vendor, lines } = useCartStore.getState();
  if (vendor === null || lines.length === 0) {
    throw new ApiError(400, 'INVALID_CART', 'The cart is empty');
  }
  const deliveryAddress = useAddressStore.getState().address;
  if (deliveryAddress === null) {
    throw new ApiError(400, NO_DELIVERY_ADDRESS, 'Add a delivery address before checkout');
  }
  const items = lines.map((line) => ({ product_id: line.productId, quantity: line.quantity }));
  const idempotency_key = useCheckoutStore
    .getState()
    .idempotencyKeyFor(
      checkoutFingerprint({ vendorId: vendor.id, paymentMethod, items, deliveryAddress }),
    );

  const parsed = checkoutRequestSchema.safeParse({
    idempotency_key,
    vendor_id: vendor.id,
    payment_method: paymentMethod,
    items,
    delivery_address: deliveryAddress,
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
      // Saved before the session starts, so the tracking screen that a PLACED order opens can
      // already show it. A replay rotates the code; the newest one overwrites the old.
      if (response.delivery_otp !== null) {
        useDeliveryOtpStore.getState().setOtp(response.order.id, response.delivery_otp);
      }
      useCheckoutStore.getState().startSession(response);
    },
    onError: onCheckoutError,
  });
}
