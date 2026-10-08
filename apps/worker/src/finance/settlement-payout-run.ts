import {
  ledgerAccounts,
  ledgerEntries,
  payoutRequests,
  recordAuditLog,
  vendorBankAccounts,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import {
  adFeesDuePaisa,
  collectAdFeesDue,
  toNpr,
  toPaisa,
  type LedgerService,
} from '@hamro-pasal/ledger';
import { maskAccountNumber, SETTLEMENT_PAYOUT_MIN_NPR } from '@hamro-pasal/shared-types';
import { and, asc, eq, gte, isNotNull, sql } from 'drizzle-orm';

export const SETTLEMENT_PAYOUT_RUN_JOB = 'SETTLEMENT_PAYOUT_RUN';
/** `payout_requests.transfer_state` of a payout whose bank transfer is still to be made. */
export const PROCESSING_BANK_TRANSFER = 'PROCESSING_BANK_TRANSFER';

/** Nepal Time is UTC+05:45 all year. */
const NEPAL_OFFSET_MS = (5 * 60 + 45) * 60_000;
const DAY_MS = 86_400_000;

/**
 * The cut-off of the run that happens at `now` (SPEC core 5): "Sunday 23:59 Nepal Time", read as
 * the end of Sunday, so the first instant of the Monday of that week in Nepal Time, exclusive.
 */
export function payoutCutoff(now: Date): Date {
  const local = now.getTime() + NEPAL_OFFSET_MS;
  const localMidnight = Math.floor(local / DAY_MS) * DAY_MS;
  const daysSinceMonday = (new Date(localMidnight).getUTCDay() + 6) % 7;
  return new Date(localMidnight - daysSinceMonday * DAY_MS - NEPAL_OFFSET_MS);
}

/** The run's name in idempotency keys: the Nepal Time date of its cut-off (a Monday). */
export function payoutRunDate(cutoff: Date): string {
  return new Date(cutoff.getTime() + NEPAL_OFFSET_MS).toISOString().slice(0, 10);
}

export type PayoutSkipReason =
  /** Paid by an earlier attempt of this run. */
  | 'ALREADY_PAID'
  /** No longer Model B, or the PAN verification was cleared, when the row lock was taken. */
  | 'NOT_ELIGIBLE'
  | 'NO_PRIMARY_BANK_ACCOUNT'
  | 'BELOW_MINIMUM';

export interface RunPayout {
  readonly vendorId: string;
  readonly payoutId: string;
  readonly amountNpr: number;
}

export interface SettlementPayoutRunSummary {
  readonly cutoff: Date;
  readonly paid: readonly RunPayout[];
  readonly skipped: Readonly<Record<PayoutSkipReason, number>>;
}

/** Some vendors could not be processed; the others were. BullMQ retries the job, which is safe. */
export class SettlementPayoutRunError extends Error {
  constructor(readonly failures: readonly { vendorId: string; error: unknown }[]) {
    super(
      `Settlement payout run failed for ${String(failures.length)} vendor(s): ${failures
        .map((failure) => failure.vendorId)
        .join(', ')}`,
    );
    this.name = 'SettlementPayoutRunError';
  }
}

/**
 * The automated payout run (SPEC core 5, "Payouts"; every Tuesday 02:00 Nepal Time).
 *
 * For every Model B (`PLATFORM_ESCROW`) vendor with a verified PAN and a primary bank account it
 * pays what was in the wallet at the cut-off, less anything debited since, and never more than
 * is available now; an amount under the minimum (1000 NPR) is left to carry over. Money credited
 * after the cut-off waits for the next run.
 *
 * No bank API exists yet, so "pays" means: the amount leaves the wallet (the Phase 22
 * `VENDOR_PAYOUT` journal, VENDOR_WALLET to PAYOUT_CLEARING) and an APPROVED `payout_requests`
 * row is written with `transfer_state = PROCESSING_BANK_TRANSFER` and the job as its actor. The
 * transfer itself is still made by a person.
 *
 * One transaction per vendor. Locks, in the order the admin's payout takes them: the vendor row
 * (`FOR UPDATE`: the lock a PAN change, a PAN verification, a settlement model approval and every
 * wallet journal take), then the vendor's ad purchase rows (flat fees due are collected first),
 * then the ledger accounts. The gates and the balance are read under the vendor lock.
 *
 * Idempotent per vendor and run: the payout row's key is `settlement-run:<cut-off date>`, so a
 * retried job, a job started twice or two workers pay each vendor once.
 */
export class SettlementPayoutRunService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
  ) {}

  async run(now: Date = new Date()): Promise<SettlementPayoutRunSummary> {
    const cutoff = payoutCutoff(now);
    const runKey = `settlement-run:${payoutRunDate(cutoff)}`;

    // A first, unlocked pass: a wallet under the minimum cannot yield a payout of the minimum.
    const candidates = await this.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(
        and(
          eq(vendors.settlement_model, 'PLATFORM_ESCROW'),
          isNotNull(vendors.pan_verified_at),
          gte(vendors.wallet_balance_npr, SETTLEMENT_PAYOUT_MIN_NPR),
        ),
      )
      .orderBy(asc(vendors.id));

    const paid: RunPayout[] = [];
    const skipped: Record<PayoutSkipReason, number> = {
      ALREADY_PAID: 0,
      NOT_ELIGIBLE: 0,
      NO_PRIMARY_BANK_ACCOUNT: 0,
      BELOW_MINIMUM: 0,
    };
    const failures: { vendorId: string; error: unknown }[] = [];
    for (const { id } of candidates) {
      try {
        const outcome = await this.db.transaction((tx) => this.payVendor(tx, id, cutoff, runKey));
        if (typeof outcome === 'string') skipped[outcome] += 1;
        else paid.push(outcome);
      } catch (error: unknown) {
        // One shop's failure must not hold back everyone else's payout.
        failures.push({ vendorId: id, error });
      }
    }
    if (failures.length > 0) throw new SettlementPayoutRunError(failures);
    return { cutoff, paid, skipped };
  }

  private async payVendor(
    tx: Transaction,
    vendorId: string,
    cutoff: Date,
    runKey: string,
  ): Promise<RunPayout | PayoutSkipReason> {
    const [vendor] = await tx
      .select({
        settlement_model: vendors.settlement_model,
        pan_verified_at: vendors.pan_verified_at,
        wallet_balance_npr: vendors.wallet_balance_npr,
      })
      .from(vendors)
      .where(eq(vendors.id, vendorId))
      .for('update');
    // Re-read under the lock: the gate is the one the admin's payout applies.
    if (vendor?.settlement_model !== 'PLATFORM_ESCROW' || vendor.pan_verified_at === null) {
      return 'NOT_ELIGIBLE';
    }

    const [existing] = await tx
      .select({ id: payoutRequests.id })
      .from(payoutRequests)
      .where(
        and(eq(payoutRequests.vendor_id, vendorId), eq(payoutRequests.idempotency_key, runKey)),
      );
    if (existing !== undefined) return 'ALREADY_PAID';

    const [bankAccount] = await tx
      .select()
      .from(vendorBankAccounts)
      .where(
        and(eq(vendorBankAccounts.vendor_id, vendorId), eq(vendorBankAccounts.is_primary, true)),
      );
    if (bankAccount === undefined) return 'NO_PRIMARY_BANK_ACCOUNT';

    // Flat ad fees the shop owes come out of the wallet first, as before a manual payout. They
    // stay collected even if nothing is paid out below: they were due either way.
    const adFeesCollectedPaisa = await collectAdFeesDue(tx, this.ledger, vendorId);
    const [swept] = await tx
      .select({ balance: vendors.wallet_balance_npr })
      .from(vendors)
      .where(eq(vendors.id, vendorId));
    const availableNowPaisa = Math.max(
      0,
      toPaisa(swept?.balance ?? 0) - (await adFeesDuePaisa(tx, vendorId)),
    );

    const [history] = await tx
      .select({
        atCutoff:
          sql<number>`coalesce(sum(${ledgerEntries.amount_npr}) filter (where ${ledgerEntries.created_at} < ${cutoff}), 0)`.mapWith(
            Number,
          ),
        debitedSince:
          sql<number>`coalesce(sum(${ledgerEntries.amount_npr}) filter (where ${ledgerEntries.created_at} >= ${cutoff} and ${ledgerEntries.amount_npr} < 0), 0)`.mapWith(
            Number,
          ),
      })
      .from(ledgerEntries)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.account_id))
      .where(
        and(
          eq(ledgerAccounts.account_type, 'VENDOR_WALLET'),
          eq(ledgerAccounts.vendor_id, vendorId),
        ),
      );
    // What was there at the cut-off, less every debit since (`debitedSince` is negative).
    const dueAtCutoffPaisa = toPaisa(history?.atCutoff ?? 0) + toPaisa(history?.debitedSince ?? 0);
    const amountPaisa = Math.min(Math.max(0, dueAtCutoffPaisa), availableNowPaisa);
    if (amountPaisa < toPaisa(SETTLEMENT_PAYOUT_MIN_NPR)) return 'BELOW_MINIMUM';

    const journal = await this.ledger.post(tx, {
      kind: 'VENDOR_PAYOUT',
      idempotencyKey: `${runKey}:${vendorId}`,
      orderId: null,
      description: 'Scheduled settlement payout: bank transfer to be made',
      postings: [
        { account: { type: 'VENDOR_WALLET', vendorId }, amountPaisa: -amountPaisa },
        { account: { type: 'PAYOUT_CLEARING' }, amountPaisa },
      ],
    });
    const [payout] = await tx
      .insert(payoutRequests)
      .values({
        vendor_id: vendorId,
        amount_npr: toNpr(amountPaisa),
        status: 'APPROVED',
        idempotency_key: runKey,
        hold_transaction_id: journal.transactionId,
        system_actor: SETTLEMENT_PAYOUT_RUN_JOB,
        transfer_state: PROCESSING_BANK_TRANSFER,
        decided_at: sql`now()`,
      })
      .returning({ id: payoutRequests.id });
    if (payout === undefined) throw new Error('The payout was not stored');

    const [after] = await tx
      .select({ balance: vendors.wallet_balance_npr })
      .from(vendors)
      .where(eq(vendors.id, vendorId));
    await recordAuditLog(tx, {
      actor: { kind: 'SYSTEM', job: SETTLEMENT_PAYOUT_RUN_JOB },
      action: 'PAYOUT_PROCESSED',
      entityId: vendorId,
      vendorId,
      beforeState: {
        wallet_balance_npr: vendor.wallet_balance_npr,
        pan_verified_at: vendor.pan_verified_at.toISOString(),
      },
      afterState: {
        wallet_balance_npr: after?.balance ?? null,
        pan_verified_at: vendor.pan_verified_at.toISOString(),
        cutoff_at: cutoff.toISOString(),
        ...(adFeesCollectedPaisa > 0 ? { ad_fees_collected_npr: toNpr(adFeesCollectedPaisa) } : {}),
        payout: {
          id: payout.id,
          amount_npr: toNpr(amountPaisa),
          transfer_state: PROCESSING_BANK_TRANSFER,
          ledger_transaction_id: journal.transactionId,
          // Where the money is to be sent, as the account stood at that moment.
          bank_account: {
            id: bankAccount.id,
            bank_name: bankAccount.bank_name,
            account_name: bankAccount.account_name,
            account_number_masked: maskAccountNumber(bankAccount.account_number),
          },
        },
      },
    });
    return { vendorId, payoutId: payout.id, amountNpr: toNpr(amountPaisa) };
  }
}
