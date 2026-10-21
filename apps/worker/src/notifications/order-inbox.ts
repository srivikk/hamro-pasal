import { recordNotificationMessage, type Database } from '@hamro-pasal/db';
import type { OrderStateChangedEvent } from '@hamro-pasal/shared-types';

import type { OrderPush } from './order-push';

/*
 * 2026-10-21 (Task 4, SPEC core 11 "notification centre"): every order alert the customer or the
 * shop is pushed is kept in that account's notification centre too, so the inbox tray holds it
 * whether or not a device was registered, the push arrived, or the system tray was cleared.
 */

/** Where an order alert is kept for the account it was meant for. */
export interface OrderInbox {
  record(event: OrderStateChangedEvent, push: OrderPush, userId: string): Promise<void>;
}

/** One message per event and side of the order, whatever the redeliveries. */
export function orderInboxDedupeKey(event: OrderStateChangedEvent, push: OrderPush): string {
  return `order:${event.event_id}:${push.audience}`;
}

/**
 * The in-app path the message opens: the order's tracking for the customer (as a tapped push
 * does), the Live Orders board for the shop.
 */
export function orderInboxLink(event: OrderStateChangedEvent, push: OrderPush): string {
  return push.audience === 'CUSTOMER' ? `/track-order?id=${event.payload.order_id}` : '/dashboard';
}

export class DatabaseOrderInbox implements OrderInbox {
  constructor(private readonly db: Database) {}

  async record(event: OrderStateChangedEvent, push: OrderPush, userId: string): Promise<void> {
    await recordNotificationMessage(this.db, {
      audience: push.audience,
      source: 'SYSTEM',
      title: push.title,
      body: push.body,
      data: {
        event_type: event.event_type,
        order_id: event.payload.order_id,
        state: event.payload.to_state,
        deep_link: orderInboxLink(event, push),
      },
      dedupeKey: orderInboxDedupeKey(event, push),
      recipientUserIds: [userId],
    });
  }
}
