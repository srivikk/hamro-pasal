import { Client } from 'pg';

import { runMigrations } from '../src/migrator';
import { databaseName, resolveTestDatabaseUrl } from './support/test-database';

/** Recreates the test database from scratch and applies every migration, like a fresh deploy. */
export default async function globalSetup(): Promise<void> {
  const testUrl = resolveTestDatabaseUrl();
  const name = databaseName(new URL(testUrl));

  const admin = new URL(testUrl);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const quoted = client.escapeIdentifier(name);
    await client.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${quoted}`);
  } finally {
    await client.end();
  }

  await runMigrations(testUrl);
  process.env.TEST_DATABASE_URL = testUrl;
}
