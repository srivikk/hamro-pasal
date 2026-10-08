import { randomUUID } from 'node:crypto';

import {
  adProducts,
  adPurchases,
  auditLogs,
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  orders,
  vendorBankAccounts,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import {
  adminAdProductListResponseSchema,
  adminPromotionResponseSchema,
  adminSettlementListResponseSchema,
  adPurchaseCancelResponseSchema,
  adPurchaseListResponseSchema,
  adPurchaseResponseSchema,
  settlementPayoutResponseSchema,
  vendorAdProductListResponseSchema,
  vendorWalletLedgerResponseSchema,
  type AdBillingModel,
  type AdSlot,
  type AuditAction,
  type SettlementModel,
} from '@hamro-pasal/shared-types';
import { and, asc, eq, sql } from 'drizzle-orm';
import request from 'supertest';

import { LedgerService } from '../src/ledger/ledger-service';
import { WalletService } from '../src/wallet/wallet-service';
import { createOrder, createUser, createVendor, vendorUserIdOf } from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

const DAY_MS = 86_400_000;

/**
 * Phase 28: the Ad Marketplace as a shop uses it and the sponsorship it unlocks (SPEC core 8,
 * verifications 7 and 8), over HTTP on real PostgreSQL.
 */
describe('vendor ad purchases API', () => {
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

  const call = (
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    token: string | null,
    body?: unknown,
  ) => {
    const req = request(t.app)[method](path);
    const authed = token === null ? req : req.set('Authorization', token);
    return body === undefined ? authed : authed.send(body as object);
  };

  const entries = (entityId: string, action: AuditAction) =>
    db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entity_id, entityId), eq(auditLogs.action, action)))
      .orderBy(asc(auditLogs.occurred_at));

  const credit = (vendorId: string, amountNpr: number) =>
    db.transaction((tx) =>
      ledger.post(tx, {
        kind: 'ADJUSTMENT',
        idempotencyKey: `seed:${vendorId}:${randomUUID()}`,
        orderId: null,
        postings: [
          {
            account: { type: 'VENDOR_WALLET', vendorId },
            amountPaisa: Math.round(amountNpr * 100),
          },
          { account: { type: 'PLATFORM_REVENUE' }, amountPaisa: -Math.round(amountNpr * 100) },
        ],
      }),
    );

  /** A prepaid, paid, placed order: 950 NPR the platform holds in escrow for the shop. */
  async function escrowOrder(vendorId: string) {
    const order = await createOrder(db, {
      vendorId,
      customerId: await createUser(db),
      paymentMethod: 'ESEWA',
    });
    await db
      .update(orders)
      .set({ state: 'PLACED', placed_at: sql`now()`, payment_status: 'PAID' })
      .where(eq(orders.id, order.id));
  }

  async function shop(
    options: { model?: SettlementModel; balance?: number; escrowOrders?: number } = {},
  ) {
    const vendorId = await createVendor(db);
    const userId = await vendorUserIdOf(db, vendorId);
    if (options.model !== undefined) {
      await db
        .update(vendors)
        .set({ settlement_model: options.model })
        .where(eq(vendors.id, vendorId));
    }
    if (options.balance !== undefined && options.balance !== 0) {
      await credit(vendorId, options.balance);
    }
    for (let i = 0; i < (options.escrowOrders ?? 0); i += 1) await escrowOrder(vendorId);
    return { vendorId, userId, token: bearer(userId, 'VENDOR') };
  }

  async function product(
    priceNpr: number,
    options: { billing?: AdBillingModel; slot?: AdSlot; days?: number; onSale?: boolean } = {},
  ) {
    const [row] = await db
      .insert(adProducts)
      .values({
        name: `Ad ${randomUUID()}`,
        slot: options.slot ?? 'CAROUSEL',
        billing_model: options.billing ?? 'FLAT_RATE',
        price_npr: priceNpr,
        duration_days: options.days ?? 7,
        is_active: options.onSale ?? true,
        created_by_user_id: adminId,
      })
      .returning();
    if (row === undefined) throw new Error('no product');
    return row;
  }

  const body = (productId: string, overrides: Record<string, unknown> = {}) => ({
    ad_product_id: productId,
    starts_at: new Date().toISOString(),
    idempotency_key: randomUUID(),
    agreed: true,
    ...overrides,
  });

  const buy = (token: string | null, payload: unknown) =>
    call('post', '/api/vendor/ads/purchases', token, payload);

  const walletOf = async (vendorId: string) =>
    (
      await db
        .select({ balance: vendors.wallet_balance_npr })
        .from(vendors)
        .where(eq(vendors.id, vendorId))
    )[0]?.balance;

  const purchaseRow = async (purchaseId: string) =>
    (await db.select().from(adPurchases).where(eq(adPurchases.id, purchaseId)))[0];

  /** The postings that name the purchase, with their account type, by amount. */
  const linesOf = (purchaseId: string) =>
    db
      .select({
        account: ledgerAccounts.account_type,
        amount: ledgerEntries.amount_npr,
        line: ledgerEntries.line_type,
        kind: ledgerTransactions.kind,
      })
      .from(ledgerEntries)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.account_id))
      .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transaction_id))
      .where(eq(ledgerEntries.ad_purchase_id, purchaseId))
      .orderBy(asc(ledgerEntries.created_at), asc(ledgerEntries.amount_npr));

  const purchasesOf = (vendorId: string) =>
    db.select().from(adPurchases).where(eq(adPurchases.vendor_id, vendorId));

  describe('GET /api/vendor/ads/products', () => {
    it('lists what is on sale with what a Model B shop holds: balance + pending escrow', async () => {
      const { token } = await shop({ balance: 1000, escrowOrders: 1 });
      const onSale = await product(5000);
      const retired = await product(800, { onSale: false });

      const res = await call('get', '/api/vendor/ads/products', token);

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const market = bodyOf(vendorAdProductListResponseSchema, res);
      expect(market.settlement_model).toBe('PLATFORM_ESCROW');
      expect(market.available_for_ads_npr).toBe(1950);
      expect(market.products.find((p) => p.id === onSale.id)).toMatchObject({
        price_npr: 5000,
        duration_days: 7,
        collection: 'PAYOUT_DEDUCTION',
        recharge_required_npr: 0,
      });
      expect(market.products.some((p) => p.id === retired.id)).toBe(false);
    });

    it('offers a Model A shop its balance only, and says what it must recharge', async () => {
      const { token } = await shop({ model: 'COD_CREDIT', balance: 500, escrowOrders: 1 });
      const cheap = await product(400);
      const dear = await product(650);

      const market = bodyOf(
        vendorAdProductListResponseSchema,
        await call('get', '/api/vendor/ads/products', token),
      );

      expect(market.settlement_model).toBe('COD_CREDIT');
      expect(market.available_for_ads_npr).toBe(500);
      expect(market.products.find((p) => p.id === cheap.id)).toMatchObject({
        collection: 'LEDGER_BALANCE',
        recharge_required_npr: 0,
      });
      expect(market.products.find((p) => p.id === dear.id)?.recharge_required_npr).toBe(150);
    });
  });

  describe('POST /api/vendor/ads/purchases, Model B (PLATFORM_ESCROW)', () => {
    it('sells a flat-rate ad for exactly what the platform holds, and collects what the wallet covers', async () => {
      const { vendorId, userId, token } = await shop({ balance: 1000, escrowOrders: 1 });
      const ad = await product(1950);

      const res = await buy(token, body(ad.id));

      expect(res.status).toBe(201);
      const { purchase, available_for_ads_npr, replayed } = bodyOf(adPurchaseResponseSchema, res);
      expect(replayed).toBe(false);
      expect(purchase).toMatchObject({
        ad_product_id: ad.id,
        product_name: ad.name,
        slot: 'CAROUSEL',
        billing_model: 'FLAT_RATE',
        price_npr: 1950,
        budget_npr: null,
        settlement_model: 'PLATFORM_ESCROW',
        status: 'ACTIVE',
        amount_paid_npr: 1000,
        amount_due_npr: 950,
      });
      expect(Date.parse(purchase.ends_at) - Date.parse(purchase.starts_at)).toBe(7 * DAY_MS);
      expect(available_for_ads_npr).toBe(0);
      expect(await walletOf(vendorId)).toBe(0);

      // Its own line type and its own revenue account, never commission (SPEC verification 7).
      expect(await linesOf(purchase.id)).toEqual([
        { account: 'VENDOR_WALLET', amount: -1000, line: 'AD_FLAT_FEE', kind: 'AD_PURCHASE' },
        { account: 'AD_REVENUE', amount: 1000, line: 'AD_FLAT_FEE', kind: 'AD_PURCHASE' },
      ]);

      const [entry, ...rest] = await entries(purchase.id, 'AD_PURCHASED');
      expect(rest).toHaveLength(0);
      expect(entry).toMatchObject({
        actor_user_id: userId,
        actor_role: 'VENDOR',
        vendor_id: vendorId,
        entity_type: 'ad_purchase',
        before_state: null,
      });
      expect(entry?.after_state).toMatchObject({ price_npr: 1950, amount_paid_npr: 1000 });

      const row = await purchaseRow(purchase.id);
      expect(row?.agreed_by_user_id).toBe(userId);

      const wallet = bodyOf(
        vendorWalletLedgerResponseSchema,
        await call('get', '/api/vendors/wallet/ledger', token),
      );
      expect(wallet.entries[0]).toMatchObject({ entry_type: 'AD_CHARGE', amount_npr: -1000 });
    });

    it('refuses a flat-rate ad one paisa above balance + pending escrow, and stores nothing', async () => {
      const { vendorId, token } = await shop({ balance: 1000, escrowOrders: 1 });
      const ad = await product(1950.01);

      const res = await buy(token, body(ad.id));

      expect(res.status).toBe(422);
      expect(errorOf(res)).toMatchObject({
        code: 'AD_EXCEEDS_PENDING_PAYOUT',
        details: {
          ad_price_npr: 1950.01,
          balance_npr: 1000,
          pending_escrow_npr: 950,
          ad_fees_due_npr: 0,
        },
      });
      expect(await purchasesOf(vendorId)).toHaveLength(0);
      expect(await walletOf(vendorId)).toBe(1000);
    });

    it('counts a fee still due against the next purchase', async () => {
      const { token } = await shop({ escrowOrders: 2 }); // holds 1900, wallet 0
      const first = await product(1000);
      const second = await product(1000);

      expect((await buy(token, body(first.id))).status).toBe(201);
      const res = await buy(token, body(second.id));

      expect(res.status).toBe(422);
      expect(errorOf(res)).toMatchObject({
        code: 'AD_EXCEEDS_PENDING_PAYOUT',
        details: { balance_npr: 0, pending_escrow_npr: 1900, ad_fees_due_npr: 1000 },
      });
    });

    it('lets simultaneous purchases spend the same money only once', async () => {
      const { vendorId, token } = await shop({ balance: 500, escrowOrders: 1 }); // holds 1450
      const ad = await product(1000);

      const results = await Promise.all(Array.from({ length: 6 }, () => buy(token, body(ad.id))));

      expect(results.map((res) => res.status).sort()).toEqual([201, 422, 422, 422, 422, 422]);
      expect(await purchasesOf(vendorId)).toHaveLength(1);
      expect(await walletOf(vendorId)).toBe(0);
    });

    it('answers a retried key with the purchase it made, and refuses the key for another one', async () => {
      const { vendorId, token } = await shop({ balance: 3000 });
      const ad = await product(1000);
      const other = await product(1000);
      const payload = body(ad.id);

      const first = await buy(token, payload);
      const again = await Promise.all([buy(token, payload), buy(token, payload)]);

      expect(first.status).toBe(201);
      for (const res of again) {
        expect(res.status).toBe(200);
        const replay = bodyOf(adPurchaseResponseSchema, res);
        expect(replay.replayed).toBe(true);
        expect(replay.purchase.id).toBe(bodyOf(adPurchaseResponseSchema, first).purchase.id);
      }
      expect(await purchasesOf(vendorId)).toHaveLength(1);
      expect(await walletOf(vendorId)).toBe(2000);

      const reused = await buy(token, { ...payload, ad_product_id: other.id });
      expect(reused.status).toBe(409);
      expect(errorOf(reused).code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('takes a per-order ad without holding anything, whatever the shop holds', async () => {
      const { vendorId, token } = await shop();
      const ad = await product(25, { billing: 'PER_ORDER_PREMIUM', slot: 'FEED_LISTING' });

      const res = await buy(token, body(ad.id, { budget_npr: 500 }));

      expect(res.status).toBe(201);
      const { purchase } = bodyOf(adPurchaseResponseSchema, res);
      expect(purchase).toMatchObject({
        billing_model: 'PER_ORDER_PREMIUM',
        budget_npr: 500,
        amount_paid_npr: 0,
        amount_due_npr: 0,
      });
      expect(await linesOf(purchase.id)).toEqual([]);
      expect(await walletOf(vendorId)).toBe(0);
    });

    it('takes the fee still due out of the wallet before a payout, and pays out the rest', async () => {
      const { vendorId, token } = await shop({ balance: 1000, escrowOrders: 1 });
      const ad = await product(1950);
      const { purchase } = bodyOf(adPurchaseResponseSchema, await buy(token, body(ad.id)));
      // The escrowed order settles and more: the wallet now holds 2000, of which 950 is the ad's.
      await credit(vendorId, 2000);
      await db
        .update(vendors)
        .set({ tax_id: '302118845', pan_verified_at: new Date(), pan_verified_by_user_id: adminId })
        .where(eq(vendors.id, vendorId));
      await db.insert(vendorBankAccounts).values({
        vendor_id: vendorId,
        bank_name: 'Nabil Bank',
        branch_name: 'Thamel',
        account_name: 'Test Pasal',
        account_number: '0123456789',
        is_primary: true,
      });

      const listed = bodyOf(
        adminSettlementListResponseSchema,
        await call('get', '/api/admin/finance/settlements', admin),
      ).vendors.find((row) => row.vendor_id === vendorId);
      expect(listed?.available_for_payout_npr).toBe(1050);

      const pay = (amount: number) =>
        call('post', `/api/admin/finance/settlements/${vendorId}/payout`, admin, {
          amount_npr: amount,
          bank_reference: 'NIC-778812',
          idempotency_key: randomUUID(),
        });
      const tooMuch = await pay(1050.01);
      expect(tooMuch.status).toBe(422);
      expect(errorOf(tooMuch)).toMatchObject({
        code: 'INSUFFICIENT_BALANCE',
        details: { available_balance_npr: 1050 },
      });
      // The refused payout rolled its collection back with it.
      expect((await purchaseRow(purchase.id))?.amount_paid_npr).toBe(1000);

      const paid = await pay(1050);
      expect(paid.status).toBe(201);
      expect(bodyOf(settlementPayoutResponseSchema, paid).vendor.available_for_payout_npr).toBe(0);
      expect(await walletOf(vendorId)).toBe(0);
      expect((await purchaseRow(purchase.id))?.amount_paid_npr).toBe(1950);
      const revenue = (await linesOf(purchase.id)).filter((line) => line.account === 'AD_REVENUE');
      expect(revenue.map((line) => line.amount)).toEqual([1000, 950]);
    });
  });

  describe('POST /api/vendor/ads/purchases, Model A (COD_CREDIT)', () => {
    it('never sells an ad on credit: the balance must cover the flat price', async () => {
      const { vendorId, token } = await shop({
        model: 'COD_CREDIT',
        balance: 500,
        escrowOrders: 1,
      });
      const ad = await product(600);

      const short = await buy(token, body(ad.id));
      expect(short.status).toBe(422);
      expect(errorOf(short)).toMatchObject({
        code: 'LEDGER_RECHARGE_REQUIRED',
        details: { recharge_required_npr: 100 },
      });
      expect(await purchasesOf(vendorId)).toHaveLength(0);

      await credit(vendorId, 100);
      const res = await buy(token, body(ad.id));

      expect(res.status).toBe(201);
      const { purchase } = bodyOf(adPurchaseResponseSchema, res);
      expect(purchase).toMatchObject({
        settlement_model: 'COD_CREDIT',
        amount_paid_npr: 600,
        amount_due_npr: 0,
      });
      expect(await walletOf(vendorId)).toBe(0);
      expect(await linesOf(purchase.id)).toEqual([
        { account: 'VENDOR_WALLET', amount: -600, line: 'AD_FLAT_FEE', kind: 'AD_PURCHASE' },
        { account: 'AD_REVENUE', amount: 600, line: 'AD_FLAT_FEE', kind: 'AD_PURCHASE' },
      ]);
    });

    it('holds the whole budget of a per-order ad, and releases it when the ad is cancelled', async () => {
      const { vendorId, userId, token } = await shop({ model: 'COD_CREDIT', balance: 400 });
      const ad = await product(25, { billing: 'PER_ORDER_PREMIUM', slot: 'FEED_LISTING' });

      const short = await buy(token, body(ad.id, { budget_npr: 400.01 }));
      expect(errorOf(short).code).toBe('LEDGER_RECHARGE_REQUIRED');

      const res = await buy(token, body(ad.id, { budget_npr: 300 }));
      expect(res.status).toBe(201);
      const { purchase } = bodyOf(adPurchaseResponseSchema, res);
      expect(await walletOf(vendorId)).toBe(100);
      expect(await linesOf(purchase.id)).toEqual([
        { account: 'VENDOR_WALLET', amount: -300, line: 'AD_BUDGET_HOLD', kind: 'AD_PURCHASE' },
        { account: 'AD_BUDGET_CLEARING', amount: 300, line: 'AD_BUDGET_HOLD', kind: 'AD_PURCHASE' },
      ]);

      const cancel = () => call('post', `/api/vendor/ads/purchases/${purchase.id}/cancel`, token);
      const cancelled = await cancel();
      expect(cancelled.status).toBe(200);
      const result = bodyOf(adPurchaseCancelResponseSchema, cancelled);
      expect(result.purchase.status).toBe('CANCELLED');
      expect(result.available_for_ads_npr).toBe(400);
      expect(await walletOf(vendorId)).toBe(400);

      // A repeat answers the same and releases nothing more.
      expect((await cancel()).status).toBe(200);
      expect(await walletOf(vendorId)).toBe(400);
      const [entry, ...rest] = await entries(purchase.id, 'AD_CANCELLED');
      expect(rest).toHaveLength(0);
      expect(entry).toMatchObject({ actor_user_id: userId, vendor_id: vendorId });
      expect(entry?.after_state).toMatchObject({ status: 'CANCELLED', returned_npr: 300 });
    });
  });

  describe('POST /api/vendor/ads/purchases, what is refused', () => {
    it('needs a budget for a per-order ad and takes none for a flat-rate one', async () => {
      const { token } = await shop({ balance: 5000 });
      const flat = await product(1000);
      const perOrder = await product(25, { billing: 'PER_ORDER_PREMIUM' });

      for (const payload of [
        body(flat.id, { budget_npr: 500 }),
        body(perOrder.id),
        body(perOrder.id, { budget_npr: 24.99 }),
      ]) {
        const res = await buy(token, payload);
        expect(res.status).toBe(422);
        expect(errorOf(res).code).toBe('AD_BUDGET_INVALID');
      }
    });

    it('refuses a body without the agreement, with a vendor or with a price', async () => {
      const { vendorId, token } = await shop({ balance: 5000 });
      const ad = await product(1000);

      for (const payload of [
        body(ad.id, { agreed: false }),
        {
          ad_product_id: ad.id,
          starts_at: new Date().toISOString(),
          idempotency_key: randomUUID(),
        },
        body(ad.id, { vendor_id: vendorId }),
        body(ad.id, { price_npr: 1 }),
        body(ad.id, { idempotency_key: 'short' }),
        body(ad.id, { starts_at: 'tomorrow' }),
      ]) {
        const res = await buy(token, payload);
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
      expect(await purchasesOf(vendorId)).toHaveLength(0);
    });

    it('refuses a start in the past or more than 90 days ahead, and a product off sale', async () => {
      const { token } = await shop({ balance: 5000 });
      const ad = await product(1000);
      const retired = await product(1000, { onSale: false });

      for (const offset of [-DAY_MS, 91 * DAY_MS]) {
        const res = await buy(
          token,
          body(ad.id, { starts_at: new Date(Date.now() + offset).toISOString() }),
        );
        expect(res.status).toBe(422);
        expect(errorOf(res).code).toBe('AD_START_OUT_OF_RANGE');
      }
      for (const id of [retired.id, randomUUID()]) {
        const res = await buy(token, body(id));
        expect(res.status).toBe(404);
        expect(errorOf(res).code).toBe('AD_PRODUCT_NOT_FOUND');
      }
    });

    it('is refused by the database when a ledger line charges an ad without a purchase', async () => {
      const { vendorId } = await shop();
      const [wallet] = await db
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(eq(ledgerAccounts.vendor_id, vendorId));

      await expect(
        db.transaction(async (tx) => {
          const [journal] = await tx
            .insert(ledgerTransactions)
            .values({ kind: 'AD_PURCHASE', idempotency_key: `rogue:${randomUUID()}` })
            .returning();
          await tx.insert(ledgerEntries).values({
            transaction_id: journal?.id ?? '',
            account_id: wallet?.id ?? '',
            amount_npr: -100,
            line_type: 'AD_FLAT_FEE',
          });
        }),
      ).rejects.toMatchObject({
        cause: { constraint: 'ledger_entries_ad_line_purchase_check' },
      });
    });
  });

  describe('GET /api/vendor/ads/purchases and cancelling', () => {
    it('lists only the shop’s own purchases, newest first', async () => {
      const mine = await shop({ balance: 5000 });
      const theirs = await shop({ balance: 5000 });
      const ad = await product(1000);
      const first = bodyOf(adPurchaseResponseSchema, await buy(mine.token, body(ad.id)));
      const second = bodyOf(adPurchaseResponseSchema, await buy(mine.token, body(ad.id)));
      await buy(theirs.token, body(ad.id));

      const res = await call('get', '/api/vendor/ads/purchases', mine.token);

      expect(res.status).toBe(200);
      expect(bodyOf(adPurchaseListResponseSchema, res).purchases.map((p) => p.id)).toEqual([
        second.purchase.id,
        first.purchase.id,
      ]);
    });

    it('returns the fee of a flat-rate ad cancelled before it starts, once', async () => {
      const { vendorId, token } = await shop({ balance: 1000, escrowOrders: 1 });
      const ad = await product(1500);
      const startsAt = new Date(Date.now() + 2 * DAY_MS).toISOString();
      const { purchase } = bodyOf(
        adPurchaseResponseSchema,
        await buy(token, body(ad.id, { starts_at: startsAt })),
      );
      expect(purchase).toMatchObject({ amount_paid_npr: 1000, amount_due_npr: 500 });

      const cancel = () => call('post', `/api/vendor/ads/purchases/${purchase.id}/cancel`, token);
      const results = await Promise.all([cancel(), cancel(), cancel()]);

      for (const res of results) expect(res.status).toBe(200);
      expect(bodyOf(adPurchaseCancelResponseSchema, results[0]).purchase).toMatchObject({
        status: 'CANCELLED',
        amount_paid_npr: 0,
        amount_due_npr: 0,
      });
      expect(await walletOf(vendorId)).toBe(1000);
      expect(await entries(purchase.id, 'AD_CANCELLED')).toHaveLength(1);
      expect((await linesOf(purchase.id)).filter((line) => line.kind === 'AD_REFUND')).toEqual([
        { account: 'AD_REVENUE', amount: -1000, line: 'AD_FLAT_FEE', kind: 'AD_REFUND' },
        { account: 'VENDOR_WALLET', amount: 1000, line: 'AD_FLAT_FEE', kind: 'AD_REFUND' },
      ]);
      // Nothing is owed any more: the money is the shop's to spend again.
      const market = bodyOf(
        vendorAdProductListResponseSchema,
        await call('get', '/api/vendor/ads/products', token),
      );
      expect(market.available_for_ads_npr).toBe(1950);
    });

    it('does not cancel a flat-rate ad whose period has started', async () => {
      const { vendorId, token } = await shop({ balance: 2000 });
      const ad = await product(1500);
      const { purchase } = bodyOf(adPurchaseResponseSchema, await buy(token, body(ad.id)));

      const res = await call('post', `/api/vendor/ads/purchases/${purchase.id}/cancel`, token);

      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'AD_PURCHASE_NOT_CANCELLABLE',
        details: { reason: 'STARTED' },
      });
      expect((await purchaseRow(purchase.id))?.status).toBe('ACTIVE');
      expect(await walletOf(vendorId)).toBe(500);
    });

    it('hides another shop’s purchase and an unknown one', async () => {
      const owner = await shop({ balance: 2000 });
      const other = await shop();
      const ad = await product(1000);
      const { purchase } = bodyOf(adPurchaseResponseSchema, await buy(owner.token, body(ad.id)));

      for (const id of [purchase.id, randomUUID()]) {
        const res = await call('post', `/api/vendor/ads/purchases/${id}/cancel`, other.token);
        expect(res.status).toBe(404);
        expect(errorOf(res).code).toBe('AD_PURCHASE_NOT_FOUND');
      }
      expect((await purchaseRow(purchase.id))?.status).toBe('ACTIVE');
    });
  });

  describe('sponsored promotions', () => {
    const promotion = (overrides: Record<string, unknown>) => ({
      placement: 'CAROUSEL',
      image_url: 'https://cdn.hamropasal.test/promotions/ad.webp',
      title: null,
      subtitle: null,
      target_type: 'SHOP',
      display_order: 0,
      is_active: true,
      starts_at: null,
      is_sponsored: true,
      ...overrides,
    });

    async function bought(slot: AdSlot = 'CAROUSEL') {
      const owner = await shop({ balance: 5000 });
      const ad = await product(1000, { slot });
      const { purchase } = bodyOf(adPurchaseResponseSchema, await buy(owner.token, body(ad.id)));
      return { ...owner, ad, purchase };
    }

    it('makes a promotion an ad through the purchase of the shop it targets', async () => {
      const { vendorId, ad, purchase } = await bought();

      const res = await call(
        'post',
        '/api/admin/promotions',
        admin,
        promotion({
          target_value: vendorId,
          ends_at: purchase.ends_at,
          ad_purchase_id: purchase.id,
        }),
      );

      expect(res.status).toBe(201);
      expect(bodyOf(adminPromotionResponseSchema, res).promotion).toMatchObject({
        is_sponsored: true,
        ad_purchase_id: purchase.id,
        target_value: vendorId,
      });
      const listed = bodyOf(
        adminAdProductListResponseSchema,
        await call('get', '/api/admin/ads/products', admin),
      ).products.find((p) => p.id === ad.id);
      expect(listed?.active_purchase_count).toBe(1);
    });

    it('refuses a purchase that cannot carry the promotion, saying why', async () => {
      const { vendorId, token, purchase } = await bought();
      const feed = await bought('FEED_LISTING');
      const stranger = await shop();
      const sponsored = {
        target_value: vendorId,
        ends_at: purchase.ends_at,
        ad_purchase_id: purchase.id,
      };
      const afterEnd = new Date(Date.parse(purchase.ends_at) + 1000).toISOString();

      const cases: [string, Record<string, unknown>][] = [
        ['NOT_FOUND', { ...sponsored, ad_purchase_id: randomUUID() }],
        ['SHOP', { ...sponsored, target_value: stranger.vendorId }],
        ['SLOT', { ...sponsored, placement: 'FEATURED', title: 'Dashain' }],
        [
          'SLOT',
          {
            target_value: feed.vendorId,
            ends_at: feed.purchase.ends_at,
            ad_purchase_id: feed.purchase.id,
          },
        ],
        ['DATES', { ...sponsored, ends_at: null }],
        ['DATES', { ...sponsored, ends_at: afterEnd }],
        ['DATES', { ...sponsored, starts_at: new Date(Date.now() - DAY_MS).toISOString() }],
      ];
      for (const [reason, overrides] of cases) {
        const res = await call('post', '/api/admin/promotions', admin, promotion(overrides));
        expect({ reason, status: res.status }).toEqual({ reason, status: 422 });
        expect(errorOf(res)).toMatchObject({ code: 'AD_PURCHASE_MISMATCH', details: { reason } });
      }

      // Once the vendor has withdrawn the ad, nothing can be sponsored by it.
      await db
        .update(adPurchases)
        .set({
          starts_at: new Date(Date.now() + DAY_MS),
          ends_at: new Date(Date.now() + 8 * DAY_MS),
        })
        .where(eq(adPurchases.id, purchase.id));
      expect(
        (await call('post', `/api/vendor/ads/purchases/${purchase.id}/cancel`, token)).status,
      ).toBe(200);
      const res = await call(
        'post',
        '/api/admin/promotions',
        admin,
        promotion({
          ...sponsored,
          starts_at: new Date(Date.now() + 2 * DAY_MS).toISOString(),
          ends_at: new Date(Date.now() + 3 * DAY_MS).toISOString(),
        }),
      );
      expect(errorOf(res)).toMatchObject({
        code: 'AD_PURCHASE_MISMATCH',
        details: { reason: 'NOT_RUNNING' },
      });
    });
  });

  it('is for vendors only: 401 without a token, 403 for every other role', async () => {
    const customer = bearer(await createUser(db), 'CUSTOMER');
    const routes = [
      (as: string | null) => call('get', '/api/vendor/ads/products', as),
      (as: string | null) => call('get', '/api/vendor/ads/purchases', as),
      (as: string | null) => buy(as, body(randomUUID())),
      (as: string | null) => call('post', `/api/vendor/ads/purchases/${randomUUID()}/cancel`, as),
    ];
    for (const route of routes) {
      expect((await route(null)).status).toBe(401);
      expect((await route(customer)).status).toBe(403);
      expect((await route(admin)).status).toBe(403);
    }
  });

  it('has no route that buys an ad for a shop on an admin’s word', async () => {
    const { vendorId } = await shop({ balance: 5000 });
    const ad = await product(1000);
    for (const path of [
      '/api/admin/ads/purchases',
      `/api/admin/vendors/${vendorId}/ads/purchases`,
    ]) {
      expect((await call('post', path, admin, body(ad.id, { vendor_id: vendorId }))).status).toBe(
        404,
      );
    }
    expect(await purchasesOf(vendorId)).toHaveLength(0);
  });
});
