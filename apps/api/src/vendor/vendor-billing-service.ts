import {
  platformSettings,
  pricingPlans,
  recordAuditLog,
  vendorSettingChanges,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import type {
  AdminPlanAssignResponseBody,
  AuditActor,
  AuditContext,
  AuditState,
  BillingChangeRequest,
  BillingChangeView,
  OfferedPlanView,
  SettingChangeStatus,
  VendorBillingView,
} from '@hamro-pasal/shared-types';
import { and, asc, eq, sql } from 'drizzle-orm';

import { HttpError } from '../http/http-error';
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

/**
 * Decided 2026-10-21: a shop chooses Subscription plans only. Commission and Free plans are a
 * Super Admin's to assign (PUT /api/admin/vendors/:id/pricing-plan).
 */
export class PricingPlanAdminOnlyError extends HttpError {
  constructor(readonly pricingPlanId: string) {
    super(422, 'PRICING_PLAN_ADMIN_ONLY', 'Only Hamro Pasal can put a shop on this plan', {
      pricing_plan_id: pricingPlanId,
    });
  }
}

/** How long a subscription is locked in once it starts (SPEC core 4: 90 days). */
const SUBSCRIPTION_LOCK_IN_MS = 90 * 86_400_000;

type PlanRow = typeof pricingPlans.$inferSelect;

export function offeredPlanView(plan: PlanRow): OfferedPlanView {
  return {
    id: plan.id,
    name: plan.name,
    model: plan.model,
    commission_rate: plan.commission_rate,
    monthly_fee_npr: plan.monthly_fee_npr,
    duration_cycles: plan.duration_cycles,
  };
}

export function billingChangeView(change: SettingChangeRow): BillingChangeView {
  return {
    id: change.id,
    setting: change.setting,
    current_value: change.current_value,
    requested_value: change.requested_value,
    status: change.status,
    requested_at: change.requested_at.toISOString(),
    effective_from: change.effective_from.toISOString(),
  };
}

/** The Subscription plans on offer, cheapest first: what a shop may choose itself. */
export async function selfSelectablePlans(executor: Pick<Database, 'select'>): Promise<PlanRow[]> {
  return executor
    .select()
    .from(pricingPlans)
    .where(and(eq(pricingPlans.is_offered, true), eq(pricingPlans.model, 'SUBSCRIPTION')))
    .orderBy(asc(pricingPlans.monthly_fee_npr), asc(pricingPlans.name));
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

  /** GET /api/vendor/billing (2026-10-21). */
  async view(vendorUserId: string): Promise<VendorBillingView> {
    const [vendor] = await this.db.select().from(vendors).where(eq(vendors.user_id, vendorUserId));
    if (vendor === undefined) throw new VendorAccountNotFoundError(vendorUserId);
    const [plan] =
      vendor.pricing_plan_id === null
        ? []
        : await this.db
            .select()
            .from(pricingPlans)
            .where(eq(pricingPlans.id, vendor.pricing_plan_id));
    const pending = await this.db
      .select()
      .from(vendorSettingChanges)
      .where(
        and(
          eq(vendorSettingChanges.vendor_id, vendor.id),
          eq(vendorSettingChanges.status, 'PENDING'),
        ),
      )
      .orderBy(asc(vendorSettingChanges.requested_at));
    const [settings] = await this.db
      .select({ reserve: platformSettings.prepaid_reserve_npr })
      .from(platformSettings);
    if (settings === undefined) throw new Error('platform_settings row is missing');
    const dues =
      vendor.dues_amount_npr === null ||
      vendor.dues_notice_opened_at === null ||
      vendor.dues_due_at === null
        ? null
        : {
            amount_npr: vendor.dues_amount_npr,
            opened_at: vendor.dues_notice_opened_at.toISOString(),
            due_at: vendor.dues_due_at.toISOString(),
          };
    return {
      vendor_id: vendor.id,
      settlement_model: vendor.settlement_model,
      pricing_plan: plan === undefined ? null : offeredPlanView(plan),
      accepted_payment_methods: vendor.accepted_payment_methods,
      billing_cycle_started_at: vendor.billing_cycle_started_at?.toISOString() ?? null,
      billing_cycle_ends_at: vendor.billing_cycle_ends_at?.toISOString() ?? null,
      pending_changes: pending.map(billingChangeView),
      self_selectable_plans: (await selfSelectablePlans(this.db)).map(offeredPlanView),
      dues,
      prepaid_reserve_npr: settings.reserve,
    };
  }

  /**
   * PUT /api/admin/vendors/:id/pricing-plan (decided 2026-10-21): a Super Admin assigns any offered
   * plan, Commission and Free included. A shop with a Billing Cycle gets it when the cycle renews
   * (queued like the shop's own change, replacing a waiting one); a shop without one (not LIVE yet)
   * gets it at once. Audited. The subscription lock-in does not bind the Super Admin.
   */
  assignPlan(
    adminUserId: string,
    vendorId: string,
    planId: string,
    context: AuditContext,
  ): Promise<AdminPlanAssignResponseBody> {
    return this.db.transaction(async (tx) => {
      const [vendor] = await tx
        .select()
        .from(vendors)
        .where(eq(vendors.id, vendorId))
        .for('update');
      if (vendor === undefined) throw new HttpError(404, 'VENDOR_NOT_FOUND', 'Vendor not found');
      const [plan] = await tx.select().from(pricingPlans).where(eq(pricingPlans.id, planId));
      if (plan?.is_offered !== true) throw new PricingPlanNotOfferedError(planId);
      const actor: AuditActor = { kind: 'USER', user_id: adminUserId, role: 'SUPER_ADMIN' };
      const before = {
        pricing_plan_id: vendor.pricing_plan_id,
        pricing_model: vendor.pricing_model,
      };

      if (vendor.billing_cycle_ends_at === null) {
        await tx
          .update(vendors)
          .set({
            pricing_plan_id: plan.id,
            pricing_model: plan.model,
            commission_rate: plan.commission_rate / 100,
            lock_in_expiry:
              plan.model === 'SUBSCRIPTION' ? new Date(Date.now() + SUBSCRIPTION_LOCK_IN_MS) : null,
          })
          .where(eq(vendors.id, vendor.id));
        await recordAuditLog(tx, {
          actor,
          action: 'PRICING_PLAN_ASSIGNED',
          entityId: vendor.id,
          vendorId: vendor.id,
          beforeState: before,
          afterState: { pricing_plan_id: plan.id, pricing_model: plan.model, effective: 'NOW' },
          context,
        });
        return {
          vendor_id: vendor.id,
          pricing_plan_id: plan.id,
          effective: 'NOW' as const,
          effective_from: null,
        };
      }

      await tx
        .update(vendorSettingChanges)
        .set({ status: 'SUPERSEDED', closed_at: sql`now()` })
        .where(
          and(
            eq(vendorSettingChanges.vendor_id, vendor.id),
            eq(vendorSettingChanges.setting, 'PRICING_PLAN'),
            eq(vendorSettingChanges.status, 'PENDING'),
          ),
        );
      const [change] = await tx
        .insert(vendorSettingChanges)
        .values({
          vendor_id: vendor.id,
          setting: 'PRICING_PLAN',
          current_value: { pricing_plan_id: vendor.pricing_plan_id },
          requested_value: { pricing_plan_id: plan.id },
          requested_by_user_id: adminUserId,
          effective_from: vendor.billing_cycle_ends_at,
        })
        .returning();
      if (change === undefined) throw new Error('The change was not stored');
      await recordAuditLog(tx, {
        actor,
        action: 'PRICING_PLAN_ASSIGNED',
        entityId: vendor.id,
        vendorId: vendor.id,
        beforeState: before,
        afterState: {
          pricing_plan_id: plan.id,
          pricing_model: plan.model,
          effective: 'NEXT_CYCLE',
          effective_from: change.effective_from.toISOString(),
        },
        context,
      });
      return {
        vendor_id: vendor.id,
        pricing_plan_id: plan.id,
        effective: 'NEXT_CYCLE' as const,
        effective_from: change.effective_from.toISOString(),
      };
    });
  }

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
        await assertPlanSelectable(tx, input.value.pricing_plan_id);
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

async function assertPlanSelectable(tx: Transaction, planId: string) {
  const [plan] = await tx.select().from(pricingPlans).where(eq(pricingPlans.id, planId));
  if (plan?.is_offered !== true) throw new PricingPlanNotOfferedError(planId);
  // 2026-10-21: a shop may only choose a Subscription plan itself, so its own request never
  // leaves a Subscription and the 90-day lock-in cannot be broken from here. Only a Super Admin
  // moves a shop off a Subscription (assignPlan).
  if (plan.model !== 'SUBSCRIPTION') throw new PricingPlanAdminOnlyError(planId);
}
