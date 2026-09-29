import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Transactional outbox. Domain events are inserted in the same DB transaction as the state change
 * they describe, then relayed to Kafka by apps/worker. `id` is the event_id consumers dedupe on.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid().primaryKey(),
    event_type: text().notNull(),
    topic: text().notNull(),
    aggregate_id: text().notNull(),
    payload: jsonb().$type<unknown>().notNull(),
    occurred_at: timestamp({ withTimezone: true, mode: 'date' }).notNull(),
    published_at: timestamp({ withTimezone: true, mode: 'date' }),
    publish_attempts: integer().notNull().default(0),
    last_error: text(),
  },
  (t) => [
    // The relay's work queue: unpublished events in occurrence order.
    index('outbox_events_unpublished_idx')
      .on(t.occurred_at, t.id)
      .where(sql`${t.published_at} IS NULL`),
    check('outbox_events_publish_attempts_check', sql`${t.publish_attempts} >= 0`),
  ],
);
