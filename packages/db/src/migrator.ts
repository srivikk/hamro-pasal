import path from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';

/** Absolute path to the SQL migrations shipped with this package. */
export const MIGRATIONS_FOLDER = path.resolve(__dirname, '..', 'drizzle');

/**
 * Phase 7 (2026-10-22): the session advisory lock every migration run takes first. Two deploys
 * that start at the same moment (a retried pipeline, two regions) queue on it instead of applying
 * the same migration twice; the second finds nothing left to do.
 */
export const MIGRATION_LOCK_KEY = 7_202_610_22;

/**
 * Applies all pending migrations, one run at a time (MIGRATION_LOCK_KEY). Each migration file
 * runs in a transaction. `lockTimeoutMs` bounds the wait for another run's lock (default: wait).
 */
export async function runMigrations(
  connectionString: string,
  options: { readonly lockTimeoutMs?: number } = {},
): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    if (options.lockTimeoutMs !== undefined) {
      await client.query(
        `SET lock_timeout = ${String(Math.max(0, Math.floor(options.lockTimeoutMs)))}`,
      );
    }
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await migrate(drizzle({ client }), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}
