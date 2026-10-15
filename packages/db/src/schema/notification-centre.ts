import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, primaryId } from './columns';
import { notificationAudienceEnum, notificationSourceEnum } from './enums';
import { users } from './users';

/**
 * Step 7.1 (SPEC core 11): every message kept for a notification centre. A VENDOR or CUSTOMER
 * message reaches the users named in notification_recipients; an ALL_CUSTOMERS broadcast is stored
 * once and seen by every customer whose account existed when it was sent (SPEC edge case 23).
 */
export const notificationMessages = pgTable(
  'notification_messages',
  {
    id: primaryId(),
    audience: notificationAudienceEnum().notNull(),
    source: notificationSourceEnum().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** The admin who sent it; null for a message the system wrote. */
    created_by_user_id: uuid().references(() => users.id, { onDelete: 'restrict' }),
    /**
     * Makes a system write idempotent: a redelivered event finds its message already there
     * (e.g. `notice:<event_id>:<vendor_id>`). Null for an admin's message.
     */
    dedupe_key: text().unique(),
    created_at: createdAt(),
  },
  (t) => [
    index('notification_messages_audience_created_idx').on(t.audience, t.created_at, t.id),
    index('notification_messages_created_by_user_id_idx')
      .on(t.created_by_user_id)
      .where(sql`${t.created_by_user_id} IS NOT NULL`),
    check(
      'notification_messages_title_check',
      sql`char_length(btrim(${t.title})) BETWEEN 1 AND 60`,
    ),
    check('notification_messages_body_check', sql`char_length(btrim(${t.body})) BETWEEN 1 AND 240`),
    check('notification_messages_data_check', sql`jsonb_typeof(${t.data}) = 'object'`),
    check(
      'notification_messages_source_check',
      sql`(${t.source} = 'ADMIN') = (${t.created_by_user_id} IS NOT NULL)`,
    ),
  ],
);

/** Who a targeted (VENDOR / CUSTOMER) message is for, and when each of them read it. */
export const notificationRecipients = pgTable(
  'notification_recipients',
  {
    message_id: uuid()
      .notNull()
      .references(() => notificationMessages.id, { onDelete: 'cascade' }),
    user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    read_at: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.message_id, t.user_id] }),
    index('notification_recipients_user_idx').on(t.user_id, t.message_id),
  ],
);

/** Read receipts of broadcasts, one row per customer who read one. */
export const notificationReads = pgTable(
  'notification_reads',
  {
    message_id: uuid()
      .notNull()
      .references(() => notificationMessages.id, { onDelete: 'cascade' }),
    user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    read_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.message_id, t.user_id] }),
    index('notification_reads_user_idx').on(t.user_id, t.message_id),
  ],
);
