import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { bytea, createdAt, primaryId } from './columns';
import { deadLetterStatusEnum } from './enums';
import { users } from './users';

/**
 * Phase 15: every message a worker consumer dead-lettered, for the Super Admin's DLQ monitor. The
 * worker writes the row before it publishes the Kafka copy (`notifications.dlq`), so a message
 * never reaches the DLQ topic without a row. Key and value are kept byte for byte, so a retry
 * republishes exactly what arrived.
 *
 * A retry is outbox-shaped: the API only sets RETRY_REQUESTED, and the worker's replayer publishes
 * the message to `source_topic`, then sets REPLAYED (Postgres and Kafka never disagree about it).
 */
export const deadLetterEvents = pgTable(
  'dead_letter_events',
  {
    id: primaryId(),
    status: deadLetterStatusEnum().notNull().default('PENDING'),
    consumer: text().notNull(),
    source_topic: text().notNull(),
    source_partition: integer().notNull(),
    /** Kafka offsets are int64: kept as their decimal string. */
    source_offset: text().notNull(),
    dead_letter_topic: text().notNull(),
    message_key: bytea(),
    message_value: bytea(),
    /** The message's own headers (string values), without the `dlq_*` bookkeeping ones. */
    headers: jsonb().$type<Record<string, string>>().notNull(),
    event_id: text(),
    event_type: text(),
    attempts: integer().notNull(),
    error_name: text().notNull(),
    error_message: text().notNull(),
    failed_at: timestamp({ withTimezone: true, mode: 'date' }).notNull(),
    retry_requested_at: timestamp({ withTimezone: true, mode: 'date' }),
    retry_requested_by: uuid().references(() => users.id, { onDelete: 'restrict' }),
    replayed_at: timestamp({ withTimezone: true, mode: 'date' }),
    replay_attempts: integer().notNull().default(0),
    last_replay_error: text(),
    /** The dead letter whose retry produced this message (from its `dlq_replay_of` header). */
    replay_of_id: uuid(),
    created_at: createdAt(),
  },
  (t) => [
    // A redelivered message (worker crash after the insert, before the offset commit) is stored once.
    uniqueIndex('dead_letter_events_source_uidx').on(
      t.consumer,
      t.source_topic,
      t.source_partition,
      t.source_offset,
    ),
    // The monitor's list: newest failure first, optionally by status.
    index('dead_letter_events_failed_at_idx').on(t.failed_at, t.id),
    index('dead_letter_events_status_idx').on(t.status, t.failed_at, t.id),
    // The replayer's work queue.
    index('dead_letter_events_retry_requested_idx')
      .on(t.retry_requested_at, t.id)
      .where(sql`${t.status} = 'RETRY_REQUESTED'`),
    // Phase 23: serves the users FK check; only a row someone retried names an admin.
    index('dead_letter_events_retry_requested_by_idx')
      .on(t.retry_requested_by)
      .where(sql`${t.retry_requested_by} IS NOT NULL`),
    check('dead_letter_events_offset_check', sql`${t.source_offset} ~ '^[0-9]+$'`),
    check('dead_letter_events_partition_check', sql`${t.source_partition} >= 0`),
    check('dead_letter_events_attempts_check', sql`${t.attempts} >= 1`),
    check('dead_letter_events_replay_attempts_check', sql`${t.replay_attempts} >= 0`),
    // PENDING has no retry bookkeeping; RETRY_REQUESTED records who asked and when; REPLAYED also when.
    check(
      'dead_letter_events_status_check',
      sql`(${t.status} = 'PENDING' AND ${t.retry_requested_at} IS NULL AND ${t.replayed_at} IS NULL)
        OR (${t.status} = 'RETRY_REQUESTED' AND ${t.retry_requested_at} IS NOT NULL AND ${t.replayed_at} IS NULL)
        OR (${t.status} = 'REPLAYED' AND ${t.retry_requested_at} IS NOT NULL AND ${t.replayed_at} IS NOT NULL)`,
    ),
  ],
);
