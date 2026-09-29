import { randomUUID } from 'node:crypto';

import {
  errorBodySchema,
  checkoutResponseSchema,
  lockStatusResponseSchema,
  paymentStatusResponseSchema,
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
