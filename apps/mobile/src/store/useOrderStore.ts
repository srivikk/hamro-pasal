import {
  orderStateSchema,
  paymentMethodSchema,
  type OrderState,
  type OrderView,
  type PaymentMethod,
} from '@hamro-pasal/shared-types';
import { z } from 'zod';
import { create, type Mutate, type StoreApi, type UseBoundStore } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

import { getAppStorage } from '../storage/app-mmkv';
import { mmkvStateStorage } from '../storage/mmkv-state-storage';

export const ORDER_STORE_KEY = 'hamro-pasal.orders';
/** v2 added deliveredAt; v1 entries are migrated with deliveredAt: null. */
export const ORDER_STORE_VERSION = 2;
/** Oldest orders are dropped beyond this, so the store cannot grow without bound. */
export const MAX_TRACKED_ORDERS = 20;

const trackedOrderSchema = z.strictObject({
  orderId: z.string().min(1),
  /**
   * When the app saw the order become PLACED (epoch ms): the start of the 60 s cancellation
   * window. Persisted, so relaunching the app neither restarts nor skips the window. Null when the
   * order was never seen being placed on this device (window treated as closed).
   */
  placedAt: z.number().int().nonnegative().nullable(),
  /**
   * When the app first saw the order DELIVERED (epoch ms): the start of the 48 h dispute and
   * review window. The API's OrderView does not expose the server's delivered_at yet, so this is
   * when this device first saw the order DELIVERED: never earlier than the real delivery, but later
   * if the app was closed at the time (the window then closes late). The server must enforce 48 h.
   */
  deliveredAt: z.number().int().nonnegative().nullable(),
  state: orderStateSchema,
  paymentMethod: paymentMethodSchema,
  totalNpr: z.number().nonnegative(),
});

const persistedOrdersSchema = z.strictObject({
  orders: z.record(z.string(), trackedOrderSchema),
});

export type TrackedOrder = z.infer<typeof trackedOrderSchema>;

export interface OrderStoreState {
  orders: Record<string, TrackedOrder>;
  /** Starts tracking a newly placed order. Idempotent: the first placedAt is kept. */
  trackPlaced: (
    order: { orderId: string; paymentMethod: PaymentMethod; totalNpr: number },
    placedAtMs: number,
  ) => void;
  /** Records the latest server view of an order (creating the entry if it is new here). */
  applyOrderView: (view: OrderView, nowMs?: number) => void;
  setState: (orderId: string, state: OrderState) => void;
}

export type PersistedOrderState = Pick<OrderStoreState, 'orders'>;

export type OrderStore = UseBoundStore<
  Mutate<StoreApi<OrderStoreState>, [['zustand/persist', PersistedOrderState]]>
>;

/** v1 entries had no deliveredAt: add it as unknown rather than dropping the orders. */
function migrateOrders(value: unknown, version: number): unknown {
  if (version !== 1 || typeof value !== 'object' || value === null) return value;
  const orders: unknown = Reflect.get(value, 'orders');
  if (typeof orders !== 'object' || orders === null) return value;
  return {
    orders: Object.fromEntries(
      Object.entries(orders).map(([id, order]) => [
        id,
        typeof order === 'object' && order !== null ? { ...order, deliveredAt: null } : order,
      ]),
    ),
  };
}

function toPersistedOrders(value: unknown): PersistedOrderState {
  const parsed = persistedOrdersSchema.safeParse(value);
  return parsed.success ? parsed.data : { orders: {} };
}

/** Keeps the MAX_TRACKED_ORDERS most recently placed orders (never-placed ones count as oldest). */
function capped(orders: Record<string, TrackedOrder>): Record<string, TrackedOrder> {
  const entries = Object.values(orders);
  if (entries.length <= MAX_TRACKED_ORDERS) return orders;
  const newest = entries
    .sort((a, b) => (b.placedAt ?? -1) - (a.placedAt ?? -1))
    .slice(0, MAX_TRACKED_ORDERS);
  return Object.fromEntries(newest.map((order) => [order.orderId, order]));
}

export function createOrderStore(storage: StateStorage<void>): OrderStore {
  return create<OrderStoreState>()(
    persist<OrderStoreState, [], [], PersistedOrderState>(
      (set, get) => ({
        orders: {},

        trackPlaced: ({ orderId, paymentMethod, totalNpr }, placedAtMs) => {
          const existing = get().orders[orderId];
          set({
            orders: capped({
              ...get().orders,
              [orderId]: {
                orderId,
                placedAt: existing?.placedAt ?? placedAtMs,
                deliveredAt: existing?.deliveredAt ?? null,
                state: existing?.state ?? 'PLACED',
                paymentMethod,
                totalNpr,
              },
            }),
          });
        },

        applyOrderView: (view, nowMs = Date.now()) => {
          const existing = get().orders[view.id];
          const deliveredAt = existing?.deliveredAt ?? (view.state === 'DELIVERED' ? nowMs : null);
          set({
            orders: capped({
              ...get().orders,
              [view.id]: {
                orderId: view.id,
                placedAt: existing?.placedAt ?? null,
                deliveredAt,
                state: view.state,
                paymentMethod: view.payment_method,
                totalNpr: view.total_npr,
              },
            }),
          });
        },

        setState: (orderId, state) => {
          const existing = get().orders[orderId];
          if (existing === undefined) return;
          set({ orders: { ...get().orders, [orderId]: { ...existing, state } } });
        },
      }),
      {
        name: ORDER_STORE_KEY,
        version: ORDER_STORE_VERSION,
        storage: createJSONStorage<PersistedOrderState>(() => storage),
        partialize: ({ orders }): PersistedOrderState => ({ orders }),
        migrate: (persisted, version) => toPersistedOrders(migrateOrders(persisted, version)),
        merge: (persisted, current) => ({ ...current, ...toPersistedOrders(persisted) }),
      },
    ),
  );
}

export const useOrderStore: OrderStore = createOrderStore(mmkvStateStorage(getAppStorage()));
