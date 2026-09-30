import {
  ORDER_SOCKET_EVENTS,
  orderStateUpdateSchema,
  orderSubscribeAckSchema,
  type OrderSnapshotView,
  type OrderStateUpdate,
} from '@hamro-pasal/shared-types';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { createOrdersSocket, reconnectDelayMs, type SocketFactory } from '../../services/socket';
import { orderQueryKey, syncOrderSnapshot } from './order-hooks';

/** How long the server may take to acknowledge `orders:subscribe`. */
export const ORDER_SUBSCRIBE_ACK_TIMEOUT_MS = 10_000;

/**
 * Patches the cached order snapshot with a socket update and mirrors it into the device stores.
 * Without a cached snapshot there is nothing to patch, so the order is fetched instead.
 */
export function applyOrderStateUpdate(queryClient: QueryClient, update: OrderStateUpdate): void {
  const key = orderQueryKey(update.order_id);
  const cached = queryClient.getQueryData<OrderSnapshotView>(key);
  if (cached === undefined) {
    void queryClient.invalidateQueries({ queryKey: key });
    return;
  }
  const next: OrderSnapshotView = {
    ...cached,
    state: update.state,
    payment_status: update.payment_status,
    refund_required: update.refund_required,
    placed_at: update.placed_at,
    delivered_at: update.delivered_at,
  };
  queryClient.setQueryData(key, next);
  syncOrderSnapshot(next);
}

/**
 * Live order tracking over Socket.io `/orders` (SPEC implicit requirement 4, journey step 9):
 * joins the order's room on every (re)connect, applies each `order:state_update` to the TanStack
 * Query cache at once, and refetches the order after each successful join so updates sent while
 * the device was offline are not lost. Disconnects while `enabled` is false (terminal orders).
 */
export function useOrderRealtime(
  orderId: string,
  enabled: boolean,
  socketFactory?: SocketFactory,
): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return undefined;
    const { socket, close } = createOrdersSocket(socketFactory);
    let latestChangedAt = Number.NEGATIVE_INFINITY;
    let subscribeAttempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const subscribe = (): void => {
      socket
        .timeout(ORDER_SUBSCRIBE_ACK_TIMEOUT_MS)
        .emit(ORDER_SOCKET_EVENTS.subscribe, { order_id: orderId }, (error, response) => {
          // Typed as Error, but null on success.
          const ack = error instanceof Error ? null : orderSubscribeAckSchema.safeParse(response);
          if (ack?.success === true && ack.data.ok) {
            subscribeAttempt = 0;
            // Anything that changed before the join never reached this socket: catch up once.
            void queryClient.invalidateQueries({ queryKey: orderQueryKey(orderId) });
            return;
          }
          const refused =
            ack?.success === true &&
            !ack.data.ok &&
            (ack.data.error.code === 'ORDER_NOT_FOUND' ||
              ack.data.error.code === 'VALIDATION_FAILED');
          if (refused || !socket.connected) return; // never retry a refusal; reconnect re-subscribes
          retryTimer = setTimeout(subscribe, reconnectDelayMs(subscribeAttempt));
          subscribeAttempt += 1;
        });
    };

    const onConnect = (): void => {
      // Rooms are per connection: join again after every reconnection.
      if (retryTimer !== null) clearTimeout(retryTimer);
      subscribeAttempt = 0;
      subscribe();
    };

    const onStateUpdate = (payload: unknown): void => {
      const parsed = orderStateUpdateSchema.safeParse(payload);
      if (!parsed.success || parsed.data.order_id !== orderId) return;
      // Never step back to an older state if updates arrive out of order.
      const changedAt = Date.parse(parsed.data.changed_at);
      if (changedAt < latestChangedAt) return;
      latestChangedAt = changedAt;
      applyOrderStateUpdate(queryClient, parsed.data);
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
  }, [orderId, enabled, queryClient, socketFactory]);
}
