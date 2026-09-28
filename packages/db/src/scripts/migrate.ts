import { runMigrations } from '../migrator';
import { describeDatabaseUrl, requireDatabaseUrl } from './database-url';

async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  console.info(`[db] applying migrations to ${describeDatabaseUrl(url)}`);
  await runMigrations(url);
  console.info('[db] migrations up to date');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
