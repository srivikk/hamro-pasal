import {
  orderPushDataSchema,
  orderStateSchema,
  type OrderState,
  type OrderStateChangedEvent,
} from '@hamro-pasal/shared-types';

import { expoMessages, orderPushes, orderPushFallbackSms } from './order-push';

const ORDER_ID = '6f1d1c5e-6f0b-4e0e-9c57-0f6a3f1f8a11';
const EVENT_ID = '0b0f2a0e-6a52-4a0d-8a43-3f5a4a1f6f10';
const AT = '2026-10-03T10:00:00.000Z';

function stateChanged(
  toState: OrderState,
  overrides: Partial<OrderStateChangedEvent['payload']> = {},
): OrderStateChangedEvent {
  return {
    event_id: EVENT_ID,
    event_type: 'order.state_changed',
    event_version: 1,
    occurred_at: AT,
    aggregate_id: ORDER_ID,
    payload: {
      order_id: ORDER_ID,
      customer_id: '11111111-1111-4111-8111-111111111111',
      vendor_id: '22222222-2222-4222-8222-222222222222',
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

describe('orderPushes', () => {
  it('tells the vendor about a new order, as a critical push', () => {
    expect(orderPushes(stateChanged('PLACED', { from_state: 'PENDING_PAYMENT' }))).toEqual([
      {
        audience: 'VENDOR',
        title: 'New order',
        body: 'Order #1F8A11 is waiting. Open the app to accept or reject it.',
        critical: true,
      },
    ]);
  });

  it('tells the customer the shop accepted', () => {
    expect(orderPushes(stateChanged('PREPARING'))).toEqual([
      {
        audience: 'CUSTOMER',
        title: 'Order accepted',
        body: 'The shop is preparing order #1F8A11.',
        critical: false,
      },
    ]);
  });

  it('tells the customer about the dispatch, as a critical push', () => {
    expect(orderPushes(stateChanged('OUT_FOR_DELIVERY', { from_state: 'PREPARING' }))).toEqual([
      {
        audience: 'CUSTOMER',
        title: 'Your order is on its way',
        body: 'Order #1F8A11 has left the shop. Keep your 4-digit delivery code ready.',
        critical: true,
      },
    ]);
  });

  it('tells the customer about the delivery', () => {
    expect(orderPushes(stateChanged('DELIVERED', { delivered_at: AT }))).toEqual([
      {
        audience: 'CUSTOMER',
        title: 'Order delivered',
        body: 'Order #1F8A11 was delivered. Rate the shop in the app.',
        critical: false,
      },
    ]);
  });

  it('tells both sides about a cancellation, and the customer about the refund', () => {
    expect(orderPushes(stateChanged('CANCELED'))).toEqual([
      {
        audience: 'CUSTOMER',
        title: 'Order cancelled',
        body: 'Order #1F8A11 was cancelled.',
        critical: false,
      },
      {
        audience: 'VENDOR',
        title: 'Order cancelled',
        body: 'Order #1F8A11 was cancelled.',
        critical: false,
      },
    ]);
    expect(
      orderPushes(stateChanged('CANCELED', { refund_required: true, payment_status: 'PAID' }))[0]
        ?.body,
    ).toBe('Order #1F8A11 was cancelled. A refund of your payment has been initiated.');
  });

  it('does not tell a vendor about the end of an order it never saw', () => {
    const pushes = orderPushes(stateChanged('CANCELED', { placed_at: null }));

    expect(pushes.map((push) => push.audience)).toEqual(['CUSTOMER']);
  });

  it('tells the customer about a failed order', () => {
    expect(orderPushes(stateChanged('FAILED', { from_state: 'PENDING_PAYMENT' }))).toEqual([
      {
        audience: 'CUSTOMER',
        title: 'Order not completed',
        body: 'Order #1F8A11 could not be completed. Open the app for details.',
        critical: false,
      },
    ]);
  });

  it.each(['PENDING_PAYMENT', 'DISPUTED'] as const)('pushes nothing for %s', (state) => {
    expect(orderPushes(stateChanged(state))).toEqual([]);
  });

  it('handles every order state', () => {
    for (const state of orderStateSchema.options) {
      expect(Array.isArray(orderPushes(stateChanged(state)))).toBe(true);
    }
  });
});

describe('expoMessages', () => {
  const tokens = ['ExponentPushToken[aaa]', 'ExponentPushToken[bbb]'];

  it('builds one visible notification per device for a normal push', () => {
    const event = stateChanged('PREPARING');
    const [push] = orderPushes(event);
    if (push === undefined) throw new Error('no push');

    expect(expoMessages(event, push, tokens)).toEqual(
      tokens.map((to) => ({
        to,
        title: 'Order accepted',
        body: 'The shop is preparing order #1F8A11.',
        sound: 'default',
        priority: 'high',
        channelId: 'orders',
        data: {
          type: 'order.state_changed',
          notification_id: EVENT_ID,
          order_id: ORDER_ID,
          state: 'PREPARING',
          audience: 'CUSTOMER',
          data_only: false,
          title: 'Order accepted',
          body: 'The shop is preparing order #1F8A11.',
        },
      })),
    );
  });

  it('builds a data-only, high-priority message for a critical push (SPEC)', () => {
    const event = stateChanged('OUT_FOR_DELIVERY');
    const [push] = orderPushes(event);
    if (push === undefined) throw new Error('no push');

    const [message] = expoMessages(event, push, ['ExponentPushToken[aaa]']);

    expect(message).toEqual({
      to: 'ExponentPushToken[aaa]',
      priority: 'high',
      _contentAvailable: true,
      data: {
        type: 'order.state_changed',
        notification_id: EVENT_ID,
        order_id: ORDER_ID,
        state: 'OUT_FOR_DELIVERY',
        audience: 'CUSTOMER',
        data_only: true,
        title: 'Your order is on its way',
        body: 'Order #1F8A11 has left the shop. Keep your 4-digit delivery code ready.',
      },
    });
    // No title, body or sound of its own: the OS shows nothing, the app posts the notification.
    expect(message).not.toHaveProperty('title');
    expect(message).not.toHaveProperty('body');
    expect(message).not.toHaveProperty('sound');
  });

  it('carries data the app accepts, for every push of every state', () => {
    for (const state of orderStateSchema.options) {
      const event = stateChanged(state);
      for (const push of orderPushes(event)) {
        for (const message of expoMessages(event, push, tokens)) {
          expect(orderPushDataSchema.safeParse(message.data).success).toBe(true);
        }
      }
    }
  });

  it('builds nothing without a device', () => {
    const event = stateChanged('PREPARING');
    const [push] = orderPushes(event);
    if (push === undefined) throw new Error('no push');

    expect(expoMessages(event, push, [])).toEqual([]);
  });

  describe('the new-order alarm per platform (2026-10-22)', () => {
    const android = 'ExponentPushToken[android]';
    const iphone = 'ExponentPushToken[iphone]';

    it('rings an iPhone with the bundled vendor_alarm.wav, and wakes Android data-only', () => {
      const event = stateChanged('PLACED');
      const [push] = orderPushes(event);
      if (push?.audience !== 'VENDOR') throw new Error('no vendor push');

      const [toAndroid, toIphone] = expoMessages(event, push, [android, iphone], new Set([iphone]));

      // Android: unchanged (SPEC: data-only); the app posts it on the order-alarm-v2 channel.
      expect(toAndroid).toMatchObject({ to: android, _contentAvailable: true });
      expect(toAndroid).not.toHaveProperty('sound');
      expect(toAndroid?.data).toMatchObject({ data_only: true });
      // iOS: APNs plays only the payload's own sound, named exactly with its extension.
      const { data, ...message } = toIphone ?? { data: {} };
      expect(message).toEqual({
        to: iphone,
        title: 'New order',
        body: push.body,
        sound: 'vendor_alarm.wav',
        priority: 'high',
      });
      expect(data).toMatchObject({ state: 'PLACED', audience: 'VENDOR', data_only: false });
      expect(orderPushDataSchema.safeParse(toIphone?.data).success).toBe(true);
    });

    it('sends an iPhone every other push exactly as before', () => {
      for (const state of ['PREPARING', 'OUT_FOR_DELIVERY', 'CANCELED'] as const) {
        const event = stateChanged(state);
        for (const push of orderPushes(event)) {
          const [toIphone] = expoMessages(event, push, [iphone], new Set([iphone]));
          const [plain] = expoMessages(event, push, [iphone]);
          expect(toIphone).toEqual(plain);
          expect(toIphone?.sound).not.toBe('vendor_alarm.wav');
        }
      }
    });
  });
});

describe('orderPushFallbackSms', () => {
  it('is the push as one branded line', () => {
    const [push] = orderPushes(stateChanged('PLACED'));
    if (push === undefined) throw new Error('no push');

    expect(orderPushFallbackSms(push)).toBe(
      'Hamro Pasal: New order. Order #1F8A11 is waiting. Open the app to accept or reject it.',
    );
  });
});
