import { randomUUID } from 'node:crypto';

import { orders } from '@hamro-pasal/db';
import {
  vendorWalletBalanceResponseSchema,
  vendorWalletLedgerResponseSchema,
  walletTopUpResponseSchema,
  type FulfillmentMode,
  type OrderState,
  type PaymentMethod,
  type VendorWalletLedgerEntry,
} from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import {
  balanceOf,
  createOrder,
  createUser,
  createVendor,
  markDelivered,
  vendorUserIdOf,
  type VendorFixture,
} from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * Phase 12: the vendor's wallet (SPEC §5) at GET /api/vendors/wallet/balance and
 * GET /api/vendors/wallet/ledger. Money is moved by the real SettlementService (double-entry
 * journals, wallet projection and suspension trigger), then read back through Express.
 */
describe('vendor wallet API', () => {
  let t: TestApp;

  beforeAll(() => {
    t = buildTestApp();
  });

  afterAll(async () => {
    await t.container.close();
  });

  const db = () => t.container.db;

  async function vendor(options: VendorFixture = {}) {
    const vendorId = await createVendor(db(), options);
    return { vendorId, userId: await vendorUserIdOf(db(), vendorId) };
  }

  const getBalance = (userId: string, role: 'VENDOR' | 'CUSTOMER' = 'VENDOR') =>
    request(t.app).get('/api/vendors/wallet/balance').set('authorization', bearer(userId, role));

  const getLedger = (userId: string, query: Record<string, string> = {}) =>
    request(t.app)
      .get('/api/vendors/wallet/ledger')
      .query(query)
      .set('authorization', bearer(userId, 'VENDOR'));

  async function balanceBody(userId: string) {
    const res = await getBalance(userId);
    expect(res.status).toBe(200);
    return bodyOf(vendorWalletBalanceResponseSchema, res);
  }

  /** Delivers and settles an order through SettlementService, like the OTP handoff does. */
  async function settled(
    vendorId: string,
    options: {
      paymentMethod?: PaymentMethod;
      fulfillment?: FulfillmentMode;
      subtotal?: number;
      commission?: number;
    } = {},
  ) {
    const paymentMethod = options.paymentMethod ?? 'COD';
    const fulfillment = options.fulfillment ?? 'SELF_DELIVERY';
    const order = await createOrder(db(), {
      vendorId,
      customerId: await createUser(db()),
      paymentMethod,
      fulfillment,
      subtotal: options.subtotal ?? 1000,
      commission: options.commission ?? (options.subtotal ?? 1000) / 10,
    });
    if (paymentMethod !== 'COD') await t.container.settlement.capturePayment(order.id);
    const driver = fulfillment === 'SELF_DELIVERY' ? null : await createUser(db(), 'DRIVER');
    await markDelivered(db(), order.id, driver);
    await t.container.settlement.settleOrder(order.id);
    return order.id;
  }

  /** A prepaid order captured into escrow and left in `state` (not delivered, so not settled). */
  async function inEscrow(
    vendorId: string,
    state: OrderState,
    fulfillment: FulfillmentMode = 'SELF_DELIVERY',
    refundRequired = false,
  ) {
    const order = await createOrder(db(), {
      vendorId,
      customerId: await createUser(db()),
      paymentMethod: 'ESEWA',
      fulfillment,
    });
    await t.container.settlement.capturePayment(order.id);
    await db()
      .update(orders)
      .set({ state, placed_at: new Date(), refund_required: refundRequired })
      .where(eq(orders.id, order.id));
    return order.id;
  }

  describe('GET /api/vendors/wallet/balance', () => {
    it('starts at zero for a new LIVE vendor, with the platform limit', async () => {
      const v = await vendor();

      const res = await getBalance(v.userId);

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(bodyOf(vendorWalletBalanceResponseSchema, res)).toEqual({
        vendor_id: v.vendorId,
        status: 'LIVE',
        is_suspended: false,
        suspended_for_debt: false,
        wallet_balance_npr: 0,
        suspension_limit_npr: -2000,
        pending_escrow_npr: 0,
        pending_escrow_order_count: 0,
      });
    });

    it('shows the COD commission debit (1000 NPR at 10% → −100) and stays LIVE', async () => {
      const v = await vendor();
      await settled(v.vendorId);

      const body = await balanceBody(v.userId);

      expect(body.wallet_balance_npr).toBe(-100);
      expect(body.wallet_balance_npr).toBe(await balanceOf(db(), { vendorId: v.vendorId }));
      expect(body.is_suspended).toBe(false);
    });

    it('reports a suspended vendor (balance below −2000) and still answers them', async () => {
      const v = await vendor();
      await settled(v.vendorId, { subtotal: 25_000 }); // commission 2500

      const body = await balanceBody(v.userId);

      expect(body).toMatchObject({
        status: 'SUSPENDED',
        is_suspended: true,
        suspended_for_debt: true,
        wallet_balance_npr: -2500,
        suspension_limit_npr: -2000,
      });
    });

    it('tells an admin suspension apart from a debt suspension', async () => {
      const v = await vendor({ status: 'SUSPENDED' });

      expect(await balanceBody(v.userId)).toMatchObject({
        is_suspended: true,
        suspended_for_debt: false,
      });
    });

    it('counts only prepaid money still held in escrow for the vendor, at its future share', async () => {
      const v = await vendor();
      // Held: 1000 − 100 + 50 fee (the shop delivers) = 950, and 1000 − 100 (a rider delivers) = 900.
      await inEscrow(v.vendorId, 'PREPARING', 'SELF_DELIVERY');
      await inEscrow(v.vendorId, 'OUT_FOR_DELIVERY', 'PLATFORM_FLEET');
      // Not held for the vendor: refunded cancellation, unpaid checkout, COD, settled order.
      await inEscrow(v.vendorId, 'CANCELED', 'SELF_DELIVERY', true);
      await createOrder(db(), {
        vendorId: v.vendorId,
        customerId: await createUser(db()),
        paymentMethod: 'KHALTI',
      });
      const cod = await createOrder(db(), {
        vendorId: v.vendorId,
        customerId: await createUser(db()),
      });
      await db()
        .update(orders)
        .set({ state: 'PLACED', placed_at: new Date() })
        .where(eq(orders.id, cod.id));
      await settled(v.vendorId, { paymentMethod: 'ESEWA' });

      const body = await balanceBody(v.userId);

      expect(body.pending_escrow_npr).toBe(1850);
      expect(body.pending_escrow_order_count).toBe(2);
      // The settled prepaid order is in the wallet instead: 1000 − 100 + 50.
      expect(body.wallet_balance_npr).toBe(950);
    });
  });

  describe('GET /api/vendors/wallet/ledger', () => {
    it('lists a COD commission debit with its order breakdown and running balance', async () => {
      const v = await vendor();
      const orderId = await settled(v.vendorId);

      const res = await getLedger(v.userId);

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = bodyOf(vendorWalletLedgerResponseSchema, res);
      expect(body.next_cursor).toBeNull();
      expect(body.entries).toEqual([
        expect.objectContaining({
          kind: 'ORDER_SETTLEMENT',
          entry_type: 'COD_COMMISSION_DEBIT',
          amount_npr: -100,
          balance_after_npr: -100,
          description: 'COD / SELF_DELIVERY settlement',
          order: {
            id: orderId,
            payment_method: 'COD',
            fulfillment: 'SELF_DELIVERY',
            subtotal_npr: 1000,
            delivery_fee_npr: 50,
            commission_npr: 100,
          },
        }),
      ]);
    });

    it('labels payouts from prepaid and fleet COD settlements', async () => {
      const v = await vendor();
      await settled(v.vendorId, { paymentMethod: 'KHALTI' }); // +950
      await settled(v.vendorId, { fulfillment: 'PLATFORM_FLEET' }); // COD via rider: +900

      const { entries } = bodyOf(vendorWalletLedgerResponseSchema, await getLedger(v.userId));

      expect(entries.map((e) => [e.entry_type, e.amount_npr, e.balance_after_npr])).toEqual([
        ['ORDER_PAYOUT', 900, 1850],
        ['ORDER_PAYOUT', 950, 950],
      ]);
    });

    it('pages newest first with a cursor, without gaps or repeats, balances chaining across pages', async () => {
      const v = await vendor();
      const orderIds: string[] = [];
      for (const subtotal of [1000, 2000, 3000, 4000, 5000]) {
        orderIds.push(await settled(v.vendorId, { subtotal, commission: subtotal / 20 }));
      }

      const seen: VendorWalletLedgerEntry[] = [];
      const pageSizes: number[] = [];
      let cursor: string | null = null;
      do {
        const query: Record<string, string> = { limit: '2' };
        if (cursor !== null) query.cursor = cursor;
        const page = bodyOf(vendorWalletLedgerResponseSchema, await getLedger(v.userId, query));
        pageSizes.push(page.entries.length);
        seen.push(...page.entries);
        cursor = page.next_cursor;
      } while (cursor !== null);

      expect(pageSizes).toEqual([2, 2, 1]);
      expect(seen.map((e) => e.order?.id)).toEqual([...orderIds].reverse());
      expect(new Set(seen.map((e) => e.id)).size).toBe(5);
      // Commissions 50 … 250 → −750 in total; the newest entry's balance is the wallet's.
      expect(seen[0]?.balance_after_npr).toBe(-750);
      expect(seen[0]?.balance_after_npr).toBe(await balanceOf(db(), { vendorId: v.vendorId }));
      for (let i = 0; i + 1 < seen.length; i += 1) {
        const [newer, older] = [seen[i], seen[i + 1]];
        expect((newer?.balance_after_npr ?? 0) - (newer?.amount_npr ?? 0)).toBeCloseTo(
          older?.balance_after_npr ?? NaN,
        );
      }
      expect(seen.at(-1)?.balance_after_npr).toBe(-50);
    });

    it('is empty for a vendor with no postings and never shows another vendor’s', async () => {
      const quiet = await vendor();
      const busy = await vendor();
      await settled(busy.vendorId);

      const body = bodyOf(vendorWalletLedgerResponseSchema, await getLedger(quiet.userId));

      expect(body).toEqual({ entries: [], next_cursor: null });
    });

    it('refuses another vendor’s entry as a cursor (400 INVALID_CURSOR)', async () => {
      const mine = await vendor();
      const theirs = await vendor();
      await settled(mine.vendorId);
      await settled(theirs.vendorId);
      const [theirEntry] = bodyOf(
        vendorWalletLedgerResponseSchema,
        await getLedger(theirs.userId),
      ).entries;

      const res = await getLedger(mine.userId, { cursor: theirEntry?.id ?? '' });

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('INVALID_CURSOR');
      const unknown = await getLedger(mine.userId, { cursor: randomUUID() });
      expect(errorOf(unknown).code).toBe('INVALID_CURSOR');
    });

    it('validates the page size and cursor format', async () => {
      const v = await vendor();
      for (const query of [{ limit: '0' }, { limit: '51' }, { limit: 'x' }, { cursor: 'nope' }]) {
        const res = await getLedger(v.userId, query);
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
    });
  });

  describe('access', () => {
    it('requires a vendor token', async () => {
      const customerId = await createUser(db());
      expect((await getBalance(customerId, 'CUSTOMER')).status).toBe(403);
      expect((await request(t.app).get('/api/vendors/wallet/ledger')).status).toBe(401);
      const driverId = await createUser(db(), 'DRIVER');
      const asDriver = await request(t.app)
        .get('/api/vendors/wallet/ledger')
        .set('authorization', bearer(driverId, 'DRIVER'));
      expect(asDriver.status).toBe(403);
    });

    it('answers 404 VENDOR_NOT_FOUND to a vendor account without a shop', async () => {
      const shopless = await createUser(db(), 'VENDOR');
      const balance = await getBalance(shopless);
      const ledger = await getLedger(shopless);
      expect([balance.status, ledger.status]).toEqual([404, 404]);
      expect(errorOf(balance).code).toBe('VENDOR_NOT_FOUND');
    });
  });

  describe('POST /api/vendors/wallet/top-up (Phase 12.5, MOCK mode)', () => {
    const topUp = (userId: string, body: Record<string, unknown>, app = t.app) =>
      request(app)
        .post('/api/vendors/wallet/top-up')
        .set('authorization', bearer(userId, 'VENDOR'))
        .send(body);

    async function suspendedVendor() {
      const v = await vendor();
      await settled(v.vendorId, { subtotal: 25_000 }); // −2500, SUSPENDED
      expect((await balanceBody(v.userId)).is_suspended).toBe(true);
      return v;
    }

    it('pays off the debt: credits the wallet, restores the shop and lists the top-up', async () => {
      const v = await suspendedVendor();
      const clearingBefore = (await balanceOf(db(), 'GATEWAY_CLEARING:ESEWA')) ?? 0;

      const res = await topUp(v.userId, { idempotency_key: randomUUID(), amount_npr: 2500 });

      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = bodyOf(walletTopUpResponseSchema, res);
      expect(body).toMatchObject({
        amount_npr: 2500,
        wallet_balance_npr: 0,
        status: 'LIVE',
        is_suspended: false,
        restored: true,
        replayed: false,
      });
      expect(await balanceBody(v.userId)).toMatchObject({ status: 'LIVE', is_suspended: false });
      // Balanced journal: the (mock) eSewa clearing account is the other side.
      expect(((await balanceOf(db(), 'GATEWAY_CLEARING:ESEWA')) ?? 0) - clearingBefore).toBe(-2500);
      const [latest] = bodyOf(vendorWalletLedgerResponseSchema, await getLedger(v.userId)).entries;
      expect(latest).toMatchObject({
        transaction_id: body.transaction_id,
        kind: 'VENDOR_TOP_UP',
        entry_type: 'TOP_UP',
        amount_npr: 2500,
        balance_after_npr: 0,
        order: null,
      });
    });

    it('keeps the shop offline after a partial payment', async () => {
      const v = await suspendedVendor();

      const res = await topUp(v.userId, { idempotency_key: randomUUID(), amount_npr: 1000 });

      expect(bodyOf(walletTopUpResponseSchema, res)).toMatchObject({
        wallet_balance_npr: -1500,
        status: 'SUSPENDED',
        is_suspended: true,
        restored: false,
      });
      // Above the −2000 limit, but still suspended for debt until the balance is cleared.
      expect(await balanceBody(v.userId)).toMatchObject({ suspended_for_debt: true });
    });

    it('credits a healthy wallet without changing the status', async () => {
      const v = await vendor();

      const res = await topUp(v.userId, { idempotency_key: randomUUID(), amount_npr: 12.5 });

      expect(bodyOf(walletTopUpResponseSchema, res)).toMatchObject({
        wallet_balance_npr: 12.5,
        status: 'LIVE',
        restored: false,
      });
    });

    it('credits once per idempotency key, and refuses the key for another amount', async () => {
      const v = await suspendedVendor();
      const key = randomUUID();

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          topUp(v.userId, { idempotency_key: key, amount_npr: 2500 }),
        ),
      );

      expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
      const bodies = results.map((r) => bodyOf(walletTopUpResponseSchema, r));
      expect(new Set(bodies.map((b) => b.transaction_id)).size).toBe(1);
      expect(bodies.filter((b) => b.replayed)).toHaveLength(4);
      expect(await balanceOf(db(), { vendorId: v.vendorId })).toBe(0);

      const reused = await topUp(v.userId, { idempotency_key: key, amount_npr: 100 });
      expect(reused.status).toBe(409);
      expect(errorOf(reused).code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await balanceOf(db(), { vendorId: v.vendorId })).toBe(0);
    });

    it('scopes keys to the vendor: another vendor may use the same key', async () => {
      const [a, b] = [await vendor(), await vendor()];
      const key = randomUUID();

      expect((await topUp(a.userId, { idempotency_key: key, amount_npr: 10 })).status).toBe(201);
      expect((await topUp(b.userId, { idempotency_key: key, amount_npr: 20 })).status).toBe(201);
      expect(await balanceOf(db(), { vendorId: b.vendorId })).toBe(20);
    });

    it('validates the amount and the key', async () => {
      const v = await vendor();
      for (const body of [
        { idempotency_key: randomUUID(), amount_npr: 0 },
        { idempotency_key: randomUUID(), amount_npr: -50 },
        { idempotency_key: randomUUID(), amount_npr: 100_000.01 },
        { idempotency_key: randomUUID(), amount_npr: 10.005 },
        { idempotency_key: randomUUID(), amount_npr: '100' },
        { amount_npr: 100 },
      ]) {
        const res = await topUp(v.userId, body);
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
      expect(await balanceOf(db(), { vendorId: v.vendorId })).toBe(0);
    });

    it('requires a vendor with a shop', async () => {
      const customerId = await createUser(db());
      const asCustomer = await request(t.app)
        .post('/api/vendors/wallet/top-up')
        .set('authorization', bearer(customerId))
        .send({ idempotency_key: randomUUID(), amount_npr: 10 });
      expect(asCustomer.status).toBe(403);
      const shopless = await topUp(await createUser(db(), 'VENDOR'), {
        idempotency_key: randomUUID(),
        amount_npr: 10,
      });
      expect(errorOf(shopless).code).toBe('VENDOR_NOT_FOUND');
    });

    it('answers 503 TOP_UP_UNAVAILABLE and credits nothing when top-ups are disabled', async () => {
      const disabled = buildTestApp({ walletTopUpMode: 'DISABLED' });
      try {
        const v = await suspendedVendor();

        const res = await topUp(
          v.userId,
          { idempotency_key: randomUUID(), amount_npr: 2500 },
          disabled.app,
        );

        expect(res.status).toBe(503);
        expect(errorOf(res).code).toBe('TOP_UP_UNAVAILABLE');
        expect(await balanceBody(v.userId)).toMatchObject({
          wallet_balance_npr: -2500,
          is_suspended: true,
        });
      } finally {
        await disabled.container.close();
      }
    });
  });
});
