import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ApiError } from '../../api/http';
import { fetchOrder } from '../../api/orders';
import { useCheckoutStore } from '../../store/useCheckoutStore';
import { useDeliveryOtpStore } from '../../store/useDeliveryOtpStore';
import { useOrderStore } from '../../store/useOrderStore';
import { useToastStore } from '../../store/useToastStore';
import { cancellationRemainingMs } from './cancellation-window';
import { cancelOrder, type CancelOrderResult } from './mock-cancel-api';
import { isTerminalOrderState } from './order-tracker';

/**
 * Interim refresh interval for a live order. State changes should arrive over the Socket.io
 * `/orders` namespace (SPEC implicit requirement 4), which the backend does not serve yet. This is
 * a light status fetch, not map polling (SPEC journey step 9).
 */
export const ORDER_REFRESH_INTERVAL_MS = 30_000;

export function orderQueryKey(orderId: string) {
  return ['order', orderId] as const;
}

/** Keeps the tracked order in step with the server until it reaches a terminal state. */
export function useOrderQuery(orderId: string) {
  const state = useOrderStore((store) => store.orders[orderId]?.state);
  const live = state === undefined || !isTerminalOrderState(state);

  return useQuery({
    queryKey: orderQueryKey(orderId),
    queryFn: async () => {
      const view = await fetchOrder(orderId);
      useOrderStore.getState().applyOrderView(view);
      // The handoff code is useless once the order is finished; do not keep it around.
      if (isTerminalOrderState(view.state)) useDeliveryOtpStore.getState().clearOtp(orderId);
      return view;
    },
    enabled: live,
    refetchInterval: live ? ORDER_REFRESH_INTERVAL_MS : false,
  });
}

export function useCancelOrder() {
  const { t } = useTranslation();
  const toast = useToastStore((store) => store.show);

  return useMutation<CancelOrderResult, ApiError, { orderId: string; placedAtMs: number }>({
    mutationKey: ['order-cancel'],
    mutationFn: ({ orderId, placedAtMs }) => cancelOrder(orderId, placedAtMs),
    onSuccess: ({ order_id: orderId }) => {
      useOrderStore.getState().setState(orderId, 'CANCELED');
      useCheckoutStore.getState().setOrderState(orderId, 'CANCELED');
      useDeliveryOtpStore.getState().clearOtp(orderId);
      toast(t('order.cancel.done'), 'info');
    },
    onError: (error) => {
      toast(
        error.code === 'CANCELLATION_WINDOW_CLOSED'
          ? t('order.cancel.windowClosed')
          : t('order.cancel.failed'),
        'error',
      );
    },
  });
}

/**
 * Milliseconds left in the 60 s cancellation window, re-rendering every second while it is open.
 * The window is anchored to the persisted placedAt, so it cannot be skipped or restarted.
 */
export function useCancellationCountdown(placedAtMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  const remaining = cancellationRemainingMs(placedAtMs, now);
  const open = remaining > 0;

  useEffect(() => {
    if (!open) return undefined;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [open]);

  return remaining;
}
