import { randomInt, randomUUID } from 'node:crypto';

import {
  createDatabase,
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  outboxEvents,
  outboxRowToDomainEvent,
  platformSettings,
  users,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import {
  JOB_QUEUES,
  type VendorStatus,
  type VendorSuspendedForDebtEvent,
} from '@hamro-pasal/shared-types';
import { Worker } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';

import { buildBullConnection } from '../src/infra/redis';
import { allTimerQueues, createTimerQueues, type TimerQueues } from '../src/queues/definitions';
import { createProcessors, createTimerHandlers } from '../src/queues/processors';
import { VendorEscalationService } from '../src/sla/vendor-escalation';
import { VendorDebtReconciliationService } from '../src/wallet/vendor-debt-reconciliation';

/**
 * Phase 12: the nightly VENDOR_DEBT_RECONCILIATION (SPEC §5, edge case 2) against real PostgreSQL
 * (wallet projection, suspension trigger, outbox) and real BullMQ. Wallets are driven negative with
 * balanced journals while the limit is the default −2000 (so the trigger leaves them LIVE), then the
 * Super Admin tightens the limit to −1000: only the sweep can suspend them now.
 */
describe('nightly vendor debt reconciliation (real PostgreSQL + BullMQ)', () => {
  const prefix = `test-${randomUUID()}`;
  const connection = buildBullConnection(process.env.TEST_REDIS_URL ?? '');
  let db: Database;
  let queues: TimerQueues;
  let reconciliation: VendorDebtReconciliationService;

  beforeAll(() => {
    db = createDatabase(process.env.TEST_DATABASE_URL ?? '', { max: 10 });
    queues = createTimerQueues(connection, prefix);
    reconciliation = new VendorDebtReconciliationService(db);
  });

  afterEach(async () => {
    await setLimit(-2000);
  });

  afterAll(async () => {
    await Promise.all(allTimerQueues(queues).map((q) => q.obliterate({ force: true })));
    await Promise.all(allTimerQueues(queues).map((q) => q.close()));
    await db.$client.end();
  });

  async function setLimit(limitNpr: number) {
    await db
      .update(platformSettings)
      .set({ vendor_wallet_suspension_limit_npr: limitNpr })
      .where(eq(platformSettings.id, true));
  }

  async function vendorUser(): Promise<string> {
    const phone = `+9779${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
    const [row] = await db
      .insert(users)
      .values({ phone, role: 'VENDOR' })
      .returning({ id: users.id });
    if (row === undefined) throw new Error('user not created');
    return row.id;
  }

  /** A vendor in `status` whose wallet is moved to `balanceNpr` by a balanced ADJUSTMENT journal. */
  async function vendorWithBalance(balanceNpr: number, status: VendorStatus = 'LIVE') {
    const [vendor] = await db
      .insert(vendors)
      .values({
        user_id: await vendorUser(),
        business_name: 'Thamel Kirana Pasal',
        phone: '+9779800000011',
        status,
        pricing_model: 'COMMISSION',
        commission_rate: 0.1,
        delivery_scope: 'RADIUS_BOUND',
        fulfillment_mode: 'SELF_DELIVERY',
        radius_km: 5,
        municipality_palika_string: 'Kathmandu Metropolitan City',
        min_order_value: 0,
        base_delivery_fee_npr: 50,
        location: { x: 85.3123, y: 27.7154 },
      })
      .returning({ id: vendors.id });
    if (vendor === undefined) throw new Error('vendor not created');
    if (balanceNpr !== 0) await postToWallet(vendor.id, balanceNpr);
    return vendor.id;
  }

  async function postToWallet(vendorId: string, amountNpr: number) {
    await db.transaction(async (tx) => {
      const [wallet] = await tx
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(eq(ledgerAccounts.vendor_id, vendorId));
      const [revenue] = await tx
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(eq(ledgerAccounts.account_type, 'PLATFORM_REVENUE'));
      const [journal] = await tx
        .insert(ledgerTransactions)
        .values({ kind: 'ADJUSTMENT', idempotency_key: `test-adjustment:${randomUUID()}` })
        .returning({ id: ledgerTransactions.id });
      if (wallet === undefined || revenue === undefined || journal === undefined) {
        throw new Error('ledger accounts missing');
      }
      await tx.insert(ledgerEntries).values([
        { transaction_id: journal.id, account_id: wallet.id, amount_npr: amountNpr },
        { transaction_id: journal.id, account_id: revenue.id, amount_npr: -amountNpr },
      ]);
    });
  }

  async function vendorRow(vendorId: string) {
    const [row] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
    if (row === undefined) throw new Error(`vendor ${vendorId} not found`);
    return row;
  }

  async function suspensionEvents(vendorId: string): Promise<VendorSuspendedForDebtEvent[]> {
    const rows = await db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.aggregate_id, vendorId),
          eq(outboxEvents.event_type, 'vendor.suspended_for_debt'),
        ),
      );
    return rows.map((row) => {
      expect(row.topic).toBe('notifications.broadcast');
      const event = outboxRowToDomainEvent(row);
      if (event.event_type !== 'vendor.suspended_for_debt') throw new Error('wrong type');
      return event;
    });
  }

  it('suspends only vendors strictly below the current limit and announces each once', async () => {
    const indebted = await vendorWithBalance(-1500);
    const indebtedApproved = await vendorWithBalance(-1200, 'APPROVED');
    const atLimit = await vendorWithBalance(-1000);
    const shallow = await vendorWithBalance(-500);
    const healthy = await vendorWithBalance(800);
    const untouched = [atLimit, shallow, healthy];
    const before = await Promise.all(untouched.map(vendorRow));
    // The trigger left them trading under the old −2000 limit.
    expect((await vendorRow(indebted)).status).toBe('LIVE');

    await setLimit(-1000);
    const result = await reconciliation.suspendIndebtedVendors();

    const mine = result.filter((s) => [indebted, indebtedApproved].includes(s.vendorId));
    expect(mine.map((s) => [s.vendorId, s.previousStatus, s.walletBalanceNpr]).sort()).toEqual(
      [
        [indebted, 'LIVE', -1500],
        [indebtedApproved, 'APPROVED', -1200],
      ].sort(),
    );
    expect(result.map((s) => s.vendorId)).not.toEqual(expect.arrayContaining([atLimit]));
    expect(await vendorRow(indebted)).toMatchObject({
      status: 'SUSPENDED',
      status_before_debt_suspension: 'LIVE',
    });
    expect(await vendorRow(indebtedApproved)).toMatchObject({
      status: 'SUSPENDED',
      status_before_debt_suspension: 'APPROVED',
    });
    // Healthy vendors: same status, and their rows were not even rewritten.
    expect(await Promise.all(untouched.map(vendorRow))).toEqual(before);
    for (const vendorId of untouched) expect(await suspensionEvents(vendorId)).toEqual([]);

    const [event] = await suspensionEvents(indebted);
    expect(await suspensionEvents(indebted)).toHaveLength(1);
    expect(event?.payload).toEqual({
      vendor_id: indebted,
      vendor_phone: '+9779800000011',
      previous_status: 'LIVE',
      wallet_balance_npr: -1500,
      suspension_limit_npr: -1000,
      suspended_at: event?.occurred_at,
    });
    expect(event?.aggregate_id).toBe(indebted);
  });

  it('leaves vendors the trigger already suspended alone (no second event)', async () => {
    // Below −2000 at posting time: the database trigger suspends immediately.
    const vendorId = await vendorWithBalance(-2500);
    expect((await vendorRow(vendorId)).status).toBe('SUSPENDED');

    const result = await reconciliation.suspendIndebtedVendors();

    expect(result.map((s) => s.vendorId)).not.toContain(vendorId);
    expect(await suspensionEvents(vendorId)).toEqual([]);
  });

  it('does nothing on a rerun and suspends each vendor once under concurrent sweeps', async () => {
    const vendorIds = await Promise.all([-1100, -1300, -1900].map((b) => vendorWithBalance(b)));
    await setLimit(-1000);

    const runs = await Promise.all(
      Array.from({ length: 4 }, () => reconciliation.suspendIndebtedVendors()),
    );
    const rerun = await reconciliation.suspendIndebtedVendors();

    const suspendedIds = runs.flat().map((s) => s.vendorId);
    for (const vendorId of vendorIds) {
      expect(suspendedIds.filter((id) => id === vendorId)).toHaveLength(1);
      expect(await suspensionEvents(vendorId)).toHaveLength(1);
      expect((await vendorRow(vendorId)).status).toBe('SUSPENDED');
    }
    expect(rerun.filter((s) => vendorIds.includes(s.vendorId))).toEqual([]);
  });

  it('keeps a vendor that paid down the debt first (limit re-checked on the locked row)', async () => {
    const vendorId = await vendorWithBalance(-1500);
    await setLimit(-1000);
    await postToWallet(vendorId, 1000); // top-up to −500 before the sweep

    await reconciliation.suspendIndebtedVendors();

    expect((await vendorRow(vendorId)).status).toBe('LIVE');
    expect(await suspensionEvents(vendorId)).toEqual([]);
  });

  it('runs as the VENDOR_DEBT_RECONCILIATION midnight job through BullMQ', async () => {
    const vendorId = await vendorWithBalance(-1500);
    await setLimit(-1000);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const worker = new Worker(
      queues.midnight.name,
      createProcessors(
        createTimerHandlers({
          escalation: new VendorEscalationService(db),
          debtReconciliation: reconciliation,
          orderReconciliation: {
            reconcileDeliveredOrders: () => Promise.resolve({ reconciled: [], discrepancies: [] }),
          },
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
      await queues.midnight.add(JOB_QUEUES.MIDNIGHT_MAINTENANCE, {
        task: 'VENDOR_DEBT_RECONCILIATION',
      });
      await completed;
    } finally {
      await worker.close();
    }

    expect((await vendorRow(vendorId)).status).toBe('SUSPENDED');
    expect(await suspensionEvents(vendorId)).toHaveLength(1);
    const audit = warn.mock.calls
      .map(([line]) => String(line))
      .find((line) => line.includes(vendorId));
    expect(JSON.parse(audit ?? '{}')).toMatchObject({
      audit: 'vendor.suspended_for_debt',
      vendor_id: vendorId,
      wallet_balance_npr: -1500,
    });
    warn.mockRestore();
    info.mockRestore();
  });

  it('matches the trigger rule: a balance exactly at the limit is not a breach', async () => {
    const vendorId = await vendorWithBalance(-1000);
    await setLimit(-1000);

    await reconciliation.suspendIndebtedVendors();
    // A later write to the row (the trigger's own check) agrees.
    await db.execute(sql`UPDATE vendors SET business_name = business_name WHERE id = ${vendorId}`);

    expect((await vendorRow(vendorId)).status).toBe('LIVE');
  });
});
