import { randomUUID } from 'node:crypto';

import type { KafkaJS } from '@hamro-pasal/kafka';
import type { DomainEvent } from '@hamro-pasal/shared-types';
import {
  MockSmsGateway,
  smsGatewayFromEnv,
  SmsDeliveryError,
  type SmsDelivery,
  type SmsGateway,
  type SmsMessage,
} from '@hamro-pasal/sms';

import { routeByTopic } from './index';
import type { EventDeduplicator } from './order-state-fanout';
import { vendorNotificationConsumer } from './vendor-notifications';

const AT = '2026-09-30T10:00:00.000Z';
const PHONE = '+9779800000011';

function suspended(): DomainEvent {
  const vendorId = randomUUID();
  return {
    event_id: randomUUID(),
    event_type: 'vendor.suspended_for_debt',
    event_version: 1,
    occurred_at: AT,
    aggregate_id: vendorId,
    payload: {
      vendor_id: vendorId,
      vendor_phone: PHONE,
      previous_status: 'LIVE',
      wallet_balance_npr: -2500,
      suspension_limit_npr: -2000,
      suspended_at: AT,
    },
  };
}

function ledgerMutated(): DomainEvent {
  return {
    event_id: randomUUID(),
    event_type: 'ledger.mutated',
    event_version: 1,
    occurred_at: AT,
    aggregate_id: randomUUID(),
    payload: {
      transaction_id: randomUUID(),
      kind: 'ADJUSTMENT',
      order_id: null,
      entries: [0, 1].map((i) => ({
        account_id: randomUUID(),
        account_type: 'SYSTEM_ESCROW' as const,
        vendor_id: null,
        driver_user_id: null,
        gateway: null,
        amount_npr: i === 0 ? 10 : -10,
        balance_after_npr: 0,
      })),
    },
  };
}

function message(value: string | null): KafkaJS.EachMessagePayload {
  return {
    topic: 'notifications.broadcast',
    partition: 1,
    message: {
      key: null,
      value: value === null ? null : Buffer.from(value),
      offset: '7',
      timestamp: String(Date.now()),
      attributes: 0,
      headers: {},
    },
    heartbeat: () => Promise.resolve(),
    pause: () => () => undefined,
  };
}

class MemoryDeduplicator implements EventDeduplicator {
  readonly claimed = new Set<string>();
  claim(eventId: string): Promise<boolean> {
    if (this.claimed.has(eventId)) return Promise.resolve(false);
    this.claimed.add(eventId);
    return Promise.resolve(true);
  }
  release(eventId: string): Promise<void> {
    this.claimed.delete(eventId);
    return Promise.resolve();
  }
}

/** Refuses the first `failures` sends like a provider outage, then delivers. */
class FlakyGateway implements SmsGateway {
  readonly provider = 'SPARROW';
  readonly sent: SmsMessage[] = [];
  constructor(private failures: number) {}
  send(sms: SmsMessage): Promise<SmsDelivery> {
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new SmsDeliveryError('SPARROW', 'HTTP 503'));
    }
    this.sent.push(sms);
    return Promise.resolve({ provider: 'SPARROW', to: sms.to });
  }
}

function setup(sms: SmsGateway = new MockSmsGateway()) {
  const deduplicator = new MemoryDeduplicator();
  const invalid: string[] = [];
  const sentEvents: string[] = [];
  const consumer = vendorNotificationConsumer({
    sms,
    deduplicator,
    onInvalidMessage: (reason) => invalid.push(reason),
    onSent: (event) => sentEvents.push(event.event_type),
  });
  return { consumer, deduplicator, invalid, sentEvents };
}

describe('vendorNotificationConsumer', () => {
  it('subscribes to notifications.broadcast', () => {
    expect(setup().consumer.topic).toBe('notifications.broadcast');
  });

  it('texts the vendor the template for the event', async () => {
    const sms = new MockSmsGateway();
    const { consumer, sentEvents } = setup(sms);

    await consumer.handle(message(JSON.stringify(suspended())));

    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]?.to).toBe(PHONE);
    expect(sms.sent[0]?.text).toMatch(/^Hamro Pasal: your shop is offline\./);
    expect(sentEvents).toEqual(['vendor.suspended_for_debt']);
  });

  it('sends a redelivered event (same event_id) once', async () => {
    const sms = new MockSmsGateway();
    const { consumer } = setup(sms);
    const body = JSON.stringify(suspended());

    await consumer.handle(message(body));
    await consumer.handle(message(body));

    expect(sms.sent).toHaveLength(1);
  });

  it('releases the claim and throws when the provider fails, so the retry sends it', async () => {
    const sms = new FlakyGateway(1);
    const { consumer, deduplicator } = setup(sms);
    const event = suspended();
    const body = JSON.stringify(event);

    await expect(consumer.handle(message(body))).rejects.toThrow(SmsDeliveryError);
    expect(deduplicator.claimed.has(event.event_id)).toBe(false);

    await consumer.handle(message(body));
    expect(sms.sent).toHaveLength(1);
  });

  it('ignores events vendors are not texted about, without claiming them', async () => {
    const sms = new MockSmsGateway();
    const { consumer, deduplicator, invalid } = setup(sms);

    await consumer.handle(message(JSON.stringify(ledgerMutated())));

    expect(sms.sent).toEqual([]);
    expect(deduplicator.claimed.size).toBe(0);
    expect(invalid).toEqual([]);
  });

  it.each([
    ['null body', null],
    ['not JSON', '{oops'],
    ['wrong shape', JSON.stringify({ event_type: 'vendor.restored', payload: {} })],
  ])('skips %s without throwing (no poison-message loop)', async (_label, value) => {
    const sms = new MockSmsGateway();
    const { consumer, invalid } = setup(sms);

    await consumer.handle(message(value));

    expect(sms.sent).toEqual([]);
    expect(invalid).toEqual(['invalid envelope at partition 1 offset 7']);
  });

  it('SMS_PROVIDER=MOCK logs the SMS body instead of calling a provider', async () => {
    const lines: string[] = [];
    const gateway = smsGatewayFromEnv(
      {
        SMS_PROVIDER: 'MOCK',
        SPARROW_SMS_TOKEN: undefined,
        SPARROW_SMS_FROM: undefined,
        SPARROW_SMS_API_URL: undefined,
        AAKASH_SMS_AUTH_TOKEN: undefined,
        AAKASH_SMS_API_URL: undefined,
      },
      {
        mockLog: (line) => lines.push(line),
        fetch: () => Promise.reject(new Error('no network in MOCK mode')),
      },
    );
    const { consumer } = setup(gateway);

    await consumer.handle(message(JSON.stringify(suspended())));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[sms:mock\] to \+9779800000011: Hamro Pasal: your shop is offline/);
  });

  it('is routed alongside the other consumers by topic', () => {
    const handlers = routeByTopic([setup().consumer]);
    expect([...handlers.keys()]).toEqual(['notifications.broadcast']);
  });
});
