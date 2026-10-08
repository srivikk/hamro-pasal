import { adPurchases, recordAuditLog, vendors, type Database } from '@hamro-pasal/db';
import { releaseUnusedAdBudget, toNpr, type LedgerService } from '@hamro-pasal/ledger';
import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm';

export const MARKETING_STATUS_SWEEP_JOB = 'MARKETING_STATUS_SWEEP';

export interface MarketingSweepSummary {
  /** Purchases whose paid period is over: ACTIVE or PAUSED → ENDED. */
  readonly ended: number;
  /** Per-order ads whose budget cannot cover one more fee: ACTIVE → PAUSED. */
  readonly paused: number;
  /** Held budget returned to shops by the ads that ended, in NPR. */
  readonly budgetReleasedNpr: number;
}

type AdPurchaseRow = typeof adPurchases.$inferSelect;

function statusState(purchase: AdPurchaseRow) {
  return {
    status: purchase.status,
    billing_model: purchase.billing_model,
    price_npr: purchase.price_npr,
    budget_npr: purchase.budget_npr,
    amount_paid_npr: purchase.amount_paid_npr,
    starts_at: purchase.starts_at.toISOString(),
    ends_at: purchase.ends_at.toISOString(),
  };
}

/**
 * The hourly upkeep of ad purchases (SPEC core 8, edge case 8).
 *
 * - **Ends** every ACTIVE or PAUSED purchase whose `ends_at` has passed, and returns the unused
 *   part of a held per-order budget to the shop in the same transaction. A flat fee a Model B shop
 *   still owes stays due: an ended ad was delivered.
 * - **Pauses** an ACTIVE per-order ad whose remaining budget is under one fee, so the next order
 *   is never charged a premium the budget did not hold. Nothing charges a premium yet, so today
 *   this finds nothing; it is the rule the per-order posting will rely on.
 *
 * One transaction per purchase. Locks in the order every ad path uses: the vendor row, then the
 * purchase row, then the ledger accounts. The conditions are re-read under the locks against the
 * database clock, so a rerun, a second worker or a cancellation racing the sweep changes a
 * purchase once. Each change is audited with the job as the actor.
 */
export class MarketingStatusSweepService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
  ) {}

  async run(): Promise<MarketingSweepSummary> {
    const { ended, releasedPaisa } = await this.endFinishedPurchases();
    const paused = await this.pauseExhaustedBudgets();
    return { ended, paused, budgetReleasedNpr: toNpr(releasedPaisa) };
  }

  private async endFinishedPurchases(): Promise<{ ended: number; releasedPaisa: number }> {
    const finished = and(
      inArray(adPurchases.status, ['ACTIVE', 'PAUSED']),
      lte(adPurchases.ends_at, sql`now()`),
    );
    const candidates = await this.db
      .select({ id: adPurchases.id, vendorId: adPurchases.vendor_id })
      .from(adPurchases)
      .where(finished)
      .orderBy(asc(adPurchases.ends_at), asc(adPurchases.id));

    let ended = 0;
    let releasedPaisa = 0;
    for (const { id, vendorId } of candidates) {
      const released = await this.db.transaction(async (tx) => {
        await tx
          .select({ id: vendors.id })
          .from(vendors)
          .where(eq(vendors.id, vendorId))
          .for('update');
        const [before] = await tx
          .select()
          .from(adPurchases)
          .where(and(eq(adPurchases.id, id), finished))
          .for('update');
        if (before === undefined) return null;

        const returned = await releaseUnusedAdBudget(tx, this.ledger, before);
        const [after] = await tx
          .update(adPurchases)
          .set({ status: 'ENDED' })
          .where(eq(adPurchases.id, id))
          .returning();
        if (after === undefined) throw new Error(`Ad purchase ${id} vanished`);
        await recordAuditLog(tx, {
          actor: { kind: 'SYSTEM', job: MARKETING_STATUS_SWEEP_JOB },
          action: 'AD_ENDED',
          entityId: id,
          vendorId,
          beforeState: statusState(before),
          afterState: { ...statusState(after), returned_npr: toNpr(returned) },
        });
        return returned;
      });
      if (released !== null) {
        ended += 1;
        releasedPaisa += released;
      }
    }
    return { ended, releasedPaisa };
  }

  private async pauseExhaustedBudgets(): Promise<number> {
    const exhausted = and(
      eq(adPurchases.status, 'ACTIVE'),
      eq(adPurchases.billing_model, 'PER_ORDER_PREMIUM'),
      gt(adPurchases.ends_at, sql`now()`),
      sql`${adPurchases.budget_npr} - ${adPurchases.amount_paid_npr} < ${adPurchases.price_npr}`,
    );
    const candidates = await this.db
      .select({ id: adPurchases.id, vendorId: adPurchases.vendor_id })
      .from(adPurchases)
      .where(exhausted)
      .orderBy(asc(adPurchases.id));

    let paused = 0;
    for (const { id, vendorId } of candidates) {
      const changed = await this.db.transaction(async (tx) => {
        await tx
          .select({ id: vendors.id })
          .from(vendors)
          .where(eq(vendors.id, vendorId))
          .for('update');
        const [before] = await tx
          .select()
          .from(adPurchases)
          .where(and(eq(adPurchases.id, id), exhausted))
          .for('update');
        if (before === undefined) return false;
        const [after] = await tx
          .update(adPurchases)
          .set({ status: 'PAUSED' })
          .where(eq(adPurchases.id, id))
          .returning();
        if (after === undefined) throw new Error(`Ad purchase ${id} vanished`);
        await recordAuditLog(tx, {
          actor: { kind: 'SYSTEM', job: MARKETING_STATUS_SWEEP_JOB },
          action: 'AD_PAUSED_BUDGET_EXHAUSTED',
          entityId: id,
          vendorId,
          beforeState: statusState(before),
          afterState: statusState(after),
        });
        return true;
      });
      if (changed) paused += 1;
    }
    return paused;
  }
}
