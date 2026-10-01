import { deadLetterEvents, type Database } from '@hamro-pasal/db';

import type { DeadLetterEntry, DeadLetterStore } from '../consumers/dead-letter';

/**
 * Writes dead letters to `dead_letter_events` for the Super Admin's DLQ monitor (Phase 15). A
 * redelivered message (the worker died after the insert, before the offset commit) hits the
 * unique source index and is not stored twice.
 */
export class DatabaseDeadLetterStore implements DeadLetterStore {
  constructor(private readonly db: Database) {}

  async save(entry: DeadLetterEntry): Promise<void> {
    await this.db
      .insert(deadLetterEvents)
      .values({
        consumer: entry.consumer,
        source_topic: entry.sourceTopic,
        source_partition: entry.partition,
        source_offset: entry.offset,
        dead_letter_topic: entry.deadLetterTopic,
        message_key: entry.key,
        message_value: entry.value,
        headers: { ...entry.headers },
        event_id: entry.eventId,
        event_type: entry.eventType,
        replay_of_id: entry.replayOfId,
        attempts: entry.attempts,
        error_name: entry.errorName,
        error_message: entry.errorMessage,
        failed_at: entry.failedAt,
      })
      .onConflictDoNothing({
        target: [
          deadLetterEvents.consumer,
          deadLetterEvents.source_topic,
          deadLetterEvents.source_partition,
          deadLetterEvents.source_offset,
        ],
      });
  }
}
