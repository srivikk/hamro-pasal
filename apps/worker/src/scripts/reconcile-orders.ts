import { createDatabase } from '@hamro-pasal/db';
import { LedgerService, SettlementService, WalletService } from '@hamro-pasal/ledger';

import { loadEnv } from '../config/env';
import { OrderReconciliationService } from '../finance/order-reconciliation';
import { runOrderReconciliation } from '../queues/processors';

/**
 * Runs the ORDER_RECONCILIATION midnight task once, now, without BullMQ or a running worker:
 *   pnpm --filter @hamro-pasal/worker reconcile:orders
 * Safe beside the scheduled job: both take each order's row lock.
 */
async function main(): Promise<void> {
  const db = createDatabase(loadEnv().DATABASE_URL);
  try {
    const settlement = new SettlementService(db, new LedgerService(new WalletService()));
    await runOrderReconciliation(new OrderReconciliationService(db, settlement));
  } finally {
    await db.$client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
