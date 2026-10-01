import { randomUUID } from 'node:crypto';

import { DOMAIN_EVENT_TOPICS, domainEventSchema } from '../events/domain-events';
import {
  ADMIN_DEAD_LETTER_MAX_LIMIT,
  adminDeadLetterListQuerySchema,
  adminVendorViewSchema,
  deadLetterViewSchema,
} from './admin';

const deadLetter = {
  id: randomUUID(),
  status: 'PENDING',
  consumer: 'vendor-notifications',
  source_topic: 'notifications.broadcast',
  source_partition: 1,
  source_offset: '42',
  dead_letter_topic: 'notifications.dlq',
  message_key: 'order-1',
  event_id: randomUUID(),
  event_type: 'vendor.restored',
  payload: { event_type: 'vendor.restored', payload: { wallet_balance_npr: 0 } },
  raw_value: '{"event_type":"vendor.restored","payload":{"wallet_balance_npr":0}}',
  headers: { event_id: 'e1' },
  attempts: 4,
  error_name: 'SmsDeliveryError',
  error_message: 'SPARROW SMS failed: HTTP 503',
  failed_at: '2026-10-01T06:00:00.000Z',
  retry_requested_at: null,
  retry_requested_by: null,
  replayed_at: null,
  replay_attempts: 0,
  last_replay_error: null,
  replay_of_id: null,
};

describe('adminDeadLetterListQuerySchema', () => {
  it('reads status, limit and cursor from query strings', () => {
    const cursor = randomUUID();
    expect(
      adminDeadLetterListQuerySchema.parse({ status: 'RETRY_REQUESTED', limit: '25', cursor }),
    ).toEqual({ status: 'RETRY_REQUESTED', limit: 25, cursor });
    expect(adminDeadLetterListQuerySchema.parse({})).toEqual({});
  });

  it('refuses an unknown status, a limit out of range and extra keys', () => {
    const parse = (query: Record<string, string>) =>
      adminDeadLetterListQuerySchema.safeParse(query).success;
    expect(parse({ status: 'LOST' })).toBe(false);
    expect(parse({ limit: '0' })).toBe(false);
    expect(parse({ limit: String(ADMIN_DEAD_LETTER_MAX_LIMIT + 1) })).toBe(false);
    expect(parse({ limit: '2.5' })).toBe(false);
    expect(parse({ cursor: 'not-a-uuid' })).toBe(false);
    expect(parse({ offset: '10' })).toBe(false);
  });
});

describe('deadLetterViewSchema', () => {
  it('accepts a decoded domain event and a poison pill without payload', () => {
    expect(deadLetterViewSchema.parse(deadLetter)).toEqual(deadLetter);
    expect(
      deadLetterViewSchema.safeParse({
        ...deadLetter,
        message_key: null,
        event_id: null,
        event_type: null,
        payload: null,
        raw_value: '{"broken":',
        headers: {},
        attempts: 1,
      }).success,
    ).toBe(true);
  });

  it('refuses a non-numeric offset, zero attempts and non-string headers', () => {
    const parse = (overrides: Record<string, unknown>) =>
      deadLetterViewSchema.safeParse({ ...deadLetter, ...overrides }).success;
    expect(parse({ source_offset: '-1' })).toBe(false);
    expect(parse({ attempts: 0 })).toBe(false);
    expect(parse({ headers: { event_version: 1 } })).toBe(false);
    expect(parse({ status: 'DONE' })).toBe(false);
  });
});

describe('adminVendorViewSchema', () => {
  const vendor = {
    id: randomUUID(),
    business_name: 'Thamel Kirana Pasal',
    phone: '+9779800000011',
    status: 'SUSPENDED',
    suspension: 'ADMIN',
    restore_status: 'LIVE',
    wallet_balance_npr: -1500,
    pricing_model: 'COMMISSION',
    fulfillment_mode: 'SELF_DELIVERY',
    municipality_palika_string: 'Kathmandu Metropolitan City',
    created_at: '2026-10-01T06:00:00.000Z',
  };

  it('accepts a suspended vendor with its restore status', () => {
    expect(adminVendorViewSchema.parse(vendor)).toEqual(vendor);
  });

  it('never restores to SUSPENDED and keeps +977 phones only', () => {
    const parse = (overrides: Record<string, unknown>) =>
      adminVendorViewSchema.safeParse({ ...vendor, ...overrides }).success;
    expect(parse({ restore_status: 'SUSPENDED' })).toBe(false);
    expect(parse({ phone: '+919800000011' })).toBe(false);
    expect(parse({ suspension: 'OTHER' })).toBe(false);
  });
});

describe('vendor.status_overridden', () => {
  const payload = {
    vendor_id: randomUUID(),
    action: 'SUSPEND',
    from_status: 'LIVE',
    to_status: 'SUSPENDED',
    wallet_balance_npr: -100,
    admin_user_id: randomUUID(),
    overridden_at: '2026-10-01T06:00:00.000Z',
  };
  const envelope = {
    event_id: randomUUID(),
    event_type: 'vendor.status_overridden',
    event_version: 1,
    occurred_at: '2026-10-01T06:00:00.000Z',
    aggregate_id: payload.vendor_id,
  };

  it('is a domain event on notifications.broadcast', () => {
    expect(domainEventSchema.parse({ ...envelope, payload }).event_type).toBe(
      'vendor.status_overridden',
    );
    expect(DOMAIN_EVENT_TOPICS['vendor.status_overridden']).toBe('notifications.broadcast');
  });

  it('only knows SUSPEND and RESTORE and needs the admin', () => {
    const parse = (overrides: Record<string, unknown>) =>
      domainEventSchema.safeParse({ ...envelope, payload: { ...payload, ...overrides } }).success;
    expect(parse({ action: 'DELETE' })).toBe(false);
    expect(parse({ admin_user_id: 'system' })).toBe(false);
  });
});
