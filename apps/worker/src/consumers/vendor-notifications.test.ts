import { randomUUID } from 'node:crypto';

import {
  IvrCallError,
  ivrGatewayFromEnv,
  MockIvrGateway,
  type IvrCall,
  type IvrCallPlaced,
  type IvrGateway,
} from '@hamro-pasal/ivr';
import type { KafkaJS } from '@hamro-pasal/kafka';
import type { DomainEvent, OrderState } from '@hamro-pasal/shared-types';
import {
  MockSmsGateway,
  smsGatewayFromEnv,
  SmsDeliveryError,
  type SmsDelivery,
  type SmsGateway,
  type SmsMessage,
} from '@hamro-pasal/sms';

import type { OrderStateReader } from '../notifications/order-state-reader';
import { PoisonMessageError } from './dead-letter';
import { routeByTopic } from './index';
import type { EventDeduplicator } from './order-state-fanout';
import { vendorNotificationConsumer, type NotificationSent } from './vendor-notifications';

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

function escalation(orderId: string = randomUUID()): DomainEvent {
  return {
    event_id: randomUUID(),
    event_type: 'vendor.escalation.required',
    event_version: 1,
    occurred_at: AT,
    aggregate_id: orderId,
    payload: {
      order_id: orderId,
      vendor_id: randomUUID(),
      vendor_phone: PHONE,
      placed_at: '2026-09-30T09:58:30.000Z',
      sla_seconds: 90,
      escalated_at: AT,
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

class FlakyIvr implements IvrGateway {
  readonly provider = 'MOCK';
  readonly placed: IvrCall[] = [];
  constructor(private failures: number) {}
  call(call: IvrCall): Promise<IvrCallPlaced> {
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new IvrCallError('MOCK', 'trunk busy'));
    }
    this.placed.push(call);
    return Promise.resolve({ provider: 'MOCK', to: call.to });
  }
}

/** Order states by id; unknown ids are PLACED unless listed (most tests escalate live orders). */
class MemoryOrders implements OrderStateReader {
  readonly states = new Map<string, OrderState | null>();
  readonly reads: string[] = [];
  currentState(orderId: string): Promise<OrderState | null> {
    this.reads.push(orderId);
    return Promise.resolve(
      this.states.has(orderId) ? (this.states.get(orderId) ?? null) : 'PLACED',
    );
  }
}

function setup(options: { sms?: SmsGateway; ivr?: IvrGateway | null; orders?: MemoryOrders } = {}) {
  const sms = options.sms ?? new MockSmsGateway();
  const ivr = options.ivr === undefined ? new MockIvrGateway() : options.ivr;
  const orders = options.orders ?? new MemoryOrders();
  const smsDeduplicator = new MemoryDeduplicator();
  const ivrDeduplicator = new MemoryDeduplicator();
  const sent: NotificationSent[] = [];
  const consumer = vendorNotificationConsumer({
    sms,
    smsDeduplicator,
    ivr,
    ivrDeduplicator,
    orders,
    onSent: (_event, delivery) => sent.push(delivery),
  });
  return { consumer, sms, ivr, orders, smsDeduplicator, ivrDeduplicator, sent };
}

describe('vendorNotificationConsumer', () => {
  it('subscribes to notifications.broadcast', () => {
    expect(setup().consumer.topic).toBe('notifications.broadcast');
  });

  it('texts the vendor the template for the event, with no call and no order lookup', async () => {
    const sms = new MockSmsGateway();
    const ivr = new MockIvrGateway();
    const { consumer, orders, sent } = setup({ sms, ivr });

    await consumer.handle(message(JSON.stringify(suspended())));

    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]?.to).toBe(PHONE);
    expect(sms.sent[0]?.text).toMatch(/^Hamro Pasal: your shop is offline\./);
    expect(ivr.placed).toEqual([]);
    expect(orders.reads).toEqual([]);
    expect(sent).toEqual([{ channel: 'SMS', provider: 'MOCK' }]);
  });

  it('sends a redelivered event (same event_id) once', async () => {
    const sms = new MockSmsGateway();
    const { consumer } = setup({ sms });
    const body = JSON.stringify(suspended());

    await consumer.handle(message(body));
    await consumer.handle(message(body));

    expect(sms.sent).toHaveLength(1);
  });

  it('releases the claim and throws when the provider fails, so the retry sends it', async () => {
    const sms = new FlakyGateway(1);
    const { consumer, smsDeduplicator } = setup({ sms });
    const event = suspended();
    const body = JSON.stringify(event);

    await expect(consumer.handle(message(body))).rejects.toThrow(SmsDeliveryError);
    expect(smsDeduplicator.claimed.has(event.event_id)).toBe(false);

    await consumer.handle(message(body));
    expect(sms.sent).toHaveLength(1);
  });

  it('ignores events vendors are not texted about, without claiming them', async () => {
    const sms = new MockSmsGateway();
    const { consumer, smsDeduplicator } = setup({ sms });

    await consumer.handle(message(JSON.stringify(ledgerMutated())));

    expect(sms.sent).toEqual([]);
    expect(smsDeduplicator.claimed.size).toBe(0);
  });

  it.each([
    ['null body', null],
    ['not JSON', '{oops'],
    ['wrong shape', JSON.stringify({ event_type: 'vendor.restored', payload: {} })],
  ])('rejects %s as a poison message (dead-lettered without retries)', async (_label, value) => {
    const sms = new MockSmsGateway();
    const { consumer } = setup({ sms });

    const handled = consumer.handle(message(value));

    await expect(handled).rejects.toThrow(PoisonMessageError);
    await expect(handled).rejects.toThrow('invalid envelope at partition 1 offset 7');
    expect(sms.sent).toEqual([]);
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
    const { consumer } = setup({ sms: gateway });

    await consumer.handle(message(JSON.stringify(suspended())));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[sms:mock\] to \+9779800000011: Hamro Pasal: your shop is offline/);
  });

  it('is routed alongside the other consumers by topic', () => {
    const handlers = routeByTopic([setup().consumer]);
    expect([...handlers.keys()]).toEqual(['notifications.broadcast']);
  });
});

describe('vendor.escalation.required: SMS + IVR and the stale-order guard', () => {
  it('texts and calls the vendor about a still-PLACED order', async () => {
    const sms = new MockSmsGateway();
    const ivr = new MockIvrGateway();
    const orderId = 'a1b2c3d4-0000-4000-8000-00000000beef';
    const { consumer, orders, sent } = setup({ sms, ivr });

    await consumer.handle(message(JSON.stringify(escalation(orderId))));

    expect(orders.reads).toEqual([orderId]);
    expect(sms.sent.map((s) => s.text)).toEqual([
      'Hamro Pasal: order #00BEEF has waited over 90 seconds. Open the app now to accept or reject it.',
    ]);
    expect(ivr.placed).toEqual([
      {
        to: PHONE,
        script:
          'You have a pending order on Hamro Pasal. Order 0 0 B E E F has waited over 90 ' +
          'seconds. Open the app now to accept or reject it.',
      },
    ]);
    expect(sent).toEqual(
      expect.arrayContaining([
        { channel: 'SMS', provider: 'MOCK' },
        { channel: 'IVR', provider: 'MOCK' },
      ]),
    );
  });

  it('starts the call without waiting for the SMS (concurrent)', async () => {
    let releaseSms: () => void = () => undefined;
    const slowSms: SmsGateway = {
      provider: 'SPARROW',
      send: (sms) =>
        new Promise((resolve) => {
          releaseSms = () => {
            resolve({ provider: 'SPARROW', to: sms.to });
          };
        }),
    };
    const ivr = new MockIvrGateway();
    const { consumer } = setup({ sms: slowSms, ivr });

    const handled = consumer.handle(message(JSON.stringify(escalation())));
    await new Promise((resolve) => setImmediate(resolve));

    expect(ivr.placed).toHaveLength(1); // placed while the SMS is still in flight
    releaseSms();
    await handled;
  });

  it.each<[string, OrderState | null]>([
    ['accepted (PREPARING)', 'PREPARING'],
    ['rejected or canceled (CANCELED)', 'CANCELED'],
    ['already out for delivery', 'OUT_FOR_DELIVERY'],
    ['unknown', null],
  ])('drops the escalation silently when the order is %s', async (_label, state) => {
    const sms = new MockSmsGateway();
    const ivr = new MockIvrGateway();
    const orders = new MemoryOrders();
    const event = escalation();
    if (event.event_type !== 'vendor.escalation.required') throw new Error('wrong type');
    orders.states.set(event.payload.order_id, state);
    const { consumer, smsDeduplicator, ivrDeduplicator, sent } = setup({ sms, ivr, orders });

    await consumer.handle(message(JSON.stringify(event)));

    expect(sms.sent).toEqual([]);
    expect(ivr.placed).toEqual([]);
    expect(sent).toEqual([]);
    expect(smsDeduplicator.claimed.size + ivrDeduplicator.claimed.size).toBe(0);
  });

  it('re-checks the state on every retry, so an order accepted meanwhile is not re-sent', async () => {
    const sms = new FlakyGateway(1);
    const ivr = new MockIvrGateway();
    const orders = new MemoryOrders();
    const event = escalation();
    if (event.event_type !== 'vendor.escalation.required') throw new Error('wrong type');
    const { consumer } = setup({ sms, ivr, orders });
    const body = JSON.stringify(event);

    await expect(consumer.handle(message(body))).rejects.toThrow(SmsDeliveryError);
    orders.states.set(event.payload.order_id, 'PREPARING');
    await consumer.handle(message(body));

    expect(sms.sent).toEqual([]);
    expect(ivr.placed).toHaveLength(1); // the first attempt's call had already gone out
  });

  it('keeps the delivered channel claimed when the other fails, so a retry repeats only it', async () => {
    const sms = new MockSmsGateway();
    const ivr = new FlakyIvr(1);
    const event = escalation();
    const { consumer, smsDeduplicator, ivrDeduplicator } = setup({ sms, ivr });
    const body = JSON.stringify(event);

    await expect(consumer.handle(message(body))).rejects.toThrow(IvrCallError);
    expect(smsDeduplicator.claimed.has(event.event_id)).toBe(true);
    expect(ivrDeduplicator.claimed.has(event.event_id)).toBe(false);

    await consumer.handle(message(body));
    expect(sms.sent).toHaveLength(1);
    expect(ivr.placed).toHaveLength(1);
  });

  it('reports both failures when SMS and IVR both fail', async () => {
    const { consumer } = setup({ sms: new FlakyGateway(1), ivr: new FlakyIvr(1) });

    await expect(consumer.handle(message(JSON.stringify(escalation())))).rejects.toThrow(
      AggregateError,
    );
  });

  it('texts only when IVR_PROVIDER=DISABLED', async () => {
    const sms = new MockSmsGateway();
    const { consumer, sent } = setup({ sms, ivr: ivrGatewayFromEnv({ IVR_PROVIDER: 'DISABLED' }) });

    await consumer.handle(message(JSON.stringify(escalation())));

    expect(sms.sent).toHaveLength(1);
    expect(sent).toEqual([{ channel: 'SMS', provider: 'MOCK' }]);
  });

  it('IVR_PROVIDER=MOCK logs the call instead of placing it', async () => {
    const lines: string[] = [];
    const ivr = ivrGatewayFromEnv(
      { IVR_PROVIDER: 'MOCK' },
      { mockLog: (line) => lines.push(line) },
    );
    const { consumer } = setup({ ivr });

    await consumer.handle(
      message(JSON.stringify(escalation('a1b2c3d4-0000-4000-8000-0000004fa5b6'))),
    );

    expect(lines).toEqual([
      '[ivr:mock] Calling +9779800000011: "You have a pending order on Hamro Pasal. Order 4 F A 5 B 6 ' +
        'has waited over 90 seconds. Open the app now to accept or reject it."',
    ]);
  });
});
