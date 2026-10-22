import type { Database } from '@hamro-pasal/db';
import { AUTH_EVENT_RETENTION_DAYS } from '@hamro-pasal/shared-types';
import { sql } from 'drizzle-orm';

/** Rows deleted per statement: short transactions, so sign-ins writing to the table never wait long. */
export const AUTH_EVENTS_PRUNE_BATCH = 5000;

/**
 * 2026-10-22 (Task 6): the nightly AUTH_EVENTS_PRUNE task. Deletes Authentication Log rows
 * (`auth_events`: one per login-code send and check, never the code) older than
 * AUTH_EVENT_RETENTION_DAYS, judged on the database clock, in batches until none is left. Nothing
 * references the table, and the reveal's audit entry (in `audit_logs`) is kept. Safe to run twice
 * or concurrently: a row is deleted once whoever reaches it.
 */
export class AuthEventsPruneService {
  constructor(
    private readonly db: Database,
    private readonly retentionDays: number = AUTH_EVENT_RETENTION_DAYS,
    private readonly batchSize: number = AUTH_EVENTS_PRUNE_BATCH,
  ) {}

  async run(): Promise<number> {
    let deleted = 0;
    for (;;) {
      const result = await this.db.execute(sql`
        DELETE FROM auth_events
        WHERE id IN (
          SELECT id FROM auth_events
          WHERE created_at < now() - make_interval(days => ${this.retentionDays})
          ORDER BY created_at
          LIMIT ${this.batchSize}
          FOR UPDATE SKIP LOCKED
        )`);
      const count = result.rowCount ?? 0;
      deleted += count;
      if (count < this.batchSize) return deleted;
    }
  }
}
