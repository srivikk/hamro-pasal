import { lockStatusResponseSchema, type LockStatusResponseBody } from '@hamro-pasal/shared-types';
import { useQuery } from '@tanstack/react-query';

import { selectShouldPollLock, useCheckoutStore } from '../store/useCheckoutStore';
import { ApiError, apiRequest } from './http';

export const LOCK_STATUS_PATH = '/api/cart/lock-status';
export const LOCK_STATUS_POLL_INTERVAL_MS = 5000;

export function lockStatusQueryKey(orderId: string) {
  return ['lock-status', orderId] as const;
}

/**
 * Fetches the lock state and applies it to the checkout store in the same step, so every poll
 * result is acted on exactly once: ACTIVE resumes, EXPIRED purges the cart ("Session Expired"),
 * RELEASED ends checkout (SPEC §3 and edge case 1).
 */
export async function fetchAndApplyLockStatus(orderId: string): Promise<LockStatusResponseBody> {
  const checkout = useCheckoutStore.getState();
  try {
    const response = await apiRequest({
      method: 'GET',
      path: LOCK_STATUS_PATH,
      query: { order_id: orderId },
      schema: lockStatusResponseSchema,
    });
    checkout.applyLockStatus(response);
    return response;
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.code === 'RESERVATION_EXPIRED') checkout.expireSession();
      // The order no longer exists for this customer: nothing left to resume.
      if (error.code === 'ORDER_NOT_FOUND') checkout.endSession();
    }
    throw error;
  }
}

/**
 * Polls GET /api/cart/lock-status every 5 s, and only while the checkout store holds a reservation
 * that is still waiting for payment. Network failures do not stop the polling, so after a
 * reconnect the next poll resumes or purges the checkout (SPEC edge case 1).
 */
export function useLockStatus({
  intervalMs = LOCK_STATUS_POLL_INTERVAL_MS,
}: { intervalMs?: number } = {}) {
  const orderId = useCheckoutStore((state) => state.session?.orderId ?? null);
  const shouldPoll = useCheckoutStore(selectShouldPollLock);
  const enabled = shouldPoll && orderId !== null;

  return useQuery({
    queryKey: lockStatusQueryKey(orderId ?? 'none'),
    queryFn: () => fetchAndApplyLockStatus(orderId ?? ''),
    enabled,
    refetchInterval: enabled ? intervalMs : false,
    // Polling is the retry: a failed poll is simply followed by the next one.
    retry: false,
    gcTime: 0,
  });
}
