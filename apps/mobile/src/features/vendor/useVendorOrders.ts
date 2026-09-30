import {
  ORDER_SOCKET_EVENTS,
  orderStateUpdateSchema,
  vendorSubscribeAckSchema,
  type VendorOrderDecisionResponseBody,
  type VendorOrderView,
} from '@hamro-pasal/shared-types';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '../../api/http';
import { retryTransientFailures } from '../../api/query-client';
import {
  decideVendorOrder,
  fetchVendorOrders,
  type VendorOrderDecision,
} from '../../api/vendor-orders';
import { createOrdersSocket, reconnectDelayMs, type SocketFactory } from '../../services/socket';
import { useToastStore } from '../../store/useToastStore';

export const vendorOrdersQueryKey = ['vendor', 'orders'] as const;

/** How long the server may take to acknowledge `vendor:subscribe`. */
export const VENDOR_SUBSCRIBE_ACK_TIMEOUT_MS = 10_000;

/** The shop's open orders (GET /api/vendors/orders), new ones first. */
export function useVendorOrdersQuery() {
  return useQuery({
    queryKey: vendorOrdersQueryKey,
    queryFn: fetchVendorOrders,
    retry: retryTransientFailures,
    // Always ask again on mount: a stale list could miss an order that is ringing.
    staleTime: 0,
  });
}

/**
 * Live incoming orders over Socket.io `/orders` (vendor flow step 6): joins the shop's
 * `vendor:{id}` room on every (re)connect and refetches the open orders after each join (catch-up)
 * and on each `order:state_update` of the shop's orders (a new PLACED order, or a customer
 * cancellation). A new order's items are not in the update, hence a refetch rather than a patch.
 */
export function useVendorOrdersRealtime(enabled: boolean, socketFactory?: SocketFactory): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return undefined;
    const { socket, close } = createOrdersSocket(socketFactory);
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const refetch = (): void => {
      void queryClient.invalidateQueries({ queryKey: vendorOrdersQueryKey });
    };

    const subscribe = (): void => {
      socket
        .timeout(VENDOR_SUBSCRIBE_ACK_TIMEOUT_MS)
        .emit(ORDER_SOCKET_EVENTS.vendorSubscribe, {}, (error, response) => {
          const ack = error instanceof Error ? null : vendorSubscribeAckSchema.safeParse(response);
          if (ack?.success === true && ack.data.ok) {
            attempt = 0;
            refetch(); // anything placed before the join never reached this socket
            return;
          }
          const refused =
            ack?.success === true &&
            !ack.data.ok &&
            (ack.data.error.code === 'FORBIDDEN' || ack.data.error.code === 'VENDOR_NOT_FOUND');
          if (refused || !socket.connected) return; // never retry a refusal; reconnect re-joins
          retryTimer = setTimeout(subscribe, reconnectDelayMs(attempt));
          attempt += 1;
        });
    };

    const onConnect = (): void => {
      if (retryTimer !== null) clearTimeout(retryTimer);
      attempt = 0;
      subscribe();
    };

    const onStateUpdate = (payload: unknown): void => {
      if (orderStateUpdateSchema.safeParse(payload).success) refetch();
    };

    socket.on('connect', onConnect);
    socket.on(ORDER_SOCKET_EVENTS.stateUpdate, onStateUpdate);
    socket.connect();

    return () => {
      if (retryTimer !== null) clearTimeout(retryTimer);
      socket.off('connect', onConnect);
      socket.off(ORDER_SOCKET_EVENTS.stateUpdate, onStateUpdate);
      close();
    };
  }, [enabled, queryClient, socketFactory]);
}

/** Applies a decision the server confirmed to the cached list, before the refetch lands. */
function applyDecision(queryClient: QueryClient, result: VendorOrderDecisionResponseBody): void {
  queryClient.setQueryData<VendorOrderView[]>(vendorOrdersQueryKey, (orders) =>
    orders
      ?.map((order) => (order.id === result.order_id ? { ...order, state: result.state } : order))
      .filter((order) => order.state === 'PLACED' || order.state === 'PREPARING'),
  );
}

/** The alarm rings while any order waits for a decision that the vendor has not given yet. */
export function isAlarmRinging(
  orders: readonly VendorOrderView[] | undefined,
  acknowledged: ReadonlySet<string>,
): boolean {
  return (orders ?? []).some((order) => order.state === 'PLACED' && !acknowledged.has(order.id));
}

export interface VendorOrderDecisionInput {
  readonly orderId: string;
  readonly decision: VendorOrderDecision;
}

/**
 * Accept / reject (vendor flow step 7). Pressing either button acknowledges the order at once, so
 * the alarm stops immediately; if the request fails the acknowledgement is withdrawn and the
 * alarm rings again until the vendor retries.
 */
export function useVendorOrderDecisions() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const toast = useToastStore((store) => store.show);
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(() => new Set());

  const setAcknowledgedFor = (orderId: string, value: boolean): void => {
    setAcknowledged((current) => {
      const next = new Set(current);
      if (value) next.add(orderId);
      else next.delete(orderId);
      return next;
    });
  };

  const mutation = useMutation<VendorOrderDecisionResponseBody, unknown, VendorOrderDecisionInput>({
    mutationKey: ['vendor', 'order-decision'],
    mutationFn: ({ orderId, decision }) => decideVendorOrder(orderId, decision),
    onMutate: ({ orderId }) => {
      setAcknowledgedFor(orderId, true);
    },
    onSuccess: (result, { decision }) => {
      applyDecision(queryClient, result);
      toast(
        decision === 'accept'
          ? t('vendorDashboard.accepted')
          : result.refund_required
            ? t('vendorDashboard.rejectedRefund')
            : t('vendorDashboard.rejected'),
        'success',
      );
    },
    onError: (error, { orderId }) => {
      // The order moved on without us (the customer canceled, or another device decided).
      const stale =
        error instanceof ApiError &&
        (error.code === 'ORDER_STATE_CONFLICT' || error.code === 'ORDER_NOT_FOUND');
      if (!stale) setAcknowledgedFor(orderId, false);
      toast(
        t(stale ? 'vendorDashboard.noLongerWaiting' : 'vendorDashboard.decisionFailed'),
        'error',
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: vendorOrdersQueryKey });
    },
  });

  /** Ids of orders the vendor has answered (the request may still be in flight). */
  return { decide: mutation.mutate, acknowledged };
}
