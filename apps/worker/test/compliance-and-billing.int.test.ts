import { randomInt, randomUUID } from 'node:crypto';

import {
  auditLogs,
  createDatabase,
  outboxEvents,
  outboxRowToDomainEvent,
  pricingPlans,
  users,
  vendorSettingChanges,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import { bsDateOf, bsMonthStart } from '@hamro-pasal/ledger';
import { and, asc, eq } from 'drizzle-orm';

import { BillingCycleRenewalService } from '../src/billing/billing-cycle-renewal';
import { ComplianceSweepService } from '../src/compliance/compliance-sweep';
import { createTimerHandlers } from '../src/queues/processors';

/**
 * Phase 25 on real PostgreSQL: the nightly VENDOR_COMPLIANCE_SWEEP (SPEC core 10) and
 * BILLING_CYCLE_RENEWAL (SPEC core 4). Both audit with the job as the actor.
 */
describe('compliance sweep and billing cycle renewal (real PostgreSQL)', () => {
  let db: Database;
  let sweep: ComplianceSweepService;
  let renewal: BillingCycleRenewalService;
  let adminId: string;

  // 1 Kartik 2082 (18 October 2025, 00:00 Nepal Time): a cycle that ended there is due on the 20th.
  const KARTIK_1 = bsMonthStart(2082, 7);
  const ASHWIN_1 = bsMonthStart(2082, 6);
  const NOW = new Date('2025-10-20T06:00:00.000Z');

  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL ?? '', { max: 10 });
    sweep = new ComplianceSweepService(db);
    renewal = new BillingCycleRenewalService(db);
    adminId = await user('SUPER_ADMIN');
  });

  afterAll(async () => {
    await db.$client.end();
  });

  async function user(role: 'VENDOR' | 'SUPER_ADMIN'): Promise<string> {
    const phone = `+9779${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
    const [row] = await db.insert(users).values({ phone, role }).returning({ id: users.id });
    if (row === undefined) throw new Error('user not created');
    return row.id;
  }

  async function vendor(values: Partial<typeof vendors.$inferInsert> = {}): Promise<string> {
    const [row] = await db
      .insert(vendors)
      .values({
        user_id: await user('VENDOR'),
        business_name: 'Test Pasal',
        phone: '+9779800000000',
        status: 'LIVE',
        pricing_model: 'COMMISSION',
        commission_rate: 0.1,
        delivery_scope: 'RADIUS_BOUND',
        fulfillment_mode: 'SELF_DELIVERY',
        radius_km: 5,
        municipality_palika_string: 'Kathmandu Metropolitan City',
        min_order_value: 0,
        location: { x: 85.3123, y: 27.7154 },
        ...values,
      })
      .returning({ id: vendors.id });
    if (row === undefined) throw new Error('vendor not created');
    return row.id;
  }

  const row = async (vendorId: string) => {
    const [found] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
    if (found === undefined) throw new Error('vendor not found');
    return found;
  };
  const audit = (entityId: string) =>
    db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entity_id, entityId))
      .orderBy(asc(auditLogs.occurred_at));

  const suspensionEvents = (vendorId: string) =>
    db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.aggregate_id, vendorId),
          eq(outboxEvents.event_type, 'vendor.suspended_for_compliance'),
        ),
      );

  describe('VENDOR_COMPLIANCE_SWEEP', () => {
    it('suspends a LIVE vendor without a PAN and audits it with the job as the actor', async () => {
      const vendorId = await vendor();

      const suspended = await sweep.suspendVendorsWithoutPan();

      expect(suspended.map((s) => s.vendorId)).toContain(vendorId);
      expect(await row(vendorId)).toMatchObject({
        status: 'SUSPENDED_COMPLIANCE',
        status_before_compliance_suspension: 'LIVE',
      });
      const entries = await audit(vendorId);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        action: 'VENDOR_SUSPENDED_FOR_COMPLIANCE',
        entity_type: 'vendor',
        actor_user_id: null,
        actor_role: null,
        system_actor: 'VENDOR_COMPLIANCE_SWEEP',
        vendor_id: vendorId,
        before_state: { status: 'LIVE', tax_id: null },
        after_state: { status: 'SUSPENDED_COMPLIANCE', restores_to: 'LIVE' },
      });

      // Phase 35: the shop is told why it went offline, through the outbox.
      const [event, ...more] = await suspensionEvents(vendorId);
      if (event === undefined) throw new Error('no suspension event in the outbox');
      expect(more).toEqual([]);
      expect(event).toMatchObject({
        topic: 'notifications.broadcast',
        published_at: null,
        payload: {
          vendor_id: vendorId,
          vendor_phone: (await row(vendorId)).phone,
          previous_status: 'LIVE',
        },
      });
      // The stored row is an envelope the relay can publish.
      expect(outboxRowToDomainEvent(event).event_type).toBe('vendor.suspended_for_compliance');
    });

    it('leaves a vendor with a PAN alone, verified or not, and any vendor that is not LIVE', async () => {
      const withPan = await vendor({ tax_id: '302118845' });
      const verified = await vendor({
        tax_id: '609871234',
        pan_verified_at: new Date(),
        pan_verified_by_user_id: adminId,
      });
      const approved = await vendor({ status: 'APPROVED' });
      const sandboxed = await vendor({ status: 'SANDBOXED', pricing_model: null });
      const suspendedForDebt = await vendor({ status: 'SUSPENDED' });

      await sweep.suspendVendorsWithoutPan();

      expect((await row(withPan)).status).toBe('LIVE');
      expect((await row(verified)).status).toBe('LIVE');
      expect((await row(approved)).status).toBe('APPROVED');
      expect((await row(sandboxed)).status).toBe('SANDBOXED');
      expect((await row(suspendedForDebt)).status).toBe('SUSPENDED');
      for (const id of [withPan, verified, approved, sandboxed, suspendedForDebt]) {
        expect(await audit(id)).toEqual([]);
        expect(await suspensionEvents(id)).toEqual([]);
      }
    });

    it('suspends each vendor once: a rerun and 4 concurrent sweeps add nothing', async () => {
      const first = await vendor();
      const second = await vendor();

      await Promise.all(Array.from({ length: 4 }, () => sweep.suspendVendorsWithoutPan()));
      const rerun = await sweep.suspendVendorsWithoutPan();

      expect(rerun.map((s) => s.vendorId)).not.toContain(first);
      for (const id of [first, second]) {
        expect((await row(id)).status).toBe('SUSPENDED_COMPLIANCE');
        expect(await audit(id)).toHaveLength(1);
        expect(await suspensionEvents(id)).toHaveLength(1);
      }
    });

    it('runs as the midnight task', async () => {
      const vendorId = await vendor();
      const handlers = createTimerHandlers({
        escalation: { escalateIfUnanswered: jest.fn() },
        debtReconciliation: { suspendIndebtedVendors: jest.fn() },
        orderReconciliation: { reconcileDeliveredOrders: jest.fn() },
        complianceSweep: sweep,
        billingRenewal: renewal,
      });
      const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
      try {
        await handlers.runMidnightTask('VENDOR_COMPLIANCE_SWEEP');
      } finally {
        info.mockRestore();
      }
      expect((await row(vendorId)).status).toBe('SUSPENDED_COMPLIANCE');
    });
  });

  describe('BILLING_CYCLE_RENEWAL', () => {
    const inCycle = (values: Partial<typeof vendors.$inferInsert> = {}) =>
      vendor({
        tax_id: '302118845',
        billing_cycle_started_at: ASHWIN_1,
        billing_cycle_ends_at: KARTIK_1,
        ...values,
      });

    async function plan(values: Partial<typeof pricingPlans.$inferInsert> = {}) {
      const [created] = await db
        .insert(pricingPlans)
        .values({
          name: `Plan ${randomUUID()}`,
          model: 'COMMISSION',
          commission_rate: 8,
          created_by_user_id: adminId,
          ...values,
        })
        .returning({ id: pricingPlans.id });
      if (created === undefined) throw new Error('plan not created');
      return created.id;
    }

    async function queued(
      vendorId: string,
      setting: 'PRICING_PLAN' | 'PAYMENT_METHODS',
      requested: Record<string, unknown>,
      effectiveFrom = KARTIK_1,
    ) {
      const vendorRow = await row(vendorId);
      const [change] = await db
        .insert(vendorSettingChanges)
        .values({
          vendor_id: vendorId,
          setting,
          current_value: {},
          requested_value: requested as never,
          requested_by_user_id: vendorRow.user_id,
          requested_at: new Date('2025-10-01T00:00:00Z'),
          effective_from: effectiveFrom,
        })
        .returning();
      if (change === undefined) throw new Error('change not queued');
      return change.id;
    }
    const changeRow = async (id: string) => {
      const [found] = await db
        .select()
        .from(vendorSettingChanges)
        .where(eq(vendorSettingChanges.id, id));
      if (found === undefined) throw new Error('change not found');
      return found;
    };

    it('starts the first cycle of a LIVE vendor, to the end of the current BS month', async () => {
      const live = await vendor({ tax_id: '302118845' });
      const approved = await vendor({ status: 'APPROVED' });

      await renewal.renewDueCycles(NOW);

      const started = await row(live);
      expect(started.billing_cycle_started_at).toEqual(NOW);
      // 20 October 2025 is in Kartik 2082: the cycle ends on 1 Mangsir.
      expect(bsDateOf(started.billing_cycle_ends_at ?? NOW)).toEqual({
        year: 2082,
        month: 8,
        day: 1,
      });
      expect((await row(approved)).billing_cycle_ends_at).toBeNull();
      expect(await audit(live)).toEqual([
        expect.objectContaining({
          action: 'BILLING_CYCLE_STARTED',
          system_actor: 'BILLING_CYCLE_RENEWAL',
          actor_user_id: null,
        }),
      ]);
    });

    it('applies a queued pricing plan at renewal and opens the next BS month', async () => {
      const vendorId = await inCycle();
      const planId = await plan({ commission_rate: 8 });
      const changeId = await queued(vendorId, 'PRICING_PLAN', { pricing_plan_id: planId });

      const summary = await renewal.renewDueCycles(NOW);

      expect(summary.applied).toBeGreaterThanOrEqual(1);
      const after = await row(vendorId);
      expect(after).toMatchObject({
        pricing_plan_id: planId,
        pricing_model: 'COMMISSION',
        commission_rate: 0.08,
      });
      expect(after.billing_cycle_started_at).toEqual(KARTIK_1);
      expect(bsDateOf(after.billing_cycle_ends_at ?? NOW)).toEqual({
        year: 2082,
        month: 8,
        day: 1,
      });
      expect(await changeRow(changeId)).toMatchObject({ status: 'APPLIED', closed_at: NOW });
      const entries = await audit(changeId);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        action: 'VENDOR_SETTING_CHANGE_APPLIED',
        entity_type: 'vendor_setting_change',
        system_actor: 'BILLING_CYCLE_RENEWAL',
        actor_user_id: null,
        vendor_id: vendorId,
        after_state: { setting: 'PRICING_PLAN', pricing_plan_id: planId },
      });
    });

    it('moves a vendor to a subscription with 0% commission and a 90-day lock-in', async () => {
      const vendorId = await inCycle();
      const planId = await plan({
        model: 'SUBSCRIPTION',
        commission_rate: 0,
        monthly_fee_npr: 1500,
      });
      await queued(vendorId, 'PRICING_PLAN', { pricing_plan_id: planId });

      await renewal.renewDueCycles(NOW);

      const after = await row(vendorId);
      expect(after).toMatchObject({ pricing_model: 'SUBSCRIPTION', commission_rate: 0 });
      expect(after.lock_in_expiry).toEqual(new Date(NOW.getTime() + 90 * 86_400_000));
    });

    it('applies queued payment methods', async () => {
      const vendorId = await inCycle();
      const changeId = await queued(vendorId, 'PAYMENT_METHODS', { methods: ['COD', 'ESEWA'] });

      await renewal.renewDueCycles(NOW);

      expect((await row(vendorId)).accepted_payment_methods).toEqual(['COD', 'ESEWA']);
      expect((await changeRow(changeId)).status).toBe('APPLIED');
    });

    it('changes nothing mid-cycle: a cycle that has not ended keeps its values and its queue', async () => {
      const future = bsMonthStart(2082, 9);
      const vendorId = await inCycle({
        billing_cycle_started_at: KARTIK_1,
        billing_cycle_ends_at: future,
      });
      const changeId = await queued(vendorId, 'PAYMENT_METHODS', { methods: ['COD'] }, future);

      await renewal.renewDueCycles(NOW);

      expect(await row(vendorId)).toMatchObject({
        accepted_payment_methods: ['ESEWA', 'KHALTI', 'COD'],
        billing_cycle_ends_at: future,
      });
      expect((await changeRow(changeId)).status).toBe('PENDING');
      expect(await audit(changeId)).toEqual([]);
    });

    it('never applies a withdrawn change, but still renews the cycle', async () => {
      const vendorId = await inCycle();
      const changeId = await queued(vendorId, 'PAYMENT_METHODS', { methods: ['COD'] });
      await db
        .update(vendorSettingChanges)
        .set({ status: 'WITHDRAWN', closed_at: new Date('2025-10-05T00:00:00Z') })
        .where(eq(vendorSettingChanges.id, changeId));

      await renewal.renewDueCycles(NOW);

      const after = await row(vendorId);
      expect(after.accepted_payment_methods).toEqual(['ESEWA', 'KHALTI', 'COD']);
      expect(after.billing_cycle_started_at).toEqual(KARTIK_1);
      expect((await changeRow(changeId)).status).toBe('WITHDRAWN');
    });

    it('drops a change whose plan was withdrawn since, leaving the vendor on its plan', async () => {
      const vendorId = await inCycle();
      const planId = await plan({ is_offered: false });
      const changeId = await queued(vendorId, 'PRICING_PLAN', { pricing_plan_id: planId });

      await renewal.renewDueCycles(NOW);

      expect(await row(vendorId)).toMatchObject({ pricing_plan_id: null, commission_rate: 0.1 });
      expect((await changeRow(changeId)).status).toBe('SUPERSEDED');
      expect(await audit(changeId)).toEqual([]);
    });

    it('applies a change exactly once when the job runs twice and 4 times at once', async () => {
      const vendorId = await inCycle();
      const changeId = await queued(vendorId, 'PAYMENT_METHODS', { methods: ['KHALTI'] });

      await Promise.all(Array.from({ length: 4 }, () => renewal.renewDueCycles(NOW)));
      await renewal.renewDueCycles(NOW);

      expect(await audit(changeId)).toHaveLength(1);
      const after = await row(vendorId);
      expect(after.accepted_payment_methods).toEqual(['KHALTI']);
      // Renewed once: the next cycle still starts where the old one ended.
      expect(after.billing_cycle_started_at).toEqual(KARTIK_1);
    });

    it('catches up a cycle that ended months ago', async () => {
      const vendorId = await inCycle({
        billing_cycle_started_at: bsMonthStart(2082, 1),
        billing_cycle_ends_at: bsMonthStart(2082, 2),
      });

      await renewal.renewDueCycles(NOW);

      const after = await row(vendorId);
      expect(after.billing_cycle_started_at).toEqual(KARTIK_1);
      expect((after.billing_cycle_ends_at ?? NOW).getTime()).toBeGreaterThan(NOW.getTime());
    });
  });
});
