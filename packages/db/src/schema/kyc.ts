import { irdPanCheckStatuses, irdReviewReasons } from '@hamro-pasal/shared-types';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, primaryId, updatedAt } from './columns';
import { users } from './users';
import { vendors } from './vendors';

export const irdPanCheckStatusEnum = pgEnum('ird_pan_check_status', irdPanCheckStatuses);
export const irdReviewReasonEnum = pgEnum('ird_review_reason', irdReviewReasons);

/**
 * Automated IRD PAN verification (2026-10-21): one row per lookup of a vendor's PAN on the IRD's
 * public PAN search, and its state machine (shared-types `kyc/ird-checks.ts`). Requested in the
 * transaction that left the vendor with a PAN and a document but no verification; worked by the
 * worker's `ird-pan-verification` queue; the open ones in MANUAL_REVIEW are the admin dashboard's
 * "Action Required: Manual Review" queue.
 */
export const irdPanChecks = pgTable(
  'ird_pan_checks',
  {
    id: primaryId(),
    vendor_id: uuid()
      .notNull()
      .references(() => vendors.id, { onDelete: 'cascade' }),
    /** The PAN this check is about: a later change of the vendor's PAN supersedes the check. */
    tax_id: text().notNull(),
    status: irdPanCheckStatusEnum().notNull().default('QUEUED'),
    review_reason: irdReviewReasonEnum(),
    attempts: integer().notNull().default(0),
    /** What the IRD answered: the trade name (English) and the effective registration date. */
    ird_business_name: text(),
    ird_registration_date: text(),
    /** 0–1, the fuzzy name score the decision was made on. */
    name_similarity: numeric({ precision: 4, scale: 3, mode: 'number' }),
    last_error: text(),
    resolved_by_user_id: uuid().references(() => users.id, { onDelete: 'restrict' }),
    created_at: createdAt(),
    updated_at: updatedAt(),
    started_at: timestamp({ withTimezone: true }),
    completed_at: timestamp({ withTimezone: true }),
  },
  (t) => [
    // One check in flight per vendor; a newer request supersedes an older one first.
    uniqueIndex('ird_pan_checks_open_uidx')
      .on(t.vendor_id)
      .where(sql`${t.status} IN ('QUEUED', 'RUNNING', 'MANUAL_REVIEW')`),
    index('ird_pan_checks_vendor_idx').on(t.vendor_id, t.created_at),
    // The admin's queue, oldest first.
    index('ird_pan_checks_review_idx')
      .on(t.created_at)
      .where(sql`${t.status} = 'MANUAL_REVIEW'`),
    index('ird_pan_checks_resolved_by_user_id_idx')
      .on(t.resolved_by_user_id)
      .where(sql`${t.resolved_by_user_id} IS NOT NULL`),
    check('ird_pan_checks_tax_id_check', sql`${t.tax_id} ~ '^[0-9]{9}$'`),
    check('ird_pan_checks_attempts_check', sql`${t.attempts} BETWEEN 0 AND 3`),
    check(
      'ird_pan_checks_similarity_check',
      sql`${t.name_similarity} IS NULL OR ${t.name_similarity} BETWEEN 0 AND 1`,
    ),
    // A reason exactly while a person is (or was) needed; a finished check has its time.
    check(
      'ird_pan_checks_state_check',
      sql`(${t.status} IN ('MANUAL_REVIEW', 'RESOLVED')) = (${t.review_reason} IS NOT NULL)
        AND (${t.status} IN ('VERIFIED', 'MANUAL_REVIEW', 'RESOLVED', 'SUPERSEDED')) = (${t.completed_at} IS NOT NULL)
        AND (${t.status} = 'RESOLVED') = (${t.resolved_by_user_id} IS NOT NULL)`,
    ),
  ],
);
