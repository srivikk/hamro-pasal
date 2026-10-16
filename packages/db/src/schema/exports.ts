import {
  exportDeliveries,
  exportJobStatuses,
  exportKinds,
  type ExportParams,
} from '@hamro-pasal/shared-types';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, primaryId } from './columns';
import { userRoleEnum } from './enums';
import { users } from './users';

export const exportKindEnum = pgEnum('export_kind', exportKinds);
export const exportJobStatusEnum = pgEnum('export_job_status', exportJobStatuses);
export const exportDeliveryEnum = pgEnum('export_delivery', exportDeliveries);

/**
 * Step 7.6 (SPEC core 11): an export too large to download at once (more than 5 000 rows), built
 * by the worker and emailed. The file itself is in the private bucket under `file_key`
 * (`exports/<id>.zip`) only when it was too large to attach, and only until `expires_at`.
 */
export const exportJobs = pgTable(
  'export_jobs',
  {
    id: primaryId(),
    requested_by_user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** The role the export was requested as (vendor exports are scoped to the vendor's shop). */
    role: userRoleEnum().notNull(),
    kind: exportKindEnum().notNull(),
    params: jsonb().$type<ExportParams>().notNull(),
    /** Where the email goes: the requester's address when it was requested. */
    email: text().notNull(),
    status: exportJobStatusEnum().notNull().default('QUEUED'),
    row_count: integer().notNull().default(0),
    file_key: text(),
    delivery: exportDeliveryEnum(),
    error: text(),
    created_at: createdAt(),
    started_at: timestamp({ withTimezone: true }),
    finished_at: timestamp({ withTimezone: true }),
    expires_at: timestamp({ withTimezone: true }),
  },
  (t) => [
    index('export_jobs_requested_by_idx').on(t.requested_by_user_id, t.created_at),
    // The daily sweep: linked files whose link has expired.
    index('export_jobs_expires_idx')
      .on(t.expires_at)
      .where(sql`${t.file_key} IS NOT NULL`),
    check('export_jobs_row_count_check', sql`${t.row_count} >= 0`),
    check('export_jobs_params_check', sql`jsonb_typeof(${t.params}) = 'object'`),
    check(
      'export_jobs_file_key_check',
      sql`${t.file_key} IS NULL OR ${t.file_key} ~ '^exports/[0-9a-f-]{36}\\.zip$'`,
    ),
    // A finished job says how it was delivered; a linked one has a file and an expiry.
    check(
      'export_jobs_outcome_check',
      sql`(${t.status} IN ('DONE', 'FAILED')) = (${t.finished_at} IS NOT NULL)
        AND (${t.status} = 'DONE') = (${t.delivery} IS NOT NULL)
        AND (${t.delivery} IS DISTINCT FROM 'LINK' OR ${t.expires_at} IS NOT NULL)
        AND (${t.file_key} IS NULL OR ${t.delivery} = 'LINK')
        AND (${t.status} <> 'FAILED' OR ${t.error} IS NOT NULL)`,
    ),
  ],
);
