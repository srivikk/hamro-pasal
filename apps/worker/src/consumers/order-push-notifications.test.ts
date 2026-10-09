import { randomUUID } from 'node:crypto';

import type { KafkaJS } from '@hamro-pasal/kafka';
import type { DomainEvent, OrderState, OrderStateChangedEvent } from '@hamro-pasal/shared-types';

import type {
  DeviceTokenRemover,
  PushRecipient,
  PushRecipientReader,
} from '../notifications/push-recipients';
import { ExpoPushGateway, type FetchLike } from '../push/expo-push';
import { buildConsumers, routeByTopic } from './index';
import {
  orderPushNotificationConsumer,
  smsFallbackLogFromEnv,
  type OrderPushOutcome,
} from './order-push-notifications';
import type { EventDeduplicator } from './order-state-fanout';

const AT = '2026-10-03T10:00:00.000Z';
const CUSTOMER_PHONE = '+9779800000001';
const VENDOR_PHONE = '+9779800000011';

function stateChanged(
  toState: OrderState,
  overrides: Partial<OrderStateChangedEvent['payload']> = {},
): OrderStateChangedEvent {
  const orderId = randomUUID();
  return {
    event_id: randomUUID(),
    event_type: 'order.state_changed',
    event_version: 1,
    occurred_at: AT,
    aggregate_id: orderId,
    payload: {
      order_id: orderId,
      customer_id: randomUUID(),
      vendor_id: randomUUID(),
      from_state: 'PLACED',
      to_state: toState,
      payment_status: 'PENDING',
      refund_required: false,
      placed_at: AT,
      delivered_at: null,
      changed_at: AT,
      ...overrides,
    },
  };
}

function message(value: string | null): KafkaJS.EachMessagePayload {
  return {
    topic: 'order.lifecycle',
    partition: 0,
    message: {
      key: null,
      value: value === null ? null : Buffer.from(value),
      offset: '3',
      timestamp: String(Date.now()),
      attributes: 0,
      headers: {},
    },
    heartbeat: () => Promise.resolve(),
    pause: () => () => undefined,
  };
}

const kafkaMessage = (event: DomainEvent) => message(JSON.stringify(event));

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

/** Device tokens by user / vendor id, standing in for PostgreSQL. */
class MemoryRecipients implements PushRecipientReader, DeviceTokenRemover {
  readonly customers = new Map<string, PushRecipient>();
  readonly vendors = new Map<string, PushRecipient>();
  readonly removed: string[] = [];
  failing = false;

  customer(userId: string): Promise<PushRecipient | null> {
    if (this.failing) return Promise.reject(new Error('connection refused'));
    return Promise.resolve(this.customers.get(userId) ?? null);
  }
  vendor(vendorId: string): Promise<PushRecipient | null> {
    if (this.failing) return Promise.reject(new Error('connection refused'));
    return Promise.resolve(this.vendors.get(vendorId) ?? null);
  }
  remove(tokens: readonly string[]): Promise<void> {
    this.removed.push(...tokens);
    return Promise.resolve();
  }
}

interface ExpoCall {
  readonly url: string;
  readonly body: unknown;
}

/** exp.host, mocked at the fetch boundary: the real ExpoPushGateway builds every request. */
function fakeExpo() {
  const calls: ExpoCall[] = [];
  const state = {
    /** HTTP status of the next answers (default 200). */
    statuses: [] as number[],
    /** Tokens Expo reports as DeviceNotRegistered. */
    unregistered: new Set<string>(),
  };
  const fetch: FetchLike = (url, init) => {
    const body: unknown = JSON.parse(typeof init.body === 'string' ? init.body : 'null');
    calls.push({ url, body });
    const status = state.statuses.shift() ?? 200;
    if (status !== 200) return Promise.resolve(new Response('unavailable', { status }));
    const messages = body as { to: string }[];
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: messages.map(({ to }, index) =>
            state.unregistered.has(to)
              ? {
                  status: 'error',
                  message: 'not a registered push notification recipient',
                  details: { error: 'DeviceNotRegistered' },
                }
              : { status: 'ok', id: `ticket-${String(index)}` },
          ),
        }),
        { status: 200 },
      ),
    );
  };
  return { calls, state, fetch };
}

function setup(options: { smsFallback?: boolean } = {}) {
  const expo = fakeExpo();
  const recipients = new MemoryRecipients();
  const deduplicator = new MemoryDeduplicator();
  const outcomes: OrderPushOutcome[] = [];
  const smsLines: string[] = [];
  const consumer = orderPushNotificationConsumer({
    recipients,
    tokens: recipients,
    push: new ExpoPushGateway({ fetch: expo.fetch }),
    deduplicator,
    smsFallbackLog: options.smsFallback === true ? (line) => smsLines.push(line) : null,
    onOutcome: (_event, outcome) => outcomes.push(outcome),
  });
  /** Registers both sides of an event's order, each with the given devices. */
  function register(
    event: OrderStateChangedEvent,
    devices: { customer?: string[]; vendor?: string[] } = {},
  ): void {
    recipients.customers.set(event.payload.customer_id, {
      userId: event.payload.customer_id,
      phone: CUSTOMER_PHONE,
      tokens: devices.customer ?? [],
    });
    recipients.vendors.set(event.payload.vendor_id, {
      userId: randomUUID(),
      phone: VENDOR_PHONE,
      tokens: devices.vendor ?? [],
    });
  }
  return { expo, recipients, deduplicator, outcomes, smsLines, consumer, register };
}

describe('orderPushNotificationConsumer', () => {
  it('listens on order.lifecycle', () => {
    expect(setup().consumer.topic).toBe('order.lifecycle');
  });

  it('fires one request to the Expo push API when an order is placed, for the vendor devices', async () => {
    const t = setup();
    const event = stateChanged('PLACED', { from_state: 'PENDING_PAYMENT' });
    t.register(event, {
      customer: ['ExponentPushToken[customer]'],
      vendor: ['ExponentPushToken[shop-phone]', 'ExponentPushToken[shop-tablet]'],
    });

    await t.consumer.handle(kafkaMessage(event));

    const code = event.payload.order_id.replace(/-/g, '').slice(-6).toUpperCase();
    const data = {
      type: 'order.state_changed',
      notification_id: event.event_id,
      order_id: event.payload.order_id,
      state: 'PLACED',
      audience: 'VENDOR',
      data_only: true,
      title: 'New order',
      body: `Order #${code} is waiting. Open the app to accept or reject it.`,
    };
    expect(t.expo.calls).toEqual([
      {
        url: 'https://exp.host/--/api/v2/push/send',
        body: [
          { to: 'ExponentPushToken[shop-phone]', priority: 'high', _contentAvailable: true, data },
          { to: 'ExponentPushToken[shop-tablet]', priority: 'high', _contentAvailable: true, data },
        ],
      },
    ]);
    expect(t.outcomes).toEqual([
      { notification: 'push.sent', sent: 2, rejected: 0, removed_tokens: 0 },
    ]);
  });

  it('sends a visible notification to the customer when the vendor accepts', async () => {
    const t = setup();
    const event = stateChanged('PREPARING');
    t.register(event, {
      customer: ['ExponentPushToken[customer]'],
      vendor: ['ExponentPushToken[shop]'],
    });

    await t.consumer.handle(kafkaMessage(event));

    expect(t.expo.calls).toHaveLength(1);
    expect(t.expo.calls[0]?.body).toMatchObject([
      {
        to: 'ExponentPushToken[customer]',
        title: 'Order accepted',
        sound: 'default',
        priority: 'high',
        channelId: 'orders',
        data: { state: 'PREPARING', audience: 'CUSTOMER', data_only: false },
      },
    ]);
  });

  it('tells both sides about a cancellation in one request', async () => {
    const t = setup();
    const event = stateChanged('CANCELED');
    t.register(event, {
      customer: ['ExponentPushToken[customer]'],
      vendor: ['ExponentPushToken[shop]'],
    });

    await t.consumer.handle(kafkaMessage(event));

    expect(t.expo.calls).toHaveLength(1);
    expect(
      (t.expo.calls[0]?.body as { to: string; data: { audience: string } }[]).map(
        ({ to, data }) => [to, data.audience],
      ),
    ).toEqual([
      ['ExponentPushToken[customer]', 'CUSTOMER'],
      ['ExponentPushToken[shop]', 'VENDOR'],
    ]);
  });

  it('sends a redelivered event only once', async () => {
    const t = setup();
    const event = stateChanged('PREPARING');
    t.register(event, { customer: ['ExponentPushToken[customer]'] });

    await t.consumer.handle(kafkaMessage(event));
    await t.consumer.handle(kafkaMessage(event));

    expect(t.expo.calls).toHaveLength(1);
  });

  it('makes no request when the recipient has no device, or does not exist', async () => {
    const t = setup();
    const noDevice = stateChanged('PREPARING');
    t.register(noDevice);
    const unknown = stateChanged('PREPARING');

    await t.consumer.handle(kafkaMessage(noDevice));
    await t.consumer.handle(kafkaMessage(unknown));

    expect(t.expo.calls).toEqual([]);
    expect(t.outcomes).toEqual([]);
  });

  it('ignores states nobody is pushed about, other events and unreadable messages', async () => {
    const t = setup();
    const pending = stateChanged('PENDING_PAYMENT', { from_state: null, placed_at: null });
    t.register(pending, { customer: ['ExponentPushToken[customer]'] });
    const locked: DomainEvent = {
      event_id: randomUUID(),
      event_type: 'order.locked',
      event_version: 1,
      occurred_at: AT,
      aggregate_id: randomUUID(),
      payload: {
        reservation_id: randomUUID(),
        vendor_id: randomUUID(),
        customer_id: randomUUID(),
        items: [{ product_id: randomUUID(), quantity: 1 }],
        locked_at: AT,
        expires_at: AT,
      },
    };

    await t.consumer.handle(kafkaMessage(pending));
    await t.consumer.handle(kafkaMessage(locked));
    await t.consumer.handle(message('{not json'));
    await t.consumer.handle(message(null));

    expect(t.expo.calls).toEqual([]);
    // Nothing was claimed either: no Redis key for events that send nothing.
    expect(t.deduplicator.claimed.size).toBe(0);
  });

  it('does not throw when Expo is down: logged, not retried, the partition moves on', async () => {
    const t = setup();
    const event = stateChanged('PREPARING');
    t.register(event, { customer: ['ExponentPushToken[customer]'] });
    t.expo.state.statuses.push(503);

    await expect(t.consumer.handle(kafkaMessage(event))).resolves.toBeUndefined();
    // A Kafka redelivery (another consumer of the topic failed) does not send it late.
    await t.consumer.handle(kafkaMessage(event));

    expect(t.expo.calls).toHaveLength(1);
    expect(t.outcomes).toEqual([
      { notification: 'push.failed', error: 'Expo push request failed: HTTP 503' },
    ]);
  });

  it('does not throw when the device tokens cannot be read', async () => {
    const t = setup();
    const event = stateChanged('PREPARING');
    t.recipients.failing = true;

    await expect(t.consumer.handle(kafkaMessage(event))).resolves.toBeUndefined();

    expect(t.expo.calls).toEqual([]);
    expect(t.outcomes).toEqual([{ notification: 'push.failed', error: 'connection refused' }]);
  });

  it('forgets a token Expo reports as DeviceNotRegistered, and only that one', async () => {
    const t = setup();
    const event = stateChanged('PREPARING');
    t.register(event, {
      customer: ['ExponentPushToken[old-phone]', 'ExponentPushToken[new-phone]'],
    });
    t.expo.state.unregistered.add('ExponentPushToken[old-phone]');

    await t.consumer.handle(kafkaMessage(event));

    expect(t.recipients.removed).toEqual(['ExponentPushToken[old-phone]']);
    expect(t.outcomes).toEqual([
      { notification: 'push.sent', sent: 1, rejected: 1, removed_tokens: 1 },
    ]);
  });

  describe('SMS fallback log (SMS_PROVIDER=MOCK)', () => {
    it('logs the mock SMS beside the push attempt, to the shop number', async () => {
      const t = setup({ smsFallback: true });
      const event = stateChanged('PLACED', { from_state: 'PENDING_PAYMENT' });
      t.register(event, { vendor: ['ExponentPushToken[shop]'] });

      await t.consumer.handle(kafkaMessage(event));

      const code = event.payload.order_id.replace(/-/g, '').slice(-6).toUpperCase();
      expect(t.smsLines).toEqual([
        `[sms:mock] to +9779800000011: Hamro Pasal: New order. Order #${code} is waiting. Open the app to accept or reject it.`,
      ]);
      expect(t.expo.calls).toHaveLength(1);
    });

    it('logs it for a recipient without a device too (no push request is made)', async () => {
      const t = setup({ smsFallback: true });
      const event = stateChanged('CANCELED');
      t.register(event);

      await t.consumer.handle(kafkaMessage(event));

      expect(t.smsLines.map((line) => line.slice(0, 30))).toEqual([
        '[sms:mock] to +9779800000001: ',
        '[sms:mock] to +9779800000011: ',
      ]);
      expect(t.expo.calls).toEqual([]);
    });

    it('logs once for a redelivered event', async () => {
      const t = setup({ smsFallback: true });
      const event = stateChanged('PREPARING');
      t.register(event);

      await t.consumer.handle(kafkaMessage(event));
      await t.consumer.handle(kafkaMessage(event));

      expect(t.smsLines).toHaveLength(1);
    });

    it('logs nothing with a real SMS provider', async () => {
      const t = setup();
      const event = stateChanged('PREPARING');
      t.register(event, { customer: ['ExponentPushToken[customer]'] });

      await t.consumer.handle(kafkaMessage(event));

      expect(t.smsLines).toEqual([]);
      expect(t.expo.calls).toHaveLength(1);
    });
  });

  describe('smsFallbackLogFromEnv', () => {
    it('logs through console.info for MOCK', () => {
      const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);

      smsFallbackLogFromEnv({ SMS_PROVIDER: 'MOCK' })?.('[sms:mock] to +9779800000011: hello');

      expect(info).toHaveBeenCalledWith('[sms:mock] to +9779800000011: hello');
      info.mockRestore();
    });

    it.each(['SPARROW', 'AAKASH', 'FIREBASE'] as const)('is off for %s', (provider) => {
      expect(smsFallbackLogFromEnv({ SMS_PROVIDER: provider })).toBeNull();
    });
  });

  it('is registered after the fan-out and the SLA timer, which still run when a push fails', async () => {
    const expo = fakeExpo();
    expo.state.statuses.push(500);
    const recipients = new MemoryRecipients();
    const event = stateChanged('PLACED', { from_state: 'PENDING_PAYMENT' });
    recipients.vendors.set(event.payload.vendor_id, {
      userId: randomUUID(),
      phone: VENDOR_PHONE,
      tokens: ['ExponentPushToken[shop]'],
    });
    const published: string[] = [];
    const scheduled: string[] = [];
    const claims = new Set<string>();
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const handlers = routeByTopic(
      buildConsumers({
        redis: {
          set: (key: string) => {
            if (claims.has(key)) return Promise.resolve(null);
            claims.add(key);
            return Promise.resolve('OK');
          },
          del: () => Promise.resolve(1),
          publish: (channel: string) => {
            published.push(channel);
            return Promise.resolve(1);
          },
        } as never,
        vendorAcceptanceTimers: {
          schedule: (job) => {
            scheduled.push(job.order_id);
            return Promise.resolve();
          },
        },
        sms: { provider: 'MOCK', send: () => Promise.reject(new Error('unused')) },
        ivr: null,
        orders: { currentState: () => Promise.resolve(null) },
        deadLetters: { publish: () => Promise.resolve() },
        deadLetterStore: { save: () => Promise.resolve() },
        push: new ExpoPushGateway({ fetch: expo.fetch }),
        pushRecipients: recipients,
        pushSmsFallbackLog: null,
        notifications: { name: 'NONE', send: () => Promise.resolve() },
        vendorContacts: { contacts: () => Promise.resolve([]) },
      }),
    );

    await handlers.get('order.lifecycle')?.(kafkaMessage(event));

    expect(published).toHaveLength(1); // the Socket.io fan-out went out
    expect(scheduled).toEqual([event.payload.order_id]); // the 90 s timer was scheduled
    expect(expo.calls).toHaveLength(1); // the push was attempted, and its failure swallowed
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });
});
