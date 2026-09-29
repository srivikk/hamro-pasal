import { mmkvStateStorage } from '../storage/mmkv-state-storage';
import {
  checkoutResponse,
  lockStatusResponse,
  ORDER_ID,
  RESERVATION_ID,
  THAMEL_ADDRESS,
} from '../test/api-fixtures';
import { InMemoryMmkv } from '../test/in-memory-mmkv';
import {
  CHECKOUT_STORE_KEY,
  CHECKOUT_STORE_VERSION,
  checkoutFingerprint,
  createCheckoutStore,
  selectIsCheckoutPending,
  selectShouldPollLock,
  type CheckoutStore,
} from './useCheckoutStore';

describe('checkout store', () => {
  let engine: InMemoryMmkv;
  let clearCart: jest.Mock;
  let keys: number;
  let store: CheckoutStore;

  const build = () =>
    createCheckoutStore(mmkvStateStorage(engine), {
      clearCart,
      newIdempotencyKey: () => `key-${String((keys += 1))}-padding`,
    });

  beforeEach(() => {
    engine = new InMemoryMmkv();
    clearCart = jest.fn();
    keys = 0;
    store = build();
  });

  describe('idempotency keys (one per checkout attempt)', () => {
    const cart = checkoutFingerprint({
      vendorId: 'v1',
      paymentMethod: 'ESEWA',
      items: [
        { product_id: 'a', quantity: 1 },
        { product_id: 'b', quantity: 2 },
      ],
      deliveryAddress: THAMEL_ADDRESS,
    });

    it('reuses the key for retries of the same cart', () => {
      const first = store.getState().idempotencyKeyFor(cart);

      expect(store.getState().idempotencyKeyFor(cart)).toBe(first);
      expect(keys).toBe(1);
    });

    it('issues a new key when the cart changes', () => {
      const first = store.getState().idempotencyKeyFor(cart);
      const changed = checkoutFingerprint({
        vendorId: 'v1',
        paymentMethod: 'ESEWA',
        items: [{ product_id: 'a', quantity: 3 }],
        deliveryAddress: THAMEL_ADDRESS,
      });

      expect(store.getState().idempotencyKeyFor(changed)).not.toBe(first);
    });

    it('fingerprints ignore line order but not payment method, vendor or address', () => {
      const base = {
        vendorId: 'v1',
        paymentMethod: 'ESEWA',
        items: [
          { product_id: 'a', quantity: 1 },
          { product_id: 'b', quantity: 2 },
        ],
        deliveryAddress: THAMEL_ADDRESS,
      };

      expect(checkoutFingerprint({ ...base, items: [...base.items].reverse() })).toBe(
        checkoutFingerprint(base),
      );
      expect(checkoutFingerprint({ ...base, paymentMethod: 'COD' })).not.toBe(
        checkoutFingerprint(base),
      );
      expect(checkoutFingerprint({ ...base, vendorId: 'v2' })).not.toBe(checkoutFingerprint(base));
      expect(
        checkoutFingerprint({
          ...base,
          deliveryAddress: { ...THAMEL_ADDRESS, ward_number: 27 },
        }),
      ).not.toBe(checkoutFingerprint(base));
      expect(
        checkoutFingerprint({
          ...base,
          deliveryAddress: { ...THAMEL_ADDRESS, exact_lat: 27.7155 },
        }),
      ).not.toBe(checkoutFingerprint(base));
    });

    it('survives a relaunch, so a retry after the app was killed replays the same attempt', () => {
      const first = store.getState().idempotencyKeyFor(cart);

      expect(build().getState().idempotencyKeyFor(cart)).toBe(first);
    });

    it('forgets the key on discardAttempt', () => {
      const first = store.getState().idempotencyKeyFor(cart);
      store.getState().discardAttempt();

      expect(store.getState().idempotencyKeyFor(cart)).not.toBe(first);
    });
  });

  describe('sessions', () => {
    it('starts a pending session from a prepaid checkout and keeps the cart', () => {
      store.getState().idempotencyKeyFor('cart');
      store.getState().startSession(checkoutResponse());

      expect(store.getState()).toMatchObject({
        session: {
          orderId: ORDER_ID,
          reservationId: RESERVATION_ID,
          orderState: 'PENDING_PAYMENT',
        },
        attempt: null,
        deliveryOtp: '4821',
      });
      expect(selectShouldPollLock(store.getState())).toBe(true);
      expect(selectIsCheckoutPending(store.getState())).toBe(true);
      expect(clearCart).not.toHaveBeenCalled();
    });

    it('clears the cart when the order is placed at once (COD)', () => {
      store
        .getState()
        .startSession(checkoutResponse({ order: { state: 'PLACED', payment_method: 'COD' } }));

      expect(clearCart).toHaveBeenCalledTimes(1);
      expect(selectShouldPollLock(store.getState())).toBe(false);
    });

    it('does not poll a session without a reservation', () => {
      store
        .getState()
        .startSession({ ...checkoutResponse(), reservation: { id: null, expires_at: null } });

      expect(selectShouldPollLock(store.getState())).toBe(false);
    });

    it('updates the expiry on ACTIVE', () => {
      store.getState().startSession(checkoutResponse());

      store.getState().applyLockStatus(
        lockStatusResponse({
          status: 'ACTIVE',
          ttl_ms: 1000,
          expires_at: '2026-09-29T10:09:00.000Z',
        }),
      );

      expect(store.getState().session?.expiresAt).toBe('2026-09-29T10:09:00.000Z');
      expect(clearCart).not.toHaveBeenCalled();
    });

    it('purges the cart and flags Session Expired on EXPIRED', () => {
      store.getState().startSession(checkoutResponse());

      store
        .getState()
        .applyLockStatus(lockStatusResponse({ status: 'EXPIRED', ttl_ms: 0, expires_at: null }));

      expect(clearCart).toHaveBeenCalledTimes(1);
      expect(store.getState()).toMatchObject({
        session: null,
        attempt: null,
        deliveryOtp: null,
        sessionExpired: true,
      });
    });

    it('records a payment-confirmed order on RELEASED and clears the cart', () => {
      store.getState().startSession(checkoutResponse());

      store
        .getState()
        .applyLockStatus(
          lockStatusResponse(
            { status: 'RELEASED', ttl_ms: 0, expires_at: null },
            { state: 'PLACED' },
          ),
        );

      expect(store.getState().session?.orderState).toBe('PLACED');
      expect(clearCart).toHaveBeenCalledTimes(1);
      expect(selectShouldPollLock(store.getState())).toBe(false);
    });

    it('keeps the cart when the order left checkout without being placed', () => {
      store.getState().startSession(checkoutResponse());

      store
        .getState()
        .applyLockStatus(
          lockStatusResponse(
            { status: 'RELEASED', ttl_ms: 0, expires_at: null },
            { state: 'FAILED' },
          ),
        );

      expect(store.getState().session?.orderState).toBe('FAILED');
      expect(clearCart).not.toHaveBeenCalled();
    });

    it('applies a confirmed payment: PLACED updates the session and empties the cart', () => {
      store.getState().startSession(checkoutResponse());

      store.getState().applyPaymentView({
        order_id: ORDER_ID,
        order_state: 'PLACED',
        payment_status: 'PAID',
        duplicate: false,
      });

      expect(store.getState().session?.orderState).toBe('PLACED');
      expect(clearCart).toHaveBeenCalledTimes(1);
      expect(selectShouldPollLock(store.getState())).toBe(false);
    });

    it('records a FAILED order without touching the cart', () => {
      store.getState().startSession(checkoutResponse());

      store.getState().setOrderState(ORDER_ID, 'FAILED');

      expect(store.getState().session?.orderState).toBe('FAILED');
      expect(clearCart).not.toHaveBeenCalled();
    });

    it('ignores payment results for another order', () => {
      store.getState().startSession(checkoutResponse());

      store.getState().applyPaymentView({
        order_id: '99999999-9999-4999-8999-999999999999',
        order_state: 'PLACED',
        payment_status: 'PAID',
        duplicate: false,
      });

      expect(store.getState().session?.orderState).toBe('PENDING_PAYMENT');
      expect(clearCart).not.toHaveBeenCalled();
    });

    it('ignores lock statuses for another order', () => {
      store.getState().startSession(checkoutResponse());

      store
        .getState()
        .applyLockStatus(
          lockStatusResponse(
            { status: 'EXPIRED', ttl_ms: 0, expires_at: null },
            { id: '99999999-9999-4999-8999-999999999999' },
          ),
        );

      expect(store.getState().session?.orderId).toBe(ORDER_ID);
      expect(clearCart).not.toHaveBeenCalled();
    });

    it('endSession and dismissSessionExpired reset the UI state', () => {
      store.getState().startSession(checkoutResponse());
      store.getState().expireSession();
      store.getState().dismissSessionExpired();
      store.getState().startSession(checkoutResponse());
      store.getState().endSession();

      expect(store.getState()).toMatchObject({
        session: null,
        deliveryOtp: null,
        sessionExpired: false,
      });
    });
  });

  describe('persistence', () => {
    it('persists the session and attempt, never the delivery OTP', () => {
      store.getState().startSession(checkoutResponse({ otp: '7391' }));

      const raw = engine.getString(CHECKOUT_STORE_KEY) ?? '';
      expect(raw).not.toContain('7391');
      expect(JSON.parse(raw)).toMatchObject({
        state: { session: { orderId: ORDER_ID }, attempt: null },
        version: CHECKOUT_STORE_VERSION,
      });
    });

    it('resumes a pending session after a relaunch (SPEC edge case 1)', () => {
      store.getState().startSession(checkoutResponse());

      const relaunched = build();

      expect(relaunched.getState().session?.orderId).toBe(ORDER_ID);
      expect(selectShouldPollLock(relaunched.getState())).toBe(true);
      expect(relaunched.getState().deliveryOtp).toBeNull();
    });

    it('discards a tampered persisted session', () => {
      engine.set(
        CHECKOUT_STORE_KEY,
        JSON.stringify({
          state: { session: { orderId: ORDER_ID, orderState: 'HACKED' }, attempt: null },
          version: CHECKOUT_STORE_VERSION,
        }),
      );

      expect(build().getState().session).toBeNull();
    });
  });
});
