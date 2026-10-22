import { describeDatabaseUrl, requireDatabaseUrl } from '../database-url';
import { runMigrations } from '../migrator';

/**
 * Phase 7 (2026-10-22): the compiled migration runner, `node dist/bin/migrate.js`, for production
 * images (no tsx, no .env file: DATABASE_URL comes from the environment). The deploy pipeline runs
 * it as a one-off task from the new API image before any new container takes traffic. It holds the
 * migration advisory lock while it works, so concurrent runs queue, and exits 1 on any failure,
 * which stops the deploy. MIGRATION_LOCK_TIMEOUT_MS (optional) bounds the wait for that lock.
 */
async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  const timeout = process.env.MIGRATION_LOCK_TIMEOUT_MS;
  console.info(`[db] applying migrations to ${describeDatabaseUrl(url)}`);
  await runMigrations(
    url,
    timeout === undefined || timeout === '' ? {} : { lockTimeoutMs: Number(timeout) },
  );
  console.info('[db] migrations up to date');
}

main().catch((error: unknown) => {
  console.error('[db] migration failed:', error);
  process.exit(1);
});
