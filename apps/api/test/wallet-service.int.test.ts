import { randomUUID } from 'node:crypto';

import { outboxEvents, platformSettings, vendors, type Database } from '@hamro-pasal/db';
import {
  vendorRestoredPayloadSchema,
  vendorSuspendedForDebtPayloadSchema,
  type VendorStatus,
} from '@hamro-pasal/shared-types';
import { and, eq } from 'drizzle-orm';

import { LedgerService } from '../src/ledger/ledger-service';
import { settleDisputeHold } from '../src/ledger/ledger-service';
import { SettlementService } from '../src/ledger/settlement-service';
import { WalletService } from '../src/wallet/wallet-service';
import {
  createOrder,
  createUser,
  createVendor,
  markDelivered,
  testDatabase,
} from './support/fixtures';

/**
 * Phase 12.5: SPEC §5 applied by WalletService inside every journal that moves a vendor wallet
 * (real PostgreSQL: postings, wallet projection, the kept safety-net trigger, outbox). Events go to
 * the outbox in the journal's transaction; the worker's OutboxRelay publishes them to Kafka
 * (topic notifications.broadcast).
 */
describe('WalletService: debt suspension and restoration', () => {
  let db: Database;
  let ledger: LedgerService;
  let settlement: SettlementService;

  beforeAll(() => {
    db = testDatabase();
    ledger = new LedgerService(new WalletService());
    settlement = new SettlementService(db, ledger);
  });

  afterEach(async () => {
    await setLimit(-2000);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  async function setLimit(limitNpr: number) {
    await db
      .update(platformSettings)
      .set({ vendor_wallet_suspension_limit_npr: limitNpr })
      .where(eq(platformSettings.id, true));
  }

  async function vendorRow(vendorId: string) {
    const [row] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
    if (row === undefined) throw new Error('vendor not found');
    return row;
  }

  async function events(vendorId: string, type: 'vendor.suspended_for_debt' | 'vendor.restored') {
    const rows = await db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.aggregate_id, vendorId), eq(outboxEvents.event_type, type)));
    for (const row of rows) expect(row.topic).toBe('notifications.broadcast');
    return rows;
  }

  /** A COD self-delivery order settled: the vendor's wallet is debited the commission. */
  async function codCommission(vendorId: string, commissionNpr: number) {
    const order = await createOrder(db, {
      vendorId,
      customerId: await createUser(db),
      subtotal: commissionNpr * 10,
      commission: commissionNpr,
    });
    await markDelivered(db, order.id);
    return settlement.settleOrder(order.id);
  }

  /** A prepaid fleet order settled: the vendor's wallet is credited S − C. */
  async function payout(vendorId: string, creditNpr: number) {
    const order = await createOrder(db, {
      vendorId,
      customerId: await createUser(db),
      paymentMethod: 'ESEWA',
      fulfillment: 'PLATFORM_FLEET',
      subtotal: creditNpr,
      commission: 0,
    });
    await settlement.capturePayment(order.id);
    await markDelivered(db, order.id, await createUser(db, 'DRIVER'));
    const settled = await settlement.settleOrder(order.id);
    // Step 7.3: a prepaid order's earnings reach the wallet when its 7-day hold is released.
    await db.transaction((tx) =>
      settleDisputeHold(tx, ledger, { orderId: order.id, vendorId, refundPaisa: 0 }),
    );
    return settled;
  }

  /** A balanced top-up journal, as the top-up endpoint posts it. */
  function topUp(vendorId: string, amountNpr: number) {
    return db.transaction((tx) =>
      ledger.post(tx, {
        kind: 'VENDOR_TOP_UP',
        idempotencyKey: `test-top-up:${randomUUID()}`,
        orderId: null,
        postings: [
          {
            account: { type: 'GATEWAY_CLEARING', gateway: 'ESEWA' },
            amountPaisa: -amountNpr * 100,
          },
          { account: { type: 'VENDOR_WALLET', vendorId }, amountPaisa: amountNpr * 100 },
        ],
      }),
    );
  }

  async function suspendedForDebt(status: VendorStatus = 'LIVE') {
    const vendorId = await createVendor(db, { status });
    await codCommission(vendorId, 2500);
    expect(await vendorRow(vendorId)).toMatchObject({
      status: 'SUSPENDED',
      wallet_balance_npr: -2500,
    });
    return vendorId;
  }

  describe('suspension', () => {
    it('suspends at the posting that crosses the limit and emits vendor.suspended_for_debt', async () => {
      const vendorId = await createVendor(db);

      const result = await codCommission(vendorId, 2500);

      expect(await vendorRow(vendorId)).toMatchObject({
        status: 'SUSPENDED',
        status_before_debt_suspension: 'LIVE',
        wallet_balance_npr: -2500,
      });
      expect(result).toMatchObject({
        status: 'posted',
        standingChanges: [
          {
            type: 'SUSPENDED_FOR_DEBT',
            vendorId,
            previousStatus: 'LIVE',
            walletBalanceNpr: -2500,
            suspensionLimitNpr: -2000,
          },
        ],
      });
      const [event] = await events(vendorId, 'vendor.suspended_for_debt');
      expect(vendorSuspendedForDebtPayloadSchema.parse(event?.payload)).toMatchObject({
        vendor_id: vendorId,
        previous_status: 'LIVE',
        wallet_balance_npr: -2500,
        suspension_limit_npr: -2000,
      });
    });

    it('leaves a vendor within the limit alone (SPEC verification 3: −100 stays LIVE)', async () => {
      const vendorId = await createVendor(db);

      const result = await codCommission(vendorId, 100);

      expect(await vendorRow(vendorId)).toMatchObject({
        status: 'LIVE',
        status_before_debt_suspension: null,
      });
      expect(result).toMatchObject({ standingChanges: [] });
      expect(await events(vendorId, 'vendor.suspended_for_debt')).toEqual([]);
    });

    it('emits once: a further debit of a suspended vendor changes nothing', async () => {
      const vendorId = await suspendedForDebt();

      const result = await codCommission(vendorId, 300);

      expect(result).toMatchObject({ standingChanges: [] });
      expect(await events(vendorId, 'vendor.suspended_for_debt')).toHaveLength(1);
      expect((await vendorRow(vendorId)).status_before_debt_suspension).toBe('LIVE');
    });

    it('applies the current limit: a tightened limit suspends at the next posting', async () => {
      const vendorId = await createVendor(db);
      await codCommission(vendorId, 1500);
      await setLimit(-1000);

      await codCommission(vendorId, 10);

      expect((await vendorRow(vendorId)).status).toBe('SUSPENDED');
      expect(await events(vendorId, 'vendor.suspended_for_debt')).toHaveLength(1);
    });

    it('suspends once under concurrent settlements that each cross the limit', async () => {
      const vendorId = await createVendor(db);

      await Promise.all(Array.from({ length: 5 }, () => codCommission(vendorId, 2100)));

      expect(await vendorRow(vendorId)).toMatchObject({
        status: 'SUSPENDED',
        wallet_balance_npr: -10_500,
        status_before_debt_suspension: 'LIVE',
      });
      expect(await events(vendorId, 'vendor.suspended_for_debt')).toHaveLength(1);
    });

    it('writes nothing for a replayed journal', async () => {
      const vendorId = await createVendor(db);
      const order = await createOrder(db, {
        vendorId,
        customerId: await createUser(db),
        subtotal: 25_000,
        commission: 2500,
      });
      await markDelivered(db, order.id);
      await settlement.settleOrder(order.id);

      await expect(settlement.settleOrder(order.id)).resolves.toMatchObject({
        status: 'duplicate',
      });
      expect(await events(vendorId, 'vendor.suspended_for_debt')).toHaveLength(1);
    });
  });

  describe('restoration', () => {
    it('restores the previous status once the negative balance is cleared, with vendor.restored', async () => {
      const vendorId = await suspendedForDebt();

      const result = await topUp(vendorId, 2500);

      expect(await vendorRow(vendorId)).toMatchObject({
        status: 'LIVE',
        status_before_debt_suspension: null,
        wallet_balance_npr: 0,
      });
      expect(result).toMatchObject({
        standingChanges: [
          { type: 'RESTORED', vendorId, restoredStatus: 'LIVE', walletBalanceNpr: 0 },
        ],
      });
      const [event] = await events(vendorId, 'vendor.restored');
      expect(vendorRestoredPayloadSchema.parse(event?.payload)).toMatchObject({
        vendor_id: vendorId,
        restored_status: 'LIVE',
        wallet_balance_npr: 0,
        transaction_id: result.transactionId,
      });
    });

    it('keeps the vendor suspended while the wallet is still negative, even above the limit', async () => {
      const vendorId = await suspendedForDebt();

      await topUp(vendorId, 1000); // −1500: within the limit, but the debt is not cleared

      expect(await vendorRow(vendorId)).toMatchObject({
        status: 'SUSPENDED',
        status_before_debt_suspension: 'LIVE',
      });
      expect(await events(vendorId, 'vendor.restored')).toEqual([]);
    });

    it('is triggered by any credit, e.g. an order payout, and restores an APPROVED vendor as APPROVED', async () => {
      const vendorId = await suspendedForDebt('APPROVED');

      await payout(vendorId, 3000);

      expect(await vendorRow(vendorId)).toMatchObject({
        status: 'APPROVED',
        wallet_balance_npr: 500,
        status_before_debt_suspension: null,
      });
      expect(await events(vendorId, 'vendor.restored')).toHaveLength(1);
    });

    it('never lifts a suspension that was not for debt', async () => {
      const vendorId = await createVendor(db);
      await db.update(vendors).set({ status: 'SUSPENDED' }).where(eq(vendors.id, vendorId));

      await topUp(vendorId, 500);

      expect(await vendorRow(vendorId)).toMatchObject({
        status: 'SUSPENDED',
        status_before_debt_suspension: null,
        wallet_balance_npr: 500,
      });
      expect(await events(vendorId, 'vendor.restored')).toEqual([]);
    });

    it('restores once under concurrent top-ups', async () => {
      const vendorId = await suspendedForDebt();

      await Promise.all(Array.from({ length: 4 }, () => topUp(vendorId, 1000)));

      expect(await vendorRow(vendorId)).toMatchObject({ status: 'LIVE', wallet_balance_npr: 1500 });
      expect(await events(vendorId, 'vendor.restored')).toHaveLength(1);
    });

    it('can suspend again after a restore (a new debt, a new event)', async () => {
      const vendorId = await suspendedForDebt();
      await topUp(vendorId, 2500);

      await codCommission(vendorId, 2200);

      expect(await vendorRow(vendorId)).toMatchObject({
        status: 'SUSPENDED',
        status_before_debt_suspension: 'LIVE',
      });
      expect(await events(vendorId, 'vendor.suspended_for_debt')).toHaveLength(2);
    });
  });
});
