import { deadLetterEvents, type Database } from '@hamro-pasal/db';
import type { KafkaJS } from '@hamro-pasal/kafka';
import { and, asc, eq, lt, sql } from 'drizzle-orm';

import { DEAD_LETTER_HEADERS, type DeadLetterPublisher } from '../consumers/dead-letter';

type DeadLetterRow = typeof deadLetterEvents.$inferSelect;

export interface DeadLetterReplayerOptions {
  readonly batchSize?: number;
  readonly pollIntervalMs?: number;
  /** After this many failed republishes a row stays RETRY_REQUESTED with its last error shown. */
  readonly maxAttempts?: number;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
  /** Called after each republished row (default: one JSON line). */
  readonly onReplayed?: (row: DeadLetterRow) => void;
}

export interface ReplayResult {
  readonly replayed: number;
  readonly failed: number;
}

const MAX_REPLAY_ERROR_LENGTH = 2_000;

/**
 * The message a retry republishes: the stored key and value byte for byte, to the topic it was
 * first consumed from, with its own headers (event_id etc., so consumers still de-duplicate) plus
 * `dlq_replay_of`, linking a retry that fails again to this row.
 */
export function replayRecord(row: DeadLetterRow): KafkaJS.ProducerRecord {
  return {
    topic: row.source_topic,
    messages: [
      {
        key: row.message_key,
        value: row.message_value,
        headers: { ...row.headers, [DEAD_LETTER_HEADERS.replayOf]: row.id },
      },
    ],
  };
}

/**
 * Phase 15: republishes the dead letters a Super Admin asked to retry (status RETRY_REQUESTED, set
 * by POST /api/admin/dlq/:id/retry). Shaped like the OutboxRelay: rows are claimed with
 * FOR UPDATE SKIP LOCKED, published through the idempotent producer, and marked REPLAYED in the same
 * transaction only after Kafka acknowledged them. A crash between the ack and the commit publishes
 * the row again (at-least-once; consumers de-duplicate on event_id).
 */
export class DeadLetterReplayer {
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => Date;
  private readonly onError: (error: unknown) => void;
  private readonly onReplayed: (row: DeadLetterRow) => void;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly db: Database,
    private readonly publisher: DeadLetterPublisher,
    options: DeadLetterReplayerOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 20;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.maxAttempts = options.maxAttempts ?? 10;
    this.now = options.now ?? (() => new Date());
    this.onError =
      options.onError ??
      ((error) => {
        console.error('[dead-letter-replayer]', error);
      });
    this.onReplayed =
      options.onReplayed ??
      ((row) => {
        console.info(
          JSON.stringify({
            notification: 'dead_letter.replayed',
            dead_letter_id: row.id,
            consumer: row.consumer,
            source_topic: row.source_topic,
            event_id: row.event_id,
          }),
        );
      });
  }

  /** Republishes one batch. Exposed for tests. */
  runOnce(): Promise<ReplayResult> {
    return this.db
      .transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(deadLetterEvents)
          .where(
            and(
              eq(deadLetterEvents.status, 'RETRY_REQUESTED'),
              lt(deadLetterEvents.replay_attempts, this.maxAttempts),
            ),
          )
          .orderBy(asc(deadLetterEvents.retry_requested_at), asc(deadLetterEvents.id))
          .limit(this.batchSize)
          .for('update', { skipLocked: true });

        let replayed = 0;
        let failed = 0;
        const done: DeadLetterRow[] = [];
        for (const row of rows) {
          try {
            await this.publisher.publish(replayRecord(row));
          } catch (error: unknown) {
            failed += 1;
            this.onError(error);
            await tx
              .update(deadLetterEvents)
              .set({
                replay_attempts: sql`${deadLetterEvents.replay_attempts} + 1`,
                last_replay_error: describe(error).slice(0, MAX_REPLAY_ERROR_LENGTH),
              })
              .where(eq(deadLetterEvents.id, row.id));
            continue;
          }
          replayed += 1;
          await tx
            .update(deadLetterEvents)
            .set({ status: 'REPLAYED', replayed_at: this.now(), last_replay_error: null })
            .where(eq(deadLetterEvents.id, row.id));
          done.push(row);
        }
        return { replayed, failed, done };
      })
      .then(({ replayed, failed, done }) => {
        // Logged only once the REPLAYED marks are committed.
        for (const row of done) this.onReplayed(row);
        return { replayed, failed };
      });
  }

  /** Polls continuously; drains back-to-back while batches are full. */
  start(): void {
    this.stopped = false;
    const tick = (): void => {
      this.running = this.runOnce()
        .then(
          (result) => (result.replayed + result.failed >= this.batchSize ? 0 : this.pollIntervalMs),
          (error: unknown) => {
            this.onError(error);
            return this.pollIntervalMs;
          },
        )
        .then((delay) => {
          if (!this.stopped) this.timer = setTimeout(tick, delay);
        });
    };
    tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    await this.running;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
