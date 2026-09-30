import { randomUUID } from 'node:crypto';

import { DOMAIN_EVENT_TOPICS, domainEventSchema, KAFKA_TOPICS } from './domain-events';

const base = {
  event_id: randomUUID(),
  event_version: 1,
  occurred_at: '2026-09-29T10:00:00.000Z',
  aggregate_id: randomUUID(),
};

describe('domainEventSchema', () => {
  it('accepts a well-formed order.locked event', () => {
    const event = domainEventSchema.parse({
      ...base,
      event_type: 'order.locked',
      payload: {
        reservation_id: randomUUID(),
        vendor_id: randomUUID(),
        customer_id: randomUUID(),
        items: [{ product_id: randomUUID(), quantity: 2 }],
        locked_at: '2026-09-29T10:00:00.000Z',
        expires_at: '2026-09-29T10:10:00.000Z',
      },
    });

    expect(event.event_type).toBe('order.locked');
  });

  it('rejects a payload that does not match its event_type', () => {
    const result = domainEventSchema.safeParse({
      ...base,
      event_type: 'ledger.mutated',
      payload: { reservation_id: randomUUID() },
    });

    expect(result.success).toBe(false);
  });

  it('requires at least two postings in a ledger.mutated event', () => {
    const result = domainEventSchema.safeParse({
      ...base,
      event_type: 'ledger.mutated',
      payload: {
        transaction_id: randomUUID(),
        kind: 'ORDER_SETTLEMENT',
        order_id: null,
        entries: [
          {
            account_id: randomUUID(),
            account_type: 'SYSTEM_ESCROW',
            vendor_id: null,
            driver_user_id: null,
            gateway: null,
            amount_npr: -100,
            balance_after_npr: 0,
          },
        ],
      },
    });

    expect(result.success).toBe(false);
  });

  it('routes every event type to a provisioned topic', () => {
    const provisioned = new Set<string>(Object.values(KAFKA_TOPICS));

    for (const topic of Object.values(DOMAIN_EVENT_TOPICS)) {
      expect(provisioned.has(topic)).toBe(true);
    }
    expect(DOMAIN_EVENT_TOPICS['order.placed']).toBe('order.lifecycle');
    expect(DOMAIN_EVENT_TOPICS['ledger.mutated']).toBe('ledger.mutations');
  });
});

describe('order.canceled_refund_due', () => {
  const payload = {
    order_id: randomUUID(),
    vendor_id: randomUUID(),
    customer_id: randomUUID(),
    payment_method: 'KHALTI',
    payment_gateway_ref: 'HT6o6PEZRWFJ5ygavzHWd5',
    refund_amount_npr: 1050,
    canceled_at: '2026-09-29T10:00:59.000Z',
  };

  it('is a valid domain event routed to payment reconciliation', () => {
    const event = domainEventSchema.parse({
      ...base,
      event_type: 'order.canceled_refund_due',
      payload,
    });

    expect(event.event_type).toBe('order.canceled_refund_due');
    expect(DOMAIN_EVENT_TOPICS['order.canceled_refund_due']).toBe('payment.reconciliation');
  });

  it('cannot describe a refund for a COD order or a zero amount', () => {
    const parse = (overrides: Record<string, unknown>) =>
      domainEventSchema.safeParse({
        ...base,
        event_type: 'order.canceled_refund_due',
        payload: { ...payload, ...overrides },
      }).success;

    expect(parse({ payment_method: 'COD' })).toBe(false);
    expect(parse({ refund_amount_npr: 0 })).toBe(false);
  });
});

describe('vendor.escalation.required', () => {
  const payload = {
    order_id: randomUUID(),
    vendor_id: randomUUID(),
    vendor_phone: '+9779800000011',
    placed_at: '2026-09-30T10:00:00.000Z',
    sla_seconds: 90,
    escalated_at: '2026-09-30T10:01:30.000Z',
  };

  it('is a valid domain event routed to the notification fan-out topic', () => {
    const event = domainEventSchema.parse({
      ...base,
      event_type: 'vendor.escalation.required',
      payload,
    });

    expect(event.event_type).toBe('vendor.escalation.required');
    expect(DOMAIN_EVENT_TOPICS['vendor.escalation.required']).toBe('notifications.broadcast');
  });

  it('only carries a strict +977 number for the IVR call and SMS', () => {
    const parse = (overrides: Record<string, unknown>) =>
      domainEventSchema.safeParse({
        ...base,
        event_type: 'vendor.escalation.required',
        payload: { ...payload, ...overrides },
      }).success;

    expect(parse({ vendor_phone: '9800000011' })).toBe(false);
    expect(parse({ vendor_phone: '+15551234567' })).toBe(false);
    expect(parse({ sla_seconds: 0 })).toBe(false);
    expect(parse({ customer_phone: '+9779800000001' })).toBe(false);
  });
});
