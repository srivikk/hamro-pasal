import { sql } from 'drizzle-orm';
import type { StoredChatAttachment } from '@hamro-pasal/shared-types';
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, npr, primaryId, updatedAt } from './columns';
import { disputeStatusEnum, reviewDirectionEnum } from './enums';
import { ledgerTransactions } from './ledger';
import { orders } from './orders';
import { users } from './users';

/**
 * Step 7.3 (SPEC core 6): an order's one Customer <-> Vendor conversation, its escalation to Hamro
 * Pasal, and how it ended. The first message opens it (OPEN); a party may escalate it once
 * (ESCALATED); the day-8 release closes it (CLOSED, also created so when nobody chatted); the
 * Super Admin resolves an escalated one (RELEASED_TO_VENDOR, REFUNDED_TO_CUSTOMER,
 * PARTIALLY_REFUNDED).
 */
export const disputes = pgTable(
  'disputes',
  {
    id: primaryId(),
    order_id: uuid()
      .notNull()
      .unique()
      .references(() => orders.id, { onDelete: 'restrict' }),
    /** Null for a row the day-8 release created: nobody chatted. */
    opened_by_user_id: uuid().references(() => users.id, { onDelete: 'restrict' }),
    /** Before step 7.3, the first message; a conversation is not a complaint. */
    reason: text(),
    status: disputeStatusEnum().notNull().default('OPEN'),
    escalated_at: timestamp({ withTimezone: true, mode: 'date' }),
    escalated_by_user_id: uuid().references(() => users.id, { onDelete: 'restrict' }),
    escalation_reason: text(),
    refund_npr: npr(),
    resolution_note: text(),
    hold_release_transaction_id: uuid().references(() => ledgerTransactions.id, {
      onDelete: 'restrict',
    }),
    resolved_by_user_id: uuid().references(() => users.id, { onDelete: 'restrict' }),
    resolved_at: timestamp({ withTimezone: true, mode: 'date' }),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    index('disputes_status_idx').on(t.status),
    // Phase 23: every foreign key has an index its parent's delete / key update can use.
    index('disputes_opened_by_user_id_idx').on(t.opened_by_user_id),
    index('disputes_resolved_by_user_id_idx')
      .on(t.resolved_by_user_id)
      .where(sql`${t.resolved_by_user_id} IS NOT NULL`),
    index('disputes_escalated_by_user_id_idx')
      .on(t.escalated_by_user_id)
      .where(sql`${t.escalated_by_user_id} IS NOT NULL`),
    index('disputes_hold_release_transaction_id_idx')
      .on(t.hold_release_transaction_id)
      .where(sql`${t.hold_release_transaction_id} IS NOT NULL`),
    // The Super Admin's queue: escalated conversations, oldest first.
    index('disputes_escalated_at_idx')
      .on(t.escalated_at, t.id)
      .where(sql`${t.escalated_at} IS NOT NULL`),
    check('disputes_reason_check', sql`${t.reason} IS NULL OR btrim(${t.reason}) <> ''`),
    // An escalation names who, when and why; a conversation that never was escalated has none.
    check(
      'disputes_escalation_check',
      sql`(${t.escalated_at} IS NULL) = (${t.escalated_by_user_id} IS NULL)
        AND (${t.escalated_at} IS NULL) = (${t.escalation_reason} IS NULL)
        AND (${t.status} <> 'ESCALATED' OR ${t.escalated_at} IS NOT NULL)`,
    ),
    check(
      'disputes_escalation_reason_check',
      sql`${t.escalation_reason} IS NULL OR length(btrim(${t.escalation_reason})) BETWEEN 10 AND 500`,
    ),
    // OPEN and ESCALATED are still running; every other status records when it ended, and only a
    // Super Admin resolution (which follows an escalation) names who, why and the refund.
    check(
      'disputes_resolution_check',
      sql`(${t.status} IN ('OPEN', 'ESCALATED')) = (${t.resolved_at} IS NULL)
        AND (${t.status} IN ('RELEASED_TO_VENDOR', 'REFUNDED_TO_CUSTOMER', 'PARTIALLY_REFUNDED'))
          = (${t.resolved_by_user_id} IS NOT NULL)
        AND (${t.resolved_by_user_id} IS NULL) = (${t.resolution_note} IS NULL)
        AND (${t.resolved_by_user_id} IS NULL) = (${t.refund_npr} IS NULL)
        AND (${t.resolved_by_user_id} IS NULL OR ${t.escalated_at} IS NOT NULL)`,
    ),
    check('disputes_refund_check', sql`${t.refund_npr} IS NULL OR ${t.refund_npr} >= 0`),
  ],
);

/**
 * The dispute chat transcript (SPEC Super Admin flow 3: arbitration reviews the in-app text/photo
 * chat). Written by the /chat namespace before a message is broadcast. Append-only by convention:
 * nothing updates or deletes messages.
 */
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: primaryId(),
    dispute_id: uuid()
      .notNull()
      .references(() => disputes.id, { onDelete: 'restrict' }),
    sender_user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    client_id: text().notNull(),
    body: text().notNull(),
    attachments: jsonb().$type<StoredChatAttachment[]>().notNull(),
    created_at: createdAt(),
  },
  (t) => [
    // A retried send (same device id) is stored once.
    unique('chat_messages_dispute_sender_client_key').on(
      t.dispute_id,
      t.sender_user_id,
      t.client_id,
    ),
    index('chat_messages_dispute_id_created_at_idx').on(t.dispute_id, t.created_at),
    index('chat_messages_sender_user_id_idx').on(t.sender_user_id),
    check('chat_messages_client_id_check', sql`length(${t.client_id}) BETWEEN 1 AND 100`),
    check('chat_messages_body_check', sql`length(${t.body}) <= 2000`),
    check(
      'chat_messages_attachments_check',
      sql`jsonb_typeof(${t.attachments}) = 'array' AND jsonb_array_length(${t.attachments}) <= 4`,
    ),
    // Text, an image, or both: never an empty message.
    check(
      'chat_messages_not_empty_check',
      sql`btrim(${t.body}) <> '' OR jsonb_array_length(${t.attachments}) > 0`,
    ),
  ],
);

/** Double-blind reviews (SPEC §6): quarantined until both sides submit or 48 hours elapse. */
export const reviews = pgTable(
  'reviews',
  {
    id: primaryId(),
    order_id: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    direction: reviewDirectionEnum().notNull(),
    rating: smallint().notNull(),
    comment: text(),
    is_published: boolean().notNull().default(false),
    published_at: timestamp({ withTimezone: true, mode: 'date' }),
    created_at: createdAt(),
  },
  (t) => [
    unique('reviews_order_id_direction_key').on(t.order_id, t.direction),
    // Serves the 48h publisher sweep over quarantined reviews.
    index('reviews_unpublished_created_at_idx')
      .on(t.created_at)
      .where(sql`${t.is_published} = false`),
    check('reviews_rating_check', sql`${t.rating} BETWEEN 1 AND 5`),
    check('reviews_comment_check', sql`${t.comment} IS NULL OR btrim(${t.comment}) <> ''`),
    check('reviews_published_at_check', sql`${t.is_published} = (${t.published_at} IS NOT NULL)`),
  ],
);
