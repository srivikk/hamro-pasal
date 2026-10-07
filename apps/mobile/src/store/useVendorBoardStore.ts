import type { VendorOrderView } from '@hamro-pasal/shared-types';
import { create } from 'zustand';

import { stageOf, type MockBoardEntry } from '../features/vendor/order-board';
import {
  buildMockOrder,
  FIRST_INCOMING_MOCK_SEQUENCE,
  MAX_WAITING_MOCK_ORDERS,
  seedMockOrders,
} from '../features/vendor/vendor-order-mocks';

/** How many finished orders each list keeps (the dashboard stays open all day). */
export const MAX_HANDED_OVER_ORDERS = 30;

const isFinished = (entry: MockBoardEntry): boolean =>
  stageOf(entry.order, entry.riderPickedUp === true) === 'HANDED_OVER';

/** Keeps every order still being worked on and the newest `MAX_HANDED_OVER_ORDERS` finished ones. */
function trimFinished(mocks: MockBoardEntry[]): MockBoardEntry[] {
  const finished = mocks.filter(isFinished);
  if (finished.length <= MAX_HANDED_OVER_ORDERS) return mocks;
  const dropped = new Set(
    finished.slice(0, finished.length - MAX_HANDED_OVER_ORDERS).map((entry) => entry.order.id),
  );
  return mocks.filter((entry) => !dropped.has(entry.order.id));
}

export interface VendorBoardState {
  /** TEMPORARY sample orders (development builds), oldest first. */
  mocks: MockBoardEntry[];
  mocksSeeded: boolean;
  nextMockSequence: number;
  /**
   * Live orders this device saw leave the server's open-order list, newest first: a fleet order
   * it dispatched (under Ready until its delivery is announced) or an order it delivered with
   * the code (Handed Over). This sitting's record only.
   */
  departed: VendorOrderView[];
  /** Fills the board with one sample order per column, once. */
  seedMocks: (nowMs: number) => void;
  /** A new sample order arrives. False (nothing added) while too many already wait. */
  addIncomingMock: (nowMs: number) => boolean;
  setMockState: (orderId: string, state: VendorOrderView['state']) => void;
  /** The (simulated) rider collected a fleet sample: Ready → Handed Over. */
  markMockPickedUp: (orderId: string) => void;
  removeMock: (orderId: string) => void;
  recordDeparted: (order: VendorOrderView) => void;
  /**
   * The server announced a new state for an order: one this device remembers moves with it
   * (delivered → Handed Over) or goes (canceled, failed). Other orders are ignored.
   */
  settleDeparted: (orderId: string, state: VendorOrderView['state']) => void;
  reset: () => void;
}

const initialState = {
  mocks: [],
  mocksSeeded: false,
  nextMockSequence: FIRST_INCOMING_MOCK_SEQUENCE,
  departed: [],
} satisfies Partial<VendorBoardState>;

/** In memory only: the board is rebuilt from the server (and the sample seed) on every launch. */
export const useVendorBoardStore = create<VendorBoardState>()((set, get) => ({
  ...initialState,
  seedMocks: (nowMs) => {
    if (get().mocksSeeded) return;
    set({ mocks: seedMockOrders(nowMs), mocksSeeded: true });
  },
  addIncomingMock: (nowMs) => {
    const { mocks, nextMockSequence } = get();
    const waiting = mocks.filter((entry) => entry.order.state === 'PLACED').length;
    if (waiting >= MAX_WAITING_MOCK_ORDERS) return false;
    set({
      mocks: [...mocks, buildMockOrder(nextMockSequence, nowMs)],
      nextMockSequence: nextMockSequence + 1,
    });
    return true;
  },
  setMockState: (orderId, state) => {
    set(({ mocks }) => ({
      mocks: trimFinished(
        mocks.map((entry) =>
          entry.order.id === orderId ? { ...entry, order: { ...entry.order, state } } : entry,
        ),
      ),
    }));
  },
  markMockPickedUp: (orderId) => {
    set(({ mocks }) => ({
      mocks: trimFinished(
        mocks.map((entry) =>
          entry.order.id === orderId ? { ...entry, riderPickedUp: true } : entry,
        ),
      ),
    }));
  },
  removeMock: (orderId) => {
    set(({ mocks }) => ({ mocks: mocks.filter((entry) => entry.order.id !== orderId) }));
  },
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
    set(initialState);
  },
}));
