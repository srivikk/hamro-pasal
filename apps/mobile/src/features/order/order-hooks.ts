import type { CancelOrderResponseBody, OrderSnapshotView } from '@hamro-pasal/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ApiError } from '../../api/http';
import { CANCELLATION_WINDOW_EXPIRED, cancelOrder, fetchOrder } from '../../api/orders';
import { retryTransientFailures } from '../../api/query-client';
import { useCheckoutStore } from '../../store/useCheckoutStore';
import { useDeliveryOtpStore } from '../../store/useDeliveryOtpStore';
import { useOrderStore } from '../../store/useOrderStore';
import { useToastStore } from '../../store/useToastStore';
import { cancellationRemainingMs } from './cancellation-window';
import { isTerminalOrderState } from './order-tracker';

export function orderQueryKey(orderId: string) {
  return ['order', orderId] as const;
}

/** Copies a server snapshot into the device stores (whether it came over REST or the socket). */
export function syncOrderSnapshot(view: OrderSnapshotView): void {
  useOrderStore.getState().applyOrderView(view);
  // The handoff code is useless once the order is finished; do not keep it around.
  if (isTerminalOrderState(view.state)) useDeliveryOtpStore.getState().clearOtp(view.id);
}

/**
 * The tracked order, read once from GET /api/orders/:id. There is no polling: state changes arrive
 * over the Socket.io `/orders` namespace (useOrderRealtime), which also refetches after every
 * (re)subscription to catch anything missed while offline.
 */
export function useOrderQuery(orderId: string) {
  const state = useOrderStore((store) => store.orders[orderId]?.state);
  const live = state === undefined || !isTerminalOrderState(state);

  return useQuery({
    queryKey: orderQueryKey(orderId),
    queryFn: async () => {
      const view = await fetchOrder(orderId);
      syncOrderSnapshot(view);
      return view;
    },
    enabled: live,
    retry: retryTransientFailures,
  });
}

/** POST /api/orders/:id/cancel. The server is the judge of the 60 s window. */
export function useCancelOrder() {
  const { t } = useTranslation();
  const toast = useToastStore((store) => store.show);
  const queryClient = useQueryClient();

  return useMutation<CancelOrderResponseBody, ApiError, { orderId: string }>({
    mutationKey: ['order-cancel'],
    mutationFn: ({ orderId }) => cancelOrder(orderId),
    onSuccess: ({ order_id: orderId, refund_required: refundRequired }) => {
      useOrderStore.getState().setState(orderId, 'CANCELED');
      useCheckoutStore.getState().setOrderState(orderId, 'CANCELED');
      useDeliveryOtpStore.getState().clearOtp(orderId);
      // The server sets refund_required for a PAID (prepaid) order: its escrow is being refunded.
      toast(t(refundRequired ? 'order.cancel.doneRefund' : 'order.cancel.done'), 'info');
    },
    onError: (error, { orderId }) => {
      toast(
        error.code === CANCELLATION_WINDOW_EXPIRED
          ? t('order.cancel.windowClosed')
          : t('order.cancel.failed'),
        'error',
      );
      // The server refused: show whatever state it actually holds (e.g. the vendor moved on).
      void queryClient.invalidateQueries({ queryKey: orderQueryKey(orderId) });
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
