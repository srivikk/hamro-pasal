import { useMutation } from '@tanstack/react-query';
import { z } from 'zod';

import { useCheckoutStore } from '../store/useCheckoutStore';
import { ApiError, apiRequest } from './http';

export function abandonCheckoutPath(orderId: string): string {
  return `/api/orders/${encodeURIComponent(orderId)}/abandon`;
}

const abandonResponseSchema = z.object({ order_id: z.string(), state: z.string() });

/**
 * - `released`: the server gave up the order and its inventory lock;
 * - `local_only`: the server could not be told (the route does not exist yet, or no connection).
 *   The cart is unlocked on this phone; the server's lock runs out by itself within 10 minutes;
 * - `already_paid`: the payment landed first (409). The order stands and the cart stays locked
 *   until the lock-status poll opens the order.
 */
export type AbandonOutcome = 'released' | 'local_only' | 'already_paid';

/**
 * "Cancel Payment": gives up a checkout that is waiting for payment. Asks the server to release
 * the order's Redis inventory lock (POST /api/orders/:id/abandon: PROPOSED, not built yet, see
 * STATE_HANDOFF §8W) and, unless the payment already went through, ends the checkout session on
 * the device: the countdown stops and the cart can be edited again. Never throws.
 */
export async function abandonCheckout(orderId: string): Promise<AbandonOutcome> {
  let outcome: AbandonOutcome;
  try {
    await apiRequest({
      method: 'POST',
      path: abandonCheckoutPath(orderId),
      schema: abandonResponseSchema,
    });
    outcome = 'released';
  } catch (error) {
    outcome =
      error instanceof ApiError && error.status === 409 && error.code === 'ORDER_STATE_CONFLICT'
        ? 'already_paid'
        : 'local_only';
  }
  if (outcome !== 'already_paid') {
    const { session, endSession } = useCheckoutStore.getState();
    if (session?.orderId === orderId) endSession();
  }
  return outcome;
}

export function useAbandonCheckout() {
  return useMutation<AbandonOutcome, never, string>({
    mutationKey: ['checkout', 'abandon'],
    mutationFn: abandonCheckout,
  });
}
