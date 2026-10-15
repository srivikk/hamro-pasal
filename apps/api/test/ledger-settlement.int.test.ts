import { orders, vendors, type Database } from '@hamro-pasal/db';
import { ledgerMutatedPayloadSchema } from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';

import { LedgerService } from '../src/ledger/ledger-service';
import { WalletService } from '../src/wallet/wallet-service';
import { SettlementNotAllowedError, SettlementService } from '../src/ledger/settlement-service';
import {
  balanceOf,
  createOrder,
  createUser,
  createVendor,
  markDelivered,
  outboxFor,
  testDatabase,
  type BalanceKey,
} from './support/fixtures';

/** SPEC §5 escrow + settlement through the double-entry ledger (real PostgreSQL). */
describe('double-entry settlement', () => {
  let db: Database;
  let ledger: LedgerService;
  let settlement: SettlementService;
  let customerId: string;

  beforeAll(async () => {
    db = testDatabase();
    ledger = new LedgerService(new WalletService());
    settlement = new SettlementService(db, ledger);
    customerId = await createUser(db);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  /** Balance deltas of system accounts across `action` (tests share one database). */
  async function deltas(keys: BalanceKey[], action: () => Promise<unknown>) {
    const before = await Promise.all(keys.map((k) => balanceOf(db, k)));
    await action();
    const after = await Promise.all(keys.map((k) => balanceOf(db, k)));
    return Object.fromEntries(
      keys.map((k, i) => [k, Math.round(((after[i] ?? 0) - (before[i] ?? 0)) * 100) / 100]),
    );
  }

  async function vendorStatus(vendorId: string) {
    const [vendor] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
    return { status: vendor?.status, wallet: vendor?.wallet_balance_npr };
  }

  /** Puts a vendor's wallet at `amount` via a balanced ADJUSTMENT against platform revenue. */
  async function seedVendorWallet(vendorId: string, amount: number) {
    await db.transaction((tx) =>
      ledger.post(tx, {
        kind: 'ADJUSTMENT',
        idempotencyKey: `seed:${vendorId}`,
        orderId: null,
        postings: [
          { account: { type: 'VENDOR_WALLET', vendorId }, amountPaisa: Math.round(amount * 100) },
          { account: { type: 'PLATFORM_REVENUE' }, amountPaisa: -Math.round(amount * 100) },
        ],
      }),
    );
  }

  describe('payment capture', () => {
    it('lands the full prepaid amount in SYSTEM_ESCROW and marks the order PAID', async () => {
      const vendorId = await createVendor(db);
      const order = await createOrder(db, { vendorId, customerId, paymentMethod: 'ESEWA' });

      const moved = await deltas(['GATEWAY_CLEARING:ESEWA', 'SYSTEM_ESCROW'], () =>
        settlement.capturePayment(order.id),
      );

      expect(moved).toEqual({ 'GATEWAY_CLEARING:ESEWA': -1050, SYSTEM_ESCROW: 1050 });
      const [reloaded] = await db.select().from(orders).where(eq(orders.id, order.id));
      expect(reloaded?.payment_status).toBe('PAID');
      const [event] = await outboxFor(db, order.id);
      expect(event?.event_type).toBe('ledger.mutated');
      expect(ledgerMutatedPayloadSchema.parse(event?.payload)).toMatchObject({
        kind: 'PAYMENT_CAPTURE',
        order_id: order.id,
      });
    });

    it('treats a duplicate capture (webhook replay) as a no-op', async () => {
      const vendorId = await createVendor(db);
      const order = await createOrder(db, { vendorId, customerId, paymentMethod: 'KHALTI' });
      const first = await settlement.capturePayment(order.id);

      let second;
      const moved = await deltas(['SYSTEM_ESCROW'], async () => {
        second = await settlement.capturePayment(order.id);
      });

      expect(first.status).toBe('posted');
      expect(second).toEqual({ status: 'duplicate', transactionId: first.transactionId });
      expect(moved).toEqual({ SYSTEM_ESCROW: 0 });
    });
  });

  describe('settlement after DELIVERED', () => {
    it('refuses to settle before DELIVERED and while DISPUTED', async () => {
      const vendorId = await createVendor(db);
      const order = await createOrder(db, { vendorId, customerId, paymentMethod: 'ESEWA' });
      await settlement.capturePayment(order.id);

      await expect(settlement.settleOrder(order.id)).rejects.toBeInstanceOf(
        SettlementNotAllowedError,
      );
      await db
        .update(orders)
        .set({ state: 'DISPUTED', placed_at: new Date() })
        .where(eq(orders.id, order.id));
      await expect(settlement.settleOrder(order.id)).rejects.toThrow(
        'cannot settle in state DISPUTED',
      );
    });

    it('splits prepaid self-delivery escrow into the vendor dispute hold and platform revenue', async () => {
      const vendorId = await createVendor(db);
      const order = await createOrder(db, { vendorId, customerId, paymentMethod: 'ESEWA' });
      await settlement.capturePayment(order.id);
      await markDelivered(db, order.id);

      const moved = await deltas(['SYSTEM_ESCROW', 'PLATFORM_REVENUE'], () =>
        settlement.settleOrder(order.id),
      );

      expect(moved).toEqual({ SYSTEM_ESCROW: -1050, PLATFORM_REVENUE: 100 });
      // Step 7.3: a delivered prepaid order is credited to the dispute hold for 7 days.
      expect(await balanceOf(db, { holdVendorId: vendorId })).toBe(950);
      expect(await balanceOf(db, { vendorId })).toBe(0);
      const events = await outboxFor(db, order.id);
      const settled = events
        .map((e) => ledgerMutatedPayloadSchema.parse(e.payload))
        .find((p) => p.kind === 'ORDER_SETTLEMENT');
      expect(settled?.entries.reduce((t, e) => t + Math.round(e.amount_npr * 100), 0)).toBe(0);
    });

    it('pays the delivery fee into a lazily-opened DRIVER_WALLET on fleet orders', async () => {
      const vendorId = await createVendor(db);
      const driverId = await createUser(db, 'DRIVER');
      const order = await createOrder(db, {
        vendorId,
        customerId,
        paymentMethod: 'KHALTI',
        fulfillment: 'PLATFORM_FLEET',
      });
      await settlement.capturePayment(order.id);
      await markDelivered(db, order.id, driverId);

      await settlement.settleOrder(order.id);

      expect(await balanceOf(db, { holdVendorId: vendorId })).toBe(900);
      expect(await balanceOf(db, { driverUserId: driverId })).toBe(50);
    });

    it('refuses to settle a prepaid order whose payment was never captured', async () => {
      const vendorId = await createVendor(db);
      const order = await createOrder(db, { vendorId, customerId, paymentMethod: 'ESEWA' });
      await markDelivered(db, order.id);

      await expect(settlement.settleOrder(order.id)).rejects.toThrow('never captured');
    });

    it('settles exactly once under concurrent attempts (SELECT ... FOR UPDATE + idempotency key)', async () => {
      const vendorId = await createVendor(db);
      const order = await createOrder(db, { vendorId, customerId, paymentMethod: 'ESEWA' });
      await settlement.capturePayment(order.id);
      await markDelivered(db, order.id);

      const results = await Promise.all(
        Array.from({ length: 10 }, () => settlement.settleOrder(order.id)),
      );

      expect(results.filter((r) => r.status === 'posted')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'duplicate')).toHaveLength(9);
      expect(await balanceOf(db, { holdVendorId: vendorId })).toBe(950);
    });
  });

  describe('COD debit logic (SPEC §5)', () => {
    it('debits the commission from the vendor wallet on COD self-delivery', async () => {
      const vendorId = await createVendor(db, { commissionRate: 0.1 });
      const order = await createOrder(db, {
        vendorId,
        customerId,
        subtotal: 1000,
        commission: 100,
      });
      await markDelivered(db, order.id);

      const moved = await deltas(['PLATFORM_REVENUE'], () => settlement.settleOrder(order.id));

      expect(moved).toEqual({ PLATFORM_REVENUE: 100 });
      expect(await vendorStatus(vendorId)).toEqual({ status: 'LIVE', wallet: -100 });
      const [reloaded] = await db.select().from(orders).where(eq(orders.id, order.id));
      expect(reloaded?.payment_status).toBe('PAID');
    });

    it('suspends the vendor when the COD debit breaches -2000 NPR, keeping the debit', async () => {
      const vendorId = await createVendor(db);
      await seedVendorWallet(vendorId, -1950);
      const order = await createOrder(db, { vendorId, customerId, commission: 100 });
      await markDelivered(db, order.id);

      await settlement.settleOrder(order.id);

      expect(await vendorStatus(vendorId)).toEqual({ status: 'SUSPENDED', wallet: -2050 });
      expect(await balanceOf(db, { vendorId })).toBe(-2050);
    });

    it('books COD fleet cash as the rider’s negative float', async () => {
      const vendorId = await createVendor(db);
      const driverId = await createUser(db, 'DRIVER');
      const order = await createOrder(db, { vendorId, customerId, fulfillment: 'EMERGENCY_FLEET' });
      await markDelivered(db, order.id, driverId);

      await settlement.settleOrder(order.id);

      expect(await balanceOf(db, { driverUserId: driverId })).toBe(-1000);
      expect(await balanceOf(db, { vendorId })).toBe(900);
    });

    it('posts nothing for a 0% subscription vendor on COD self-delivery', async () => {
      const vendorId = await createVendor(db, { pricingModel: 'SUBSCRIPTION' });
      const order = await createOrder(db, { vendorId, customerId, commission: 0 });
      await markDelivered(db, order.id);

      await expect(settlement.settleOrder(order.id)).resolves.toEqual({
        status: 'nothing_to_post',
      });
      expect(await balanceOf(db, { vendorId })).toBe(0);
    });

    it('rejects paying a non-driver as a rider', async () => {
      const vendorId = await createVendor(db);
      const notADriver = await createUser(db, 'CUSTOMER');
      const order = await createOrder(db, { vendorId, customerId, fulfillment: 'PLATFORM_FLEET' });
      await markDelivered(db, order.id, notADriver);

      await expect(settlement.settleOrder(order.id)).rejects.toThrow('is not a DRIVER');
    });
  });
});
