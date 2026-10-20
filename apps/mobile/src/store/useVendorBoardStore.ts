import type { VendorOrderView } from '@hamro-pasal/shared-types';
import { create } from 'zustand';

/** How many finished orders the board remembers (the dashboard stays open all day). */
export const MAX_HANDED_OVER_ORDERS = 30;

export interface VendorBoardState {
  /**
   * Live orders this device saw leave the server's open-order list, newest first: a fleet order
   * it dispatched (under Ready until its delivery is announced) or an order it delivered with
   * the code (Handed Over). This sitting's record only.
   */
  departed: VendorOrderView[];
  recordDeparted: (order: VendorOrderView) => void;
  /**
   * The server announced a new state for an order: one this device remembers moves with it
   * (delivered → Handed Over) or goes (canceled, failed). Other orders are ignored.
   */
  settleDeparted: (orderId: string, state: VendorOrderView['state']) => void;
  reset: () => void;
}

/** In memory only: the board is rebuilt from the server on every launch. */
export const useVendorBoardStore = create<VendorBoardState>()((set, get) => ({
  departed: [],
  recordDeparted: (order) => {
    set(({ departed }) => ({
      departed: [order, ...departed.filter((existing) => existing.id !== order.id)].slice(
        0,
        MAX_HANDED_OVER_ORDERS,
      ),
    }));
  },
  settleDeparted: (orderId, state) => {
    const { departed } = get();
    if (!departed.some((order) => order.id === orderId)) return;
    set({
      departed:
        state === 'DELIVERED'
          ? departed.map((order) => (order.id === orderId ? { ...order, state } : order))
          : state === 'OUT_FOR_DELIVERY'
            ? departed
            : departed.filter((order) => order.id !== orderId),
    });
  },
  reset: () => {
    set({ departed: [] });
  },
}));
