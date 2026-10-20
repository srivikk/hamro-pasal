import { randomInt, randomUUID } from 'node:crypto';

import {
  adProducts,
  adPurchases,
  auditLogs,
  createDatabase,
  invoices,
  ledgerAccounts,
  ledgerEntries,
  orderItems,
  products,
  ledgerTransactions,
  orders,
  users,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import { LedgerService, SettlementService, WalletService } from '@hamro-pasal/ledger';
import {
  JOB_QUEUES,
  type FulfillmentMode,
  type PaymentMethod,
  type PricingModel,
} from '@hamro-pasal/shared-types';
import { Worker } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';

import { OrderReconciliationService } from '../src/finance/order-reconciliation';
import { buildBullConnection } from '../src/infra/redis';
import { allTimerQueues, createTimerQueues, type TimerQueues } from '../src/queues/definitions';
import { createProcessors, createTimerHandlers } from '../src/queues/processors';
import { VendorEscalationService } from '../src/sla/vendor-escalation';
import { VendorDebtReconciliationService } from '../src/wallet/vendor-debt-reconciliation';

const BCRYPT_OTP_HASH = '$2b$10$abcdefghijklmnopqrstuuM3bJ0n9ZkZ2p9Y5o0t7m6c1QwV8e2yG';

/**
 * Phase 22: the nightly ORDER_RECONCILIATION against real PostgreSQL (double-entry journals, the
 * wallet projection, the balanced-journal triggers) and real BullMQ. Settlement is the real
 * SettlementService from @hamro-pasal/ledger, the one the API's delivery handoff uses.
 */
describe('nightly order reconciliation (real PostgreSQL + BullMQ)', () => {
  const prefix = `test-${randomUUID()}`;
  const connection = buildBullConnection(process.env.TEST_REDIS_URL ?? '');
  let db: Database;
  let queues: TimerQueues;
  let ledger: LedgerService;
  let settlement: SettlementService;
  let reconciliation: OrderReconciliationService;

  beforeAll(() => {
    db = createDatabase(process.env.TEST_DATABASE_URL ?? '', { max: 10 });
    queues = createTimerQueues(connection, prefix);
    ledger = new LedgerService(new WalletService());
    settlement = new SettlementService(db, ledger);
    reconciliation = new OrderReconciliationService(db, settlement, ledger);
  });

  afterAll(async () => {
    await Promise.all(allTimerQueues(queues).map((q) => q.obliterate({ force: true })));
    await Promise.all(allTimerQueues(queues).map((q) => q.close()));
    await db.$client.end();
  });

  async function user(role: 'CUSTOMER' | 'VENDOR' | 'DRIVER'): Promise<string> {
    const phone = `+9779${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
    const [row] = await db.insert(users).values({ phone, role }).returning({ id: users.id });
    if (row === undefined) throw new Error('user not created');
    return row.id;
  }

  async function vendor(pricingModel: PricingModel = 'COMMISSION'): Promise<string> {
    const [row] = await db
      .insert(vendors)
      .values({
        user_id: await user('VENDOR'),
        business_name: 'Thamel Kirana Pasal',
        phone: '+9779800000011',
        status: 'LIVE',
        pricing_model: pricingModel,
        commission_rate: pricingModel === 'COMMISSION' ? 0.1 : 0,
        delivery_scope: 'RADIUS_BOUND',
        fulfillment_mode: 'SELF_DELIVERY',
        radius_km: 5,
        municipality_palika_string: 'Kathmandu Metropolitan City',
        min_order_value: 0,
        base_delivery_fee_npr: 50,
        location: { x: 85.3123, y: 27.7154 },
      })
      .returning({ id: vendors.id });
    if (row === undefined) throw new Error('vendor not created');
    return row.id;
  }

  interface OrderOptions {
    paymentMethod?: PaymentMethod;
    fulfillment?: FulfillmentMode;
    subtotal?: number;
    deliveryFee?: number;
    commission?: number;
    /** Capture a prepaid payment into escrow (the default); false leaves it unpaid. */
    captured?: boolean;
    delivered?: boolean;
  }

  /** An order as the delivery handoff leaves it, but with NO settlement journal. */
  async function order(vendorId: string, options: OrderOptions = {}): Promise<string> {
    const paymentMethod = options.paymentMethod ?? 'ESEWA';
    const fulfillment = options.fulfillment ?? 'SELF_DELIVERY';
    const [row] = await db
      .insert(orders)
      .values({
        idempotency_key: randomUUID(),
        customer_id: await user('CUSTOMER'),
        vendor_id: vendorId,
        subtotal: options.subtotal ?? 1000,
        delivery_fee: options.deliveryFee ?? 0,
        platform_commission_amount: options.commission ?? 100,
        fulfillment_locked: fulfillment,
        payment_method: paymentMethod,
        delivery_otp: BCRYPT_OTP_HASH,
      })
      .returning({ id: orders.id });
    if (row === undefined) throw new Error('order not created');
    if (paymentMethod !== 'COD' && options.captured !== false) {
      await settlement.capturePayment(row.id);
    }
    await db
      .update(orders)
      .set(
        options.delivered === false
          ? { state: 'PLACED', placed_at: new Date() }
          : {
              state: 'DELIVERED',
              placed_at: new Date(),
              delivered_at: new Date(),
              driver_user_id: fulfillment === 'SELF_DELIVERY' ? null : await user('DRIVER'),
            },
      )
      .where(eq(orders.id, row.id));
    return row.id;
  }

  async function walletOf(vendorId: string): Promise<number> {
    const [row] = await db
      .select({ projection: vendors.wallet_balance_npr, account: ledgerAccounts.balance_npr })
      .from(vendors)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.vendor_id, vendors.id))
      .where(eq(vendors.id, vendorId));
    if (row === undefined) throw new Error(`vendor ${vendorId} not found`);
    // The projection and the ledger account can never disagree.
    expect(row.projection).toBe(row.account);
    // Step 7.3: a prepaid order's earnings are credited to the vendor's dispute hold until day 8;
    // what settlement credited the vendor is both together.
    const [hold] = await db
      .select({ balance: ledgerAccounts.balance_npr })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.hold_vendor_id, vendorId));
    return Math.round((row.projection + (hold?.balance ?? 0)) * 100) / 100;
  }

  async function orderRow(orderId: string) {
    const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
    if (row === undefined) throw new Error(`order ${orderId} not found`);
    return row;
  }

  async function settlementJournals(orderId: string): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(ledgerTransactions)
      .where(
        and(
          eq(ledgerTransactions.order_id, orderId),
          eq(ledgerTransactions.kind, 'ORDER_SETTLEMENT'),
        ),
      );
    return row?.count ?? 0;
  }

  async function revenue(): Promise<number> {
    const [row] = await db
      .select({ balance: ledgerAccounts.balance_npr })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.account_type, 'PLATFORM_REVENUE'));
    return row?.balance ?? 0;
  }

  describe('commission and the vendor cut', () => {
    it('credits 900 NPR for a prepaid 1000 NPR order at 10% and books 100 NPR as revenue', async () => {
      const vendorId = await vendor();
      const orderId = await order(vendorId, { subtotal: 1000, commission: 100 });
      const revenueBefore = await revenue();

      const outcome = await reconciliation.reconcileOrder(orderId);

      expect(outcome).toMatchObject({
        status: 'RECONCILED',
        orderId,
        vendorId,
        vendorWalletNpr: 900,
        commissionNpr: 100,
        settlementPosted: true,
      });
      expect(await walletOf(vendorId)).toBe(900);
      expect((await revenue()) - revenueBefore).toBe(100);
      expect((await orderRow(orderId)).reconciled_at).toBeInstanceOf(Date);
      expect(await settlementJournals(orderId)).toBe(1);
    });

    it('uses the commission stored on the order, not a flat rate', async () => {
      const vendorId = await vendor();
      const orderId = await order(vendorId, { subtotal: 1000, commission: 75.5 });

      expect(await reconciliation.reconcileOrder(orderId)).toMatchObject({
        status: 'RECONCILED',
        vendorWalletNpr: 924.5,
        commissionNpr: 75.5,
      });
      expect(await walletOf(vendorId)).toBe(924.5);
    });

    it('adds the delivery fee for a shop that delivered itself, and not for a fleet order', async () => {
      const selfVendor = await vendor();
      const fleetVendor = await vendor();
      const self = await order(selfVendor, { deliveryFee: 50 });
      const fleet = await order(fleetVendor, { deliveryFee: 50, fulfillment: 'PLATFORM_FLEET' });

      expect(await reconciliation.reconcileOrder(self)).toMatchObject({ vendorWalletNpr: 950 });
      expect(await reconciliation.reconcileOrder(fleet)).toMatchObject({ vendorWalletNpr: 900 });
      expect(await walletOf(selfVendor)).toBe(950);
      expect(await walletOf(fleetVendor)).toBe(900);
    });

    it('debits only the commission for a COD order the shop delivered (it holds the cash)', async () => {
      const vendorId = await vendor();
      const orderId = await order(vendorId, {
        paymentMethod: 'COD',
        subtotal: 1000,
        commission: 100,
      });

      expect(await reconciliation.reconcileOrder(orderId)).toMatchObject({
        status: 'RECONCILED',
        vendorWalletNpr: -100,
        settlementPosted: true,
      });
      expect(await walletOf(vendorId)).toBe(-100);
      expect((await orderRow(orderId)).payment_status).toBe('PAID');
    });

    it('reconciles a 0% subscription COD order that has nothing to post', async () => {
      const vendorId = await vendor('SUBSCRIPTION');
      const orderId = await order(vendorId, { paymentMethod: 'COD', commission: 0 });

      expect(await reconciliation.reconcileOrder(orderId)).toMatchObject({
        status: 'RECONCILED',
        vendorWalletNpr: 0,
        commissionNpr: 0,
      });
      expect(await walletOf(vendorId)).toBe(0);
      expect(await settlementJournals(orderId)).toBe(0);
      expect((await orderRow(orderId)).reconciled_at).toBeInstanceOf(Date);
    });
  });

  describe('double reconciliation', () => {
    it('does not credit again an order the delivery already settled', async () => {
      const vendorId = await vendor();
      const orderId = await order(vendorId);
      await settlement.settleOrder(orderId);
      expect(await walletOf(vendorId)).toBe(900);

      expect(await reconciliation.reconcileOrder(orderId)).toMatchObject({
        status: 'RECONCILED',
        vendorWalletNpr: 900,
        settlementPosted: false,
      });
      expect(await walletOf(vendorId)).toBe(900);
      expect(await settlementJournals(orderId)).toBe(1);
    });

    it('skips an order that is already reconciled: a second run changes nothing', async () => {
      const vendorId = await vendor();
      const orderId = await order(vendorId);

      const first = await reconciliation.reconcileDeliveredOrders();
      const stampedAt = (await orderRow(orderId)).reconciled_at;
      const second = await reconciliation.reconcileDeliveredOrders();

      expect(first.reconciled.filter((o) => o.orderId === orderId)).toHaveLength(1);
      expect(second.reconciled.filter((o) => o.orderId === orderId)).toHaveLength(0);
      expect(await reconciliation.reconcileOrder(orderId)).toEqual({ status: 'SKIPPED' });
      expect(await walletOf(vendorId)).toBe(900);
      expect(await settlementJournals(orderId)).toBe(1);
      expect((await orderRow(orderId)).reconciled_at).toEqual(stampedAt);
    });

    it('lets exactly one of 6 simultaneous runs reconcile each order', async () => {
      const vendorId = await vendor();
      const orderIds = await Promise.all([1, 2, 3].map(() => order(vendorId)));

      const runs = await Promise.all(
        [1, 2, 3, 4, 5, 6].map(() => reconciliation.reconcileDeliveredOrders()),
      );

      for (const orderId of orderIds) {
        const winners = runs.flatMap((run) => run.reconciled.filter((o) => o.orderId === orderId));
        expect(winners).toHaveLength(1);
        expect(await settlementJournals(orderId)).toBe(1);
      }
      expect(
        runs.flatMap((run) => run.discrepancies.filter((d) => d.vendorId === vendorId)),
      ).toEqual([]);
      // 3 orders of 1000 NPR at 10%: 2700, not a paisa more.
      expect(await walletOf(vendorId)).toBe(2700);
    });

    it('leaves orders that are not DELIVERED alone', async () => {
      const vendorId = await vendor();
      const placed = await order(vendorId, { delivered: false });

      const run = await reconciliation.reconcileDeliveredOrders();

      expect(run.reconciled.some((o) => o.orderId === placed)).toBe(false);
      expect(await reconciliation.reconcileOrder(placed)).toEqual({ status: 'SKIPPED' });
      expect((await orderRow(placed)).reconciled_at).toBeNull();
      expect(await walletOf(vendorId)).toBe(0);
    });

    it('the database refuses reconciled_at on an order that was never delivered', async () => {
      const placed = await order(await vendor(), { delivered: false });

      await expect(
        db.update(orders).set({ reconciled_at: new Date() }).where(eq(orders.id, placed)),
      ).rejects.toMatchObject({ cause: { constraint: 'orders_reconciled_at_check' } });
    });
  });

  describe('discrepancies', () => {
    it('reports a settlement that disagrees with the order and leaves it unreconciled', async () => {
      const vendorId = await vendor();
      const orderId = await order(vendorId, { subtotal: 1000, commission: 100 });
      await settlement.settleOrder(orderId);
      // The snapshot now says the platform was owed 200: the journal credited the vendor 100 too much.
      await db
        .update(orders)
        .set({ platform_commission_amount: 200 })
        .where(eq(orders.id, orderId));

      const run = await reconciliation.reconcileDeliveredOrders();

      expect(run.reconciled.some((o) => o.orderId === orderId)).toBe(false);
      expect(run.discrepancies.filter((d) => d.orderId === orderId)).toEqual([
        expect.objectContaining({
          status: 'DISCREPANCY',
          vendorId,
          reason: 'SETTLEMENT_MISMATCH',
          expectedVendorWalletNpr: 800,
          actualVendorWalletNpr: 900,
        }),
      ]);
      expect((await orderRow(orderId)).reconciled_at).toBeNull();
      expect(await walletOf(vendorId)).toBe(900);
      expect(await settlementJournals(orderId)).toBe(1);
    });

    it('reports an order that cannot be settled, posts nothing for it and still reconciles the rest', async () => {
      const vendorId = await vendor();
      const unpaid = await order(vendorId, { captured: false });
      const good = await order(vendorId);

      const run = await reconciliation.reconcileDeliveredOrders();

      expect(run.discrepancies.filter((d) => d.orderId === unpaid)).toEqual([
        expect.objectContaining({ reason: 'SETTLEMENT_FAILED', vendorId: null }),
      ]);
      expect(run.reconciled.filter((o) => o.orderId === good)).toHaveLength(1);
      expect((await orderRow(unpaid)).reconciled_at).toBeNull();
      expect(await settlementJournals(unpaid)).toBe(0);
      expect(await walletOf(vendorId)).toBe(900);
    });
  });

  it('runs as the ORDER_RECONCILIATION midnight job through BullMQ', async () => {
    const vendorId = await vendor();
    const orderId = await order(vendorId);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const worker = new Worker(
      queues.midnight.name,
      createProcessors(
        createTimerHandlers({
          escalation: new VendorEscalationService(db),
          debtReconciliation: new VendorDebtReconciliationService(db),
          orderReconciliation: reconciliation,
        }),
      ).midnight,
      { connection, prefix },
    );
    try {
      const completed = new Promise<void>((resolve, reject) => {
        worker.on('completed', () => {
          resolve();
        });
        worker.on('failed', (_job, error) => {
          reject(error);
        });
      });
      await queues.midnight.add(JOB_QUEUES.MIDNIGHT_MAINTENANCE, { task: 'ORDER_RECONCILIATION' });
      await completed;
    } finally {
      await worker.close();
    }

    expect((await orderRow(orderId)).reconciled_at).toBeInstanceOf(Date);
    expect(await walletOf(vendorId)).toBe(900);
    expect(info.mock.calls.map(([line]) => String(line))).toContainEqual(
      expect.stringMatching(/^\[worker\] order reconciliation: \d+ order\(s\) reconciled/),
    );
    warn.mockRestore();
    info.mockRestore();
  });

  describe('the per-order ad premium of a settlement this job posts (Phase 30)', () => {
    /** A per-order ad of the shop: 25 NPR per delivered order, running since an hour ago. */
    async function perOrderAd(vendorId: string, budgetNpr: number): Promise<string> {
      const [shop] = await db
        .select({ userId: vendors.user_id })
        .from(vendors)
        .where(eq(vendors.id, vendorId));
      const phone = `+9779${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
      const [admin] = await db
        .insert(users)
        .values({ phone, role: 'SUPER_ADMIN' })
        .returning({ id: users.id });
      if (shop === undefined || admin === undefined) throw new Error('fixture not created');
      const [product] = await db
        .insert(adProducts)
        .values({
          name: `Per order ${randomUUID()}`,
          slot: 'FEED_LISTING',
          billing_model: 'PER_ORDER_PREMIUM',
          price_npr: 25,
          duration_days: 7,
          created_by_user_id: admin.id,
        })
        .returning();
      if (product === undefined) throw new Error('product not created');
      const [purchase] = await db
        .insert(adPurchases)
        .values({
          vendor_id: vendorId,
          ad_product_id: product.id,
          billing_model: 'PER_ORDER_PREMIUM',
          price_npr: 25,
          budget_npr: budgetNpr,
          settlement_model: 'PLATFORM_ESCROW',
          starts_at: new Date(Date.now() - 3_600_000),
          ends_at: new Date(Date.now() + 86_400_000),
          agreed_by_user_id: shop.userId,
          idempotency_key: randomUUID(),
        })
        .returning({ id: adPurchases.id });
      if (purchase === undefined) throw new Error('purchase not created');
      return purchase.id;
    }

    const adRow = async (id: string) =>
      (await db.select().from(adPurchases).where(eq(adPurchases.id, id)))[0];

    const premiumLines = async (purchaseId: string) =>
      (
        await db
          .select({ type: ledgerAccounts.account_type, amount: ledgerEntries.amount_npr })
          .from(ledgerEntries)
          .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.account_id))
          .where(
            and(
              eq(ledgerEntries.ad_purchase_id, purchaseId),
              eq(ledgerEntries.line_type, 'AD_ORDER_PREMIUM'),
            ),
          )
      ).sort((a, b) => a.amount - b.amount);

    it('charges the ad fee with the settlement it posts, once, as its own lines', async () => {
      const vendorId = await vendor();
      const adId = await perOrderAd(vendorId, 100);
      const orderId = await order(vendorId, { subtotal: 1000, commission: 100 });

      const outcome = await reconciliation.reconcileOrder(orderId);

      expect(outcome).toMatchObject({
        status: 'RECONCILED',
        settlementPosted: true,
        // The settlement's own posting is still what is verified: the fee is a separate journal.
        vendorWalletNpr: 900,
        adPremiumNpr: 25,
      });
      expect(await walletOf(vendorId)).toBe(875);
      expect(await premiumLines(adId)).toEqual([
        { type: 'VENDOR_WALLET', amount: -25 },
        { type: 'AD_REVENUE', amount: 25 },
      ]);
      expect(await adRow(adId)).toMatchObject({ amount_paid_npr: 25, status: 'ACTIVE' });

      // A second run finds the order reconciled and charges nothing more.
      expect(await reconciliation.reconcileOrder(orderId)).toEqual({ status: 'SKIPPED' });
      expect(await walletOf(vendorId)).toBe(875);
      expect(await premiumLines(adId)).toHaveLength(2);
    });

    it('does not charge an order the delivery had already settled', async () => {
      const vendorId = await vendor();
      const adId = await perOrderAd(vendorId, 100);
      const orderId = await order(vendorId);
      // The delivery's settlement (its own ad charge is the delivery's business, not this job's).
      await settlement.settleOrder(orderId);

      expect(await reconciliation.reconcileOrder(orderId)).toMatchObject({
        status: 'RECONCILED',
        settlementPosted: false,
        adPremiumNpr: 0,
      });
      expect(await walletOf(vendorId)).toBe(900);
      expect(await premiumLines(adId)).toEqual([]);
      expect((await adRow(adId))?.amount_paid_npr).toBe(0);
    });

    it('charges nothing when the settlement cannot be posted', async () => {
      const vendorId = await vendor();
      const adId = await perOrderAd(vendorId, 100);
      const orderId = await order(vendorId, { captured: false });

      expect(await reconciliation.reconcileOrder(orderId)).toMatchObject({
        status: 'DISCREPANCY',
        reason: 'SETTLEMENT_FAILED',
      });
      expect(await walletOf(vendorId)).toBe(0);
      expect(await premiumLines(adId)).toEqual([]);
      expect((await adRow(adId))?.amount_paid_npr).toBe(0);
    });

    it('pauses an exhausted ad with its audit entry; the next order is settled without a fee', async () => {
      const vendorId = await vendor();
      const adId = await perOrderAd(vendorId, 25); // exactly one fee
      const first = await order(vendorId);
      const second = await order(vendorId);

      expect(await reconciliation.reconcileOrder(first)).toMatchObject({ adPremiumNpr: 25 });
      expect(await reconciliation.reconcileOrder(second)).toMatchObject({
        status: 'RECONCILED',
        settlementPosted: true,
        adPremiumNpr: 0,
      });

      expect(await adRow(adId)).toMatchObject({ amount_paid_npr: 25, status: 'PAUSED' });
      expect(await walletOf(vendorId)).toBe(900 + 900 - 25);
      const pauses = await db
        .select()
        .from(auditLogs)
        .where(
          and(eq(auditLogs.entity_id, adId), eq(auditLogs.action, 'AD_PAUSED_BUDGET_EXHAUSTED')),
        );
      expect(pauses).toHaveLength(1);
      expect(pauses[0]).toMatchObject({ system_actor: 'AD_ORDER_PREMIUM', actor_user_id: null });
    });
  });

  describe('the fiscal invoice of an order this job reconciles (Phase 31)', () => {
    /**
     * A shop with a verified PAN (SPEC core 10, amended 2026-10-20: only a verified PAN is printed),
     * and a delivered 2 x 500 order of it with its item line.
     */
    async function invoiceable(options: { pan?: boolean } = {}) {
      const vendorId = await vendor();
      if (options.pan !== false) {
        const phone = `+9779${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
        const [verifier] = await db
          .insert(users)
          .values({ phone, role: 'SUPER_ADMIN' })
          .returning({ id: users.id });
        await db
          .update(vendors)
          .set({
            tax_id: '302118845',
            is_vat_registered: true,
            pan_verified_at: new Date(),
            pan_verified_by_user_id: verifier?.id ?? null,
          })
          .where(eq(vendors.id, vendorId));
      }
      const orderId = await order(vendorId, { subtotal: 1000, commission: 100, deliveryFee: 50 });
      const [product] = await db
        .insert(products)
        .values({
          vendor_id: vendorId,
          name: `Rice ${randomUUID()}`,
          price_npr: 500,
          stock_quantity: 10,
        })
        .returning({ id: products.id });
      if (product === undefined) throw new Error('product not created');
      await db.insert(orderItems).values({
        order_id: orderId,
        product_id: product.id,
        product_name: 'Basmati Rice 5kg',
        unit_price_npr: 500,
        quantity: 2,
      });
      return { vendorId, orderId };
    }

    const invoicesOf = (orderId: string) =>
      db.select().from(invoices).where(eq(invoices.order_id, orderId));

    it('issues the invoice the delivery did not, in the transaction that reconciles the order', async () => {
      const { vendorId, orderId } = await invoiceable();

      expect(await reconciliation.reconcileOrder(orderId)).toMatchObject({
        status: 'RECONCILED',
        settlementPosted: true,
        invoiceIssued: true,
      });

      const [invoice, ...rest] = await invoicesOf(orderId);
      expect(rest).toHaveLength(0);
      expect(invoice).toMatchObject({
        vendor_id: vendorId,
        bill_number: 1,
        seller_tax_id: '302118845',
        payment_method: 'ESEWA',
        subtotal_npr: 1000,
        delivery_charge_npr: 50,
        grand_total_npr: 1050,
        // 1050.00 inclusive over two lines: 884.96 + 44.25 taxable, 115.04 + 5.75 VAT.
        taxable_amount_npr: 929.21,
        vat_amount_npr: 120.79,
      });
      // A second run finds the order reconciled: no second invoice, no second number.
      expect(await reconciliation.reconcileOrder(orderId)).toEqual({ status: 'SKIPPED' });
      expect(await invoicesOf(orderId)).toHaveLength(1);
    });

    it('issues none for a shop without a PAN, and still reconciles the order', async () => {
      const { orderId } = await invoiceable({ pan: false });

      expect(await reconciliation.reconcileOrder(orderId)).toMatchObject({
        status: 'RECONCILED',
        invoiceIssued: false,
      });
      expect(await invoicesOf(orderId)).toEqual([]);
    });

    it('rolls the invoice and its number back with a settlement that does not verify', async () => {
      const { vendorId, orderId } = await invoiceable();
      // The order's stored commission no longer matches the journal a delivery posted for it.
      await settlement.settleOrder(orderId);
      await db
        .update(orders)
        .set({ platform_commission_amount: 200 })
        .where(eq(orders.id, orderId));

      expect(await reconciliation.reconcileOrder(orderId)).toMatchObject({
        status: 'DISCREPANCY',
        reason: 'SETTLEMENT_MISMATCH',
      });
      expect(await invoicesOf(orderId)).toEqual([]);
      expect(await db.select().from(invoices).where(eq(invoices.vendor_id, vendorId))).toEqual([]);
    });
  });
});
