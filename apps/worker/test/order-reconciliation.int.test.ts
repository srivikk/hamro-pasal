import { randomInt, randomUUID } from 'node:crypto';

import {
  createDatabase,
  ledgerAccounts,
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
  let settlement: SettlementService;
  let reconciliation: OrderReconciliationService;

  beforeAll(() => {
    db = createDatabase(process.env.TEST_DATABASE_URL ?? '', { max: 10 });
    queues = createTimerQueues(connection, prefix);
    settlement = new SettlementService(db, new LedgerService(new WalletService()));
    reconciliation = new OrderReconciliationService(db, settlement);
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
    return row.projection;
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
});
