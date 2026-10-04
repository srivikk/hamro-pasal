import { randomUUID } from 'node:crypto';

import type { KafkaJS } from '@hamro-pasal/kafka';
import type { OrderState, OrderStateChangedEvent } from '@hamro-pasal/shared-types';

import { orderPushNotificationConsumer } from '../consumers/order-push-notifications';
import type { EventDeduplicator } from '../consumers/order-state-fanout';
import type {
  DeviceTokenRemover,
  PushRecipient,
  PushRecipientReader,
} from '../notifications/push-recipients';
import { ExpoPushGateway } from './expo-push';
import {
  MockPushGateway,
  mockPushLogFromEnv,
  mockPushLogLine,
  pushGatewayFromEnv,
} from './mock-push';

const AT = '2026-10-04T10:00:00.000Z';

function stateChanged(toState: OrderState): OrderStateChangedEvent {
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
      payment_status: 'PAID',
      refund_required: false,
      placed_at: AT,
      delivered_at: null,
      changed_at: AT,
    },
  };
}

function kafkaMessage(event: OrderStateChangedEvent): KafkaJS.EachMessagePayload {
  return {
    topic: 'order.lifecycle',
    partition: 0,
    message: {
      key: null,
      value: Buffer.from(JSON.stringify(event)),
      offset: '1',
      timestamp: String(Date.now()),
      attributes: 0,
      headers: {},
    },
    heartbeat: () => Promise.resolve(),
    pause: () => () => undefined,
  };
}

const once: EventDeduplicator = {
  claim: () => Promise.resolve(true),
  release: () => Promise.resolve(),
};

/** Every customer and vendor exists, with the given devices. */
function recipientsWith(tokens: string[]): PushRecipientReader & DeviceTokenRemover {
  const recipient = (phone: string): Promise<PushRecipient> =>
    Promise.resolve({ userId: randomUUID(), phone, tokens });
  return {
    customer: () => recipient('+9779800000001'),
    vendor: () => recipient('+9779800000011'),
    remove: () => Promise.resolve(),
  };
}

function setup(tokens: string[]) {
  const push = new MockPushGateway();
  const lines: string[] = [];
  const recipients = recipientsWith(tokens);
  const consumer = orderPushNotificationConsumer({
    recipients,
    tokens: recipients,
    push,
    deduplicator: once,
    smsFallbackLog: null,
    mockPushLog: (line) => lines.push(line),
    onOutcome: () => undefined,
  });
  return { push, lines, consumer };
}

describe('MockPushGateway', () => {
  it('accepts every message with an ok ticket and makes no request', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const gateway = new MockPushGateway();

    const tickets = await gateway.send([
      { to: 'ExponentPushToken[a]', priority: 'high', data: {} },
      { to: 'ExponentPushToken[b]', priority: 'high', data: {} },
    ]);

    expect(tickets).toEqual([
      { token: 'ExponentPushToken[a]', status: 'ok', id: 'mock-1' },
      { token: 'ExponentPushToken[b]', status: 'ok', id: 'mock-2' },
    ]);
    expect(gateway.sent).toHaveLength(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('mockPushLogLine', () => {
  it('names a vendor by "Vendor" and a customer by "User"', () => {
    const payload = { priority: 'high', data: { state: 'PLACED' } } as const;
    expect(mockPushLogLine('VENDOR', 'v-1', payload)).toBe(
      '[MOCK PUSH] -> Vendor v-1: {"priority":"high","data":{"state":"PLACED"}}',
    );
    expect(mockPushLogLine('CUSTOMER', 'u-1', payload)).toBe(
      '[MOCK PUSH] -> User u-1: {"priority":"high","data":{"state":"PLACED"}}',
    );
  });
});

describe('the mock toggles', () => {
  it('use the mock gateway and the log only with MOCK_SERVICES outside production', () => {
    const on = { MOCK_SERVICES: true, NODE_ENV: 'development' } as const;
    expect(pushGatewayFromEnv(on)).toBeInstanceOf(MockPushGateway);
    expect(mockPushLogFromEnv(on)).not.toBeNull();

    const off = { MOCK_SERVICES: false, NODE_ENV: 'development' } as const;
    expect(pushGatewayFromEnv(off)).toBeInstanceOf(ExpoPushGateway);
    expect(mockPushLogFromEnv(off)).toBeNull();

    const production = { MOCK_SERVICES: true, NODE_ENV: 'production' } as const;
    expect(pushGatewayFromEnv(production)).toBeInstanceOf(ExpoPushGateway);
    expect(mockPushLogFromEnv(production)).toBeNull();
  });

  it('logs to console.info by default', () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    mockPushLogFromEnv({ MOCK_SERVICES: true, NODE_ENV: 'test' })?.('[MOCK PUSH] -> User u: {}');
    expect(info).toHaveBeenCalledWith('[MOCK PUSH] -> User u: {}');
    info.mockRestore();
  });
});

describe('order pushes with MOCK_SERVICES', () => {
  it('logs a placed order for the vendor id with the data-only payload', async () => {
    const t = setup(['ExponentPushToken[shop]']);
    const event = stateChanged('PLACED');

    await t.consumer.handle(kafkaMessage(event));

    expect(t.lines).toHaveLength(1);
    const [line = ''] = t.lines;
    const prefix = `[MOCK PUSH] -> Vendor ${event.payload.vendor_id}: `;
    expect(line.startsWith(prefix)).toBe(true);
    expect(JSON.parse(line.slice(prefix.length))).toEqual({
      priority: 'high',
      _contentAvailable: true,
      data: expect.objectContaining({
        order_id: event.payload.order_id,
        state: 'PLACED',
        audience: 'VENDOR',
        data_only: true,
        title: 'New order',
      }) as unknown,
    });
    expect(t.push.sent.map((message) => message.to)).toEqual(['ExponentPushToken[shop]']);
  });

  it('logs an accepted order for the customer id as "User"', async () => {
    const t = setup(['ExponentPushToken[phone]']);
    const event = stateChanged('PREPARING');

    await t.consumer.handle(kafkaMessage(event));

    expect(t.lines).toHaveLength(1);
    expect(t.lines[0]).toContain(`[MOCK PUSH] -> User ${event.payload.customer_id}: `);
    expect(t.lines[0]).toContain('"title":"Order accepted"');
  });

  it('logs both sides of a cancellation', async () => {
    const t = setup([]);
    const event = stateChanged('CANCELED');

    await t.consumer.handle(kafkaMessage(event));

    expect(t.lines.map((line) => line.split(': ')[0])).toEqual([
      `[MOCK PUSH] -> User ${event.payload.customer_id}`,
      `[MOCK PUSH] -> Vendor ${event.payload.vendor_id}`,
    ]);
  });

  it('logs the push even when the recipient has no device registered', async () => {
    const t = setup([]);
    const event = stateChanged('PLACED');

    await t.consumer.handle(kafkaMessage(event));

    expect(t.lines).toHaveLength(1);
    expect(t.push.sent).toHaveLength(0);
  });
});
