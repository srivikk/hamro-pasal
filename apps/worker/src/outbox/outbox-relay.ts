import {
  outboxEvents,
  outboxRowToDomainEvent,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import type { DomainEvent } from '@hamro-pasal/shared-types';
import { and, asc, inArray, isNull, lt, sql } from 'drizzle-orm';

export interface EventPublisher {
  publish(events: readonly DomainEvent[]): Promise<void>;
}

export interface OutboxRelayOptions {
  readonly batchSize?: number;
  readonly pollIntervalMs?: number;
  /** After this many failed attempts a row is left for operators (dead-lettered in place). */
  readonly maxAttempts?: number;
  readonly onError?: (error: unknown) => void;
}

export interface RelayResult {
  readonly published: number;
  readonly failed: number;
}

/**
 * Transactional-outbox relay: moves committed domain events from PostgreSQL to Kafka.
 *
 * Each batch is claimed with FOR UPDATE SKIP LOCKED, so several worker replicas never publish
 * the same row concurrently. Rows are marked published only after Kafka acks (idempotent
 * producer, acks=all). A crash between ack and commit re-publishes the batch, so delivery is
 * at-least-once and consumers de-duplicate on event_id. Rows are published in occurrence order.
 * A failed publish leaves them in place for the next poll, which preserves per-aggregate order.
 */
export class OutboxRelay {
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly onError: (error: unknown) => void;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly db: Database,
    private readonly publisher: EventPublisher,
    options: OutboxRelayOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 100;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.maxAttempts = options.maxAttempts ?? 20;
    this.onError =
      options.onError ??
      ((error) => {
        console.error('[outbox-relay]', error);
      });
  }

  /** Publishes one batch. Exposed for tests and for draining on shutdown. */
  runOnce(): Promise<RelayResult> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(outboxEvents)
        .where(
          and(
            isNull(outboxEvents.published_at),
            lt(outboxEvents.publish_attempts, this.maxAttempts),
          ),
        )
        .orderBy(asc(outboxEvents.occurred_at), asc(outboxEvents.id))
        .limit(this.batchSize)
        .for('update', { skipLocked: true });
      if (rows.length === 0) {
        return { published: 0, failed: 0 };
      }

      const valid: { id: string; event: DomainEvent }[] = [];
      for (const row of rows) {
        try {
          valid.push({ id: row.id, event: outboxRowToDomainEvent(row) });
        } catch (error: unknown) {
          await markFailed(tx, [row.id], `invalid envelope: ${describe(error)}`);
        }
      }
      const poisoned = rows.length - valid.length;
      if (valid.length === 0) {
        return { published: 0, failed: poisoned };
      }

      const ids = valid.map((v) => v.id);
      try {
        await this.publisher.publish(valid.map((v) => v.event));
      } catch (error: unknown) {
        await markFailed(tx, ids, describe(error));
        this.onError(error);
        return { published: 0, failed: rows.length };
      }
      await tx
        .update(outboxEvents)
        .set({ published_at: new Date(), last_error: null })
        .where(inArray(outboxEvents.id, ids));
      return { published: ids.length, failed: poisoned };
    });
  }

  /** Polls continuously; drains back-to-back while batches are full. */
  start(): void {
    this.stopped = false;
    const tick = (): void => {
      this.running = this.runOnce()
        .then(
          (result) =>
            result.published + result.failed >= this.batchSize ? 0 : this.pollIntervalMs,
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

async function markFailed(tx: Transaction, ids: string[], message: string): Promise<void> {
  await tx
    .update(outboxEvents)
    .set({
      publish_attempts: sql`${outboxEvents.publish_attempts} + 1`,
      last_error: message.slice(0, 2000),
    })
    .where(inArray(outboxEvents.id, ids));
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
