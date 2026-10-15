import {
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  type Transaction,
} from '@hamro-pasal/db';
import { and, eq, sql } from 'drizzle-orm';

import type { LedgerService } from './ledger-service';
import { toPaisa } from './money';
import type { PlannedPosting } from './settlement-plan';

/** The day-8 (or resolution) release of one order's hold: posted at most once. */
export function disputeReleaseKey(orderId: string): string {
  return `dispute-release:${orderId}`;
}

/** A resolution's refund of one order: posted at most once. */
export function disputeRefundKey(orderId: string): string {
  return `dispute-refund:${orderId}`;
}

/**
 * Step 7.3 (SPEC core 6): what is held for one order now, in paisa: everything its journals
 * posted to the vendor's VENDOR_DISPUTE_HOLD (the settlement's credit, less a release or refund).
 * 0 for a cash order, an order delivered before the hold existed, or one already released.
 */
export async function heldForOrderPaisa(
  tx: Transaction,
  orderId: string,
  vendorId: string,
): Promise<number> {
  const [row] = await tx
    .select({ held: sql<string>`coalesce(sum(${ledgerEntries.amount_npr}), 0)` })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.account_id))
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transaction_id))
    .where(
      and(eq(ledgerAccounts.hold_vendor_id, vendorId), eq(ledgerTransactions.order_id, orderId)),
    );
  return toPaisa(Number(row?.held ?? 0));
}

/** How one order's held amount and a refund are split (all paisa, never negative). */
export interface DisputeSplit {
  /** Hold -> wallet. */
  readonly releasePaisa: number;
  /** Hold -> REFUND_CLEARING. */
  readonly refundFromHoldPaisa: number;
  /**
   * Wallet -> REFUND_CLEARING: the part of a refund the hold cannot cover (all of it for a cash
   * order, which has nothing held: SPEC core 6, the vendor holds the cash).
   */
  readonly refundFromWalletPaisa: number;
}

/**
 * The refund comes out of the order's hold first, then out of the vendor's wallet; what is left
 * of the hold goes to the wallet. A plain release is a refund of 0.
 */
export function splitDispute(heldPaisa: number, refundPaisa: number): DisputeSplit {
  if (!Number.isInteger(heldPaisa) || heldPaisa < 0) {
    throw new RangeError(
      `Held amount must be whole, non-negative paisa (got ${String(heldPaisa)})`,
    );
  }
  if (!Number.isInteger(refundPaisa) || refundPaisa < 0) {
    throw new RangeError(`Refund must be whole, non-negative paisa (got ${String(refundPaisa)})`);
  }
  const refundFromHoldPaisa = Math.min(heldPaisa, refundPaisa);
  return {
    releasePaisa: heldPaisa - refundFromHoldPaisa,
    refundFromHoldPaisa,
    refundFromWalletPaisa: refundPaisa - refundFromHoldPaisa,
  };
}

/** The release journal's postings (empty when nothing is released). */
export function planHoldRelease(vendorId: string, split: DisputeSplit): PlannedPosting[] {
  if (split.releasePaisa === 0) return [];
  return [
    {
      account: { type: 'VENDOR_DISPUTE_HOLD', vendorId },
      amountPaisa: -split.releasePaisa,
      lineType: 'DISPUTE_RELEASE',
    },
    {
      account: { type: 'VENDOR_WALLET', vendorId },
      amountPaisa: split.releasePaisa,
      lineType: 'DISPUTE_RELEASE',
    },
  ];
}

/** The refund journal's postings (empty without a refund). */
export function planDisputeRefund(vendorId: string, split: DisputeSplit): PlannedPosting[] {
  const refund = split.refundFromHoldPaisa + split.refundFromWalletPaisa;
  if (refund === 0) return [];
  return [
    ...(split.refundFromHoldPaisa === 0
      ? []
      : [
          {
            account: { type: 'VENDOR_DISPUTE_HOLD', vendorId } as const,
            amountPaisa: -split.refundFromHoldPaisa,
            lineType: 'DISPUTE_REFUND' as const,
          },
        ]),
    ...(split.refundFromWalletPaisa === 0
      ? []
      : [
          {
            account: { type: 'VENDOR_WALLET', vendorId } as const,
            amountPaisa: -split.refundFromWalletPaisa,
            lineType: 'DISPUTE_REFUND' as const,
          },
        ]),
    { account: { type: 'REFUND_CLEARING' }, amountPaisa: refund, lineType: 'DISPUTE_REFUND' },
  ];
}

export interface DisputeMoneyResult {
  readonly split: DisputeSplit;
  /** The release journal, when one was posted (or already existed). */
  readonly releaseTransactionId: string | null;
  /** The refund journal, when one was posted (or already existed). */
  readonly refundTransactionId: string | null;
}

/**
 * Moves one order's held amount, and records a refund, in the caller's transaction. The caller
 * must hold the order row lock (the day-8 release and an escalation take the same lock: SPEC edge
 * case 19). Each journal has its own idempotency key, so a retry posts nothing twice; through
 * LedgerService, so a release can lift a debt suspension and a cash refund can cause one.
 */
export async function settleDisputeHold(
  tx: Transaction,
  ledger: LedgerService,
  input: { readonly orderId: string; readonly vendorId: string; readonly refundPaisa: number },
): Promise<DisputeMoneyResult> {
  const held = await heldForOrderPaisa(tx, input.orderId, input.vendorId);
  const split = splitDispute(held, input.refundPaisa);
  const refundPostings = planDisputeRefund(input.vendorId, split);
  const releasePostings = planHoldRelease(input.vendorId, split);
  const refund =
    refundPostings.length === 0
      ? null
      : await ledger.post(tx, {
          kind: 'DISPUTE_REFUND',
          idempotencyKey: disputeRefundKey(input.orderId),
          orderId: input.orderId,
          description: 'Refund decided by Hamro Pasal, owed to the customer',
          postings: refundPostings,
        });
  const release =
    releasePostings.length === 0
      ? null
      : await ledger.post(tx, {
          kind: 'DISPUTE_HOLD_RELEASE',
          idempotencyKey: disputeReleaseKey(input.orderId),
          orderId: input.orderId,
          description: 'Held earnings released to the wallet',
          postings: releasePostings,
        });
  return {
    split,
    releaseTransactionId: release?.transactionId ?? null,
    refundTransactionId: refund?.transactionId ?? null,
  };
}
