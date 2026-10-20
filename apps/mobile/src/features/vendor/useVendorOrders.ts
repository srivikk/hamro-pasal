import {
  ORDER_SOCKET_EVENTS,
  orderStateUpdateSchema,
  type OrderStateUpdate,
  vendorSubscribeAckSchema,
  type DeliveryConfirmedResponseBody,
  type VendorOrderDecisionResponseBody,
  type VendorOrderDispatchResponseBody,
  type VendorOrderView,
} from '@hamro-pasal/shared-types';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { ApiError } from '../../api/http';
import { retryTransientFailures } from '../../api/query-client';
import {
  CANCELLATION_WINDOW_OPEN,
  decideVendorOrder,
  deliverVendorOrder,
  dispatchVendorOrder,
  fetchVendorOrders,
  type VendorOrderDecision,
} from '../../api/vendor-orders';
import { createOrdersSocket, reconnectDelayMs, type SocketFactory } from '../../services/socket';
import { useToastStore } from '../../store/useToastStore';
import { deliveryErrorMessage, isStaleDeliveryError } from '../delivery/delivery-errors';

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
 * `onStateUpdate` also receives each valid update (the board follows orders the list has dropped).
 */
export function useVendorOrdersRealtime(
  enabled: boolean,
  socketFactory?: SocketFactory,
  onStateUpdate?: (update: OrderStateUpdate) => void,
): void {
  const queryClient = useQueryClient();
  // Read at call time, so a new callback never reconnects the socket.
  const listener = useRef(onStateUpdate);
  useEffect(() => {
    listener.current = onStateUpdate;
  }, [onStateUpdate]);

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

    const onUpdate = (payload: unknown): void => {
      const update = orderStateUpdateSchema.safeParse(payload);
      if (!update.success) return;
      listener.current?.(update.data);
      refetch();
    };

    socket.on('connect', onConnect);
    socket.on(ORDER_SOCKET_EVENTS.stateUpdate, onUpdate);
    socket.connect();

    return () => {
      if (retryTimer !== null) clearTimeout(retryTimer);
      socket.off('connect', onConnect);
      socket.off(ORDER_SOCKET_EVENTS.stateUpdate, onUpdate);
      close();
    };
  }, [enabled, queryClient, socketFactory]);
}

/** Applies a decision the server confirmed to the cached list, before the refetch lands. */
function applyDecision(queryClient: QueryClient, result: VendorOrderDecisionResponseBody): void {
  queryClient.setQueryData<VendorOrderView[]>(vendorOrdersQueryKey, (orders) =>
    orders
      ?.map((order) => (order.id === result.order_id ? { ...order, state: result.state } : order))
      .filter(isOnVendorDashboard),
  );
}

/**
 * The orders the server lists for the vendor: new, being packed, and the shop's own deliveries on
 * the road (a fleet order out for delivery is the rider's).
 */
export function isOnVendorDashboard(order: VendorOrderView): boolean {
  return (
    order.state === 'PLACED' ||
    order.state === 'PREPARING' ||
    (order.state === 'OUT_FOR_DELIVERY' && order.fulfillment === 'SELF_DELIVERY')
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
      // SPEC core 10: a shop without a verified PAN cannot take on an order.
      const suspended = error instanceof ApiError && error.code === 'VENDOR_COMPLIANCE_SUSPENDED';
      toast(
        t(
          stale
            ? 'vendorDashboard.noLongerWaiting'
            : suspended
              ? 'vendorDashboard.complianceSuspended'
              : 'vendorDashboard.decisionFailed',
        ),
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

const windowOpenDetailsSchema = z.object({ retry_after_seconds: z.number().int().positive() });

/** Patches one order's state in the cached list and drops it if the vendor no longer sees it. */
function patchState(
  queryClient: QueryClient,
  orderId: string,
  state: VendorOrderView['state'],
): void {
  queryClient.setQueryData<VendorOrderView[]>(vendorOrdersQueryKey, (orders) =>
    orders
      ?.map((order) => (order.id === orderId ? { ...order, state } : order))
      .filter(isOnVendorDashboard),
  );
}

/**
 * Dispatch (vendor flow step 8): PREPARING → OUT_FOR_DELIVERY. A SELF_DELIVERY order stays on the
 * dashboard with the handoff code field; a fleet order leaves it (the rider has it). Inside the
 * customer's 60 s window the server answers 422 CANCELLATION_WINDOW_OPEN, shown with the seconds
 * left; nothing is retried automatically.
 */
export function useVendorDispatch() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const toast = useToastStore((store) => store.show);

  const mutation = useMutation<VendorOrderDispatchResponseBody, unknown, string>({
    mutationKey: ['vendor', 'order-dispatch'],
    mutationFn: dispatchVendorOrder,
    retry: false,
    onSuccess: (result) => {
      const order = queryClient
        .getQueryData<VendorOrderView[]>(vendorOrdersQueryKey)
        ?.find((candidate) => candidate.id === result.order_id);
      patchState(queryClient, result.order_id, result.state);
      toast(
        t(
          order?.fulfillment === 'SELF_DELIVERY'
            ? 'vendorDashboard.dispatched'
            : 'vendorDashboard.dispatchedFleet',
        ),
        'success',
      );
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === CANCELLATION_WINDOW_OPEN) {
        const details = windowOpenDetailsSchema.safeParse(error.details);
        toast(
          t('vendorDashboard.windowOpen', {
            seconds: details.success ? details.data.retry_after_seconds : 60,
          }),
          'error',
        );
        return;
      }
      const stale =
        error instanceof ApiError &&
        (error.code === 'ORDER_STATE_CONFLICT' || error.code === 'ORDER_NOT_FOUND');
      toast(t(stale ? 'vendorDashboard.movedOn' : 'vendorDashboard.dispatchFailed'), 'error');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: vendorOrdersQueryKey });
    },
  });

  return {
    dispatch: mutation.mutate,
    /** The order being dispatched right now, if any. */
    pendingOrderId: mutation.isPending ? mutation.variables : null,
  };
}

export interface VendorDeliverInput {
  readonly orderId: string;
  readonly otp: string;
}

/**
 * The shop's own handoff of a SELF_DELIVERY order (vendor flow step 9), with the rider's rules:
 * success removes the order; a wrong code or a lockout keeps it and says why; an order that moved
 * on is removed. Never retried automatically: a retry of a wrong code is another attempt.
 */
export function useVendorDelivery() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const toast = useToastStore((store) => store.show);

  const mutation = useMutation<DeliveryConfirmedResponseBody, unknown, VendorDeliverInput>({
    mutationKey: ['vendor', 'order-deliver'],
    mutationFn: ({ orderId, otp }) => deliverVendorOrder(orderId, otp),
    retry: false,
    onSuccess: (result) => {
      patchState(queryClient, result.order_id, result.state);
      toast(t('delivery.delivered'), 'success');
    },
    onError: (error, { orderId }) => {
      toast(deliveryErrorMessage(error, t), 'error');
      if (isStaleDeliveryError(error)) {
        queryClient.setQueryData<VendorOrderView[]>(vendorOrdersQueryKey, (orders) =>
          orders?.filter((order) => order.id !== orderId),
        );
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: vendorOrdersQueryKey });
    },
  });

  return {
    deliver: mutation.mutate,
    /** The order whose code is being checked right now, if any. */
    pendingOrderId: mutation.isPending ? mutation.variables.orderId : null,
  };
}
