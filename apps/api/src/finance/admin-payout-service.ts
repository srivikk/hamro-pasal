import {
  payoutRequests,
  recordAuditLog,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import { toPaisa, type LedgerService } from '@hamro-pasal/ledger';
import {
  ADMIN_PAYOUT_DEFAULT_LIMIT,
  NO_AUDIT_CONTEXT,
  type AdminPayoutListQuery,
  type AuditContext,
  type PayoutStatus,
} from '@hamro-pasal/shared-types';
import { and, desc, eq, sql } from 'drizzle-orm';

import { PanNotVerifiedError } from './admin-settlement-service';
import type { PayoutRow } from './vendor-finance-service';

export interface AdminPayoutRow {
  readonly payout: PayoutRow;
  readonly vendor: {
    readonly id: string;
    readonly businessName: string;
    readonly phone: string;
    readonly walletBalanceNpr: number;
  };
}

export interface AdminPayoutPage {
  readonly rows: readonly AdminPayoutRow[];
  readonly nextCursor: string | null;
}

export class PayoutNotFoundError extends Error {
  constructor(readonly payoutId: string) {
    super(`Payout request ${payoutId} not found`);
    this.name = 'PayoutNotFoundError';
  }
}

/** The request was already approved or rejected, and this call asks for something else. */
export class PayoutAlreadyDecidedError extends Error {
  constructor(
    readonly payoutId: string,
    readonly status: PayoutStatus,
  ) {
    super(`Payout request ${payoutId} is already ${status}`);
    this.name = 'PayoutAlreadyDecidedError';
  }
}

/** The `cursor` is not a stored payout request. */
export class InvalidPayoutCursorError extends Error {
  constructor(readonly cursor: string) {
    super(`Cursor ${cursor} is not a payout request`);
    this.name = 'InvalidPayoutCursorError';
  }
}

/**
 * The Super Admin's side of the payout state machine (Phase 22):
 *
 *   PENDING ── approve {bank_reference} ──▶ APPROVED   (the held amount stays out of the wallet)
 *   PENDING ── reject {reason?} ──────────▶ REJECTED   (VENDOR_PAYOUT_REVERSAL posts it back)
 *
 * Both run under the request's row lock, so an approve racing a reject has exactly one winner and
 * the money is never both paid out and returned. Repeating the same decision answers with the same
 * row; the other decision, or an approval with another bank reference, is refused.
 */
export class AdminPayoutService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
  ) {}

  /** Newest request first, keyset-paginated on the row id (compared in SQL, microsecond exact). */
  async list({
    status,
    limit = ADMIN_PAYOUT_DEFAULT_LIMIT,
    cursor,
  }: AdminPayoutListQuery): Promise<AdminPayoutPage> {
    if (cursor !== undefined) {
      const [known] = await this.db
        .select({ id: payoutRequests.id })
        .from(payoutRequests)
        .where(eq(payoutRequests.id, cursor));
      if (known === undefined) throw new InvalidPayoutCursorError(cursor);
    }
    const rows = await this.db
      .select({ payout: payoutRequests, vendor: vendorColumns })
      .from(payoutRequests)
      .innerJoin(vendors, eq(vendors.id, payoutRequests.vendor_id))
      .where(
        and(
          status === undefined ? undefined : eq(payoutRequests.status, status),
          cursor === undefined
            ? undefined
            : sql`(${payoutRequests.created_at}, ${payoutRequests.id}) <
                (SELECT c.created_at, c.id FROM payout_requests c WHERE c.id = ${cursor})`,
        ),
      )
      .orderBy(desc(payoutRequests.created_at), desc(payoutRequests.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      rows: page,
      nextCursor: rows.length > limit && last !== undefined ? last.payout.id : null,
    };
  }

  async approve(
    adminUserId: string,
    payoutId: string,
    bankReference: string,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<AdminPayoutRow> {
    return this.db.transaction(async (tx) => {
      const payout = await lockPayout(tx, payoutId);
      if (payout.status === 'APPROVED' && payout.bank_reference === bankReference) {
        return viewOf(tx, payout);
      }
      if (payout.status !== 'PENDING') throw new PayoutAlreadyDecidedError(payoutId, payout.status);
      // The PAN payout gate (SPEC core 5): approving records a transfer to the vendor's bank, so
      // it waits for the PAN to be verified. Read under the vendor row lock a PAN change takes.
      // The request stays PENDING; rejecting it is not gated.
      const [vendor] = await tx
        .select({ panVerifiedAt: vendors.pan_verified_at })
        .from(vendors)
        .where(eq(vendors.id, payout.vendor_id))
        .for('update');
      if (vendor?.panVerifiedAt == null) throw new PanNotVerifiedError(payout.vendor_id);

      const [approved] = await tx
        .update(payoutRequests)
        .set({
          status: 'APPROVED',
          bank_reference: bankReference,
          decided_by_user_id: adminUserId,
          decided_at: sql`now()`,
        })
        .where(eq(payoutRequests.id, payoutId))
        .returning();
      if (approved === undefined) throw new PayoutNotFoundError(payoutId);
      await recordDecision(tx, 'PAYOUT_APPROVED', approved, adminUserId, context);
      return viewOf(tx, approved);
    });
  }

  async reject(
    adminUserId: string,
    payoutId: string,
    reason: string | null,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<AdminPayoutRow> {
    return this.db.transaction(async (tx) => {
      const payout = await lockPayout(tx, payoutId);
      if (payout.status === 'REJECTED') return viewOf(tx, payout);
      if (payout.status !== 'PENDING') throw new PayoutAlreadyDecidedError(payoutId, payout.status);

      const amountPaisa = toPaisa(payout.amount_npr);
      // Through LedgerService, so a credit that clears a debt also lifts a debt suspension.
      const reversal = await this.ledger.post(tx, {
        kind: 'VENDOR_PAYOUT_REVERSAL',
        idempotencyKey: `vendor-payout-reversal:${payout.id}`,
        orderId: null,
        description: 'Payout rejected: amount returned to the wallet',
        postings: [
          { account: { type: 'PAYOUT_CLEARING' }, amountPaisa: -amountPaisa },
          { account: { type: 'VENDOR_WALLET', vendorId: payout.vendor_id }, amountPaisa },
        ],
      });
      const [rejected] = await tx
        .update(payoutRequests)
        .set({
          status: 'REJECTED',
          reversal_transaction_id: reversal.transactionId,
          rejection_reason: reason,
          decided_by_user_id: adminUserId,
          decided_at: sql`now()`,
        })
        .where(eq(payoutRequests.id, payoutId))
        .returning();
      if (rejected === undefined) throw new PayoutNotFoundError(payoutId);
      await recordDecision(tx, 'PAYOUT_REJECTED', rejected, adminUserId, context);
      return viewOf(tx, rejected);
    });
  }
}

/**
 * One audit entry per money decision, in the decision's own transaction (Phase 25; it was a
 * console line after the commit before). A repeated decision changes nothing and records nothing.
 */
async function recordDecision(
  tx: Transaction,
  action: 'PAYOUT_APPROVED' | 'PAYOUT_REJECTED',
  payout: PayoutRow,
  adminUserId: string,
  context: AuditContext,
): Promise<void> {
  await recordAuditLog(tx, {
    actor: { kind: 'USER', user_id: adminUserId, role: 'SUPER_ADMIN' },
    action,
    entityId: payout.id,
    vendorId: payout.vendor_id,
    beforeState: { status: 'PENDING', amount_npr: payout.amount_npr },
    afterState: {
      status: payout.status,
      amount_npr: payout.amount_npr,
      bank_reference: payout.bank_reference,
      rejection_reason: payout.rejection_reason,
      reversal_transaction_id: payout.reversal_transaction_id,
      decided_at: payout.decided_at?.toISOString() ?? null,
    },
    context,
  });
}

const vendorColumns = {
  id: vendors.id,
  businessName: vendors.business_name,
  phone: vendors.phone,
  walletBalanceNpr: vendors.wallet_balance_npr,
};

async function lockPayout(tx: Transaction, payoutId: string): Promise<PayoutRow> {
  const [payout] = await tx
    .select()
    .from(payoutRequests)
    .where(eq(payoutRequests.id, payoutId))
    .for('update');
  if (payout === undefined) throw new PayoutNotFoundError(payoutId);
  return payout;
}

async function viewOf(tx: Transaction, payout: PayoutRow): Promise<AdminPayoutRow> {
  const [vendor] = await tx
    .select(vendorColumns)
    .from(vendors)
    .where(eq(vendors.id, payout.vendor_id));
  if (vendor === undefined) throw new Error(`Vendor ${payout.vendor_id} vanished`);
  return { payout, vendor };
}
