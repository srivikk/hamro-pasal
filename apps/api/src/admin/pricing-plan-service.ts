import {
  pricingPlans,
  recordAuditLog,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import {
  NO_AUDIT_CONTEXT,
  type AuditContext,
  type PricingPlanCreate,
  type PricingPlanUpdate,
} from '@hamro-pasal/shared-types';
import { and, asc, eq, ne, sql } from 'drizzle-orm';

type PlanRow = typeof pricingPlans.$inferSelect;

export interface PricingPlanWithCount {
  readonly plan: PlanRow;
  /** Vendors whose active plan this is. */
  readonly vendorCount: number;
}

export class PricingPlanNotFoundError extends Error {
  constructor(readonly planId: string) {
    super(`Pricing plan ${planId} not found`);
    this.name = 'PricingPlanNotFoundError';
  }
}

/** Another plan already has this name (compared without regard to case). */
export class PricingPlanNameTakenError extends Error {
  constructor(readonly planName: string) {
    super(`Another pricing plan is already named "${planName}"`);
    this.name = 'PricingPlanNameTakenError';
  }
}

/**
 * The change would leave no default plan: the default was switched off or withdrawn directly, or
 * a first plan was created without being the default.
 */
export class DefaultPlanRequiredError extends Error {
  constructor() {
    super('Exactly one plan is the default: make another Commission plan the default instead');
    this.name = 'DefaultPlanRequiredError';
  }
}

export class DefaultPlanNotCommissionError extends Error {
  constructor() {
    super('Only a Commission plan can be the default');
    this.name = 'DefaultPlanNotCommissionError';
  }
}

/** Serialises every plan write: "exactly one default" is a rule over the whole table. */
const PRICING_PLANS_LOCK = 2600026;

/**
 * The pricing plans a Super Admin offers (SPEC core 4, "Onboarding Models").
 *
 * - **Immutable terms:** a plan's model, rate, fee and duration are written once, at creation.
 *   `update` has no parameter for them (and the request schema refuses them): a new rate is a new
 *   plan, and the old one is withdrawn while vendors already on it keep it.
 * - **Exactly one default**, an offered Commission plan (what an expired Free plan reverts to).
 *   Making a plan the default takes it from the previous one in the same transaction; the default
 *   cannot be switched off or withdrawn directly.
 *
 * Each write runs in one transaction with its audit entries.
 */
export class PricingPlanService {
  constructor(private readonly db: Database) {}

  /** Every plan, withdrawn ones included, by name. */
  async list(): Promise<PricingPlanWithCount[]> {
    const rows = await this.db
      .select({ plan: pricingPlans, vendorCount: vendorCountOf() })
      .from(pricingPlans)
      .orderBy(asc(sql`lower(${pricingPlans.name})`), asc(pricingPlans.id));
    return rows;
  }

  create(
    adminUserId: string,
    input: PricingPlanCreate,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<PricingPlanWithCount> {
    return this.db.transaction(async (tx) => {
      await lockPlans(tx);
      await assertNameFree(tx, input.name, null);
      const previousDefault = await currentDefault(tx);
      if (previousDefault === undefined && !input.is_default) throw new DefaultPlanRequiredError();
      if (input.is_default && previousDefault !== undefined) {
        await clearDefault(tx, previousDefault, adminUserId, context);
      }

      const [plan] = await tx
        .insert(pricingPlans)
        .values({
          name: input.name,
          model: input.model,
          commission_rate: input.commission_rate,
          monthly_fee_npr: input.monthly_fee_npr,
          duration_cycles: input.duration_cycles,
          is_offered: input.is_offered,
          is_default: input.is_default,
          created_by_user_id: adminUserId,
        })
        .returning();
      if (plan === undefined) throw new Error('The pricing plan was not stored');

      await recordAuditLog(tx, {
        actor: { kind: 'USER', user_id: adminUserId, role: 'SUPER_ADMIN' },
        action: 'PRICING_PLAN_CREATED',
        entityId: plan.id,
        vendorId: null,
        beforeState: null,
        afterState: planState(plan),
        context,
      });
      return { plan, vendorCount: 0 };
    });
  }

  /** Replaces the name and the two switches. Saving what is stored changes and records nothing. */
  update(
    adminUserId: string,
    planId: string,
    input: PricingPlanUpdate,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<PricingPlanWithCount> {
    return this.db.transaction(async (tx) => {
      await lockPlans(tx);
      const [before] = await tx.select().from(pricingPlans).where(eq(pricingPlans.id, planId));
      if (before === undefined) throw new PricingPlanNotFoundError(planId);

      if (input.is_default && before.model !== 'COMMISSION') {
        throw new DefaultPlanNotCommissionError();
      }
      // Never "no default": another Commission plan is made the default instead.
      if (before.is_default && !input.is_default) throw new DefaultPlanRequiredError();
      if (input.name.toLowerCase() !== before.name.toLowerCase()) {
        await assertNameFree(tx, input.name, planId);
      }

      const unchanged =
        before.name === input.name &&
        before.is_offered === input.is_offered &&
        before.is_default === input.is_default;
      if (unchanged) return withCount(tx, before);

      if (input.is_default && !before.is_default) {
        const previousDefault = await currentDefault(tx);
        if (previousDefault !== undefined) {
          await clearDefault(tx, previousDefault, adminUserId, context);
        }
      }
      const [after] = await tx
        .update(pricingPlans)
        .set({ name: input.name, is_offered: input.is_offered, is_default: input.is_default })
        .where(eq(pricingPlans.id, planId))
        .returning();
      if (after === undefined) throw new PricingPlanNotFoundError(planId);

      await recordAuditLog(tx, {
        actor: { kind: 'USER', user_id: adminUserId, role: 'SUPER_ADMIN' },
        action: 'PRICING_PLAN_UPDATED',
        entityId: planId,
        vendorId: null,
        beforeState: planState(before),
        afterState: planState(after),
        context,
      });
      return withCount(tx, after);
    });
  }
}

function vendorCountOf() {
  // Drizzle writes this single-table query's columns unqualified, so the subquery names the
  // outer table itself.
  return sql<number>`(SELECT count(*) FROM vendors v WHERE v.pricing_plan_id = "pricing_plans"."id")::int`;
}

async function lockPlans(tx: Transaction): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRICING_PLANS_LOCK})`);
}

async function assertNameFree(tx: Transaction, name: string, exceptId: string | null) {
  const [taken] = await tx
    .select({ id: pricingPlans.id })
    .from(pricingPlans)
    .where(
      and(
        sql`lower(${pricingPlans.name}) = lower(${name})`,
        exceptId === null ? undefined : ne(pricingPlans.id, exceptId),
      ),
    );
  if (taken !== undefined) throw new PricingPlanNameTakenError(name);
}

async function currentDefault(tx: Transaction): Promise<PlanRow | undefined> {
  const [plan] = await tx.select().from(pricingPlans).where(eq(pricingPlans.is_default, true));
  return plan;
}

/** Takes the default from the plan that had it, with that plan's own audit entry. */
async function clearDefault(
  tx: Transaction,
  previous: PlanRow,
  adminUserId: string,
  context: AuditContext,
): Promise<void> {
  const [cleared] = await tx
    .update(pricingPlans)
    .set({ is_default: false })
    .where(eq(pricingPlans.id, previous.id))
    .returning();
  if (cleared === undefined) throw new Error(`Pricing plan ${previous.id} vanished`);
  await recordAuditLog(tx, {
    actor: { kind: 'USER', user_id: adminUserId, role: 'SUPER_ADMIN' },
    action: 'PRICING_PLAN_UPDATED',
    entityId: previous.id,
    vendorId: null,
    beforeState: planState(previous),
    afterState: planState(cleared),
    context,
  });
}

async function withCount(tx: Transaction, plan: PlanRow): Promise<PricingPlanWithCount> {
  const [count] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(vendors)
    .where(eq(vendors.pricing_plan_id, plan.id));
  return { plan, vendorCount: count?.count ?? 0 };
}

function planState(plan: PlanRow) {
  return {
    name: plan.name,
    model: plan.model,
    commission_rate: plan.commission_rate,
    monthly_fee_npr: plan.monthly_fee_npr,
    duration_cycles: plan.duration_cycles,
    is_offered: plan.is_offered,
    is_default: plan.is_default,
  };
}
