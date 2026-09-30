import { randomUUID } from 'node:crypto';

import {
  cancelOrderResponseSchema,
  errorBodySchema,
  checkoutResponseSchema,
  feedResponseSchema,
  lockStatusResponseSchema,
  orderDetailResponseSchema,
  paymentStatusResponseSchema,
  tokenRefreshResponseSchema,
  vendorMenuSchema,
} from './responses';

const order = {
  id: randomUUID(),
  vendor_id: randomUUID(),
  state: 'PENDING_PAYMENT',
  payment_method: 'ESEWA',
  payment_status: 'PENDING',
  fulfillment: 'SELF_DELIVERY',
  subtotal_npr: 1000,
  delivery_fee_npr: 50,
  total_npr: 1050,
  created_at: '2026-09-29T10:00:00.000Z',
};

describe('API response schemas', () => {
  it('accept a well-formed checkout response', () => {
    const body = {
      order,
      reservation: { id: randomUUID(), expires_at: '2026-09-29T10:10:00.000Z' },
      delivery_otp: '0421',
      replayed: false,
    };

    expect(checkoutResponseSchema.parse(body)).toEqual(body);
  });

  it('reject fields the server must never expose, and malformed OTPs', () => {
    const base = { order, reservation: { id: null, expires_at: null }, replayed: true };

    expect(
      checkoutResponseSchema.safeParse({
        ...base,
        delivery_otp: null,
        order: { ...order, delivery_otp: '$2b$10$hash' },
      }).success,
    ).toBe(false);
    expect(checkoutResponseSchema.safeParse({ ...base, delivery_otp: '12345' }).success).toBe(
      false,
    );
  });

  it('only allow the three lock statuses', () => {
    const lock = { status: 'ACTIVE', ttl_ms: 42_000, expires_at: '2026-09-29T10:10:00.000Z' };

    expect(lockStatusResponseSchema.safeParse({ order, lock }).success).toBe(true);
    expect(
      lockStatusResponseSchema.safeParse({ order, lock: { ...lock, status: 'PAUSED' } }).success,
    ).toBe(false);
  });

  it('describe the standard error envelope, with optional details', () => {
    const withDetails = {
      error: {
        code: 'INSUFFICIENT_STOCK',
        message: 'Some items are out of stock',
        details: { shortfalls: [{ productId: order.id, requested: 2, available: 1 }] },
      },
    };

    expect(errorBodySchema.parse(withDetails)).toEqual(withDetails);
    expect(
      errorBodySchema.parse({ error: { code: 'NOT_FOUND', message: 'Route not found' } }),
    ).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    expect(errorBodySchema.safeParse({ error: { message: 'no code' } }).success).toBe(false);
    expect(errorBodySchema.safeParse({ error: 'NOT_FOUND' }).success).toBe(false);
  });

  it('model a gateway status with or without a confirmed payment', () => {
    expect(paymentStatusResponseSchema.parse({ status: 'Pending', payment: null }).payment).toBe(
      null,
    );
    expect(
      paymentStatusResponseSchema.parse({
        status: 'COMPLETE',
        payment: {
          order_id: order.id,
          order_state: 'PLACED',
          payment_status: 'PAID',
          duplicate: false,
        },
      }).payment?.order_state,
    ).toBe('PLACED');
  });
});

describe('feed and menu schemas', () => {
  const vendor = {
    id: randomUUID(),
    business_name: 'Thamel Kirana Pasal',
    delivery_scope: 'RADIUS_BOUND',
    radius_km: 5,
    municipality_palika_string: 'Kathmandu Metropolitan City',
    min_order_value: 500,
    base_delivery_fee_npr: 50,
    fulfillment_mode: 'SELF_DELIVERY',
    location: { x: 85.3123, y: 27.7154 },
  };

  it('accept a partitioned feed', () => {
    const body = {
      serviceable: [{ vendor, distance_km: 0.18, serviceable: true }],
      explore_further: [
        { vendor: { ...vendor, id: randomUUID() }, distance_km: 7.2, serviceable: false },
      ],
    };

    expect(feedResponseSchema.parse(body)).toEqual(body);
  });

  it('reject vendor fields the feed must not expose', () => {
    const leaky = { ...vendor, wallet_balance_npr: -150, phone: '+9779800000011' };

    expect(
      feedResponseSchema.safeParse({
        serviceable: [{ vendor: leaky, distance_km: 1, serviceable: true }],
        explore_further: [],
      }).success,
    ).toBe(false);
  });

  it('accept a menu with real product uuids only', () => {
    const product = { id: randomUUID(), name: 'Ilam Tea 500g', price_npr: 450, in_stock: true };

    expect(
      vendorMenuSchema.parse({ vendor, serviceable: true, products: [product] }),
    ).toBeDefined();
    expect(
      vendorMenuSchema.safeParse({
        vendor,
        serviceable: true,
        products: [{ ...product, id: 'p-1' }],
      }).success,
    ).toBe(false);
  });
});

describe('order detail and cancellation schemas', () => {
  const snapshot = {
    ...order,
    state: 'DELIVERED',
    payment_status: 'PAID',
    customer_id: randomUUID(),
    refund_required: false,
    placed_at: '2026-09-29T10:00:20.000Z',
    delivered_at: '2026-09-29T11:00:00.000Z',
    delivery_address: {
      province_id: 3,
      district_string: 'Kathmandu',
      municipality_palika_string: 'Kathmandu Metropolitan City',
      ward_number: 26,
      tole_locality: 'Thamel',
      landmark: 'Near Kathmandu Guest House',
      exact_lat: 27.7149,
      exact_lng: 85.3106,
    },
    items: [
      { product_id: randomUUID(), product_name: 'Ilam Tea 500g', unit_price_npr: 500, quantity: 2 },
    ],
  };

  it('accept an order snapshot with delivered_at and the address', () => {
    expect(orderDetailResponseSchema.parse({ order: snapshot })).toEqual({ order: snapshot });
    expect(
      orderDetailResponseSchema.parse({
        order: { ...snapshot, placed_at: null, delivered_at: null, delivery_address: null },
      }).order.delivered_at,
    ).toBeNull();
  });

  it('require delivered_at as an ISO datetime and never expose the OTP hash', () => {
    expect(
      orderDetailResponseSchema.safeParse({ order: { ...snapshot, delivered_at: 'yesterday' } })
        .success,
    ).toBe(false);
    expect(
      orderDetailResponseSchema.safeParse({
        order: { ...snapshot, delivery_otp: '$2b$10$abc' },
      }).success,
    ).toBe(false);
  });

  it('accept only a CANCELED cancellation result', () => {
    const body = { order_id: randomUUID(), state: 'CANCELED', refund_required: true };

    expect(cancelOrderResponseSchema.parse(body)).toEqual(body);
    expect(cancelOrderResponseSchema.safeParse({ ...body, state: 'PLACED' }).success).toBe(false);
  });
});

describe('token refresh schemas', () => {
  it('accept a new access token and nothing that leaks a refresh token back', () => {
    const body = { token_type: 'Bearer', access_token: 'a.b.c', access_token_expires_in: 900 };

    expect(tokenRefreshResponseSchema.parse(body)).toEqual(body);
    expect(tokenRefreshResponseSchema.safeParse({ ...body, refresh_token: 'x.y.z' }).success).toBe(
      false,
    );
  });
});
