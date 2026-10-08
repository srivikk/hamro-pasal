import { adPurchases, vendors, type Transaction } from '@hamro-pasal/db';
import { and, asc, eq, inArray, lt, ne, sql } from 'drizzle-orm';

import type { LedgerService } from './ledger-service';
import { toNpr, toPaisa } from './money';

type AdPurchaseRow = typeof adPurchases.$inferSelect;

/**
 * Flat fees a Model B shop still owes (SPEC core 8, "Collection by settlement model"): the price
 * of its FLAT_RATE purchases less what has been collected. The platform sold those ads against
 * money it holds for the shop, so the fee is taken from the wallet before anything is paid out.
 *
 * It is a projection of `ad_purchases` (price − amount_paid), not a stored balance. A cancelled
 * purchase owes nothing: a flat-rate ad can only be cancelled before it starts, and is then
 * refunded.
 */
const feeIsDue = and(
  eq(adPurchases.billing_model, 'FLAT_RATE'),
  eq(adPurchases.settlement_model, 'PLATFORM_ESCROW'),
  ne(adPurchases.status, 'CANCELLED'),
  lt(adPurchases.amount_paid_npr, adPurchases.price_npr),
);

const dueSum = sql<number>`coalesce(sum(${adPurchases.price_npr} - ${adPurchases.amount_paid_npr}), 0)`;

export async function adFeesDuePaisa(tx: Transaction, vendorId: string): Promise<number> {
  const [row] = await tx
    .select({ due: dueSum.mapWith(Number) })
    .from(adPurchases)
    .where(and(eq(adPurchases.vendor_id, vendorId), feeIsDue));
  return toPaisa(row?.due ?? 0);
}

/** `adFeesDuePaisa` for several vendors in one query; a vendor that owes nothing is absent. */
export async function adFeesDueByVendor(
  tx: Transaction,
  vendorIds: readonly string[],
): Promise<Map<string, number>> {
  if (vendorIds.length === 0) return new Map();
  const rows = await tx
    .select({ vendorId: adPurchases.vendor_id, due: dueSum.mapWith(Number) })
    .from(adPurchases)
    .where(and(inArray(adPurchases.vendor_id, [...vendorIds]), feeIsDue))
    .groupBy(adPurchases.vendor_id);
  return new Map(rows.map((row) => [row.vendorId, toPaisa(row.due)]));
}

/**
 * One collection of a flat fee: VENDOR_WALLET to AD_REVENUE, both lines AD_FLAT_FEE naming the
 * purchase (never commission, SPEC core 8 "Itemisation"), and the purchase's `amount_paid_npr`
 * raised by the same amount. The key carries what was paid before, so each collection of a
 * purchase is its own journal.
 */
export async function postFlatFee(
  tx: Transaction,
  ledger: LedgerService,
  purchase: Pick<AdPurchaseRow, 'id' | 'vendor_id' | 'amount_paid_npr'>,
  amountPaisa: number,
): Promise<void> {
  const paidBefore = toPaisa(purchase.amount_paid_npr);
  const line = { lineType: 'AD_FLAT_FEE', adPurchaseId: purchase.id } as const;
  await ledger.post(tx, {
    kind: 'AD_PURCHASE',
    idempotencyKey: `ad-flat-fee:${purchase.id}:${String(paidBefore)}`,
    orderId: null,
    description: 'Ad purchase: flat fee',
    postings: [
      {
        account: { type: 'VENDOR_WALLET', vendorId: purchase.vendor_id },
        amountPaisa: -amountPaisa,
        ...line,
      },
      { account: { type: 'AD_REVENUE' }, amountPaisa, ...line },
    ],
  });
  await tx
    .update(adPurchases)
    .set({ amount_paid_npr: toNpr(paidBefore + amountPaisa) })
    .where(eq(adPurchases.id, purchase.id));
}

/**
 * Takes the flat fees a shop owes out of its wallet, oldest purchase first, as far as the balance
 * goes: never below 0, an ad is never collected on credit. Returns what was collected, in paisa.
 *
 * Lock order: the vendor row first (taken here; a caller that already holds it loses nothing),
 * then the purchase rows, then the ledger accounts inside `LedgerService.post`. Every path that
 * touches a purchase takes them in this order.
 */
export async function collectAdFeesDue(
  tx: Transaction,
  ledger: LedgerService,
  vendorId: string,
): Promise<number> {
  const [vendor] = await tx
    .select({ balance: vendors.wallet_balance_npr })
    .from(vendors)
    .where(eq(vendors.id, vendorId))
    .for('no key update');
  let remaining = toPaisa(vendor?.balance ?? 0);
  if (remaining <= 0) return 0;

  const owed = await tx
    .select()
    .from(adPurchases)
    .where(and(eq(adPurchases.vendor_id, vendorId), feeIsDue))
    .orderBy(asc(adPurchases.agreed_at), asc(adPurchases.id))
    .for('update');
  let collected = 0;
  for (const purchase of owed) {
    if (remaining <= 0) break;
    const amount = Math.min(
      remaining,
      toPaisa(purchase.price_npr) - toPaisa(purchase.amount_paid_npr),
    );
    if (amount <= 0) continue;
    await postFlatFee(tx, ledger, purchase, amount);
    remaining -= amount;
    collected += amount;
  }
  return collected;
}
