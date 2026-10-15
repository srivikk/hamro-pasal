import { randomInt, randomUUID } from 'node:crypto';

import {
  createDatabase,
  deviceTokens,
  notificationMessages,
  notificationRecipients,
  products,
  shopOpenAlerts,
  stockAlerts,
  users,
  vendorOpeningHours,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import { ALERT_NOTICE_BATCH_SIZE, type LanguagePreference } from '@hamro-pasal/shared-types';
import { eq, inArray } from 'drizzle-orm';

import { NotifyMeService } from '../src/notifications/notify-me';
import type { ExpoPushMessage, PushGateway, PushTicket } from '../src/push/expo-push';

class RecordingPush implements PushGateway {
  readonly sent: ExpoPushMessage[] = [];
  failWith: Error | null = null;
  unregistered = new Set<string>();

  send(messages: readonly ExpoPushMessage[]): Promise<PushTicket[]> {
    if (this.failWith !== null) return Promise.reject(this.failWith);
    this.sent.push(...messages);
    return Promise.resolve(
      messages.map((message) =>
        this.unregistered.has(message.to)
          ? {
              token: message.to,
              status: 'error' as const,
              error: 'DeviceNotRegistered',
              message: 'gone',
            }
          : { token: message.to, status: 'ok' as const, id: randomUUID() },
      ),
    );
  }
}

/** Step 7.4 (SPEC core 11, verification 29): Notify Me against real PostgreSQL. */
describe('Notify Me (real PostgreSQL)', () => {
  let db: Database;
  let push: RecordingPush;
  let notifyMe: NotifyMeService;

  beforeAll(() => {
    db = createDatabase(process.env.TEST_DATABASE_URL ?? '', { max: 10 });
  });

  beforeEach(() => {
    push = new RecordingPush();
    notifyMe = new NotifyMeService(db, push);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  async function customer(language: LanguagePreference = 'en', token?: string): Promise<string> {
    const phone = `+9779${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
    const [row] = await db
      .insert(users)
      .values({ phone, role: 'CUSTOMER', language_preference: language })
      .returning({ id: users.id });
    if (row === undefined) throw new Error('user not created');
    if (token !== undefined) {
      await db.insert(deviceTokens).values({ user_id: row.id, token, platform: 'ANDROID' });
    }
    return row.id;
  }

  async function shop(stock = 0): Promise<{ vendorId: string; productId: string }> {
    const phone = `+9779${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
    const [owner] = await db
      .insert(users)
      .values({ phone, role: 'VENDOR' })
      .returning({ id: users.id });
    if (owner === undefined) throw new Error('owner not created');
    const [vendor] = await db
      .insert(vendors)
      .values({
        user_id: owner.id,
        business_name: 'Thamel Kirana Pasal',
        phone: '+9779800000011',
        status: 'LIVE',
        pricing_model: 'COMMISSION',
        commission_rate: 0.1,
        delivery_scope: 'RADIUS_BOUND',
        fulfillment_mode: 'SELF_DELIVERY',
        radius_km: 5,
        municipality_palika_string: 'Kathmandu Metropolitan City',
        min_order_value: 0,
        base_delivery_fee_npr: 50,
        location: { x: 85.3123, y: 27.7154 },
      })
      .returning({ id: vendors.id });
    if (vendor === undefined) throw new Error('vendor not created');
    const [product] = await db
      .insert(products)
      .values({
        vendor_id: vendor.id,
        name: `Basmati Rice ${randomUUID().slice(0, 8)}`,
        price_npr: 500,
        stock_quantity: stock,
      })
      .returning({ id: products.id, name: products.name });
    if (product === undefined) throw new Error('product not created');
    return { vendorId: vendor.id, productId: product.id };
  }

  async function messagesFor(userId: string) {
    return db
      .select({
        title: notificationMessages.title,
        body: notificationMessages.body,
        audience: notificationMessages.audience,
        data: notificationMessages.data,
      })
      .from(notificationRecipients)
      .innerJoin(
        notificationMessages,
        eq(notificationMessages.id, notificationRecipients.message_id),
      )
      .where(eq(notificationRecipients.user_id, userId));
  }

  it('tells every customer waiting for a product once, in their language, and uses the requests up', async () => {
    const { vendorId, productId } = await shop(5);
    const english = await customer('en', `ExponentPushToken[${randomUUID()}]`);
    const nepali = await customer('ne', `ExponentPushToken[${randomUUID()}]`);
    await db.insert(stockAlerts).values([
      { user_id: english, product_id: productId },
      { user_id: nepali, product_id: productId },
    ]);

    await expect(notifyMe.productBackInStock(productId)).resolves.toEqual({ notified: 2 });

    const [en] = await messagesFor(english);
    expect(en).toMatchObject({
      audience: 'CUSTOMER',
      title: 'Back in stock',
      data: { kind: 'BACK_IN_STOCK', product_id: productId, vendor_id: vendorId },
    });
    expect(en?.body).toMatch(/is back in stock at Thamel Kirana Pasal\.$/);
    expect((await messagesFor(nepali))[0]?.title).toBe('फेरि उपलब्ध छ');
    expect(push.sent.map((m) => m.title).sort()).toEqual(['Back in stock', 'फेरि उपलब्ध छ']);
    expect(
      await db.select().from(stockAlerts).where(eq(stockAlerts.product_id, productId)),
    ).toEqual([]);

    // A redelivered event finds nobody left.
    await expect(notifyMe.productBackInStock(productId)).resolves.toEqual({ notified: 0 });
    expect(await messagesFor(english)).toHaveLength(1);
  });

  it('still tells them when the product sold out again before the notice went (edge case 22)', async () => {
    const { productId } = await shop(0);
    const waiting = await customer();
    await db.insert(stockAlerts).values({ user_id: waiting, product_id: productId });

    await expect(notifyMe.productBackInStock(productId)).resolves.toEqual({ notified: 1 });
    expect(await messagesFor(waiting)).toHaveLength(1);
  });

  it('keeps the notice when the push fails, and forgets unregistered devices', async () => {
    const { productId } = await shop(3);
    const gone = `ExponentPushToken[${randomUUID()}]`;
    const first = await customer('en', gone);
    await db.insert(stockAlerts).values({ user_id: first, product_id: productId });
    push.unregistered.add(gone);

    await notifyMe.productBackInStock(productId);
    expect(await db.select().from(deviceTokens).where(eq(deviceTokens.token, gone))).toEqual([]);

    const second = await customer('en', `ExponentPushToken[${randomUUID()}]`);
    await db.insert(stockAlerts).values({ user_id: second, product_id: productId });
    push.failWith = new Error('Expo is down');
    await expect(notifyMe.productBackInStock(productId)).resolves.toEqual({ notified: 1 });
    expect(await messagesFor(second)).toHaveLength(1);
  });

  it(`works through more than ${String(ALERT_NOTICE_BATCH_SIZE)} customers in batches`, async () => {
    const { productId } = await shop(1);
    const ids: string[] = [];
    for (let i = 0; i < ALERT_NOTICE_BATCH_SIZE + 5; i += 1) ids.push(await customer());
    await db.insert(stockAlerts).values(ids.map((id) => ({ user_id: id, product_id: productId })));

    await expect(notifyMe.productBackInStock(productId)).resolves.toEqual({
      notified: ALERT_NOTICE_BATCH_SIZE + 5,
    });
    const told = await db
      .selectDistinct({ user: notificationRecipients.user_id })
      .from(notificationRecipients)
      .where(inArray(notificationRecipients.user_id, ids));
    expect(told).toHaveLength(ids.length);
  });

  it('tells customers waiting for a shop only once it takes orders', async () => {
    const { vendorId } = await shop();
    const waiting = await customer('en', `ExponentPushToken[${randomUUID()}]`);
    await db.insert(shopOpenAlerts).values({ user_id: waiting, vendor_id: vendorId });
    await db
      .update(vendors)
      .set({ auto_paused_at: new Date(), consecutive_missed_orders: 3 })
      .where(eq(vendors.id, vendorId));

    // Still paused: nobody is told and the request waits.
    await expect(notifyMe.shopOpened(vendorId)).resolves.toEqual({ notified: 0 });
    expect(
      await db.select().from(shopOpenAlerts).where(eq(shopOpenAlerts.vendor_id, vendorId)),
    ).toHaveLength(1);

    await db
      .update(vendors)
      .set({ auto_paused_at: null, consecutive_missed_orders: 0 })
      .where(eq(vendors.id, vendorId));
    await expect(notifyMe.shopOpened(vendorId)).resolves.toEqual({ notified: 1 });
    expect((await messagesFor(waiting))[0]).toMatchObject({
      title: 'Shop open',
      body: 'Thamel Kirana Pasal is open and taking orders now.',
      data: { kind: 'SHOP_OPEN', vendor_id: vendorId },
    });
  });

  it('sweeps restocked products and shops opened by their hours, and leaves the rest waiting', async () => {
    const restocked = await shop(0);
    const soldOut = await shop(0);
    const openByHours = await shop();
    const closedByHours = await shop();
    const waiting = await customer();
    await db.insert(stockAlerts).values([
      { user_id: waiting, product_id: restocked.productId },
      { user_id: waiting, product_id: soldOut.productId },
    ]);
    await db.insert(shopOpenAlerts).values([
      { user_id: waiting, vendor_id: openByHours.vendorId },
      { user_id: waiting, vendor_id: closedByHours.vendorId },
    ]);
    // Kathmandu wall clock (UTC+05:45) of a moment: its weekday and HH:MM.
    const nepal = (offsetMs: number) => new Date(Date.now() + offsetMs + 5.75 * 60 * 60 * 1000);
    const hhmm = (d: Date) =>
      `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    // Open from two hours ago to two hours from now / for one minute, an hour from now.
    const opened = nepal(-2 * 60 * 60 * 1000);
    await db.insert(vendorOpeningHours).values({
      vendor_id: openByHours.vendorId,
      weekday: opened.getUTCDay(),
      opens_at: hhmm(opened),
      closes_at: hhmm(nepal(2 * 60 * 60 * 1000)),
    });
    const later = nepal(60 * 60 * 1000);
    await db.insert(vendorOpeningHours).values({
      vendor_id: closedByHours.vendorId,
      weekday: later.getUTCDay(),
      opens_at: hhmm(later),
      closes_at: hhmm(new Date(later.getTime() + 60_000)),
    });
    // Restocked another way (a cancelled order's items returned): no event was written.
    await db
      .update(products)
      .set({ stock_quantity: 4 })
      .where(eq(products.id, restocked.productId));

    const summary = await notifyMe.sweep();
    expect(summary.notified).toBeGreaterThanOrEqual(2);

    const left = await db.select().from(stockAlerts).where(eq(stockAlerts.user_id, waiting));
    expect(left.map((row) => row.product_id)).toEqual([soldOut.productId]);
    const shopsLeft = await db
      .select()
      .from(shopOpenAlerts)
      .where(eq(shopOpenAlerts.user_id, waiting));
    expect(shopsLeft.map((row) => row.vendor_id)).toEqual([closedByHours.vendorId]);
    expect(await messagesFor(waiting)).toHaveLength(2);
  });
});
