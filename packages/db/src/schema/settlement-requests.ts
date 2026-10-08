import { settlementModelRequestStatuses } from '@hamro-pasal/shared-types';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId } from './columns';
import { settlementModelEnum } from './enums';
import { users } from './users';
import { vendors } from './vendors';

export const settlementModelRequestStatusEnum = pgEnum(
  'settlement_model_request_status',
  settlementModelRequestStatuses,
);

/**
 * Phase 27: a vendor's request to change its settlement model (SPEC core 5). The shop's own
 * account creates it (a trigger of migration 0026 refuses any other requester, so no admin can
 * file one for a shop); a Super Admin approves or rejects it as it was made. One PENDING request
 * per vendor.
 *
 * `from_model` is the model the shop was on when it asked: the shop's model now is
 * `vendors.settlement_model`, and after an approval the two differ.
 */
export const settlementModelChangeRequests = pgTable(
  'settlement_model_change_requests',
  {
    id: primaryId(),
    vendor_id: uuid()
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    from_model: settlementModelEnum().notNull(),
    requested_model: settlementModelEnum().notNull(),
    status: settlementModelRequestStatusEnum().notNull().default('PENDING'),
    /** Always the vendor's own user. */
    requested_by_user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    requested_at: timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    decided_by_user_id: uuid().references(() => users.id, { onDelete: 'restrict' }),
    decided_at: timestamp({ withTimezone: true, mode: 'date' }),
    /** Shown to the vendor; a rejection's only. */
    rejection_reason: text(),
  },
  (t) => [
    uniqueIndex('settlement_model_change_requests_pending_uidx')
      .on(t.vendor_id)
      .where(sql`${t.status} = 'PENDING'`),
    index('settlement_model_change_requests_vendor_id_idx').on(t.vendor_id, t.requested_at),
    index('settlement_model_change_requests_status_idx').on(t.status, t.requested_at),
    index('settlement_model_change_requests_requested_by_idx').on(t.requested_by_user_id),
    index('settlement_model_change_requests_decided_by_idx')
      .on(t.decided_by_user_id)
      .where(sql`${t.decided_by_user_id} IS NOT NULL`),
    check(
      'settlement_model_change_requests_models_check',
      sql`${t.from_model} <> ${t.requested_model}`,
    ),
    check(
      'settlement_model_change_requests_decision_check',
      sql`(${t.status} = 'PENDING') = (${t.decided_at} IS NULL) AND (${t.decided_at} IS NULL) = (${t.decided_by_user_id} IS NULL)`,
    ),
    check(
      'settlement_model_change_requests_reason_check',
      sql`${t.rejection_reason} IS NULL OR (${t.status} = 'REJECTED' AND btrim(${t.rejection_reason}) <> '')`,
    ),
  ],
);
