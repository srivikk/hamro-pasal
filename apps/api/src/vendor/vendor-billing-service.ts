import {
  pricingPlans,
  recordAuditLog,
  vendorSettingChanges,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import type {
  AuditActor,
  AuditContext,
  AuditState,
  BillingChangeRequest,
  SettingChangeStatus,
} from '@hamro-pasal/shared-types';
import { and, eq, sql } from 'drizzle-orm';

import { VendorAccountNotFoundError } from '../orders/vendor-order-service';
import type { VendorRow } from './vendor-compliance-service';

export type SettingChangeRow = typeof vendorSettingChanges.$inferSelect;

/** The shop has no Billing Cycle yet (it is not LIVE, or the renewal job has not started one). */
export class BillingCycleNotStartedError extends Error {
  constructor() {
    super('This shop has no billing cycle yet');
    this.name = 'BillingCycleNotStartedError';
  }
}

export class PricingPlanNotOfferedError extends Error {
  constructor(readonly pricingPlanId: string) {
    super('This pricing plan is not on offer');
    this.name = 'PricingPlanNotOfferedError';
  }
}

/** SPEC core 4: a subscription cannot be left inside its 90-day lock-in. */
export class LockInActiveError extends Error {
  constructor(readonly lockInExpiry: Date) {
    super('The subscription lock-in has not ended');
    this.name = 'LockInActiveError';
  }
}

export class SettingChangeNotFoundError extends Error {
  constructor(readonly changeId: string) {
    super('Queued change not found');
    this.name = 'SettingChangeNotFoundError';
  }
}

export class SettingChangeClosedError extends Error {
  constructor(readonly status: SettingChangeStatus) {
    super(`This change is already ${status}`);
    this.name = 'SettingChangeClosedError';
  }
}

type VendorActor = AuditActor & { kind: 'USER' };

/**
 * The Billing Cycle queue (SPEC core 4, "Billing Cycle Lock"). A vendor may ask to change its
 * pricing plan or accepted payment methods at any time; nothing changes until the cycle renews.
 * This service only queues: the worker's BILLING_CYCLE_RENEWAL applies, under the same vendor row
 * lock, so a request and the renewal can never half-apply (SPEC edge case 9).
 */
export class VendorBillingService {
  constructor(private readonly db: Database) {}

  /** Queues a change (replacing a waiting one of the same setting). Null: it equals the active value. */
  requestChange(
    actor: VendorActor,
    input: BillingChangeRequest,
    context: AuditContext,
  ): Promise<SettingChangeRow | null> {
    return this.db.transaction(async (tx) => {
      const vendor = await lockVendor(tx, actor.user_id);
      if (vendor.billing_cycle_ends_at === null) throw new BillingCycleNotStartedError();

      const current = activeValue(vendor, input.setting);
      const requested: AuditState =
        input.setting === 'PRICING_PLAN'
          ? { pricing_plan_id: input.value.pricing_plan_id }
          : { methods: [...input.value.methods].sort() };
      if (input.setting === 'PRICING_PLAN') {
        await assertPlanSelectable(tx, vendor, input.value.pricing_plan_id);
      }

      // One waiting change per setting: the new request replaces it.
      await tx
        .update(vendorSettingChanges)
        .set({ status: 'SUPERSEDED', closed_at: sql`now()` })
        .where(
          and(
            eq(vendorSettingChanges.vendor_id, vendor.id),
            eq(vendorSettingChanges.setting, input.setting),
            eq(vendorSettingChanges.status, 'PENDING'),
          ),
        );
      // Asking for what is already active just withdraws whatever was waiting.
      if (JSON.stringify(current) === JSON.stringify(requested)) return null;

      const [change] = await tx
        .insert(vendorSettingChanges)
        .values({
          vendor_id: vendor.id,
          setting: input.setting,
          current_value: current,
          requested_value: requested,
          requested_by_user_id: actor.user_id,
          effective_from: vendor.billing_cycle_ends_at,
        })
        .returning();
      if (change === undefined) throw new Error('The change was not stored');
      await recordAuditLog(tx, {
        actor,
        action: 'VENDOR_SETTING_CHANGE_REQUESTED',
        entityId: change.id,
        vendorId: vendor.id,
        beforeState: { setting: input.setting, ...current },
        afterState: {
          setting: input.setting,
          ...requested,
          effective_from: change.effective_from.toISOString(),
        },
        context,
      });
      return change;
    });
  }

  /** Withdraws a waiting change. A repeat is fine; an applied or replaced one cannot be withdrawn. */
  withdrawChange(actor: VendorActor, changeId: string, context: AuditContext): Promise<void> {
    return this.db.transaction(async (tx) => {
      const vendor = await lockVendor(tx, actor.user_id);
      const [change] = await tx
        .select()
        .from(vendorSettingChanges)
        .where(
          and(eq(vendorSettingChanges.id, changeId), eq(vendorSettingChanges.vendor_id, vendor.id)),
        );
      if (change === undefined) throw new SettingChangeNotFoundError(changeId);
      if (change.status === 'WITHDRAWN') return;
      if (change.status !== 'PENDING') throw new SettingChangeClosedError(change.status);

      await tx
        .update(vendorSettingChanges)
        .set({ status: 'WITHDRAWN', closed_at: sql`now()` })
        .where(eq(vendorSettingChanges.id, changeId));
      await recordAuditLog(tx, {
        actor,
        action: 'VENDOR_SETTING_CHANGE_WITHDRAWN',
        entityId: change.id,
        vendorId: vendor.id,
        beforeState: { status: 'PENDING', ...change.requested_value },
        afterState: { status: 'WITHDRAWN' },
        context,
      });
    });
  }
}

/** The vendor row lock the renewal job also takes: a request and a renewal never interleave. */
async function lockVendor(tx: Transaction, userId: string): Promise<VendorRow> {
  const [vendor] = await tx.select().from(vendors).where(eq(vendors.user_id, userId)).for('update');
  if (vendor === undefined) throw new VendorAccountNotFoundError(userId);
  return vendor;
}

function activeValue(vendor: VendorRow, setting: BillingChangeRequest['setting']): AuditState {
  return setting === 'PRICING_PLAN'
    ? { pricing_plan_id: vendor.pricing_plan_id }
    : { methods: [...vendor.accepted_payment_methods].sort() };
}

async function assertPlanSelectable(tx: Transaction, vendor: VendorRow, planId: string) {
  const [plan] = await tx.select().from(pricingPlans).where(eq(pricingPlans.id, planId));
  if (plan?.is_offered !== true) throw new PricingPlanNotOfferedError(planId);
  const leavingSubscription =
    vendor.pricing_model === 'SUBSCRIPTION' && plan.model !== 'SUBSCRIPTION';
  if (leavingSubscription && vendor.lock_in_expiry !== null && vendor.lock_in_expiry > new Date()) {
    throw new LockInActiveError(vendor.lock_in_expiry);
  }
}
