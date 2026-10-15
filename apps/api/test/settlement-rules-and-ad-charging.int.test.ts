import { randomUUID } from 'node:crypto';

import {
  adProducts,
  adPurchases,
  auditLogs,
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  orders,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import {
  adPurchaseResponseSchema,
  cartQuoteResponseSchema,
  checkoutResponseSchema,
  esewaInitiateResponseSchema,
  paymentStatusResponseSchema,
  type PaymentMethod,
  type SettlementModel,
} from '@hamro-pasal/shared-types';
import { and, eq, sql } from 'drizzle-orm';
import request from 'supertest';

import { LedgerService } from '../src/ledger/ledger-service';
import { WalletService } from '../src/wallet/wallet-service';
import {
  backdatePlacement,
  createProduct,
  createUser,
  createVendor,
  DELIVERY_ADDRESS,
  stockOf,
  vendorUserIdOf,
} from './support/fixtures';
import { bearer, bodyOf, buildTestApp, esewaCallback, errorOf, type TestApp } from './support/http';

/**
 * Phase 29 on real Express + PostgreSQL + Redis: payment routing by settlement model (SPEC core
 * 9), the model locked on each order (SPEC core 5), and the per-order ad premium charged in the
 * delivery's own transaction (SPEC core 8).
 */
describe('settlement rules at checkout and ad charging at delivery', () => {
  let t: TestApp;
  let db: Database;
  let adminId: string;
  const ledger = new LedgerService(new WalletService());

  beforeAll(async () => {
    t = buildTestApp();
    db = t.container.db;
    adminId = await createUser(db, 'SUPER_ADMIN');
  });

  afterAll(async () => {
    await t.container.close();
  });

  async function setup(model: SettlementModel = 'PLATFORM_ESCROW', accepted?: PaymentMethod[]) {
    const customerId = await createUser(db);
    const vendorId = await createVendor(db, { baseDeliveryFee: 50 });
    await db
      .update(vendors)
      .set({
        settlement_model: model,
        ...(accepted === undefined ? {} : { accepted_payment_methods: accepted }),
      })
      .where(eq(vendors.id, vendorId));
    const vendorUserId = await vendorUserIdOf(db, vendorId);
    const productId = await createProduct(db, vendorId, 10, 500);
    return { customerId, vendorId, vendorUserId, productId };
  }
  type Setup = Awaited<ReturnType<typeof setup>>;

  const cartOf = (s: Setup, quantity = 2) => ({
    vendor_id: s.vendorId,
    items: [{ product_id: s.productId, quantity }],
    delivery_address: DELIVERY_ADDRESS,
  });

  const quote = async (s: Setup) =>
    bodyOf(
      cartQuoteResponseSchema,
      await request(t.app)
        .post('/api/cart/quote')
        .set('authorization', bearer(s.customerId))
        .send(cartOf(s)),
    ).payment_options;

  const checkout = (s: Setup, paymentMethod: PaymentMethod, quantity = 2) =>
    request(t.app)
      .post('/api/cart/checkout')
      .set('authorization', bearer(s.customerId))
      .send({
        ...cartOf(s, quantity),
        idempotency_key: randomUUID(),
        payment_method: paymentMethod,
      });

  const ordersOf = (s: Setup) => db.select().from(orders).where(eq(orders.vendor_id, s.vendorId));

  const walletOf = async (vendorId: string) =>
    (
      await db
        .select({ balance: vendors.wallet_balance_npr, status: vendors.status })
        .from(vendors)
        .where(eq(vendors.id, vendorId))
    )[0];

  describe('payment routing (Model A is cash only)', () => {
    it('quotes a Model A shop with Cash on Delivery only', async () => {
      const s = await setup('COD_CREDIT');

      expect(await quote(s)).toEqual([
        { method: 'ESEWA', available: false, reason: 'SETTLEMENT_MODEL' },
        { method: 'KHALTI', available: false, reason: 'SETTLEMENT_MODEL' },
        { method: 'COD', available: true },
      ]);
    });

    it('refuses a digital checkout at a Model A shop with 422 and creates nothing', async () => {
      const s = await setup('COD_CREDIT');

      for (const method of ['ESEWA', 'KHALTI'] as const) {
        const refused = await checkout(s, method);
        expect(refused.status).toBe(422);
        expect(errorOf(refused)).toMatchObject({
          code: 'PAYMENT_METHOD_UNAVAILABLE',
          details: {
            accepted: ['COD'],
            reason: 'SETTLEMENT_MODEL',
            settlement_model: 'COD_CREDIT',
          },
        });
      }
      expect(await ordersOf(s)).toEqual([]);
      // No inventory was held for the refused checkouts.
      expect(await stockOf(db, s.productId)).toBe(10);
      expect((await checkout(s, 'COD', 10)).status).toBe(201);
    });

    it('takes a cash order at a Model A shop and locks COD_CREDIT on it', async () => {
      const s = await setup('COD_CREDIT');

      const placed = await checkout(s, 'COD');

      expect(placed.status).toBe(201);
      expect(bodyOf(checkoutResponseSchema, placed).order.state).toBe('PLACED');
      expect((await ordersOf(s)).map((order) => order.settlement_model_locked)).toEqual([
        'COD_CREDIT',
      ]);
    });

    it('offers the intersection of the model’s methods and the shop’s own', async () => {
      // Model B narrowed by the shop.
      const narrowed = await setup('PLATFORM_ESCROW', ['ESEWA', 'COD']);
      expect(await quote(narrowed)).toEqual([
        { method: 'ESEWA', available: true },
        { method: 'KHALTI', available: false, reason: 'NOT_ACCEPTED_BY_SHOP' },
        { method: 'COD', available: true },
      ]);
      expect(errorOf(await checkout(narrowed, 'KHALTI'))).toMatchObject({
        code: 'PAYMENT_METHOD_UNAVAILABLE',
        details: { accepted: ['ESEWA', 'COD'], reason: 'NOT_ACCEPTED_BY_SHOP' },
      });

      // A Model A shop whose own list has no cash can take nothing: its list never widens the model.
      const empty = await setup('COD_CREDIT', ['ESEWA', 'KHALTI']);
      expect(await quote(empty)).toEqual([
        { method: 'ESEWA', available: false, reason: 'SETTLEMENT_MODEL' },
        { method: 'KHALTI', available: false, reason: 'SETTLEMENT_MODEL' },
        { method: 'COD', available: false, reason: 'NOT_ACCEPTED_BY_SHOP' },
      ]);
      for (const method of ['ESEWA', 'COD'] as const) {
        const refused = await checkout(empty, method);
        expect(refused.status).toBe(422);
        expect(errorOf(refused)).toMatchObject({
          code: 'PAYMENT_METHOD_UNAVAILABLE',
          details: { accepted: [] },
        });
      }
    });

    it('offers nothing at a Model C shop: the model is not built', async () => {
      const s = await setup('DIRECT_PREPAID');

      expect((await quote(s)).map((option) => [option.available, option.reason])).toEqual([
        [false, 'SETTLEMENT_MODEL'],
        [false, 'SETTLEMENT_MODEL'],
        [false, 'SETTLEMENT_MODEL'],
      ]);
      expect((await checkout(s, 'COD')).status).toBe(422);
    });
  });

  describe('the settlement model locked on an order', () => {
    it('copies the shop’s model at creation and keeps it when the shop changes model', async () => {
      const s = await setup('PLATFORM_ESCROW');
      expect((await checkout(s, 'ESEWA')).status).toBe(201);
      expect((await checkout(s, 'COD')).status).toBe(201);

      await db
        .update(vendors)
        .set({ settlement_model: 'COD_CREDIT' })
        .where(eq(vendors.id, s.vendorId));
      expect((await checkout(s, 'COD')).status).toBe(201);

      const locked = (await ordersOf(s))
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
        .map((order) => [order.payment_method, order.settlement_model_locked]);
      expect(locked).toEqual([
        ['ESEWA', 'PLATFORM_ESCROW'],
        ['COD', 'PLATFORM_ESCROW'],
        ['COD', 'COD_CREDIT'],
      ]);
    });

    it('the database refuses a change of the locked model, and nothing else', async () => {
      const s = await setup('PLATFORM_ESCROW');
      const orderId = bodyOf(checkoutResponseSchema, await checkout(s, 'COD')).order.id;

      const changed = await db
        .update(orders)
        .set({ settlement_model_locked: 'COD_CREDIT' })
        .where(eq(orders.id, orderId))
        .then(
          () => 'changed',
          (error: unknown) => String((error as { cause?: unknown }).cause ?? error),
        );
      expect(changed).toContain('settlement_model_locked never changes');

      // Every other update of the order still works.
      await backdatePlacement(db, orderId, 5);
      const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
      expect(order?.settlement_model_locked).toBe('PLATFORM_ESCROW');
    });

    it('a checkout racing a model change takes the model that committed, or is refused by it', async () => {
      const s = await setup('PLATFORM_ESCROW');
      let pending: Promise<request.Response> | undefined;

      // The approval's transaction: the vendor row FOR UPDATE, the model changed, then commit.
      await db.transaction(async (tx) => {
        await tx.select().from(vendors).where(eq(vendors.id, s.vendorId)).for('update');
        await tx
          .update(vendors)
          .set({ settlement_model: 'COD_CREDIT' })
          .where(eq(vendors.id, s.vendorId));
        // Priced while the shop still reads as Model B; then it waits on the vendor row.
        pending = checkout(s, 'ESEWA').then((res) => res);
        await new Promise((resolve) => setTimeout(resolve, 400));
      });

      const refused = await pending;
      expect(refused?.status).toBe(422);
      expect(errorOf(refused ?? { body: null })).toMatchObject({
        code: 'PAYMENT_METHOD_UNAVAILABLE',
        details: { accepted: ['COD'], settlement_model: 'COD_CREDIT' },
      });
      expect(await ordersOf(s)).toEqual([]);
      // The refused checkout released its inventory lock: the whole stock can still be ordered.
      expect((await checkout(s, 'COD', 10)).status).toBe(201);
    });
  });

  describe('the per-order ad premium at delivery', () => {
    const vendorPost = (s: Setup, orderId: string, action: string) =>
      request(t.app)
        .post(`/api/vendors/orders/${orderId}/${action}`)
        .set('authorization', bearer(s.vendorUserId, 'VENDOR'));

    /** A per-order ad bought through the API: 25 per delivered order, running for 4 minutes. */
    async function perOrderAd(s: Setup, budgetNpr: number) {
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
        .set('Authorization', bearer(s.vendorUserId, 'VENDOR'))
        .send({
          ad_product_id: product?.id,
          // Before the orders' (backdated) placement, on the database clock.
          starts_at: new Date(Date.now() - 4 * 60_000).toISOString(),
          budget_npr: budgetNpr,
          idempotency_key: randomUUID(),
          agreed: true,
        });
      expect(res.status).toBe(201);
      return bodyOf(adPurchaseResponseSchema, res).purchase.id;
    }

    /** 2 x 500 + 50 delivery, placed through the API. */
    async function placed(s: Setup, method: 'COD' | 'ESEWA' = 'COD') {
      const res = await checkout(s, method);
      expect(res.status).toBe(201);
      const body = bodyOf(checkoutResponseSchema, res);
      if (body.delivery_otp === null) throw new Error('checkout returned no delivery code');
      if (method === 'ESEWA') {
        const initiate = await request(t.app)
          .post('/api/payments/esewa/initiate')
          .set('authorization', bearer(s.customerId))
          .send({ order_id: body.order.id });
        const uuid = bodyOf(esewaInitiateResponseSchema, initiate).fields.transaction_uuid;
        const paid = await request(t.app)
          .post('/api/payments/esewa/webhook')
          .send({ data: esewaCallback({ transaction_uuid: uuid ?? '', total_amount: '1050.0' }) });
        expect(bodyOf(paymentStatusResponseSchema, paid).payment?.order_state).toBe('PLACED');
      }
      return { orderId: body.order.id, otp: body.delivery_otp };
    }

    async function dispatched(s: Setup, order: { orderId: string }) {
      expect((await vendorPost(s, order.orderId, 'accept')).status).toBe(200);
      await backdatePlacement(db, order.orderId, 61);
      expect((await vendorPost(s, order.orderId, 'dispatch')).status).toBe(200);
    }

    const deliver = (s: Setup, order: { orderId: string; otp: string }, otp = order.otp) =>
      vendorPost(s, order.orderId, 'deliver').send({ delivery_otp: otp });

    const premiumLines = async (purchaseId: string) =>
      (
        await db
          .select({
            account: ledgerAccounts.account_type,
            amount: ledgerEntries.amount_npr,
            orderId: ledgerTransactions.order_id,
            kind: ledgerTransactions.kind,
          })
          .from(ledgerEntries)
          .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.account_id))
          .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transaction_id))
          .where(
            and(
              eq(ledgerEntries.ad_purchase_id, purchaseId),
              eq(ledgerEntries.line_type, 'AD_ORDER_PREMIUM'),
            ),
          )
      ).sort((a, b) => a.amount - b.amount);

    const purchaseRow = async (id: string) =>
      (await db.select().from(adPurchases).where(eq(adPurchases.id, id)))[0];

    const pauses = (purchaseId: string) =>
      db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entity_id, purchaseId),
            eq(auditLogs.action, 'AD_PAUSED_BUDGET_EXHAUSTED'),
          ),
        );

    it('charges the fee in the delivery of a cash order, as its own lines, taking the wallet negative', async () => {
      const s = await setup();
      const adId = await perOrderAd(s, 100);
      const order = await placed(s);
      await dispatched(s, order);

      expect((await deliver(s, order)).status).toBe(200);

      // Commission 100 (10% of 1000) and the 25 ad fee, each its own journal.
      expect(await walletOf(s.vendorId)).toMatchObject({ balance: -125, status: 'LIVE' });
      expect(await premiumLines(adId)).toEqual([
        { account: 'VENDOR_WALLET', amount: -25, orderId: order.orderId, kind: 'AD_PURCHASE' },
        { account: 'AD_REVENUE', amount: 25, orderId: order.orderId, kind: 'AD_PURCHASE' },
      ]);
      expect(await purchaseRow(adId)).toMatchObject({ amount_paid_npr: 25, status: 'ACTIVE' });
      expect(await pauses(adId)).toHaveLength(0);

      // A retried delivery answers 200 and charges nothing more.
      expect((await deliver(s, order)).status).toBe(200);
      expect(await walletOf(s.vendorId)).toMatchObject({ balance: -125 });
      expect(await premiumLines(adId)).toHaveLength(2);
    });

    it('takes the fee of a prepaid order out of what that order has just credited', async () => {
      const s = await setup();
      const adId = await perOrderAd(s, 100);
      const order = await placed(s, 'ESEWA');
      await dispatched(s, order);

      expect((await deliver(s, order)).status).toBe(200);

      // 1000 - 100 commission + 50 own delivery fee = 950, held for 7 days (step 7.3); the 25
      // ad fee is charged to the wallet now.
      expect(await walletOf(s.vendorId)).toMatchObject({ balance: -25 });
      expect((await purchaseRow(adId))?.amount_paid_npr).toBe(25);
    });

    it('charges nothing for a wrong code, an order placed before the ad, or a shop without an ad', async () => {
      const s = await setup();
      const before = await placed(s);
      await dispatched(s, before); // placed 61 s ago
      // This ad starts now: after that order was placed.
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
      const bought = await request(t.app)
        .post('/api/vendor/ads/purchases')
        .set('Authorization', bearer(s.vendorUserId, 'VENDOR'))
        .send({
          ad_product_id: product?.id,
          starts_at: new Date().toISOString(),
          budget_npr: 100,
          idempotency_key: randomUUID(),
          agreed: true,
        });
      const adId = bodyOf(adPurchaseResponseSchema, bought).purchase.id;

      const wrong = before.otp === '0000' ? '0001' : '0000';
      expect((await deliver(s, before, wrong)).status).toBe(401);
      expect(await walletOf(s.vendorId)).toMatchObject({ balance: 0 });

      expect((await deliver(s, before)).status).toBe(200);
      expect(await walletOf(s.vendorId)).toMatchObject({ balance: -100 });
      expect(await premiumLines(adId)).toEqual([]);

      const plain = await setup();
      const order = await placed(plain);
      await dispatched(plain, order);
      expect((await deliver(plain, order)).status).toBe(200);
      expect(await walletOf(plain.vendorId)).toMatchObject({ balance: -100 });
    });

    it('pauses the ad with one audit entry when the charge uses up the budget; later orders are free', async () => {
      const s = await setup();
      const adId = await perOrderAd(s, 25); // exactly one fee
      const first = await placed(s);
      const second = await placed(s);
      await dispatched(s, first);
      await dispatched(s, second);

      expect((await deliver(s, first)).status).toBe(200);

      expect(await purchaseRow(adId)).toMatchObject({ amount_paid_npr: 25, status: 'PAUSED' });
      const [entry, ...rest] = await pauses(adId);
      expect(rest).toHaveLength(0);
      expect(entry).toMatchObject({
        system_actor: 'AD_ORDER_PREMIUM',
        actor_user_id: null,
        vendor_id: s.vendorId,
      });
      expect(entry?.after_state).toMatchObject({ status: 'PAUSED', order_id: first.orderId });

      // Placed while the ad ran, delivered after it paused: delivered, and not charged.
      expect((await deliver(s, second)).status).toBe(200);
      expect(await premiumLines(adId)).toHaveLength(2);
      expect(await walletOf(s.vendorId)).toMatchObject({ balance: -225 });
      expect(await pauses(adId)).toHaveLength(1);
    });

    it('a cash order’s ad fee that crosses the debt limit suspends the shop, and the delivery stands', async () => {
      const s = await setup();
      const adId = await perOrderAd(s, 100);
      // 10 short of the limit once this order's commission (100) is taken.
      await db.transaction((tx) =>
        ledger.post(tx, {
          kind: 'ADJUSTMENT',
          idempotencyKey: `seed:${randomUUID()}`,
          orderId: null,
          postings: [
            { account: { type: 'VENDOR_WALLET', vendorId: s.vendorId }, amountPaisa: -189_000 },
            { account: { type: 'PLATFORM_REVENUE' }, amountPaisa: 189_000 },
          ],
        }),
      );
      const order = await placed(s);
      await dispatched(s, order);

      expect((await deliver(s, order)).status).toBe(200);

      expect(await walletOf(s.vendorId)).toEqual({ balance: -2015, status: 'SUSPENDED' });
      expect((await purchaseRow(adId))?.amount_paid_npr).toBe(25);
      const [delivered] = await db.select().from(orders).where(eq(orders.id, order.orderId));
      expect(delivered).toMatchObject({ state: 'DELIVERED', payment_status: 'PAID' });
    });

    it('charges each of several simultaneous deliveries once, within the budget', async () => {
      const s = await setup();
      const adId = await perOrderAd(s, 50); // two fees
      const all = [await placed(s), await placed(s), await placed(s), await placed(s)];
      for (const order of all) await dispatched(s, order);

      const answers = await Promise.all(all.map((order) => deliver(s, order)));

      expect(answers.map((res) => res.status)).toEqual([200, 200, 200, 200]);
      expect(await purchaseRow(adId)).toMatchObject({ amount_paid_npr: 50, status: 'PAUSED' });
      expect(await premiumLines(adId)).toHaveLength(4);
      expect(await pauses(adId)).toHaveLength(1);
      expect(await walletOf(s.vendorId)).toMatchObject({ balance: -450 });
      const delivered = await db
        .select({ total: sql<number>`count(*)`.mapWith(Number) })
        .from(orders)
        .where(and(eq(orders.vendor_id, s.vendorId), eq(orders.state, 'DELIVERED')));
      expect(delivered[0]?.total).toBe(4);
    });
  });
});
