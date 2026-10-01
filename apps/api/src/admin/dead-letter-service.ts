import { deadLetterEvents, type Database } from '@hamro-pasal/db';
import {
  ADMIN_DEAD_LETTER_DEFAULT_LIMIT,
  type AdminDeadLetterListQuery,
} from '@hamro-pasal/shared-types';
import { and, desc, eq, sql } from 'drizzle-orm';

export type DeadLetterRow = typeof deadLetterEvents.$inferSelect;

export interface DeadLetterPage {
  readonly rows: readonly DeadLetterRow[];
  readonly nextCursor: string | null;
}

export class DeadLetterNotFoundError extends Error {
  constructor(readonly deadLetterId: string) {
    super(`Dead letter ${deadLetterId} not found`);
    this.name = 'DeadLetterNotFoundError';
  }
}

/** The row was already republished: a replay that failed again is a new dead letter to retry. */
export class DeadLetterAlreadyReplayedError extends Error {
  constructor(readonly deadLetterId: string) {
    super(`Dead letter ${deadLetterId} was already replayed`);
    this.name = 'DeadLetterAlreadyReplayedError';
  }
}

/** The `cursor` is not a stored dead letter. */
export class InvalidDeadLetterCursorError extends Error {
  constructor(readonly cursor: string) {
    super(`Cursor ${cursor} is not a dead letter`);
    this.name = 'InvalidDeadLetterCursorError';
  }
}

/**
 * The Super Admin's view of `dead_letter_events` (Phase 15). Reading is plain SQL; a retry only
 * records the request (RETRY_REQUESTED). The worker's DeadLetterReplayer republishes the message and
 * marks it REPLAYED, so the API needs no Kafka producer and a retry is never lost between a
 * database commit and a Kafka publish.
 */
export class DeadLetterService {
  constructor(private readonly db: Database) {}

  /** Newest failure first, keyset-paginated on the row id (compared in SQL, microsecond exact). */
  async list({
    status,
    limit = ADMIN_DEAD_LETTER_DEFAULT_LIMIT,
    cursor,
  }: AdminDeadLetterListQuery): Promise<DeadLetterPage> {
    if (cursor !== undefined) {
      const [known] = await this.db
        .select({ id: deadLetterEvents.id })
        .from(deadLetterEvents)
        .where(eq(deadLetterEvents.id, cursor));
      if (known === undefined) throw new InvalidDeadLetterCursorError(cursor);
    }
    const rows = await this.db
      .select()
      .from(deadLetterEvents)
      .where(
        and(
          status === undefined ? undefined : eq(deadLetterEvents.status, status),
          cursor === undefined
            ? undefined
            : sql`(${deadLetterEvents.failed_at}, ${deadLetterEvents.id}) <
                (SELECT c.failed_at, c.id FROM dead_letter_events c WHERE c.id = ${cursor})`,
        ),
      )
      .orderBy(desc(deadLetterEvents.failed_at), desc(deadLetterEvents.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      rows: page,
      nextCursor: rows.length > limit && last !== undefined ? last.id : null,
    };
  }

  /**
   * PENDING → RETRY_REQUESTED under the row lock. Asking again while the retry is still queued
   * answers with the same row; if the replayer has been failing on it, its attempt count restarts
   * so a retry stuck on a Kafka outage can be pushed again. A REPLAYED row is refused.
   */
  requestRetry(deadLetterId: string, adminUserId: string): Promise<DeadLetterRow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(deadLetterEvents)
        .where(eq(deadLetterEvents.id, deadLetterId))
        .for('update');
      if (row === undefined) throw new DeadLetterNotFoundError(deadLetterId);
      if (row.status === 'REPLAYED') throw new DeadLetterAlreadyReplayedError(deadLetterId);
      if (row.status === 'RETRY_REQUESTED' && row.replay_attempts === 0) return row;

      const [updated] = await tx
        .update(deadLetterEvents)
        .set(
          row.status === 'PENDING'
            ? {
                status: 'RETRY_REQUESTED',
                retry_requested_at: sql`now()`,
                retry_requested_by: adminUserId,
              }
            : { replay_attempts: 0 },
        )
        .where(eq(deadLetterEvents.id, deadLetterId))
        .returning();
      if (updated === undefined) throw new DeadLetterNotFoundError(deadLetterId);
      return updated;
    });
  }
}
