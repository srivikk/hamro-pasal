import {
  irdPanChecks,
  recordAuditLog,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import {
  IRD_PAN_VERIFICATION_JOB,
  PanChangedError,
  PanDocumentMissingError,
  PanMissingError,
  PanVendorNotFoundError,
  verifyVendorPan,
} from '@hamro-pasal/ledger';
import {
  bestBusinessNameMatch,
  IRD_CHECK_MAX_ATTEMPTS,
  IRD_NAME_MATCH_THRESHOLD,
  type AuditActor,
  type IrdReviewReason,
} from '@hamro-pasal/shared-types';
import { and, eq, sql } from 'drizzle-orm';

import type { IrdLookupResult, IrdPanLookup } from './ird-lookup';

/*
 * The automated IRD PAN verification (decided by the user 2026-10-21; SPEC core 10 amended): the
 * state machine of one ird_pan_checks row (shared-types kyc/ird-checks.ts).
 *
 *   claim QUEUED → RUNNING (or a RUNNING one abandoned by a crashed worker)
 *   up to 3 attempts, each: attempts + 1, then one lookup
 *     FOUND           → decide: inactive account / name mismatch → MANUAL_REVIEW; match → VERIFIED
 *                       (verifyVendorPan as the IRD_PAN_VERIFICATION job, the check closed in the
 *                       same transaction)
 *     LAYOUT_CHANGED  → MANUAL_REVIEW at once: the parser cannot be trusted any more
 *     NOT_FOUND       → another attempt (the IRD says "invalid information" for a refused CAPTCHA
 *                       too); after the 3rd, MANUAL_REVIEW PAN_NOT_FOUND
 *     a thrown error  → another attempt (a timeout, the network, 2Captcha); after the 3rd,
 *                       MANUAL_REVIEW SCRAPER_FAILED with the last error
 *   lookup disabled   → MANUAL_REVIEW AUTOMATION_DISABLED
 *
 * Every write to the row is guarded by `status = 'RUNNING'`: a check superseded meanwhile (the
 * vendor changed its PAN, a Super Admin verified it by hand) is left alone, and its outcome is
 * dropped. Each terminal outcome is audited, by the job.
 */

const JOB_ACTOR: AuditActor = { kind: 'SYSTEM', job: IRD_PAN_VERIFICATION_JOB };

/** A RUNNING check older than this was abandoned by a worker that died: it may be claimed again. */
const STALE_RUNNING = sql`interval '10 minutes'`;

type CheckRow = typeof irdPanChecks.$inferSelect;

export type IrdCheckOutcome =
  | { readonly status: 'VERIFIED'; readonly similarity: number }
  | { readonly status: 'MANUAL_REVIEW'; readonly reason: IrdReviewReason }
  | { readonly status: 'SUPERSEDED' }
  /** Not QUEUED (done, superseded, or running elsewhere): nothing was done. */
  | { readonly status: 'SKIPPED' };

export interface IrdPanVerificationDeps {
  readonly db: Database;
  /** null: IRD_VERIFICATION_PROVIDER=DISABLED. */
  readonly lookup: IrdPanLookup | null;
  /** Wait before attempt 2 and 3 (default 5 s and 15 s). */
  readonly retryDelaysMs?: readonly number[];
  readonly sleep?: (ms: number) => Promise<void>;
}

interface Finding {
  readonly irdBusinessName?: string | null;
  readonly irdRegistrationDate?: string | null;
  readonly similarity?: number | null;
  readonly error?: string | null;
}

/** The check was closed by someone else while this job ran. */
class CheckClosedError extends Error {}

export class IrdPanVerificationService {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retryDelaysMs: readonly number[];

  constructor(private readonly deps: IrdPanVerificationDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.retryDelaysMs = deps.retryDelaysMs ?? [5_000, 15_000];
  }

  async run(checkId: string): Promise<IrdCheckOutcome> {
    const check = await this.claim(checkId);
    if (check === null) return { status: 'SKIPPED' };
    if (this.deps.lookup === null) {
      return this.toReview(check, 'AUTOMATION_DISABLED', {});
    }

    let lastError = '';
    let lastWasNotFound = false;
    for (let attempt = check.attempts + 1; attempt <= IRD_CHECK_MAX_ATTEMPTS; attempt += 1) {
      if (attempt > check.attempts + 1) {
        await this.sleep(this.retryDelaysMs[attempt - check.attempts - 2] ?? 15_000);
      }
      if (!(await this.countAttempt(check.id, attempt))) return { status: 'SUPERSEDED' };

      let result: IrdLookupResult;
      try {
        result = await this.deps.lookup.lookup(check.tax_id);
      } catch (error: unknown) {
        lastError = error instanceof Error ? error.message : String(error);
        lastWasNotFound = false;
        console.warn(
          JSON.stringify({
            ird_check: 'attempt_failed',
            check_id: check.id,
            attempt,
            error: lastError,
          }),
        );
        continue;
      }

      if (result.kind === 'FOUND') return this.decide(check, result);
      if (result.kind === 'LAYOUT_CHANGED') {
        return this.toReview(check, 'LAYOUT_CHANGED', { error: result.detail });
      }
      lastWasNotFound = true;
      lastError =
        'The IRD answered "invalid information" (no such PAN, or the CAPTCHA was refused)';
    }
    return this.toReview(check, lastWasNotFound ? 'PAN_NOT_FOUND' : 'SCRAPER_FAILED', {
      error: lastError,
    });
  }

  /** QUEUED → RUNNING, or a RUNNING row a dead worker left behind; null when neither. */
  private async claim(checkId: string): Promise<CheckRow | null> {
    const [check] = await this.deps.db
      .update(irdPanChecks)
      .set({ status: 'RUNNING', started_at: sql`now()` })
      .where(
        and(
          eq(irdPanChecks.id, checkId),
          sql`(${irdPanChecks.status} = 'QUEUED' OR (${irdPanChecks.status} = 'RUNNING' AND ${irdPanChecks.started_at} < now() - ${STALE_RUNNING}))`,
        ),
      )
      .returning();
    return check ?? null;
  }

  /** Records the attempt; false when the check is no longer RUNNING (it was superseded). */
  private async countAttempt(checkId: string, attempt: number): Promise<boolean> {
    const rows = await this.deps.db
      .update(irdPanChecks)
      .set({ attempts: attempt })
      .where(and(eq(irdPanChecks.id, checkId), eq(irdPanChecks.status, 'RUNNING')))
      .returning({ id: irdPanChecks.id });
    return rows.length === 1;
  }

  private async decide(
    check: CheckRow,
    found: Extract<IrdLookupResult, { kind: 'FOUND' }>,
  ): Promise<IrdCheckOutcome> {
    const [vendor] = await this.deps.db
      .select({ legalName: vendors.legal_name, businessName: vendors.business_name })
      .from(vendors)
      .where(eq(vendors.id, check.vendor_id));
    if (vendor === undefined) return this.supersede(check);

    const similarity = bestBusinessNameMatch(found.businessName, [
      vendor.legalName,
      vendor.businessName,
    ]);
    const finding: Finding = {
      irdBusinessName: found.businessName === '' ? null : found.businessName,
      irdRegistrationDate: found.registrationDate,
      similarity,
    };
    if (found.accountStatuses.length > 0 && !found.accountStatuses.includes('Active')) {
      return this.toReview(check, 'IRD_ACCOUNT_INACTIVE', {
        ...finding,
        error: `IRD registration status: ${found.accountStatuses.join(', ')}`,
      });
    }
    if (similarity < IRD_NAME_MATCH_THRESHOLD) {
      return this.toReview(check, 'NAME_MISMATCH', finding);
    }

    try {
      await verifyVendorPan(
        this.deps.db,
        check.vendor_id,
        { kind: 'JOB', job: IRD_PAN_VERIFICATION_JOB },
        {
          expectTaxId: check.tax_id,
          onVerified: async (tx) => {
            await this.close(tx, check, 'VERIFIED', null, finding);
          },
        },
      );
      return { status: 'VERIFIED', similarity };
    } catch (error: unknown) {
      if (error instanceof PanDocumentMissingError) {
        return this.toReview(check, 'DOCUMENT_MISSING', finding);
      }
      if (
        error instanceof CheckClosedError ||
        error instanceof PanChangedError ||
        error instanceof PanMissingError ||
        error instanceof PanVendorNotFoundError
      ) {
        return this.supersede(check);
      }
      throw error;
    }
  }

  private async toReview(
    check: CheckRow,
    reason: IrdReviewReason,
    finding: Finding,
  ): Promise<IrdCheckOutcome> {
    try {
      await this.deps.db.transaction((tx) =>
        this.close(tx, check, 'MANUAL_REVIEW', reason, finding),
      );
    } catch (error: unknown) {
      if (error instanceof CheckClosedError) return { status: 'SUPERSEDED' };
      throw error;
    }
    console.warn(
      JSON.stringify({
        ird_check: 'manual_review',
        check_id: check.id,
        vendor_id: check.vendor_id,
        reason,
      }),
    );
    return { status: 'MANUAL_REVIEW', reason };
  }

  /** The PAN changed or the vendor went away under the check: it is moot. */
  private async supersede(check: CheckRow): Promise<IrdCheckOutcome> {
    await this.deps.db
      .update(irdPanChecks)
      .set({ status: 'SUPERSEDED', completed_at: sql`now()` })
      .where(and(eq(irdPanChecks.id, check.id), eq(irdPanChecks.status, 'RUNNING')));
    return { status: 'SUPERSEDED' };
  }

  /** The terminal write and its audit entry, in the caller's transaction; only from RUNNING. */
  private async close(
    tx: Transaction,
    check: CheckRow,
    status: 'VERIFIED' | 'MANUAL_REVIEW',
    reason: IrdReviewReason | null,
    finding: Finding,
  ): Promise<void> {
    const updated = await tx
      .update(irdPanChecks)
      .set({
        status,
        review_reason: reason,
        ird_business_name: finding.irdBusinessName ?? null,
        ird_registration_date: finding.irdRegistrationDate ?? null,
        name_similarity: finding.similarity ?? null,
        last_error: finding.error?.slice(0, 1000) ?? null,
        completed_at: sql`now()`,
      })
      .where(and(eq(irdPanChecks.id, check.id), eq(irdPanChecks.status, 'RUNNING')))
      .returning({ attempts: irdPanChecks.attempts });
    const row = updated[0];
    if (row === undefined) throw new CheckClosedError(`IRD check ${check.id} was closed meanwhile`);
    await recordAuditLog(tx, {
      actor: JOB_ACTOR,
      action: 'IRD_PAN_CHECK_COMPLETED',
      entityId: check.id,
      vendorId: check.vendor_id,
      beforeState: { status: 'RUNNING', tax_id: check.tax_id },
      afterState: {
        status,
        review_reason: reason,
        attempts: row.attempts,
        ird_business_name: finding.irdBusinessName ?? null,
        ird_registration_date: finding.irdRegistrationDate ?? null,
        name_similarity: finding.similarity ?? null,
      },
    });
  }
}
