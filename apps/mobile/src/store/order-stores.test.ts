import { mmkvStateStorage } from '../storage/mmkv-state-storage';
import { orderView, ORDER_ID } from '../test/api-fixtures';
import { InMemoryMmkv } from '../test/in-memory-mmkv';
import { createDeliveryOtpStore, DELIVERY_OTP_STORE_KEY } from './useDeliveryOtpStore';
import { createOrderStore, MAX_TRACKED_ORDERS, ORDER_STORE_KEY } from './useOrderStore';

const PLACED_AT = Date.parse('2026-09-29T10:00:00.000Z');
const placed = { orderId: ORDER_ID, paymentMethod: 'COD' as const, totalNpr: 1250 };

describe('order store', () => {
  let engine: InMemoryMmkv;
  beforeEach(() => {
    engine = new InMemoryMmkv();
  });
  const build = () => createOrderStore(mmkvStateStorage(engine));

  it('records when an order was placed', () => {
    const store = build();

    store.getState().trackPlaced(placed, PLACED_AT);

    expect(store.getState().orders[ORDER_ID]).toEqual({
      ...placed,
      placedAt: PLACED_AT,
      state: 'PLACED',
    });
  });

  it('keeps the first placement time, so the 60 s window cannot be restarted', () => {
    const store = build();
    store.getState().trackPlaced(placed, PLACED_AT);

    store.getState().trackPlaced(placed, PLACED_AT + 30_000);

    expect(store.getState().orders[ORDER_ID]?.placedAt).toBe(PLACED_AT);
  });

  it('persists the placement time across a relaunch', () => {
    build().getState().trackPlaced(placed, PLACED_AT);

    expect(build().getState().orders[ORDER_ID]?.placedAt).toBe(PLACED_AT);
    expect(engine.getString(ORDER_STORE_KEY)).toContain(String(PLACED_AT));
  });

  it('applies server views without losing the placement time', () => {
    const store = build();
    store.getState().trackPlaced(placed, PLACED_AT);

    store.getState().applyOrderView(orderView({ state: 'OUT_FOR_DELIVERY', total_npr: 1300 }));

    expect(store.getState().orders[ORDER_ID]).toMatchObject({
      state: 'OUT_FOR_DELIVERY',
      totalNpr: 1300,
      placedAt: PLACED_AT,
    });
  });

  it('tracks an order first seen from the server with an unknown placement time', () => {
    const store = build();

    store.getState().applyOrderView(orderView({ state: 'PREPARING' }));

    expect(store.getState().orders[ORDER_ID]).toMatchObject({ placedAt: null, state: 'PREPARING' });
  });

  it('updates the state of a tracked order only', () => {
    const store = build();
    store.getState().trackPlaced(placed, PLACED_AT);

    store.getState().setState(ORDER_ID, 'CANCELED');
    store.getState().setState('unknown-order', 'CANCELED');

    expect(store.getState().orders[ORDER_ID]?.state).toBe('CANCELED');
    expect(store.getState().orders['unknown-order']).toBeUndefined();
  });

  it(`keeps only the ${String(MAX_TRACKED_ORDERS)} most recent orders`, () => {
    const store = build();
    for (let i = 0; i <= MAX_TRACKED_ORDERS; i += 1) {
      store.getState().trackPlaced({ ...placed, orderId: `order-${String(i)}` }, PLACED_AT + i);
    }

    expect(Object.keys(store.getState().orders)).toHaveLength(MAX_TRACKED_ORDERS);
    expect(store.getState().orders['order-0']).toBeUndefined();
    expect(store.getState().orders[`order-${String(MAX_TRACKED_ORDERS)}`]).toBeDefined();
  });

  it('discards a tampered persisted store', () => {
    engine.set(
      ORDER_STORE_KEY,
      JSON.stringify({ state: { orders: { x: { orderId: 'x', state: 'HACKED' } } }, version: 1 }),
    );

    expect(build().getState().orders).toEqual({});
  });
});

describe('delivery OTP store (encrypted)', () => {
  let engine: InMemoryMmkv;
  beforeEach(() => {
    engine = new InMemoryMmkv();
  });
  const build = () => createDeliveryOtpStore(mmkvStateStorage(engine));

  it('keeps the latest code per order across a relaunch', () => {
    const store = build();
    store.getState().setOtp(ORDER_ID, '4821');
    store.getState().setOtp(ORDER_ID, '0427');

    expect(build().getState().otps[ORDER_ID]).toBe('0427');
    expect(engine.getString(DELIVERY_OTP_STORE_KEY)).toContain('0427');
  });

  it('forgets a code', () => {
    const store = build();
    store.getState().setOtp(ORDER_ID, '4821');
    store.getState().setOtp('other', '1111');

    store.getState().clearOtp(ORDER_ID);

    expect(store.getState().otps).toEqual({ other: '1111' });
  });

  it.each(['123', '12345', 'abcd', ''])('rejects %p', (otp) => {
    expect(() => {
      build().getState().setOtp(ORDER_ID, otp);
    }).toThrow(RangeError);
  });
});
