import { orders, type Database } from '@hamro-pasal/db';
import { cancelPlacedOrder, recordMissedOrder, type LedgerService } from '@hamro-pasal/ledger';
import type { VendorAcceptanceTimeoutJobInput } from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';

/** The system actor of an auto-cancel and of the pause it may cause. */
export const VENDOR_ACCEPTANCE_EXPIRY_JOB = 'VENDOR_ACCEPTANCE_EXPIRY';

/** What the 5-minute timer found when it fired. */
export type VendorAcceptanceExpiryOutcome =
  /** Still PLACED: cancelled (refund flagged when paid) and counted as missed. */
  | { readonly kind: 'CANCELLED'; readonly paused: boolean }
  /** The vendor answered, or the customer cancelled, in time: nothing to do. */
  | { readonly kind: 'NOT_PENDING' };

/**
 * Step 7.3 (decided 2026-10-15): an order the vendor has not accepted 5 minutes after it was
 * placed is cancelled, with the customer cancellation's exact effects (stock back,
 * `order.state_changed`, the refund flag and `order.canceled_refund_due` for a paid order), and
 * counts as a missed order toward Auto-Pause. One transaction holding the order row FOR UPDATE,
 * the lock the vendor's accept and reject take, so exactly one of them wins at the edge (SPEC edge
 * case 20). A retried job finds the order no longer PLACED and does nothing.
 */
export class VendorAcceptanceExpiryService {
  constructor(
    private readonly db: Database,
    /** 2026-10-21: a cancelled wallet or Model C order moves its money back in the same commit. */
    private readonly ledger: LedgerService,
  ) {}

  cancelIfUnanswered(job: VendorAcceptanceTimeoutJobInput): Promise<VendorAcceptanceExpiryOutcome> {
    return this.db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, job.order_id))
        .for('update');
      if (order?.state !== 'PLACED') return { kind: 'NOT_PENDING' };
      await cancelPlacedOrder(tx, order, this.ledger);
      const missed = await recordMissedOrder(tx, order.vendor_id, {
        kind: 'SYSTEM',
        job: VENDOR_ACCEPTANCE_EXPIRY_JOB,
      });
      return { kind: 'CANCELLED', paused: missed.paused };
    });
  }
}
