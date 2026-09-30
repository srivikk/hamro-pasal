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

import { createdAt, primaryId, updatedAt } from './columns';
import { disputeStatusEnum, reviewDirectionEnum } from './enums';
import { orders } from './orders';
import { users } from './users';

export const disputes = pgTable(
  'disputes',
  {
    id: primaryId(),
    order_id: uuid()
      .notNull()
      .unique()
      .references(() => orders.id, { onDelete: 'restrict' }),
    opened_by_user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reason: text().notNull(),
    status: disputeStatusEnum().notNull().default('OPEN'),
    resolved_by_user_id: uuid().references(() => users.id, { onDelete: 'restrict' }),
    resolved_at: timestamp({ withTimezone: true, mode: 'date' }),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    index('disputes_status_idx').on(t.status),
    check('disputes_reason_check', sql`btrim(${t.reason}) <> ''`),
    // An OPEN dispute has no resolution, and a resolved one records who resolved it and when.
    check(
      'disputes_resolution_check',
      sql`(${t.status} = 'OPEN') = (${t.resolved_at} IS NULL AND ${t.resolved_by_user_id} IS NULL)`,
    ),
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
