import type { adPurchases, Transaction } from '@hamro-pasal/db';

import type { LedgerService } from './ledger-service';
import { toPaisa } from './money';

type HeldBudgetPurchase = Pick<
  typeof adPurchases.$inferSelect,
  'id' | 'vendor_id' | 'billing_model' | 'settlement_model' | 'budget_npr' | 'amount_paid_npr'
>;

/**
 * Returns the unused part of a per-order ad's held budget to the shop: AD_BUDGET_CLEARING back to
 * VENDOR_WALLET, both lines AD_BUDGET_RELEASE naming the purchase. Only a shop that pays from its
 * ledger (Models A and C) had a budget held at purchase; for any other purchase nothing moves.
 *
 * One journal per purchase (`ad-budget-release:<id>`), so the vendor's cancellation and the
 * hourly sweep that ends an ad can never both release it. Returns what was released, in paisa.
 * The caller holds the vendor row lock and the purchase row lock.
 */
export async function releaseUnusedAdBudget(
  tx: Transaction,
  ledger: LedgerService,
  purchase: HeldBudgetPurchase,
): Promise<number> {
  if (
    purchase.billing_model !== 'PER_ORDER_PREMIUM' ||
    purchase.settlement_model === 'PLATFORM_ESCROW' ||
    purchase.budget_npr === null
  ) {
    return 0;
  }
  const unused = toPaisa(purchase.budget_npr) - toPaisa(purchase.amount_paid_npr);
  if (unused <= 0) return 0;
  const line = { lineType: 'AD_BUDGET_RELEASE', adPurchaseId: purchase.id } as const;
  const journal = await ledger.post(tx, {
    kind: 'AD_BUDGET_RELEASE',
    idempotencyKey: `ad-budget-release:${purchase.id}`,
    orderId: null,
    description: 'Ad over: unused budget released',
    postings: [
      { account: { type: 'AD_BUDGET_CLEARING' }, amountPaisa: -unused, ...line },
      {
        account: { type: 'VENDOR_WALLET', vendorId: purchase.vendor_id },
        amountPaisa: unused,
        ...line,
      },
    ],
  });
  return journal.status === 'posted' ? unused : 0;
}
