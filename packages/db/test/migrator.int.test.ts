import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Client } from 'pg';

import { MIGRATION_LOCK_KEY, runMigrations } from '../src/migrator';

/**
 * Phase 7 (2026-10-22): deploys run `node dist/bin/migrate.js` before new containers take traffic.
 * Several runs may start together (a retried pipeline); the advisory lock makes them queue, so on an
 * empty database every run succeeds and each migration is applied exactly once.
 */
describe('runMigrations under concurrency (real PostgreSQL)', () => {
  const base = new URL(process.env.TEST_DATABASE_URL ?? '');
  const name = `${base.pathname.slice(1)}_migrator_test`;
  const url = new URL(base.toString());
  url.pathname = `/${name}`;
  const admin = new URL(base.toString());
  admin.pathname = '/postgres';

  async function onAdmin(sql: string): Promise<void> {
    const client = new Client({ connectionString: admin.toString() });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    await onAdmin(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await onAdmin(`CREATE DATABASE "${name}"`);
  });

  afterAll(async () => {
    await onAdmin(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  });

  it('applies every migration once when three runs start together', async () => {
    await Promise.all([1, 2, 3].map(() => runMigrations(url.toString())));

    const journal = JSON.parse(
      readFileSync(path.resolve(__dirname, '..', 'drizzle', 'meta', '_journal.json'), 'utf8'),
    ) as { entries: unknown[] };
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    try {
      const applied = await client.query<{ count: string }>(
        'SELECT count(*) FROM drizzle.__drizzle_migrations',
      );
      expect(Number(applied.rows[0]?.count)).toBe(journal.entries.length);
      // The lock is released: nobody is left holding it.
      const held = await client.query<{ count: string }>(
        `SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = $1`,
        [MIGRATION_LOCK_KEY],
      );
      expect(Number(held.rows[0]?.count)).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('gives up waiting for another run’s lock after MIGRATION_LOCK_TIMEOUT_MS', async () => {
    const holder = new Client({ connectionString: url.toString() });
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      await expect(runMigrations(url.toString(), { lockTimeoutMs: 300 })).rejects.toThrow(
        /lock timeout/,
      );
    } finally {
      await holder.end();
    }
  });
});
