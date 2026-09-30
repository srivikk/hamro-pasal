import { randomUUID } from 'node:crypto';

import type { DomainEvent } from '@hamro-pasal/shared-types';

import {
  formatNpr,
  orderCode,
  SINGLE_SMS_SEGMENT_LENGTH,
  vendorNotificationSms,
} from './vendor-sms';

const AT = '2026-09-30T10:00:00.000Z';
const PHONE = '+9779800000011';

const base = () => ({ event_id: randomUUID(), event_version: 1 as const, occurred_at: AT });

function suspended(balance: number, limit = -2000): DomainEvent {
  const vendorId = randomUUID();
  return {
    ...base(),
    event_type: 'vendor.suspended_for_debt',
    aggregate_id: vendorId,
    payload: {
      vendor_id: vendorId,
      vendor_phone: PHONE,
      previous_status: 'LIVE',
      wallet_balance_npr: balance,
      suspension_limit_npr: limit,
      suspended_at: AT,
    },
  };
}

function restored(balance: number): DomainEvent {
  const vendorId = randomUUID();
  return {
    ...base(),
    event_type: 'vendor.restored',
    aggregate_id: vendorId,
    payload: {
      vendor_id: vendorId,
      vendor_phone: PHONE,
      restored_status: 'LIVE',
      wallet_balance_npr: balance,
      transaction_id: randomUUID(),
      restored_at: AT,
    },
  };
}

function escalation(orderId: string): DomainEvent {
  return {
    ...base(),
    event_type: 'vendor.escalation.required',
    aggregate_id: orderId,
    payload: {
      order_id: orderId,
      vendor_id: randomUUID(),
      vendor_phone: PHONE,
      placed_at: AT,
      sla_seconds: 90,
      escalated_at: AT,
    },
  };
}

describe('vendorNotificationSms', () => {
  it('suspension: explains the offline shop, the limit and the exact top-up', () => {
    expect(vendorNotificationSms(suspended(-2500))).toEqual({
      to: PHONE,
      text:
        'Hamro Pasal: your shop is offline. Your wallet is at Rs. -2,500, below the Rs. -2,000 ' +
        "limit. Pay Rs. 2,500 in the app's Wallet to go back online.",
    });
  });

  it('suspension after a tightened limit quotes the limit from the event', () => {
    expect(vendorNotificationSms(suspended(-1500.5, -1000))?.text).toContain(
      'Your wallet is at Rs. -1,500.50, below the Rs. -1,000 limit. Pay Rs. 1,500.50',
    );
  });

  it('restore: says the shop is back online', () => {
    expect(vendorNotificationSms(restored(0))).toEqual({
      to: PHONE,
      text: 'Hamro Pasal: your dues are cleared and your shop is back online. Wallet balance: Rs. 0.',
    });
  });

  it('escalation: names the order by its dashboard code and the SLA', () => {
    const orderId = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4fa5b6';
    expect(vendorNotificationSms(escalation(orderId))).toEqual({
      to: PHONE,
      text:
        'Hamro Pasal: order #4FA5B6 has waited over 90 seconds. ' +
        'Open the app now to accept or reject it.',
    });
  });

  it('returns null for events vendors are not texted about', () => {
    const orderId = randomUUID();
    const placed: DomainEvent = {
      ...base(),
      event_type: 'order.state_changed',
      aggregate_id: orderId,
      payload: {
        order_id: orderId,
        customer_id: randomUUID(),
        vendor_id: randomUUID(),
        from_state: 'PLACED',
        to_state: 'PREPARING',
        payment_status: 'PENDING',
        refund_required: false,
        placed_at: AT,
        delivered_at: null,
        changed_at: AT,
      },
    };
    expect(vendorNotificationSms(placed)).toBeNull();
  });

  it.each([
    ['suspension at -1,00,000.55', suspended(-100_000.55)],
    ['restore at 1,00,000.55', restored(100_000.55)],
    ['escalation', escalation(randomUUID())],
  ])('%s fits one plain-ASCII SMS segment', (_label, event) => {
    const text = vendorNotificationSms(event)?.text ?? '';
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(SINGLE_SMS_SEGMENT_LENGTH);
    expect(text).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe('formatNpr', () => {
  it.each([
    [0, 'Rs. 0'],
    [100, 'Rs. 100'],
    [-2500, 'Rs. -2,500'],
    [123456.5, 'Rs. 1,23,456.50'],
  ])('%p → %s', (amount, expected) => {
    expect(formatNpr(amount)).toBe(expected);
  });
});

describe('orderCode', () => {
  it('matches the vendor dashboard code (last 6 hex digits, upper case)', () => {
    expect(orderCode('3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4fa5b6')).toBe('4FA5B6');
  });
});
