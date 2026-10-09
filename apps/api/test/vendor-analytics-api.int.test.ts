import { randomUUID } from 'node:crypto';

import {
  adProducts,
  orderItems,
  orders,
  outboxEvents,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import { chargePerOrderAdPremium, LedgerService, WalletService } from '@hamro-pasal/ledger';
import {
  adminCampaignResponseSchema,
  adPurchaseResponseSchema,
  ANALYTICS_WEEK_DAYS,
  campaignOptInResponseSchema,
  domainEventSchema,
  vendorAnalyticsSummarySchema,
  vendorOfferResponseSchema,
  type UserRole,
} from '@hamro-pasal/shared-types';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';

import {
  createOrder,
  createProduct,
  createUser,
  createVendor,
  vendorUserIdOf,
} from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Nepal Time is UTC+05:45 the whole year. */
const NPT_OFFSET = (5 * 60 + 45) * MINUTE;

/** The instant the Nepal Time day began, `daysAgo` days before today. */
function nptDayStart(daysAgo = 0): Date {
  const local = Date.now() + NPT_OFFSET;
  return new Date(Math.floor(local / DAY) * DAY - NPT_OFFSET - daysAgo * DAY);
}

/** The weekday of a Nepal Time day, as the summary names it. */
function nptWeekDay(daysAgo: number) {
  return ANALYTICS_WEEK_DAYS[new Date(nptDayStart(daysAgo).getTime() + NPT_OFFSET).getUTCDay()];
}

/**
 * Phase 35: GET /api/vendor/analytics/summary on real PostgreSQL. Sales are the delivered
 * subtotal less the discounts the shop itself paid for; a day is a calendar day in
 * Asia/Kathmandu, by the time of delivery.
 */
describe('Vendor analytics API', () => {
  let t: TestApp;
  let db: Database;
  let adminId: string;
  let admin: string;
  const ledger = new LedgerService(new WalletService());

  beforeAll(async () => {
    t = buildTestApp();
    db = t.container.db;
    adminId = await createUser(db, 'SUPER_ADMIN');
    admin = bearer(adminId, 'SUPER_ADMIN');
  });

  afterAll(async () => {
    await t.container.close();
  });

  async function shop() {
    const vendorId = await createVendor(db);
    const userId = await vendorUserIdOf(db, vendorId);
    return { vendorId, userId, token: bearer(userId, 'VENDOR') };
  }

  const get = (token: string | null) => {
    const req = request(t.app).get('/api/vendor/analytics/summary');
    return token === null ? req : req.set('authorization', token);
  };

  async function summary(token: string) {
    const res = await get(token);
    expect(res.status).toBe(200);
    return bodyOf(vendorAnalyticsSummarySchema, res);
  }

  interface Delivery {
    readonly subtotal?: number;
    readonly deliveredAt?: Date;
    readonly placedAt?: Date;
    readonly items?: readonly {
      productId: string;
      name: string;
      price: number;
      quantity: number;
    }[];
    readonly extra?: Partial<typeof orders.$inferInsert>;
  }

  /** An order of the shop that was delivered (now, unless another time is given). */
  async function delivered(vendorId: string, options: Delivery = {}) {
    const order = await createOrder(db, {
      vendorId,
      customerId: await createUser(db),
      subtotal: options.subtotal ?? 1000,
    });
    const deliveredAt = options.deliveredAt ?? new Date();
    await db
      .update(orders)
      .set({
        state: 'DELIVERED',
        placed_at: options.placedAt ?? new Date(deliveredAt.getTime() - 30 * MINUTE),
        delivered_at: deliveredAt,
        ...options.extra,
      })
      .where(eq(orders.id, order.id));
    for (const item of options.items ?? []) {
      await db.insert(orderItems).values({
        order_id: order.id,
        product_id: item.productId,
        product_name: item.name,
        unit_price_npr: item.price,
        quantity: item.quantity,
      });
    }
    return order.id;
  }

  it('answers zeros, seven empty days ending today, and no top item or ad for a new shop', async () => {
    const { token } = await shop();

    const res = await get(token);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(bodyOf(vendorAnalyticsSummarySchema, res)).toEqual({
      today_sales_npr: 0,
      today_order_count: 0,
      top_item: null,
      ad_roi: null,
      daily_sales: [6, 5, 4, 3, 2, 1, 0].map((daysAgo) => ({
        day: nptWeekDay(daysAgo),
        sales_npr: 0,
      })),
    });
  });

  it('counts sales as the subtotal less the shop’s own offer and its share of a campaign', async () => {
    const { vendorId, token } = await shop();
    const offer = await request(t.app)
      .post('/api/vendor/offers')
      .set('authorization', token)
      .send({ kind: 'FLAT', value: 100, min_cart_npr: 500 });
    expect(offer.status).toBe(201);
    const campaign = await request(t.app)
      .post('/api/admin/campaigns')
      .set('authorization', admin)
      .send({
        name: `Analytics ${randomUUID()}`,
        kind: 'PERCENTAGE',
        value: 10,
        max_discount_npr: null,
        min_cart_npr: 0,
        vendor_share_percent: 50,
        starts_at: new Date(Date.now() + DAY).toISOString(),
        ends_at: new Date(Date.now() + 10 * DAY).toISOString(),
        is_active: true,
      });
    expect(campaign.status).toBe(201);
    const campaignId = bodyOf(adminCampaignResponseSchema, campaign).campaign.id;
    const optIn = await request(t.app)
      .post(`/api/vendor/campaigns/${campaignId}/opt-in`)
      .set('authorization', token)
      .send({ terms_version: 1 });
    expect(optIn.status).toBe(201);

    // SPEC verification 5: 1000 of goods, the shop's FLAT 100, a 90 campaign discount of which
    // the shop bears 45. The platform's 45 and the 50 delivery fee are not the shop's.
    await delivered(vendorId, {
      extra: {
        vendor_offer_id: bodyOf(vendorOfferResponseSchema, offer).offer.id,
        vendor_offer_discount_npr: 100,
        campaign_opt_in_id: bodyOf(campaignOptInResponseSchema, optIn).opt_in.id,
        platform_promo_discount_npr: 90,
        platform_promo_vendor_share_npr: 45,
        discount_snapshot: { kind: 'PERCENTAGE', value: 10 },
      },
    });
    await delivered(vendorId, { subtotal: 250.5 });

    const body = await summary(token);

    expect(body.today_sales_npr).toBe(1105.5); // 855 + 250.50
    expect(body.today_order_count).toBe(2);
    expect(body.daily_sales.at(-1)).toEqual({ day: nptWeekDay(0), sales_npr: 1105.5 });
  });

  it('puts each delivery on its Nepal Time day: midnight there, not in UTC, is the boundary', async () => {
    const { vendorId, token } = await shop();
    const midnight = nptDayStart();
    // The first instant of today, and the last second of yesterday.
    await delivered(vendorId, { subtotal: 300, deliveredAt: midnight });
    await delivered(vendorId, { subtotal: 70, deliveredAt: new Date(midnight.getTime() - 1000) });
    // 23:30 yesterday in UTC is 05:15 today in Nepal when "today" there has just begun: either
    // way it is the Nepal Time day that decides. Three days ago, mid-afternoon there.
    await delivered(vendorId, {
      subtotal: 40,
      deliveredAt: new Date(nptDayStart(3).getTime() + 15 * 60 * MINUTE),
    });
    // The first instant of the oldest bar is in; one second earlier is in no bar.
    await delivered(vendorId, { subtotal: 9, deliveredAt: nptDayStart(6) });
    await delivered(vendorId, {
      subtotal: 5000,
      deliveredAt: new Date(nptDayStart(6).getTime() - 1000),
    });

    const body = await summary(token);

    expect(body.daily_sales).toEqual([
      { day: nptWeekDay(6), sales_npr: 9 },
      { day: nptWeekDay(5), sales_npr: 0 },
      { day: nptWeekDay(4), sales_npr: 0 },
      { day: nptWeekDay(3), sales_npr: 40 },
      { day: nptWeekDay(2), sales_npr: 0 },
      { day: nptWeekDay(1), sales_npr: 70 },
      { day: nptWeekDay(0), sales_npr: 300 },
    ]);
    expect(body.today_sales_npr).toBe(300);
    expect(body.today_order_count).toBe(1);
  });

  it('counts only DELIVERED orders, and only the caller’s own shop', async () => {
    const { vendorId, token } = await shop();
    const other = await shop();
    await delivered(vendorId, { subtotal: 400 });
    await delivered(other.vendorId, { subtotal: 9000 });
    const customerId = await createUser(db);
    // Placed, cancelled after placement and disputed after delivery: none is a sale today.
    const placed = await createOrder(db, { vendorId, customerId, subtotal: 111 });
    await db
      .update(orders)
      .set({ state: 'PLACED', placed_at: new Date() })
      .where(eq(orders.id, placed.id));
    const cancelled = await createOrder(db, { vendorId, customerId, subtotal: 222 });
    await db
      .update(orders)
      .set({ state: 'CANCELED', placed_at: new Date() })
      .where(eq(orders.id, cancelled.id));
    const disputed = await delivered(vendorId, { subtotal: 333 });
    await db.update(orders).set({ state: 'DISPUTED' }).where(eq(orders.id, disputed));

    const body = await summary(token);

    expect(body.today_sales_npr).toBe(400);
    expect(body.today_order_count).toBe(1);
    expect((await summary(other.token)).today_sales_npr).toBe(9000);
  });

  it('names the item with the most units in seven days, with the name it was last sold under', async () => {
    const { vendorId, token } = await shop();
    const noodles = await createProduct(db, vendorId, 50, 20);
    const ghee = await createProduct(db, vendorId, 50, 750);
    const old = await createProduct(db, vendorId, 50, 10);
    await delivered(vendorId, {
      deliveredAt: new Date(nptDayStart(2).getTime() + 60 * MINUTE),
      items: [
        { productId: noodles, name: 'Wai Wai (old name)', price: 18, quantity: 6 },
        { productId: ghee, name: 'DDC Ghee 500ml', price: 750, quantity: 3 },
      ],
    });
    await delivered(vendorId, {
      items: [{ productId: noodles, name: 'Wai Wai Noodles', price: 20, quantity: 5 }],
    });
    // More units, but delivered before the window: it does not count.
    await delivered(vendorId, {
      deliveredAt: new Date(nptDayStart(6).getTime() - MINUTE),
      items: [{ productId: old, name: 'Old favourite', price: 10, quantity: 99 }],
    });

    const body = await summary(token);

    // By volume: 11 packets beat 3 jars worth far more. 6 x 18 + 5 x 20 = 208.
    expect(body.top_item).toEqual({
      product_name: 'Wai Wai Noodles',
      units_sold: 11,
      sales_npr: 208,
    });
  });

  it('breaks a tie in units by the larger amount', async () => {
    const { vendorId, token } = await shop();
    const cheap = await createProduct(db, vendorId, 50, 10);
    const dear = await createProduct(db, vendorId, 50, 500);
    await delivered(vendorId, {
      items: [
        { productId: cheap, name: 'Cheap', price: 10, quantity: 4 },
        { productId: dear, name: 'Dear', price: 500, quantity: 4 },
      ],
    });

    expect((await summary(token)).top_item).toEqual({
      product_name: 'Dear',
      units_sold: 4,
      sales_npr: 2000,
    });
  });

  describe('ad return', () => {
    /** A per-order ad bought through the API: 25 per delivered order, already running. */
    async function perOrderAd(token: string, budgetNpr: number) {
      const [product] = await db
        .insert(adProducts)
        .values({
          name: `Per order ${randomUUID()}`,
          slot: 'FEED_LISTING',
          billing_model: 'PER_ORDER_PREMIUM',
          price_npr: 25,
          duration_days: 7,
          created_by_user_id: adminId,
        })
        .returning();
      const res = await request(t.app)
        .post('/api/vendor/ads/purchases')
        .set('authorization', token)
        .send({
          ad_product_id: product?.id,
          starts_at: new Date(Date.now() - MINUTE).toISOString(),
          budget_npr: budgetNpr,
          idempotency_key: randomUUID(),
          agreed: true,
        });
      expect(res.status).toBe(201);
      return bodyOf(adPurchaseResponseSchema, res).purchase;
    }

    const charge = (orderId: string, vendorId: string) =>
      db.transaction((tx) => chargePerOrderAdPremium(tx, ledger, orderId, vendorId));

    it('sets what the ads cost against the sales of orders placed while one ran', async () => {
      const { vendorId, token } = await shop();
      // Delivered today but placed an hour before the ad began: not the ad's.
      await delivered(vendorId, {
        subtotal: 5000,
        placedAt: new Date(Date.now() - 60 * MINUTE),
      });
      await perOrderAd(token, 100);
      const first = await delivered(vendorId, { subtotal: 600, placedAt: new Date() });
      const second = await delivered(vendorId, { subtotal: 400, placedAt: new Date() });
      expect((await charge(first, vendorId)).status).toBe('CHARGED');
      expect((await charge(second, vendorId)).status).toBe('CHARGED');
      // A retried delivery charges nothing more.
      expect((await charge(second, vendorId)).status).toBe('ALREADY_CHARGED');

      const body = await summary(token);

      expect(body.ad_roi).toEqual({ spend_npr: 50, revenue_npr: 1000 });
      expect(body.today_sales_npr).toBe(6000);
    });

    it('shows an ad that has brought nothing yet as 0 for 0, and no ad at all as null', async () => {
      const { token } = await shop();
      expect((await summary(token)).ad_roi).toBeNull();

      await perOrderAd(token, 100);

      expect((await summary(token)).ad_roi).toEqual({ spend_npr: 0, revenue_npr: 0 });
    });

    it('forgets an ad that was cancelled before it cost anything', async () => {
      const { vendorId, token } = await shop();
      const ad = await perOrderAd(token, 100);
      await delivered(vendorId, { subtotal: 700, placedAt: new Date() });
      const cancel = await request(t.app)
        .post(`/api/vendor/ads/purchases/${ad.id}/cancel`)
        .set('authorization', token);
      expect(cancel.status).toBe(200);

      expect((await summary(token)).ad_roi).toBeNull();
    });

    it('writes marketing.ad_paused to the outbox when a delivery uses the budget up', async () => {
      const { vendorId, token } = await shop();
      const ad = await perOrderAd(token, 25);
      const orderId = await delivered(vendorId, { subtotal: 600, placedAt: new Date() });
      const events = () =>
        db
          .select()
          .from(outboxEvents)
          .where(
            and(
              eq(outboxEvents.aggregate_id, ad.id),
              eq(outboxEvents.event_type, 'marketing.ad_paused'),
            ),
          );
      expect(await events()).toEqual([]);

      expect(await charge(orderId, vendorId)).toMatchObject({ status: 'CHARGED', paused: true });

      const [event, ...rest] = await events();
      expect(rest).toEqual([]);
      expect(event).toMatchObject({
        topic: 'notifications.broadcast',
        published_at: null,
        payload: {
          ad_purchase_id: ad.id,
          vendor_id: vendorId,
          reason: 'BUDGET_EXHAUSTED',
          budget_npr: 25,
          amount_paid_npr: 25,
        },
      });
      const [vendor] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
      expect(event?.payload).toMatchObject({ vendor_phone: vendor?.phone });
      // The stored envelope is one the relay can publish.
      expect(
        domainEventSchema.safeParse({
          event_id: event?.id,
          event_type: event?.event_type,
          event_version: 1,
          occurred_at: event?.occurred_at.toISOString(),
          aggregate_id: event?.aggregate_id,
          payload: event?.payload,
        }).success,
      ).toBe(true);
    });
  });

  it('takes no parameter that names a shop, and serves vendors with a shop only', async () => {
    const { vendorId, token } = await shop();
    const other = await shop();
    await delivered(other.vendorId, { subtotal: 800 });

    const res = await request(t.app)
      .get(`/api/vendor/analytics/summary?vendor_id=${other.vendorId}`)
      .set('authorization', token);
    expect(bodyOf(vendorAnalyticsSummarySchema, res).today_sales_npr).toBe(0);
    expect(vendorId).not.toBe(other.vendorId);

    expect((await get(null)).status).toBe(401);
    for (const role of ['CUSTOMER', 'DRIVER', 'SUPER_ADMIN'] satisfies UserRole[]) {
      expect((await get(bearer(await createUser(db, role), role))).status).toBe(403);
    }
    const shopless = await get(bearer(await createUser(db, 'VENDOR'), 'VENDOR'));
    expect(shopless.status).toBe(404);
    expect(errorOf(shopless).code).toBe('VENDOR_NOT_FOUND');
  });

  it('reads the deliveries through the vendor and delivery time index', async () => {
    const { rows } = await db.execute<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'orders_vendor_id_delivered_at_idx'",
    );
    expect(rows[0]?.indexdef).toContain('(vendor_id, delivered_at)');
    expect(rows[0]?.indexdef).toContain('delivered_at IS NOT NULL');
  });
});
