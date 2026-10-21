import { randomInt, randomUUID } from 'node:crypto';

import {
  auditLogs,
  createDatabase,
  outboxEvents,
  users,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import { bsMonthStart, LedgerService, WalletService } from '@hamro-pasal/ledger';
import type { AuditAction } from '@hamro-pasal/shared-types';
import { and, eq } from 'drizzle-orm';

import { BillingCycleRenewalService } from '../src/billing/billing-cycle-renewal';
import { CycleDuesSweepService } from '../src/billing/cycle-dues-sweep';
import { createTimerHandlers } from '../src/queues/processors';

/**
 * 2026-10-21 (SPEC core 4, "Cycle dues") on real PostgreSQL: a Billing Cycle that ends with the
 * wallet below 0 opens a 7-day notice, whether or not the suspension limit was reached; the shop
 * is suspended for debt if the dues are not cleared in time, and restored by paying them.
 */
describe('cycle dues (real PostgreSQL)', () => {
  let db: Database;
  const ledger = new LedgerService(new WalletService());

  const KARTIK_1 = bsMonthStart(2082, 7);
  const ASHWIN_1 = bsMonthStart(2082, 6);
  const RENEWAL = new Date('2025-10-20T06:00:00.000Z');
  const DAY = 86_400_000;

  beforeAll(() => {
    db = createDatabase(process.env.TEST_DATABASE_URL ?? '', { max: 10 });
  });

  afterAll(async () => {
    await db.$client.end();
  });

  async function vendor(values: Partial<typeof vendors.$inferInsert> = {}): Promise<string> {
    const phone = `+9779${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
    const [owner] = await db
      .insert(users)
      .values({ phone, role: 'VENDOR' })
      .returning({ id: users.id });
    if (owner === undefined) throw new Error('user not created');
    const [row] = await db
      .insert(vendors)
      .values({
        user_id: owner.id,
        business_name: 'Dues Pasal',
        phone,
        status: 'LIVE',
        pricing_model: 'COMMISSION',
        commission_rate: 0.1,
        delivery_scope: 'RADIUS_BOUND',
        fulfillment_mode: 'SELF_DELIVERY',
        radius_km: 5,
        municipality_palika_string: 'Kathmandu Metropolitan City',
        min_order_value: 0,
        location: { x: 85.3123, y: 27.7154 },
        billing_cycle_started_at: ASHWIN_1,
        billing_cycle_ends_at: KARTIK_1,
        ...values,
      })
      .returning({ id: vendors.id });
    if (row === undefined) throw new Error('vendor not created');
    return row.id;
  }

  /** Moves a shop's wallet by a balanced journal (the projection only moves through postings). */
  async function post(vendorId: string, amountNpr: number): Promise<void> {
    await db.transaction((tx) =>
      ledger.post(tx, {
        kind: 'ADJUSTMENT',
        idempotencyKey: `test-dues:${randomUUID()}`,
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
  }

  const row = async (vendorId: string) => {
    const [found] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
    if (found === undefined) throw new Error('vendor not found');
    return found;
  };

  const events = (vendorId: string, type: string) =>
    db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.aggregate_id, vendorId), eq(outboxEvents.event_type, type)));

  const audit = (vendorId: string, action: AuditAction) =>
    db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.vendor_id, vendorId), eq(auditLogs.action, action)));

  it('opens a 7-day notice when a cycle ends below 0, though above the suspension limit', async () => {
    const vendorId = await vendor();
    await post(vendorId, -150);

    await new BillingCycleRenewalService(db).renewDueCycles(RENEWAL);

    const shop = await row(vendorId);
    expect(shop).toMatchObject({ status: 'LIVE', dues_amount_npr: 150 });
    expect(shop.dues_notice_opened_at?.toISOString()).toBe(RENEWAL.toISOString());
    expect(shop.dues_due_at?.getTime()).toBe(RENEWAL.getTime() + 7 * DAY);
    expect(await events(vendorId, 'vendor.dues_notice_opened')).toHaveLength(1);
    expect(await audit(vendorId, 'CYCLE_DUES_NOTICE_OPENED')).toHaveLength(1);
  });

  it('opens none for a wallet at 0 or above, nor for a Model C shop', async () => {
    const clear = await vendor();
    const prepaid = await vendor({ settlement_model: 'DIRECT_PREPAID' });
    await post(prepaid, -10);
    await new BillingCycleRenewalService(db).renewDueCycles(RENEWAL);
    expect((await row(clear)).dues_due_at).toBeNull();
    expect((await row(prepaid)).dues_due_at).toBeNull();
  });

  it('suspends for debt when the dues are still unpaid at the due time, once', async () => {
    const vendorId = await vendor();
    await post(vendorId, -150);
    await new BillingCycleRenewalService(db).renewDueCycles(RENEWAL);

    const early = new CycleDuesSweepService(db, () => new Date(RENEWAL.getTime() + 7 * DAY - 1000));
    expect((await early.run()).suspended).not.toContain(vendorId);
    expect((await row(vendorId)).status).toBe('LIVE');

    const due = new CycleDuesSweepService(db, () => new Date(RENEWAL.getTime() + 7 * DAY));
    const runs = await Promise.all([due.run(), due.run(), due.run()]);
    expect(runs.flatMap((r) => r.suspended).filter((id) => id === vendorId)).toHaveLength(1);
    const shop = await row(vendorId);
    expect(shop).toMatchObject({
      status: 'SUSPENDED',
      status_before_debt_suspension: 'LIVE',
      dues_due_at: null,
    });
    expect(await events(vendorId, 'vendor.suspended_for_dues')).toHaveLength(1);
    expect(await audit(vendorId, 'VENDOR_SUSPENDED_FOR_DUES')).toHaveLength(1);

    // Paying back to 0 lifts it, like any debt suspension: through the PAN gate (this fixture shop
    // has no verified PAN, so it lands in SUSPENDED_COMPLIANCE, never SUSPENDED again).
    await post(vendorId, 150);
    expect(await row(vendorId)).toMatchObject({
      status: 'SUSPENDED_COMPLIANCE',
      status_before_debt_suspension: null,
    });
  });

  it('closes the notice as soon as a payment brings the wallet back to 0', async () => {
    const vendorId = await vendor();
    await post(vendorId, -150);
    await new BillingCycleRenewalService(db).renewDueCycles(RENEWAL);
    await post(vendorId, 150);
    expect((await row(vendorId)).dues_due_at).toBeNull();

    const sweep = new CycleDuesSweepService(db, () => new Date(RENEWAL.getTime() + 8 * DAY));
    expect((await sweep.run()).suspended).not.toContain(vendorId);
    expect((await row(vendorId)).status).toBe('LIVE');
  });

  it('runs as the midnight task', async () => {
    let ran = 0;
    const handlers = createTimerHandlers({
      escalation: { escalateIfUnanswered: () => Promise.reject(new Error('unused')) },
      debtReconciliation: { suspendIndebtedVendors: () => Promise.resolve([]) },
      orderReconciliation: {
        reconcileDeliveredOrders: () => Promise.resolve({ reconciled: [], discrepancies: [] }),
      },
      cycleDues: {
        run: () => {
          ran += 1;
          return Promise.resolve({ suspended: [], closed: 0 });
        },
      },
    });
    await handlers.runMidnightTask('CYCLE_DUES_SWEEP');
    expect(ran).toBe(1);
  });
});
