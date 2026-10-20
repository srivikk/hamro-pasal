import { enqueueDomainEvent, irdPanChecks, type Transaction } from '@hamro-pasal/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { VendorRow } from './compliance-standing';

/*
 * Requesting the automated IRD PAN check (2026-10-21). Called inside the transaction that changed
 * the vendor row (a PAN saved, a document uploaded), under the vendor row lock it holds, with the
 * row as that transaction leaves it. The check, its outbox event and the change commit together.
 */

/** A vendor is checkable when it has a PAN and its document, and nobody has verified it yet. */
export function isIrdCheckable(vendor: VendorRow): boolean {
  return (
    vendor.tax_id !== null && vendor.pan_document_url !== null && vendor.pan_verified_at === null
  );
}

/**
 * Brings the vendor's IRD check in line with its row:
 *
 * - not checkable (no PAN, no document, or already verified): every open check is SUPERSEDED;
 * - a check already QUEUED or RUNNING for this very PAN is left to run;
 * - otherwise any open check (for another PAN, or one in manual review: the vendor has given new
 *   information, a name or a document) is SUPERSEDED and a new one QUEUED, with
 *   `vendor.pan_check_requested` written to the outbox.
 *
 * Returns the new check's id, or null when none was queued.
 */
export async function requestIrdPanCheck(
  tx: Transaction,
  vendor: VendorRow,
): Promise<string | null> {
  const open = await tx
    .select({ id: irdPanChecks.id, taxId: irdPanChecks.tax_id, status: irdPanChecks.status })
    .from(irdPanChecks)
    .where(
      and(
        eq(irdPanChecks.vendor_id, vendor.id),
        inArray(irdPanChecks.status, ['QUEUED', 'RUNNING', 'MANUAL_REVIEW']),
      ),
    )
    .for('update');

  const taxId = vendor.tax_id;
  if (!isIrdCheckable(vendor) || taxId === null) {
    await supersede(
      tx,
      open.map((check) => check.id),
    );
    return null;
  }
  const inFlight = open.find(
    (check) => check.taxId === taxId && (check.status === 'QUEUED' || check.status === 'RUNNING'),
  );
  if (inFlight !== undefined) return null;

  await supersede(
    tx,
    open.map((check) => check.id),
  );
  const [check] = await tx
    .insert(irdPanChecks)
    .values({ vendor_id: vendor.id, tax_id: taxId })
    .returning({ id: irdPanChecks.id, createdAt: irdPanChecks.created_at });
  if (check === undefined) throw new Error('The IRD check was not created');
  await enqueueDomainEvent(tx, {
    type: 'vendor.pan_check_requested',
    aggregateId: vendor.id,
    occurredAt: check.createdAt,
    payload: {
      check_id: check.id,
      vendor_id: vendor.id,
      tax_id: taxId,
      requested_at: check.createdAt.toISOString(),
    },
  });
  return check.id;
}

async function supersede(tx: Transaction, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(irdPanChecks)
    .set({ status: 'SUPERSEDED', review_reason: null, completed_at: sql`now()` })
    .where(inArray(irdPanChecks.id, [...ids]));
}
