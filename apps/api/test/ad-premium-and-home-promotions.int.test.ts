import { randomUUID } from 'node:crypto';

import {
  adProducts,
  adPurchases,
  auditLogs,
  categories,
  ledgerAccounts,
  ledgerEntries,
  orders,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import { chargePerOrderAdPremium } from '@hamro-pasal/ledger';
import {
  adminPromotionResponseSchema,
  adPurchaseResponseSchema,
  homePromotionsResponseSchema,
  type AdSlot,
  type SettlementModel,
} from '@hamro-pasal/shared-types';
import { and, asc, eq, sql } from 'drizzle-orm';
import request from 'supertest';

import { LedgerService } from '../src/ledger/ledger-service';
import { WalletService } from '../src/wallet/wallet-service';
import {
  createCategory,
  createOrder,
  createUser,
  createVendor,
  vendorUserIdOf,
} from './support/fixtures';
import { bearer, bodyOf, buildTestApp, type TestApp } from './support/http';

const DAY_MS = 86_400_000;

/**
 * Phase 28, part 3 on real PostgreSQL: the per-order ad premium (SPEC core 8, edge case 8,
 * verification 7) and the public Home promotions read with its stale target guard (§8Z.4).
 */
describe('per-order ad premium and public Home promotions', () => {
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

  async function shop(model: SettlementModel = 'PLATFORM_ESCROW', balanceNpr = 0) {
    const vendorId = await createVendor(db);
    await db.update(vendors).set({ settlement_model: model }).where(eq(vendors.id, vendorId));
    if (balanceNpr > 0) {
      await db.transaction((tx) =>
        ledger.post(tx, {
          kind: 'ADJUSTMENT',
          idempotencyKey: `seed:${randomUUID()}`,
          orderId: null,
          postings: [
            { account: { type: 'VENDOR_WALLET', vendorId }, amountPaisa: balanceNpr * 100 },
            { account: { type: 'PLATFORM_REVENUE' }, amountPaisa: -balanceNpr * 100 },
          ],
        }),
      );
    }
    return { vendorId, token: bearer(await vendorUserIdOf(db, vendorId), 'VENDOR') };
  }

  /**
   * A per-order ad bought through the API: 25 per order, already running. It starts a minute ago
   * because "running" is decided on the database clock, which may be behind this process's.
   */
  async function perOrderAd(token: string, budgetNpr: number, slot: AdSlot = 'FEED_LISTING') {
    const [product] = await db
      .insert(adProducts)
      .values({
        name: `Per order ${randomUUID()}`,
        slot,
        billing_model: 'PER_ORDER_PREMIUM',
        price_npr: 25,
        duration_days: 7,
        created_by_user_id: adminId,
      })
      .returning();
    const res = await request(t.app)
      .post('/api/vendor/ads/purchases')
      .set('Authorization', token)
      .send({
        ad_product_id: product?.id,
        starts_at: new Date(Date.now() - 60_000).toISOString(),
        budget_npr: budgetNpr,
        idempotency_key: randomUUID(),
        agreed: true,
      });
    expect(res.status).toBe(201);
    return bodyOf(adPurchaseResponseSchema, res).purchase;
  }

  /** An order of the shop, placed now unless another time is given. */
  async function placedOrder(vendorId: string, placed = sql`now()`) {
    const order = await createOrder(db, { vendorId, customerId: await createUser(db) });
    await db
      .update(orders)
      .set({ state: 'PLACED', placed_at: placed })
      .where(eq(orders.id, order.id));
    return order.id;
  }

  const charge = (orderId: string, vendorId: string) =>
    db.transaction((tx) => chargePerOrderAdPremium(tx, ledger, orderId, vendorId));

  const purchaseRow = async (id: string) =>
    (await db.select().from(adPurchases).where(eq(adPurchases.id, id)))[0];
  const walletOf = async (vendorId: string) =>
    (
      await db
        .select({ balance: vendors.wallet_balance_npr })
        .from(vendors)
        .where(eq(vendors.id, vendorId))
    )[0]?.balance;
  const premiumLines = (purchaseId: string) =>
    db
      .select({ account: ledgerAccounts.account_type, amount: ledgerEntries.amount_npr })
      .from(ledgerEntries)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.account_id))
      .where(
        and(
          eq(ledgerEntries.ad_purchase_id, purchaseId),
          eq(ledgerEntries.line_type, 'AD_ORDER_PREMIUM'),
        ),
      )
      .orderBy(asc(ledgerEntries.created_at), asc(ledgerEntries.amount_npr));
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

  describe('chargePerOrderAdPremium', () => {
    it('charges one fee per order as its own line, once, and pauses the ad when the budget runs out', async () => {
      const { vendorId, token } = await shop('PLATFORM_ESCROW', 100);
      const ad = await perOrderAd(token, 60);
      const first = await placedOrder(vendorId);
      const second = await placedOrder(vendorId);
      const third = await placedOrder(vendorId);

      expect(await charge(first, vendorId)).toEqual({
        status: 'CHARGED',
        purchaseId: ad.id,
        amountNpr: 25,
        paused: false,
      });
      // A retried delivery charges nothing more.
      expect(await charge(first, vendorId)).toEqual({
        status: 'ALREADY_CHARGED',
        purchaseId: ad.id,
      });
      expect(await walletOf(vendorId)).toBe(75);
      expect(await purchaseRow(ad.id)).toMatchObject({ amount_paid_npr: 25, status: 'ACTIVE' });

      // 60 − 50 = 10 is under one fee: the second charge pauses the ad.
      expect(await charge(second, vendorId)).toMatchObject({ status: 'CHARGED', paused: true });
      expect(await purchaseRow(ad.id)).toMatchObject({ amount_paid_npr: 50, status: 'PAUSED' });
      expect(await walletOf(vendorId)).toBe(50);
      const [entry, ...rest] = await pauses(ad.id);
      expect(rest).toHaveLength(0);
      expect(entry).toMatchObject({ system_actor: 'AD_ORDER_PREMIUM', actor_user_id: null });

      // A paused ad charges no further order.
      expect(await charge(third, vendorId)).toEqual({ status: 'NONE' });
      expect(await premiumLines(ad.id)).toEqual([
        { account: 'VENDOR_WALLET', amount: -25 },
        { account: 'AD_REVENUE', amount: 25 },
        { account: 'VENDOR_WALLET', amount: -25 },
        { account: 'AD_REVENUE', amount: 25 },
      ]);
    });

    it('draws a ledger-funded shop’s fee from the budget it held, not from its wallet', async () => {
      const { vendorId, token } = await shop('COD_CREDIT', 100);
      const ad = await perOrderAd(token, 100);
      expect(await walletOf(vendorId)).toBe(0);

      expect(await charge(await placedOrder(vendorId), vendorId)).toMatchObject({
        status: 'CHARGED',
        paused: false,
      });

      expect(await walletOf(vendorId)).toBe(0);
      expect(await premiumLines(ad.id)).toEqual([
        { account: 'AD_BUDGET_CLEARING', amount: -25 },
        { account: 'AD_REVENUE', amount: 25 },
      ]);
      // Cancelling returns only what was not drawn.
      await request(t.app)
        .post(`/api/vendor/ads/purchases/${ad.id}/cancel`)
        .set('Authorization', token)
        .expect(200);
      expect(await walletOf(vendorId)).toBe(75);
    });

    it('charges nothing for an order placed outside the ad’s period, or for another shop’s order', async () => {
      const { vendorId, token } = await shop('PLATFORM_ESCROW', 100);
      const other = await shop('PLATFORM_ESCROW', 100);
      const ad = await perOrderAd(token, 100);
      const before = await placedOrder(vendorId, sql`now() - interval '1 hour'`);
      const theirs = await placedOrder(other.vendorId);

      expect(await charge(before, vendorId)).toEqual({ status: 'NONE' });
      expect(await charge(theirs, vendorId)).toEqual({ status: 'NONE' });
      expect(await charge(theirs, other.vendorId)).toEqual({ status: 'NONE' });
      expect(await charge(randomUUID(), vendorId)).toEqual({ status: 'NONE' });
      expect(await premiumLines(ad.id)).toEqual([]);
      expect(await walletOf(vendorId)).toBe(100);
    });

    it('never charges past the budget when orders are delivered at the same moment', async () => {
      const { vendorId, token } = await shop('PLATFORM_ESCROW', 500);
      const ad = await perOrderAd(token, 50);
      const orderIds = await Promise.all(Array.from({ length: 6 }, () => placedOrder(vendorId)));

      const outcomes = await Promise.all(orderIds.map((id) => charge(id, vendorId)));

      expect(outcomes.filter((outcome) => outcome.status === 'CHARGED')).toHaveLength(2);
      expect(await purchaseRow(ad.id)).toMatchObject({ amount_paid_npr: 50, status: 'PAUSED' });
      expect(await walletOf(vendorId)).toBe(450);
      expect(await pauses(ad.id)).toHaveLength(1);
    });

    it('pauses instead of charging when the budget does not hold one fee', async () => {
      const { vendorId, token } = await shop('PLATFORM_ESCROW', 100);
      const ad = await perOrderAd(token, 40);
      // As if fees had been drawn elsewhere: 40 − 20 leaves less than one fee.
      await db.update(adPurchases).set({ amount_paid_npr: 20 }).where(eq(adPurchases.id, ad.id));

      expect(await charge(await placedOrder(vendorId), vendorId)).toEqual({
        status: 'PAUSED_UNCHARGED',
        purchaseId: ad.id,
      });
      expect(await purchaseRow(ad.id)).toMatchObject({ amount_paid_npr: 20, status: 'PAUSED' });
      expect(await walletOf(vendorId)).toBe(100);
      expect(await premiumLines(ad.id)).toEqual([]);
    });
  });

  describe('GET /api/home/promotions', () => {
    const body = (overrides: Record<string, unknown>) => ({
      placement: 'CAROUSEL',
      image_url: 'https://cdn.hamropasal.test/promotions/a.webp',
      title: null,
      subtitle: null,
      target_type: null,
      target_value: null,
      display_order: 50_000,
      is_active: true,
      starts_at: null,
      ends_at: null,
      is_sponsored: false,
      ad_purchase_id: null,
      ...overrides,
    });
    async function saved(overrides: Record<string, unknown> = {}) {
      const res = await request(t.app)
        .post('/api/admin/promotions')
        .set('Authorization', admin)
        .send(body(overrides));
      expect(res.status).toBe(201);
      return bodyOf(adminPromotionResponseSchema, res).promotion.id;
    }
    const home = async () => {
      const res = await request(t.app).get('/api/home/promotions');
      expect(res.status).toBe(200);
      return { res, promotions: bodyOf(homePromotionsResponseSchema, res) };
    };
    const at = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString();

    it('serves, without a token, what is switched on and inside its dates, grouped and in order', async () => {
      const later = await saved({ display_order: 50_002 });
      const sooner = await saved({ display_order: 50_001, starts_at: at(-1), ends_at: at(1) });
      const tile = await saved({ placement: 'FEATURED', image_url: null, title: '10% OFF' });
      const hidden = await saved({ is_active: false });
      const over = await saved({ starts_at: at(-2), ends_at: at(-1) });
      const notYet = await saved({ starts_at: at(1), ends_at: at(2) });

      const { res, promotions } = await home();

      expect(res.headers['cache-control']).toBe('public, max-age=60');
      const mine = new Set([later, sooner, tile, hidden, over, notYet]);
      expect(promotions.banners.filter((p) => mine.has(p.id)).map((p) => p.id)).toEqual([
        sooner,
        later,
      ]);
      expect(promotions.offers.filter((p) => mine.has(p.id))).toEqual([
        {
          id: tile,
          placement: 'FEATURED',
          image_url: null,
          title: '10% OFF',
          subtitle: null,
          target_type: null,
          target_value: null,
          is_sponsored: false,
        },
      ]);
    });

    it('drops a promotion whose shop or category went stale after it was saved', async () => {
      const { vendorId } = await shop();
      const categoryId = await createCategory(db);
      const [category] = await db
        .select({ slug: categories.slug })
        .from(categories)
        .where(eq(categories.id, categoryId));
      const toShop = await saved({ target_type: 'SHOP', target_value: vendorId });
      const toCategory = await saved({ target_type: 'CATEGORY', target_value: category?.slug });
      const toTag = await saved({ target_type: 'DISCOUNT_TAG', target_value: '10% OFF' });
      const listed = async () => {
        const ids = new Set((await home()).promotions.banners.map((p) => p.id));
        return [toShop, toCategory, toTag].filter((id) => ids.has(id));
      };
      expect(await listed()).toEqual([toShop, toCategory, toTag]);

      await db.update(vendors).set({ status: 'APPROVED' }).where(eq(vendors.id, vendorId));
      expect(await listed()).toEqual([toCategory, toTag]);

      await db.update(categories).set({ is_active: false }).where(eq(categories.id, categoryId));
      expect(await listed()).toEqual([toTag]);

      // Nothing was deleted: both return with their targets.
      await db.update(vendors).set({ status: 'LIVE' }).where(eq(vendors.id, vendorId));
      await db.update(categories).set({ is_active: true }).where(eq(categories.id, categoryId));
      expect(await listed()).toEqual([toShop, toCategory, toTag]);
    });

    it('shows a sponsored banner as an ad, and drops it once the vendor cancels the purchase', async () => {
      const { vendorId, token } = await shop();
      const ad = await perOrderAd(token, 100, 'CAROUSEL');
      const sponsored = await saved({
        target_type: 'SHOP',
        target_value: vendorId,
        ends_at: ad.ends_at,
        is_sponsored: true,
        ad_purchase_id: ad.id,
      });
      const find = async () =>
        (await home()).promotions.banners.find((promotion) => promotion.id === sponsored);
      expect(await find()).toMatchObject({ is_sponsored: true, target_value: vendorId });

      await request(t.app)
        .post(`/api/vendor/ads/purchases/${ad.id}/cancel`)
        .set('Authorization', token)
        .expect(200);

      expect(await find()).toBeUndefined();
    });
  });
});
