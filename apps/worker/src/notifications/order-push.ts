import {
  ORDER_ALARM_SOUND,
  ORDER_PUSH_CHANNEL_ID,
  ORDER_PUSH_TYPE,
  orderPushRings,
  type OrderPushData,
  type OrderStateChangedEvent,
  type PushAudience,
} from '@hamro-pasal/shared-types';

import type { ExpoPushMessage } from '../push/expo-push';
import { orderCode } from './vendor-sms';

/*
 * Push notifications for `order.state_changed` (Phase 20). Texts are English, like the vendor SMS:
 * the server does not know the app's language. The order code is the one both apps show.
 */

/** One notification of an order event, for one side of the order. */
export interface OrderPush {
  readonly audience: PushAudience;
  readonly title: string;
  readonly body: string;
  /**
   * SPEC implicit requirement 1: order arrivals and dispatches are sent data-only, so a budget
   * Android device is woken silently and the app posts the notification itself.
   */
  readonly critical: boolean;
}

/** Who is told what when an order changes state; empty for a change nobody is pushed about. */
export function orderPushes(event: OrderStateChangedEvent): OrderPush[] {
  const { to_state, refund_required, placed_at } = event.payload;
  const code = orderCode(event.payload.order_id);
  switch (to_state) {
    case 'PLACED':
      return [
        {
          audience: 'VENDOR',
          title: 'New order',
          body: `Order #${code} is waiting. Open the app to accept or reject it.`,
          critical: true,
        },
      ];
    case 'PREPARING':
      return [
        {
          audience: 'CUSTOMER',
          title: 'Order accepted',
          body: `The shop is preparing order #${code}.`,
          critical: false,
        },
      ];
    case 'OUT_FOR_DELIVERY':
      return [
        {
          audience: 'CUSTOMER',
          title: 'Your order is on its way',
          body: `Order #${code} has left the shop. Keep your 4-digit delivery code ready.`,
          critical: true,
        },
      ];
    case 'DELIVERED':
      return [
        {
          audience: 'CUSTOMER',
          title: 'Order delivered',
          body: `Order #${code} was delivered. Rate the shop in the app.`,
          critical: false,
        },
      ];
    case 'CANCELED': {
      const customer: OrderPush = {
        audience: 'CUSTOMER',
        title: 'Order cancelled',
        body: refund_required
          ? `Order #${code} was cancelled. A refund of your payment has been initiated.`
          : `Order #${code} was cancelled.`,
        critical: false,
      };
      // The shop only ever saw an order that was placed.
      if (placed_at === null) return [customer];
      return [
        customer,
        {
          audience: 'VENDOR',
          title: 'Order cancelled',
          body: `Order #${code} was cancelled.`,
          critical: false,
        },
      ];
    }
    case 'FAILED':
      return [
        {
          audience: 'CUSTOMER',
          title: 'Order not completed',
          body: `Order #${code} could not be completed. Open the app for details.`,
          critical: false,
        },
      ];
    case 'PENDING_PAYMENT':
    case 'DISPUTED':
      return [];
  }
}

/** The `data` every order push carries (the app validates it with orderPushDataSchema). */
export function orderPushData(event: OrderStateChangedEvent, push: OrderPush): OrderPushData {
  return {
    type: ORDER_PUSH_TYPE,
    notification_id: event.event_id,
    order_id: event.payload.order_id,
    state: event.payload.to_state,
    audience: push.audience,
    data_only: push.critical,
    title: push.title,
    body: push.body,
  };
}

/** What every device of the recipient is sent. A critical push has no title or body (data-only). */
export function expoMessagePayload(
  event: OrderStateChangedEvent,
  push: OrderPush,
): Omit<ExpoPushMessage, 'to'> {
  const data = orderPushData(event, push);
  return push.critical
    ? { priority: 'high', _contentAvailable: true, data }
    : {
        title: push.title,
        body: push.body,
        sound: 'default',
        priority: 'high',
        channelId: ORDER_PUSH_CHANNEL_ID,
        data,
      };
}

/**
 * 2026-10-22: what an iPhone is sent for a push that rings the shop's alarm (a new order). The
 * data-only message Android gets (SPEC implicit requirement 1) cannot ring on iOS: iOS does not
 * wake a force-quit app for it, and only the APNs payload's own `sound` plays a custom sound
 * there, named by its exact file in the app bundle (`vendor_alarm.wav`, bundled by the
 * expo-notifications plugin). So the iPhone gets a visible notification with that sound; the app
 * then has nothing to post itself (`data_only: false`). On Android the sound is the
 * `order-alarm-v2` channel's, which the app creates with the same file.
 */
export function iosAlarmPayload(
  event: OrderStateChangedEvent,
  push: OrderPush,
): Omit<ExpoPushMessage, 'to'> {
  return {
    title: push.title,
    body: push.body,
    sound: ORDER_ALARM_SOUND,
    priority: 'high',
    data: { ...orderPushData(event, push), data_only: false },
  };
}

/**
 * One Expo message per device. `iosTokens` names the devices registered as iOS: they get the visible
 * alarm for a push that rings (iosAlarmPayload); every other device, and every other push, gets
 * expoMessagePayload. Without it every device is treated as Android (the behaviour before
 * 2026-10-22).
 */
export function expoMessages(
  event: OrderStateChangedEvent,
  push: OrderPush,
  tokens: readonly string[],
  iosTokens: ReadonlySet<string> = new Set(),
): ExpoPushMessage[] {
  const payload = expoMessagePayload(event, push);
  const rings = orderPushRings({ audience: push.audience, state: event.payload.to_state });
  const iosPayload = rings ? iosAlarmPayload(event, push) : payload;
  return tokens.map((to): ExpoPushMessage => ({
    to,
    ...(iosTokens.has(to) ? iosPayload : payload),
  }));
}

/** The SMS a push stands in for, logged when SMS_PROVIDER=MOCK (no SMS is sent for order pushes). */
export function orderPushFallbackSms(push: OrderPush): string {
  return `Hamro Pasal: ${push.title}. ${push.body}`;
}
