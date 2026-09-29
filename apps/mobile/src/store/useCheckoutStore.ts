import {
  orderStateSchema,
  paymentMethodSchema,
  type CheckoutResponseBody,
  type LockStatusResponseBody,
} from '@hamro-pasal/shared-types';
import { randomUUID } from 'expo-crypto';
import { z } from 'zod';
import { create, type Mutate, type StoreApi, type UseBoundStore } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

import { getAppStorage } from '../storage/app-mmkv';
import { mmkvStateStorage } from '../storage/mmkv-state-storage';
import { useCartStore } from './useCartStore';

export const CHECKOUT_STORE_KEY = 'hamro-pasal.checkout';
export const CHECKOUT_STORE_VERSION = 1;

const checkoutSessionSchema = z.strictObject({
  orderId: z.string().min(1),
  /** Null when the order holds no Redis lock (e.g. a replay of an order that already left checkout). */
  reservationId: z.string().min(1).nullable(),
  /** ISO timestamp at which the 600 s inventory lock lapses (SPEC §3). */
  expiresAt: z.string().nullable(),
  orderState: orderStateSchema,
  paymentMethod: paymentMethodSchema,
  totalNpr: z.number().nonnegative(),
});

const checkoutAttemptSchema = z.strictObject({
  idempotencyKey: z.string().min(8).max(100),
  /** The exact cart the key was issued for; a different cart gets a different key. */
  fingerprint: z.string().min(1),
});

const persistedCheckoutSchema = z.strictObject({
  session: checkoutSessionSchema.nullable(),
  attempt: checkoutAttemptSchema.nullable(),
});

export type CheckoutSession = z.infer<typeof checkoutSessionSchema>;
export type CheckoutAttempt = z.infer<typeof checkoutAttemptSchema>;

export interface CheckoutState {
  /** The order created by the latest successful checkout call. Persisted, so a relaunch resumes it. */
  session: CheckoutSession | null;
  /** The idempotency key of the checkout attempt in flight or last failed. Persisted for retries. */
  attempt: CheckoutAttempt | null;
  /**
   * Raw 4-digit handoff OTP. Memory only: never written to disk. Replays rotate it on the server,
   * so only the value from the latest response is kept.
   */
  deliveryOtp: string | null;
  /** Set when the lock lapsed and the cart was purged; drives the "Session Expired" notice. */
  sessionExpired: boolean;

  /**
   * One key per checkout attempt, reused for every retry of the same cart, so a retried POST can
   * never create a second order. Any change to the cart (or payment method) issues a new key.
   */
  idempotencyKeyFor: (fingerprint: string) => string;
  /** Forget the attempt key (the server refused it as reused with a different payload). */
  discardAttempt: () => void;
  startSession: (response: CheckoutResponseBody) => void;
  /** Applies a GET /api/cart/lock-status result (SPEC edge case 1). */
  applyLockStatus: (response: LockStatusResponseBody) => void;
  /** TTL reached 0: purge the cart and return the user to it with "Session Expired" (SPEC §3). */
  expireSession: () => void;
  endSession: () => void;
  dismissSessionExpired: () => void;
}

export type PersistedCheckoutState = Pick<CheckoutState, 'session' | 'attempt'>;

export type CheckoutStore = UseBoundStore<
  Mutate<StoreApi<CheckoutState>, [['zustand/persist', PersistedCheckoutState]]>
>;

export interface CheckoutStoreDeps {
  clearCart: () => void;
  newIdempotencyKey: () => string;
}

const EMPTY: PersistedCheckoutState = { session: null, attempt: null };

function toPersistedCheckoutState(value: unknown): PersistedCheckoutState {
  const parsed = persistedCheckoutSchema.safeParse(value);
  return parsed.success ? parsed.data : EMPTY;
}

/** Poll the lock only while the order is still waiting for payment inside a live reservation. */
export function selectShouldPollLock(state: Pick<CheckoutState, 'session'>): boolean {
  return state.session?.reservationId != null && state.session.orderState === 'PENDING_PAYMENT';
}

/** While a reservation is pending payment, the cart must not change underneath it. */
export const selectIsCheckoutPending = selectShouldPollLock;

/** Canonical description of a checkout payload, independent of line order. */
export function checkoutFingerprint(input: {
  vendorId: string;
  paymentMethod: string;
  items: readonly { product_id: string; quantity: number }[];
}): string {
  const items = [...input.items]
    .sort((a, b) => a.product_id.localeCompare(b.product_id))
    .map((item) => `${item.product_id}x${String(item.quantity)}`);
  return JSON.stringify([input.vendorId, input.paymentMethod, items]);
}

export function createCheckoutStore(
  storage: StateStorage<void>,
  { clearCart, newIdempotencyKey }: CheckoutStoreDeps,
): CheckoutStore {
  return create<CheckoutState>()(
    persist<CheckoutState, [], [], PersistedCheckoutState>(
      (set, get) => ({
        ...EMPTY,
        deliveryOtp: null,
        sessionExpired: false,

        idempotencyKeyFor: (fingerprint) => {
          const { attempt } = get();
          if (attempt?.fingerprint === fingerprint) return attempt.idempotencyKey;
          const idempotencyKey = newIdempotencyKey();
          set({ attempt: { idempotencyKey, fingerprint } });
          return idempotencyKey;
        },

        discardAttempt: () => {
          set({ attempt: null });
        },

        startSession: ({ order, reservation, delivery_otp }) => {
          set({
            session: {
              orderId: order.id,
              reservationId: reservation.id,
              expiresAt: reservation.expires_at,
              orderState: order.state,
              paymentMethod: order.payment_method,
              totalNpr: order.total_npr,
            },
            // The attempt succeeded; the next checkout is a new attempt with a new key.
            attempt: null,
            deliveryOtp: delivery_otp,
            sessionExpired: false,
          });
          // COD is confirmed at checkout (order PLACED at once): the cart has become an order.
          if (order.state === 'PLACED') clearCart();
        },

        applyLockStatus: ({ order, lock }) => {
          const { session } = get();
          if (session?.orderId !== order.id) return;

          if (lock.status === 'EXPIRED') {
            get().expireSession();
            return;
          }
          set({
            session: {
              ...session,
              orderState: order.state,
              expiresAt: lock.status === 'ACTIVE' ? lock.expires_at : session.expiresAt,
            },
          });
          // RELEASED + PLACED: payment confirmed and stock claimed; the cart has become an order.
          if (lock.status === 'RELEASED' && order.state === 'PLACED') clearCart();
        },

        expireSession: () => {
          clearCart();
          set({ ...EMPTY, deliveryOtp: null, sessionExpired: true });
        },

        endSession: () => {
          set({ session: null, deliveryOtp: null });
        },

        dismissSessionExpired: () => {
          set({ sessionExpired: false });
        },
      }),
      {
        name: CHECKOUT_STORE_KEY,
        version: CHECKOUT_STORE_VERSION,
        storage: createJSONStorage<PersistedCheckoutState>(() => storage),
        partialize: ({ session, attempt }): PersistedCheckoutState => ({ session, attempt }),
        migrate: (persisted) => toPersistedCheckoutState(persisted),
        merge: (persisted, current) => ({ ...current, ...toPersistedCheckoutState(persisted) }),
      },
    ),
  );
}

export const useCheckoutStore: CheckoutStore = createCheckoutStore(
  mmkvStateStorage(getAppStorage()),
  {
    clearCart: () => {
      useCartStore.getState().clearCart();
    },
    newIdempotencyKey: randomUUID,
  },
);
