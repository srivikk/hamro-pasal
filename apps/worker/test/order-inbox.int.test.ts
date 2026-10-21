import { randomInt, randomUUID } from 'node:crypto';

import {
  createDatabase,
  notificationMessages,
  notificationRecipients,
  users,
  type Database,
} from '@hamro-pasal/db';
import type { OrderStateChangedEvent } from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';

import { DatabaseOrderInbox } from '../src/notifications/order-inbox';
import { orderPushes } from '../src/notifications/order-push';

/**
 * 2026-10-21 (Task 4) on real PostgreSQL: an order alert is kept in the recipient's notification
 * centre once per event and side, whatever the redeliveries. No Kafka: the consumer's wiring is
 * unit-tested; this is the database half.
 */
describe('DatabaseOrderInbox (real PostgreSQL)', () => {
  let db: Database;

  beforeAll(() => {
    db = createDatabase(process.env.TEST_DATABASE_URL ?? '', { max: 4 });
  });

  afterAll(async () => {
    await db.$client.end();
  });

  async function customer(): Promise<string> {
    const phone = `+9779${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
    const [row] = await db
      .insert(users)
      .values({ phone, role: 'CUSTOMER' })
      .returning({ id: users.id });
    if (row === undefined) throw new Error('user not created');
    return row.id;
  }

  function dispatched(customerId: string): OrderStateChangedEvent {
    const orderId = randomUUID();
    const at = new Date().toISOString();
    return {
      event_id: randomUUID(),
      event_type: 'order.state_changed',
      event_version: 1,
      occurred_at: at,
      aggregate_id: orderId,
      payload: {
        order_id: orderId,
        customer_id: customerId,
        vendor_id: randomUUID(),
        from_state: 'PREPARING',
        to_state: 'OUT_FOR_DELIVERY',
        payment_status: 'PAID',
        refund_required: false,
        placed_at: at,
        delivered_at: null,
        changed_at: at,
      },
    };
  }

  it('keeps one SYSTEM message for the customer, with the link to the order, however often it is sent', async () => {
    const customerId = await customer();
    const event = dispatched(customerId);
    const [push] = orderPushes(event);
    if (push === undefined) throw new Error('no push for a dispatch');
    const inbox = new DatabaseOrderInbox(db);

    await Promise.all([
      inbox.record(event, push, customerId),
      inbox.record(event, push, customerId),
    ]);
    await inbox.record(event, push, customerId);

    const kept = await db
      .select()
      .from(notificationMessages)
      .where(eq(notificationMessages.dedupe_key, `order:${event.event_id}:CUSTOMER`));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({
      audience: 'CUSTOMER',
      source: 'SYSTEM',
      title: 'Your order is on its way',
      data: {
        order_id: event.payload.order_id,
        state: 'OUT_FOR_DELIVERY',
        deep_link: `/track-order?id=${event.payload.order_id}`,
      },
    });
    const recipients = await db
      .select()
      .from(notificationRecipients)
      .where(eq(notificationRecipients.message_id, kept[0]?.id ?? ''));
    expect(recipients.map((r) => r.user_id)).toEqual([customerId]);
  });
});
