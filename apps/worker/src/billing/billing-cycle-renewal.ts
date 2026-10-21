import {
  enqueueDomainEvent,
  pricingPlans,
  recordAuditLog,
  vendorSettingChanges,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import { nextBsMonthStart } from '@hamro-pasal/ledger';
import {
  CYCLE_DUES_GRACE_DAYS,
  shopPaymentMethodSchema,
  type PricingModel,
} from '@hamro-pasal/shared-types';
import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import { z } from 'zod';

export const BILLING_RENEWAL_JOB = 'BILLING_CYCLE_RENEWAL';
const SUBSCRIPTION_LOCK_IN_DAYS = 90;

export interface BillingRenewalSummary {
  /** LIVE vendors given their first cycle. */
  readonly started: number;
  /** Vendors whose ended cycle was renewed. */
  readonly renewed: number;
  /** Queued changes applied. */
  readonly applied: number;
}

const planValue = z.object({ pricing_plan_id: z.uuid() });
const methodsValue = z.object({ methods: z.array(shopPaymentMethodSchema).min(1) });

type VendorRow = typeof vendors.$inferSelect;
type ChangeRow = typeof vendorSettingChanges.$inferSelect;

/**
 * SPEC core 4, "Billing Cycle Lock". The Billing Cycle is the BS calendar month: it ends at 00:00
 * Nepal Time on the 1st of the next BS month. Run at midnight (and safe to run at any time, twice,
 * or by two workers), this job:
 *
 *  1. starts the first cycle of every LIVE vendor that has none (a mid-month joiner's first cycle
 *     runs to the end of that BS month);
 *  2. for every vendor whose cycle has ended: applies its queued changes that are due, then opens
 *     the next cycle. Nothing else ever applies a queued change.
 *
 * One transaction per vendor under the vendor row lock, which the request to queue a change also
 * takes: a change committed before the renewal is applied by it, one that arrives after waits a
 * full cycle, and none is applied twice or half-applied (SPEC edge case 9).
 */
export class BillingCycleRenewalService {
  constructor(private readonly db: Database) {}

  async renewDueCycles(now: Date = new Date()): Promise<BillingRenewalSummary> {
    let started = 0;
    const unstarted = await this.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(eq(vendors.status, 'LIVE'), isNull(vendors.billing_cycle_ends_at)))
      .orderBy(asc(vendors.id));
    for (const { id } of unstarted) {
      if (await this.db.transaction((tx) => startFirstCycle(tx, id, now))) started += 1;
    }

    let renewed = 0;
    let applied = 0;
    const due = await this.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(lte(vendors.billing_cycle_ends_at, now))
      .orderBy(asc(vendors.id));
    for (const { id } of due) {
      const count = await this.db.transaction((tx) => renewCycle(tx, id, now));
      if (count !== null) {
        renewed += 1;
        applied += count;
      }
    }
    return { started, renewed, applied };
  }
}

async function lockVendor(tx: Transaction, vendorId: string): Promise<VendorRow | undefined> {
  const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, vendorId)).for('update');
  return vendor;
}

async function startFirstCycle(tx: Transaction, vendorId: string, now: Date): Promise<boolean> {
  const vendor = await lockVendor(tx, vendorId);
  if (vendor?.status !== 'LIVE' || vendor.billing_cycle_ends_at !== null) {
    return false;
  }
  const endsAt = nextBsMonthStart(now);
  await tx
    .update(vendors)
    .set({ billing_cycle_started_at: now, billing_cycle_ends_at: endsAt })
    .where(eq(vendors.id, vendorId));
  await recordAuditLog(tx, {
    actor: { kind: 'SYSTEM', job: BILLING_RENEWAL_JOB },
    action: 'BILLING_CYCLE_STARTED',
    entityId: vendorId,
    vendorId,
    beforeState: { billing_cycle_started_at: null, billing_cycle_ends_at: null },
    afterState: {
      billing_cycle_started_at: now.toISOString(),
      billing_cycle_ends_at: endsAt.toISOString(),
    },
  });
  return true;
}

/** Returns how many changes were applied, or null when the cycle was not due after all. */
async function renewCycle(tx: Transaction, vendorId: string, now: Date): Promise<number | null> {
  const vendor = await lockVendor(tx, vendorId);
  // Re-checked under the lock: another run may have renewed it already.
  if (vendor?.billing_cycle_ends_at == null || vendor.billing_cycle_ends_at > now) return null;

  const dueChanges = await tx
    .select()
    .from(vendorSettingChanges)
    .where(
      and(
        eq(vendorSettingChanges.vendor_id, vendorId),
        eq(vendorSettingChanges.status, 'PENDING'),
        lte(vendorSettingChanges.effective_from, now),
      ),
    )
    .orderBy(asc(vendorSettingChanges.requested_at));
  let applied = 0;
  for (const change of dueChanges) {
    if (await applyChange(tx, vendor, change, now)) applied += 1;
  }

  // The next cycle starts where the old one ended; a job that missed several months catches up.
  let startedAt = vendor.billing_cycle_ends_at;
  let endsAt = nextBsMonthStart(startedAt);
  while (endsAt <= now) {
    startedAt = endsAt;
    endsAt = nextBsMonthStart(startedAt);
  }
  await tx
    .update(vendors)
    .set({ billing_cycle_started_at: startedAt, billing_cycle_ends_at: endsAt })
    .where(eq(vendors.id, vendorId));
  await openDuesNotice(tx, vendor, now);
  return applied;
}

/**
 * 2026-10-21 (SPEC core 4, "Cycle dues"): a cycle that ends with the shop's wallet below 0 opens a
 * notice. The dues (that balance) must be cleared within CYCLE_DUES_GRACE_DAYS, whether or not the
 * suspension limit was reached, or the CYCLE_DUES_SWEEP suspends the shop for debt. A Model C shop
 * is prepaid (below its reserve it is suspended already) and gets none; an open notice is never
 * extended by the next renewal.
 */
async function openDuesNotice(tx: Transaction, vendor: VendorRow, now: Date): Promise<void> {
  if (
    vendor.wallet_balance_npr >= 0 ||
    vendor.settlement_model === 'DIRECT_PREPAID' ||
    vendor.dues_due_at !== null ||
    vendor.status === 'DEACTIVATED'
  ) {
    return;
  }
  const amount = -vendor.wallet_balance_npr;
  const dueAt = new Date(now.getTime() + CYCLE_DUES_GRACE_DAYS * 86_400_000);
  await tx
    .update(vendors)
    .set({ dues_notice_opened_at: now, dues_due_at: dueAt, dues_amount_npr: amount })
    .where(eq(vendors.id, vendor.id));
  await recordAuditLog(tx, {
    actor: { kind: 'SYSTEM', job: BILLING_RENEWAL_JOB },
    action: 'CYCLE_DUES_NOTICE_OPENED',
    entityId: vendor.id,
    vendorId: vendor.id,
    beforeState: { dues_due_at: null },
    afterState: { dues_amount_npr: amount, dues_due_at: dueAt.toISOString() },
  });
  await enqueueDomainEvent(tx, {
    type: 'vendor.dues_notice_opened',
    aggregateId: vendor.id,
    occurredAt: now,
    payload: {
      vendor_id: vendor.id,
      vendor_phone: vendor.phone,
      dues_amount_npr: amount,
      due_at: dueAt.toISOString(),
      opened_at: now.toISOString(),
    },
  });
}

/**
 * Applies one queued change and closes it as APPLIED, with its audit entry. A change that can no
 * longer be applied (its plan was withdrawn or removed since) is closed as SUPERSEDED and changes
 * nothing: the vendor keeps its active plan.
 */
async function applyChange(
  tx: Transaction,
  vendor: VendorRow,
  change: ChangeRow,
  now: Date,
): Promise<boolean> {
  const set = await vendorUpdateFor(tx, change, now);
  await tx
    .update(vendorSettingChanges)
    .set({ status: set === null ? 'SUPERSEDED' : 'APPLIED', closed_at: now })
    .where(eq(vendorSettingChanges.id, change.id));
  if (set === null) return false;

  await tx.update(vendors).set(set).where(eq(vendors.id, vendor.id));
  await recordAuditLog(tx, {
    actor: { kind: 'SYSTEM', job: BILLING_RENEWAL_JOB },
    action: 'VENDOR_SETTING_CHANGE_APPLIED',
    entityId: change.id,
    vendorId: vendor.id,
    beforeState: { setting: change.setting, ...change.current_value },
    afterState: {
      setting: change.setting,
      ...change.requested_value,
      requested_by_user_id: change.requested_by_user_id,
      effective_from: change.effective_from.toISOString(),
    },
  });
  return true;
}

async function vendorUpdateFor(tx: Transaction, change: ChangeRow, now: Date) {
  if (change.setting === 'PAYMENT_METHODS') {
    const parsed = methodsValue.safeParse(change.requested_value);
    return parsed.success ? { accepted_payment_methods: parsed.data.methods } : null;
  }
  const parsed = planValue.safeParse(change.requested_value);
  if (!parsed.success) return null;
  const [plan] = await tx
    .select()
    .from(pricingPlans)
    .where(eq(pricingPlans.id, parsed.data.pricing_plan_id));
  if (plan?.is_offered !== true) return null;
  const model: PricingModel = plan.model;
  return {
    pricing_plan_id: plan.id,
    pricing_model: model,
    // The plan states a percentage; the vendor row holds the fraction checkout multiplies by.
    commission_rate: plan.commission_rate / 100,
    // SPEC core 4: paying for a subscription starts its 90-day lock-in.
    ...(model === 'SUBSCRIPTION'
      ? { lock_in_expiry: new Date(now.getTime() + SUBSCRIPTION_LOCK_IN_DAYS * 86_400_000) }
      : {}),
  };
}
