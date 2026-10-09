import {
  adPurchases,
  auditLogs,
  campaignOptIns,
  deviceTokens,
  payoutRequests,
  recordAuditLog,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import {
  adFeesDuePaisa,
  collectAdFeesDue,
  releaseUnusedAdBudget,
  toNpr,
  toPaisa,
  type LedgerService,
} from '@hamro-pasal/ledger';
import type {
  AuditActor,
  AuditContext,
  VendorDeactivationBlocker,
} from '@hamro-pasal/shared-types';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';

import { VendorAccountNotFoundError } from '../orders/vendor-order-service';

type AdPurchaseRow = typeof adPurchases.$inferSelect;

export interface VendorDeactivation {
  readonly vendorId: string;
  readonly deactivatedAt: Date;
  readonly cancelledAdCount: number;
  readonly returnedNpr: number;
  readonly closedOptInCount: number;
  readonly walletBalanceNpr: number;
}

/** Money or goods are still in motion: the shop cannot be closed under them. */
export class VendorNotDeactivatableError extends Error {
  constructor(readonly blockers: readonly VendorDeactivationBlocker[]) {
    super(`The shop cannot be deactivated yet: ${blockers.join(', ')}`);
    this.name = 'VendorNotDeactivatableError';
  }
}

function adState(purchase: AdPurchaseRow) {
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
 * Closing a shop (Phase 36, SPEC vendor flow step 23). A vendor is never hard-deleted: its orders,
 * invoices, journals and audit entries name it. The row stays, with `status = 'DEACTIVATED'`:
 * out of the feed and the product list, not orderable, and its account can no longer sign in.
 *
 * One transaction under the **vendor row lock** (FOR UPDATE: the lock a checkout, a payout, every
 * ad path and a settlement model approval wait for), then in the order every ad path uses: the
 * ad purchase rows, the ledger accounts; then the opt-in rows (the order an opt-out uses).
 *
 * 1. Flat-rate ads that have not started are cancelled and what was paid for them is returned.
 * 2. Flat fees still owed for ads that did run are taken from the wallet.
 * 3. **The blockers are read**, under the lock, after those two steps. Any of them rolls the
 *    whole transaction back (the refunds and the collection with it) and names itself.
 * 4. Every other running or paused ad is cancelled: a held per-order budget goes back to the
 *    wallet; a flat fee for a period that began stays paid (decided 2026-10-08).
 * 5. The shop's live campaign opt-ins are closed as its own opt-out.
 * 6. The account's device tokens are removed (no more pushes), the status is set, and the three
 *    remembered suspension statuses are cleared: nothing restores a closed shop.
 *
 * A positive wallet balance is not a blocker: the platform still owes it, and a Super Admin pays
 * it out (the settlement list does not look at the status).
 */
export class VendorDeactivationService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
  ) {}

  deactivate(
    actor: AuditActor & { kind: 'USER' },
    context: AuditContext,
  ): Promise<VendorDeactivation> {
    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(vendors)
        .where(eq(vendors.user_id, actor.user_id))
        .for('update');
      if (before === undefined) throw new VendorAccountNotFoundError(actor.user_id);
      if (before.status === 'DEACTIVATED') return alreadyDeactivated(tx, before);

      const { rows: clock } = await tx.execute<{ now: Date }>(sql`SELECT now() AS now`);
      const now = new Date(clock[0]?.now ?? Date.now());

      const running = await tx
        .select()
        .from(adPurchases)
        .where(
          and(
            eq(adPurchases.vendor_id, before.id),
            inArray(adPurchases.status, ['ACTIVE', 'PAUSED']),
          ),
        )
        .orderBy(asc(adPurchases.agreed_at), asc(adPurchases.id))
        .for('update');
      const unstartedFlat = (ad: AdPurchaseRow) =>
        ad.billing_model === 'FLAT_RATE' && ad.starts_at > now;

      let returnedPaisa = 0;
      const cancel = async (ad: AdPurchaseRow): Promise<void> => {
        const returned = unstartedFlat(ad)
          ? await this.refundFlatFee(tx, ad)
          : await releaseUnusedAdBudget(tx, this.ledger, ad);
        returnedPaisa += returned;
        const [after] = await tx
          .update(adPurchases)
          .set({ status: 'CANCELLED', ...(unstartedFlat(ad) ? { amount_paid_npr: 0 } : {}) })
          .where(eq(adPurchases.id, ad.id))
          .returning();
        if (after === undefined) throw new Error(`Ad purchase ${ad.id} vanished`);
        await recordAuditLog(tx, {
          actor,
          action: 'AD_CANCELLED',
          entityId: ad.id,
          vendorId: before.id,
          beforeState: adState(ad),
          afterState: {
            ...adState(after),
            returned_npr: toNpr(returned),
            reason: 'VENDOR_DEACTIVATED',
          },
          context,
        });
      };

      for (const ad of running.filter(unstartedFlat)) await cancel(ad);
      await collectAdFeesDue(tx, this.ledger, before.id);

      const blockers = await blockersOf(tx, before.id);
      if (blockers.length > 0) throw new VendorNotDeactivatableError(blockers);

      for (const ad of running.filter((each) => !unstartedFlat(each))) await cancel(ad);

      const optIns = await tx
        .select()
        .from(campaignOptIns)
        .where(and(eq(campaignOptIns.vendor_id, before.id), eq(campaignOptIns.status, 'ACTIVE')))
        .orderBy(asc(campaignOptIns.opted_in_at), asc(campaignOptIns.id))
        .for('update');
      for (const optIn of optIns) {
        const [closed] = await tx
          .update(campaignOptIns)
          .set({ status: 'OPTED_OUT', closed_at: sql`now()`, closed_by_user_id: actor.user_id })
          .where(eq(campaignOptIns.id, optIn.id))
          .returning();
        if (closed === undefined) throw new Error(`Opt-in ${optIn.id} vanished`);
        await recordAuditLog(tx, {
          actor,
          action: 'CAMPAIGN_OPTED_OUT',
          entityId: optIn.id,
          vendorId: before.id,
          beforeState: { status: optIn.status, opt_in_terms_version: optIn.opt_in_terms_version },
          afterState: {
            campaign_id: optIn.campaign_id,
            status: closed.status,
            opt_in_terms_version: closed.opt_in_terms_version,
            closed_at: closed.closed_at?.toISOString() ?? null,
            reason: 'VENDOR_DEACTIVATED',
          },
          context,
        });
      }

      await tx.delete(deviceTokens).where(eq(deviceTokens.user_id, actor.user_id));

      const [after] = await tx
        .update(vendors)
        .set({
          status: 'DEACTIVATED',
          status_before_debt_suspension: null,
          status_before_admin_suspension: null,
          status_before_compliance_suspension: null,
        })
        .where(eq(vendors.id, before.id))
        .returning();
      if (after === undefined) throw new Error(`Vendor ${before.id} vanished`);

      const result = {
        cancelledAdCount: running.length,
        returnedNpr: toNpr(returnedPaisa),
        closedOptInCount: optIns.length,
        walletBalanceNpr: after.wallet_balance_npr,
      };
      await recordAuditLog(tx, {
        actor,
        action: 'VENDOR_DEACTIVATED',
        entityId: before.id,
        vendorId: before.id,
        beforeState: { status: before.status, wallet_balance_npr: before.wallet_balance_npr },
        afterState: {
          status: after.status,
          wallet_balance_npr: result.walletBalanceNpr,
          cancelled_ad_count: result.cancelledAdCount,
          returned_npr: result.returnedNpr,
          closed_opt_in_count: result.closedOptInCount,
        },
        context,
      });
      return { vendorId: before.id, deactivatedAt: now, ...result };
    });
  }

  /** What the shop paid for a flat-rate ad that never started goes back (the vendor's own cancel does the same). */
  private async refundFlatFee(tx: Transaction, ad: AdPurchaseRow): Promise<number> {
    const paid = toPaisa(ad.amount_paid_npr);
    if (paid <= 0) return 0;
    const line = { lineType: 'AD_FLAT_FEE', adPurchaseId: ad.id } as const;
    await this.ledger.post(tx, {
      kind: 'AD_REFUND',
      idempotencyKey: `ad-refund:${ad.id}`,
      orderId: null,
      description: 'Ad cancelled before it started: flat fee returned',
      postings: [
        { account: { type: 'AD_REVENUE' }, amountPaisa: -paid, ...line },
        { account: { type: 'VENDOR_WALLET', vendorId: ad.vendor_id }, amountPaisa: paid, ...line },
      ],
    });
    return paid;
  }
}

/**
 * What still stands in the way, read under the vendor row lock. An unpaid checkout counts only
 * while its 600-second inventory lock can still be claimed (the settlement model rule, §8Z.26).
 */
async function blockersOf(tx: Transaction, vendorId: string): Promise<VendorDeactivationBlocker[]> {
  const { rows } = await tx.execute<{ balance: string; open_orders: number }>(sql`
    SELECT v.wallet_balance_npr::text AS balance,
           (SELECT count(*) FROM orders o
             WHERE o.vendor_id = v.id
               AND (o.state IN ('PLACED', 'PREPARING', 'OUT_FOR_DELIVERY', 'DISPUTED')
                 OR (o.state = 'PENDING_PAYMENT'
                     AND o.created_at > now() - interval '600 seconds')))::int AS open_orders
    FROM vendors v WHERE v.id = ${vendorId}`);
  const [payout] = await tx
    .select({ id: payoutRequests.id })
    .from(payoutRequests)
    .where(
      and(
        eq(payoutRequests.vendor_id, vendorId),
        or(
          eq(payoutRequests.status, 'PENDING'),
          eq(payoutRequests.transfer_state, 'PROCESSING_BANK_TRANSFER'),
        ),
      ),
    )
    .limit(1);

  const blockers: VendorDeactivationBlocker[] = [];
  if (Number(rows[0]?.balance ?? 0) < 0) blockers.push('NEGATIVE_BALANCE');
  if ((rows[0]?.open_orders ?? 0) > 0) blockers.push('ACTIVE_ORDERS');
  if (payout !== undefined) blockers.push('PENDING_PAYOUT');
  if ((await adFeesDuePaisa(tx, vendorId)) > 0) blockers.push('AD_FEES_DUE');
  return blockers;
}

/** A repeat: the answer of the request that closed the shop, from its audit entry. */
async function alreadyDeactivated(
  tx: Transaction,
  vendor: typeof vendors.$inferSelect,
): Promise<VendorDeactivation> {
  const [entry] = await tx
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entity_id, vendor.id), eq(auditLogs.action, 'VENDOR_DEACTIVATED')))
    .orderBy(asc(auditLogs.occurred_at))
    .limit(1);
  const state = (entry?.after_state ?? {}) as Record<string, unknown>;
  const count = (key: string): number => (typeof state[key] === 'number' ? state[key] : 0);
  return {
    vendorId: vendor.id,
    deactivatedAt: entry?.occurred_at ?? new Date(),
    cancelledAdCount: count('cancelled_ad_count'),
    returnedNpr: count('returned_npr'),
    closedOptInCount: count('closed_opt_in_count'),
    walletBalanceNpr: Math.max(0, vendor.wallet_balance_npr),
  };
}
