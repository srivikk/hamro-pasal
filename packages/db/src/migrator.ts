import path from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';

/** Absolute path to the SQL migrations shipped with this package. */
export const MIGRATIONS_FOLDER = path.resolve(__dirname, '..', 'drizzle');

/** Applies all pending migrations. Each migration file runs in a transaction. */
export async function runMigrations(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await migrate(drizzle({ client }), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await client.end();
  }
}
