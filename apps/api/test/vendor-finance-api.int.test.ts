import { randomUUID } from 'node:crypto';

import { ledgerAccounts, ledgerTransactions, orders, payoutRequests } from '@hamro-pasal/db';
import {
  payoutRequestResponseSchema,
  vendorFinanceLedgerResponseSchema,
  vendorWalletLedgerResponseSchema,
  type FulfillmentMode,
  type PaymentMethod,
} from '@hamro-pasal/shared-types';
import { and, eq, like } from 'drizzle-orm';
import request from 'supertest';

import {
  createOrder,
  createUser,
  createVendor,
  markDelivered,
  vendorUserIdOf,
} from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * Phase 22: the vendor's earnings and payout requests at /api/vendor/finance, through real Express,
 * PostgreSQL and the double-entry ledger. Wallets are funded and orders settled by the real
 * services; reconciliation itself (the worker's job) is covered in apps/worker.
 */
describe('vendor finance API', () => {
  let t: TestApp;

  beforeAll(() => {
    t = buildTestApp();
  });

  afterAll(async () => {
    await t.container.close();
  });

  const db = () => t.container.db;

  async function vendor() {
    const vendorId = await createVendor(db());
    return { vendorId, userId: await vendorUserIdOf(db(), vendorId) };
  }

  /** Credits the wallet through the (mock) top-up endpoint. */
  async function fund(userId: string, amountNpr: number) {
    const res = await request(t.app)
      .post('/api/vendors/wallet/top-up')
      .set('authorization', bearer(userId, 'VENDOR'))
      .send({ idempotency_key: randomUUID(), amount_npr: amountNpr });
    expect(res.status).toBe(201);
  }

  async function fundedVendor(amountNpr: number) {
    const created = await vendor();
    await fund(created.userId, amountNpr);
    return created;
  }

  const getLedger = (
    userId: string,
    role: 'VENDOR' | 'CUSTOMER' | 'DRIVER' | 'SUPER_ADMIN' = 'VENDOR',
  ) => request(t.app).get('/api/vendor/finance/ledger').set('authorization', bearer(userId, role));

  async function ledgerBody(userId: string) {
    const res = await getLedger(userId);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    return bodyOf(vendorFinanceLedgerResponseSchema, res);
  }

  const requestPayout = (
    userId: string,
    body: unknown,
    role: 'VENDOR' | 'CUSTOMER' | 'DRIVER' | 'SUPER_ADMIN' = 'VENDOR',
  ) =>
    request(t.app)
      .post('/api/vendor/finance/payout')
      .set('authorization', bearer(userId, role))
      .send(body as object);

  const payout = (userId: string, amountNpr: number, key: string = randomUUID()) =>
    requestPayout(userId, { idempotency_key: key, amount_npr: amountNpr });

  async function payoutsOf(vendorId: string) {
    return db().select().from(payoutRequests).where(eq(payoutRequests.vendor_id, vendorId));
  }

  async function holdJournals(vendorId: string): Promise<number> {
    const rows = await db()
      .select({ id: ledgerTransactions.id })
      .from(ledgerTransactions)
      .where(
        and(
          eq(ledgerTransactions.kind, 'VENDOR_PAYOUT'),
          like(ledgerTransactions.idempotency_key, `vendor-payout:${vendorId}:%`),
        ),
      );
    return rows.length;
  }

  async function clearingBalance(): Promise<number> {
    const [account] = await db()
      .select({ balance: ledgerAccounts.balance_npr })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.account_type, 'PAYOUT_CLEARING'));
    return account?.balance ?? 0;
  }

  /** A delivered and settled order, optionally stamped as the nightly reconciliation leaves it. */
  async function settledOrder(
    vendorId: string,
    options: {
      paymentMethod?: PaymentMethod;
      fulfillment?: FulfillmentMode;
      reconciledAt?: Date | null;
    } = {},
  ) {
    const paymentMethod = options.paymentMethod ?? 'ESEWA';
    const fulfillment = options.fulfillment ?? 'SELF_DELIVERY';
    const order = await createOrder(db(), {
      vendorId,
      customerId: await createUser(db()),
      paymentMethod,
      fulfillment,
    });
    if (paymentMethod !== 'COD') await t.container.settlement.capturePayment(order.id);
    await markDelivered(
      db(),
      order.id,
      fulfillment === 'SELF_DELIVERY' ? null : await createUser(db(), 'DRIVER'),
    );
    await t.container.settlement.settleOrder(order.id);
    if (options.reconciledAt !== null) {
      await db()
        .update(orders)
        .set({ reconciled_at: options.reconciledAt ?? new Date() })
        .where(eq(orders.id, order.id));
    }
    return order.id;
  }

  describe('GET /api/vendor/finance/ledger', () => {
    it('answers zeros and empty lists for a shop with no money yet', async () => {
      const { vendorId, userId } = await vendor();

      expect(await ledgerBody(userId)).toEqual({
        vendor_id: vendorId,
        available_balance_npr: 0,
        dispute_hold_npr: 0,
        pending_balance_npr: 0,
        pending_payout_npr: 0,
        unreconciled_order_count: 0,
        reconciled_orders: [],
        payouts: [],
      });
    });

    it('shows the wallet as available, escrow as pending, and each reconciled order with its cut', async () => {
      const { vendorId, userId } = await vendor();
      // Fixture orders: subtotal 1000, commission 100 (10%), delivery fee 50.
      const prepaid = await settledOrder(vendorId, {
        reconciledAt: new Date('2026-10-01T18:15:00.000Z'),
      });
      const cod = await settledOrder(vendorId, {
        paymentMethod: 'COD',
        reconciledAt: new Date('2026-10-02T18:15:00.000Z'),
      });
      const fleet = await settledOrder(vendorId, {
        fulfillment: 'PLATFORM_FLEET',
        reconciledAt: new Date('2026-10-03T18:15:00.000Z'),
      });
      await settledOrder(vendorId, { reconciledAt: null });
      // Paid, not delivered: still in escrow.
      const inEscrow = await createOrder(db(), {
        vendorId,
        customerId: await createUser(db()),
        paymentMethod: 'KHALTI',
      });
      await t.container.settlement.capturePayment(inEscrow.id);
      await db()
        .update(orders)
        .set({ state: 'PREPARING', placed_at: new Date() })
        .where(eq(orders.id, inEscrow.id));

      const body = await ledgerBody(userId);

      // Step 7.3: the delivered prepaid orders wait in the dispute hold: 950 + 900 + 950 (the
      // unreconciled one is settled too); only the cash commission (−100) is in the wallet.
      expect(body.available_balance_npr).toBe(-100);
      expect(body.dispute_hold_npr).toBe(2800);
      expect(body.pending_balance_npr).toBe(950);
      expect(body.unreconciled_order_count).toBe(1);
      expect(
        body.reconciled_orders.map((o) => [
          o.order_id,
          o.commission_npr,
          o.vendor_cut_npr,
          o.wallet_amount_npr,
        ]),
      ).toEqual([
        [fleet, 100, 900, 900],
        [cod, 100, 950, -100],
        [prepaid, 100, 950, 950],
      ]);
      expect(body.reconciled_orders[0]).toMatchObject({
        payment_method: 'ESEWA',
        fulfillment: 'PLATFORM_FLEET',
        subtotal_npr: 1000,
        delivery_fee_npr: 50,
        reconciled_at: '2026-10-03T18:15:00.000Z',
      });
    });

    it("never shows another shop's orders or payouts", async () => {
      const mine = await fundedVendor(500);
      const other = await fundedVendor(500);
      await settledOrder(other.vendorId);
      expect((await payout(other.userId, 200)).status).toBe(201);

      const body = await ledgerBody(mine.userId);

      expect(body.reconciled_orders).toEqual([]);
      expect(body.payouts).toEqual([]);
      expect(body.available_balance_npr).toBe(500);
    });

    it('is for vendors with a shop only', async () => {
      const { userId } = await vendor();
      expect((await request(t.app).get('/api/vendor/finance/ledger')).status).toBe(401);
      for (const role of ['CUSTOMER', 'DRIVER', 'SUPER_ADMIN'] as const) {
        expect((await getLedger(userId, role)).status).toBe(403);
      }
      const shopless = await getLedger(await createUser(db(), 'VENDOR'));
      expect(shopless.status).toBe(404);
      expect(errorOf(shopless).code).toBe('VENDOR_NOT_FOUND');
    });
  });

  describe('POST /api/vendor/finance/payout', () => {
    it('holds the amount: it leaves the wallet for PAYOUT_CLEARING and the request is PENDING', async () => {
      const { vendorId, userId } = await fundedVendor(1000);
      const clearingBefore = await clearingBalance();

      const res = await payout(userId, 400);

      expect(res.status).toBe(201);
      const body = bodyOf(payoutRequestResponseSchema, res);
      expect(body).toMatchObject({
        available_balance_npr: 600,
        replayed: false,
        payout: {
          amount_npr: 400,
          status: 'PENDING',
          bank_reference: null,
          rejection_reason: null,
          decided_at: null,
        },
      });
      expect((await clearingBalance()) - clearingBefore).toBe(400);
      const [row] = await payoutsOf(vendorId);
      expect(row).toMatchObject({ id: body.payout.id, status: 'PENDING', amount_npr: 400 });

      const ledger = await ledgerBody(userId);
      expect(ledger.available_balance_npr).toBe(600);
      expect(ledger.pending_payout_npr).toBe(400);
      expect(ledger.payouts).toEqual([body.payout]);

      // The hold is an ordinary posting of the wallet.
      const wallet = bodyOf(
        vendorWalletLedgerResponseSchema,
        await request(t.app)
          .get('/api/vendors/wallet/ledger')
          .set('authorization', bearer(userId, 'VENDOR')),
      );
      expect(wallet.entries[0]).toMatchObject({
        kind: 'VENDOR_PAYOUT',
        entry_type: 'PAYOUT_HOLD',
        amount_npr: -400,
        balance_after_npr: 600,
        transaction_id: row?.hold_transaction_id,
      });
    });

    it('allows exactly the whole balance and refuses one paisa more', async () => {
      const over = await fundedVendor(1000);
      const refused = await payout(over.userId, 1000.01);
      expect(refused.status).toBe(422);
      expect(errorOf(refused)).toMatchObject({
        code: 'INSUFFICIENT_BALANCE',
        details: { requested_npr: 1000.01, available_balance_npr: 1000 },
      });
      expect(await payoutsOf(over.vendorId)).toEqual([]);
      expect(await holdJournals(over.vendorId)).toBe(0);
      expect((await ledgerBody(over.userId)).available_balance_npr).toBe(1000);

      const exact = await payout(over.userId, 1000);
      expect(exact.status).toBe(201);
      expect(bodyOf(payoutRequestResponseSchema, exact).available_balance_npr).toBe(0);
    });

    it('refuses any payout from an empty wallet or one in debt', async () => {
      const empty = await vendor();
      expect(errorOf(await payout(empty.userId, 1)).code).toBe('INSUFFICIENT_BALANCE');

      const indebted = await vendor();
      await settledOrder(indebted.vendorId, { paymentMethod: 'COD', reconciledAt: null });
      const res = await payout(indebted.userId, 1);
      expect(res.status).toBe(422);
      expect(errorOf(res).details).toMatchObject({ available_balance_npr: -100 });
    });

    it('counts earlier pending payouts: the second request sees what the first left', async () => {
      const { userId } = await fundedVendor(1000);

      expect((await payout(userId, 700)).status).toBe(201);
      const second = await payout(userId, 400);

      expect(second.status).toBe(422);
      expect(errorOf(second).details).toMatchObject({ available_balance_npr: 300 });
      expect((await payout(userId, 300)).status).toBe(201);
    });

    it('lets 10 simultaneous requests of 300 take at most the 1000 NPR balance', async () => {
      const { vendorId, userId } = await fundedVendor(1000);

      const responses = await Promise.all(Array.from({ length: 10 }, () => payout(userId, 300)));

      expect(responses.filter((res) => res.status === 201)).toHaveLength(3);
      const refused = responses.filter((res) => res.status !== 201);
      expect(refused).toHaveLength(7);
      for (const res of refused) {
        expect(res.status).toBe(422);
        expect(errorOf(res).code).toBe('INSUFFICIENT_BALANCE');
      }
      expect(await payoutsOf(vendorId)).toHaveLength(3);
      expect(await holdJournals(vendorId)).toBe(3);
      const ledger = await ledgerBody(userId);
      expect(ledger.available_balance_npr).toBe(100);
      expect(ledger.pending_payout_npr).toBe(900);
    });

    it('lets one of 6 simultaneous requests for the whole balance win', async () => {
      const { vendorId, userId } = await fundedVendor(750);

      const responses = await Promise.all(Array.from({ length: 6 }, () => payout(userId, 750)));

      expect(responses.map((res) => res.status).sort()).toEqual([201, 422, 422, 422, 422, 422]);
      expect(await payoutsOf(vendorId)).toHaveLength(1);
      expect((await ledgerBody(userId)).available_balance_npr).toBe(0);
    });

    it('replays the same idempotency key without a second hold, also under concurrency', async () => {
      const { vendorId, userId } = await fundedVendor(1000);
      const key = randomUUID();

      const first = await payout(userId, 250, key);
      const again = await payout(userId, 250, key);
      const burst = await Promise.all(Array.from({ length: 5 }, () => payout(userId, 250, key)));

      expect(first.status).toBe(201);
      expect(again.status).toBe(200);
      expect(bodyOf(payoutRequestResponseSchema, again)).toMatchObject({
        replayed: true,
        available_balance_npr: 750,
        payout: bodyOf(payoutRequestResponseSchema, first).payout,
      });
      expect(burst.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
      expect(await payoutsOf(vendorId)).toHaveLength(1);
      expect(await holdJournals(vendorId)).toBe(1);
      expect((await ledgerBody(userId)).available_balance_npr).toBe(750);
    });

    it('creates one request when 5 first uses of a key arrive together', async () => {
      const { vendorId, userId } = await fundedVendor(1000);
      const key = randomUUID();

      const responses = await Promise.all(
        Array.from({ length: 5 }, () => payout(userId, 250, key)),
      );

      expect(responses.map((res) => res.status).sort()).toEqual([200, 200, 200, 200, 201]);
      expect(await payoutsOf(vendorId)).toHaveLength(1);
      expect((await ledgerBody(userId)).available_balance_npr).toBe(750);
    });

    it('refuses a key reused for another amount, and scopes keys to the vendor', async () => {
      const a = await fundedVendor(1000);
      const b = await fundedVendor(1000);
      const key = randomUUID();
      expect((await payout(a.userId, 100, key)).status).toBe(201);

      const reused = await payout(a.userId, 200, key);
      expect(reused.status).toBe(409);
      expect(errorOf(reused).code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect((await ledgerBody(a.userId)).available_balance_npr).toBe(900);

      expect((await payout(b.userId, 200, key)).status).toBe(201);
    });

    it('validates the body and stores nothing for a bad one', async () => {
      const { vendorId, userId } = await fundedVendor(1000);
      const key = randomUUID();
      const bad: unknown[] = [
        { idempotency_key: key, amount_npr: 0 },
        { idempotency_key: key, amount_npr: -50 },
        { idempotency_key: key, amount_npr: 10.005 },
        { idempotency_key: key, amount_npr: 1_000_000.01 },
        { idempotency_key: key, amount_npr: '100' },
        { idempotency_key: 'short', amount_npr: 100 },
        { amount_npr: 100 },
        { idempotency_key: key, amount_npr: 100, vendor_id: vendorId },
        { idempotency_key: key, amount_npr: 100, status: 'APPROVED' },
      ];
      for (const body of bad) {
        const res = await requestPayout(userId, body);
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
      expect(await payoutsOf(vendorId)).toEqual([]);
      expect((await ledgerBody(userId)).available_balance_npr).toBe(1000);
    });

    it('is for vendors with a shop only', async () => {
      const { userId } = await fundedVendor(1000);
      const body = { idempotency_key: randomUUID(), amount_npr: 100 };
      expect((await request(t.app).post('/api/vendor/finance/payout').send(body)).status).toBe(401);
      for (const role of ['CUSTOMER', 'DRIVER', 'SUPER_ADMIN'] as const) {
        expect((await requestPayout(userId, body, role)).status).toBe(403);
      }
      const shopless = await requestPayout(await createUser(db(), 'VENDOR'), body);
      expect(shopless.status).toBe(404);
      expect((await ledgerBody(userId)).available_balance_npr).toBe(1000);
    });
  });
});
