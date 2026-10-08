import { adPurchases, orders, recordAuditLog, vendors, type Transaction } from '@hamro-pasal/db';
import { and, asc, eq, gt, lte } from 'drizzle-orm';

import type { LedgerService } from './ledger-service';
import { toNpr, toPaisa } from './money';

/** The actor of the audit entry written when a charge uses up an ad's budget. */
export const AD_ORDER_PREMIUM_JOB = 'AD_ORDER_PREMIUM';

export type AdOrderPremiumOutcome =
  /** No per-order ad of the shop was running when the order was placed. */
  | { readonly status: 'NONE' }
  /** The fee was posted. `paused`: what is left of the budget is under one more fee. */
  | {
      readonly status: 'CHARGED';
      readonly purchaseId: string;
      readonly amountNpr: number;
      readonly paused: boolean;
    }
  /** This order was charged before (a retried delivery, the nightly reconciliation). */
  | { readonly status: 'ALREADY_CHARGED'; readonly purchaseId: string }
  /** The budget did not hold one fee: the ad is paused and the order is not charged. */
  | { readonly status: 'PAUSED_UNCHARGED'; readonly purchaseId: string };

type AdPurchaseRow = typeof adPurchases.$inferSelect;

function budgetState(purchase: AdPurchaseRow) {
  return {
    status: purchase.status,
    price_npr: purchase.price_npr,
    budget_npr: purchase.budget_npr,
    amount_paid_npr: purchase.amount_paid_npr,
  };
}

/**
 * The per-order ad premium (SPEC core 8): a fixed fee for each delivered order **placed while
 * the vendor's own PER_ORDER_PREMIUM ad was running**, up to the budget the vendor set. Call it
 * inside the transaction that settles the order, after the settlement journal.
 *
 * - The fee is its own journal line, AD_ORDER_PREMIUM to AD_REVENUE, never part of the commission.
 *   A Model B shop pays it from its wallet (which the settlement has just credited); a shop that
 *   pays from its ledger (Models A and C) pays it from the budget held at purchase
 *   (AD_BUDGET_CLEARING).
 * - **An order is never charged a premium the budget did not hold** (SPEC edge case 8): with less
 *   than one fee left the ad is paused and nothing is posted. A charge that leaves less than one
 *   fee pauses the ad in the same transaction.
 * - One journal per purchase and order (`ad-order-premium:<purchase>:<order>`): a second call for
 *   the same order posts nothing.
 * - Locks: the vendor row, then the purchase row, then the ledger accounts.
 * - A shop with several running per-order ads is charged for the oldest one.
 */
export async function chargePerOrderAdPremium(
  tx: Transaction,
  ledger: LedgerService,
  orderId: string,
  vendorId: string,
): Promise<AdOrderPremiumOutcome> {
  await tx.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, vendorId)).for('update');
  const [order] = await tx
    .select({ placedAt: orders.placed_at })
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.vendor_id, vendorId)));
  const placedAt = order?.placedAt ?? null;
  if (placedAt === null) return { status: 'NONE' };

  const [purchase] = await tx
    .select()
    .from(adPurchases)
    .where(
      and(
        eq(adPurchases.vendor_id, vendorId),
        eq(adPurchases.billing_model, 'PER_ORDER_PREMIUM'),
        eq(adPurchases.status, 'ACTIVE'),
        lte(adPurchases.starts_at, placedAt),
        gt(adPurchases.ends_at, placedAt),
      ),
    )
    .orderBy(asc(adPurchases.agreed_at), asc(adPurchases.id))
    .limit(1)
    .for('update');
  const budgetNpr = purchase?.budget_npr ?? null;
  if (purchase === undefined || budgetNpr === null) return { status: 'NONE' };

  const fee = toPaisa(purchase.price_npr);
  const budget = toPaisa(budgetNpr);
  const paid = toPaisa(purchase.amount_paid_npr);

  const pause = async (before: AdPurchaseRow): Promise<void> => {
    const [after] = await tx
      .update(adPurchases)
      .set({ status: 'PAUSED' })
      .where(eq(adPurchases.id, before.id))
      .returning();
    if (after === undefined) throw new Error(`Ad purchase ${before.id} vanished`);
    await recordAuditLog(tx, {
      actor: { kind: 'SYSTEM', job: AD_ORDER_PREMIUM_JOB },
      action: 'AD_PAUSED_BUDGET_EXHAUSTED',
      entityId: before.id,
      vendorId,
      beforeState: budgetState(before),
      afterState: { ...budgetState(after), order_id: orderId },
    });
  };

  if (budget - paid < fee) {
    await pause(purchase);
    return { status: 'PAUSED_UNCHARGED', purchaseId: purchase.id };
  }

  const line = { lineType: 'AD_ORDER_PREMIUM', adPurchaseId: purchase.id } as const;
  const journal = await ledger.post(tx, {
    kind: 'AD_PURCHASE',
    idempotencyKey: `ad-order-premium:${purchase.id}:${orderId}`,
    orderId,
    description: 'Ad premium for a delivered order',
    postings: [
      {
        account:
          purchase.settlement_model === 'PLATFORM_ESCROW'
            ? { type: 'VENDOR_WALLET', vendorId }
            : { type: 'AD_BUDGET_CLEARING' },
        amountPaisa: -fee,
        ...line,
      },
      { account: { type: 'AD_REVENUE' }, amountPaisa: fee, ...line },
    ],
  });
  if (journal.status === 'duplicate') return { status: 'ALREADY_CHARGED', purchaseId: purchase.id };

  const [charged] = await tx
    .update(adPurchases)
    .set({ amount_paid_npr: toNpr(paid + fee) })
    .where(eq(adPurchases.id, purchase.id))
    .returning();
  if (charged === undefined) throw new Error(`Ad purchase ${purchase.id} vanished`);
  const paused = budget - (paid + fee) < fee;
  if (paused) await pause(charged);
  return { status: 'CHARGED', purchaseId: purchase.id, amountNpr: toNpr(fee), paused };
}
