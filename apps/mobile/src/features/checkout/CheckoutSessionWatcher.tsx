import { router } from 'expo-router';
import { useEffect } from 'react';

import { useLockStatus } from '../../api/queries';
import { useCheckoutStore, type CheckoutSession } from '../../store/useCheckoutStore';
import { useOrderStore } from '../../store/useOrderStore';

/**
 * Calls `onPlaced` once each time the checkout session's order becomes PLACED, whichever path got
 * it there: COD at checkout, the eSewa webhook / Khalti lookup, or the lock-status poll.
 */
export function subscribeToPlacedOrders(onPlaced: (session: CheckoutSession) => void): () => void {
  return useCheckoutStore.subscribe((state, previous) => {
    const session = state.session;
    if (session?.orderState !== 'PLACED') return;
    const before = previous.session;
    if (before?.orderId === session.orderId && before.orderState === 'PLACED') return;
    onPlaced(session);
  });
}

/** Starts the 60 s window (SPEC journey step 8) and opens the tracking screen. */
export function followPlacedOrder(session: CheckoutSession, nowMs: number = Date.now()): void {
  useOrderStore.getState().trackPlaced(
    {
      orderId: session.orderId,
      paymentMethod: session.paymentMethod,
      totalNpr: session.totalNpr,
    },
    nowMs,
  );
  // Only the id travels in the route; the OTP is read from encrypted storage, never from params.
  router.push({ pathname: '/order/[id]', params: { id: session.orderId } });
}

/**
 * Mounted once at the root: keeps the reservation checked (a lapsed one purges the cart) and
 * takes the customer to order tracking as soon as an order is placed, whichever screen they are on.
 */
export function CheckoutSessionWatcher() {
  useLockStatus();
  useEffect(
    () =>
      subscribeToPlacedOrders((session) => {
        followPlacedOrder(session);
      }),
    [],
  );
  return null;
}
