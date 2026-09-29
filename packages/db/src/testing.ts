import { existsSync } from 'node:fs';
import path from 'node:path';

import { Client } from 'pg';

import { runMigrations } from './migrator';

/*
 * Integration-test helpers, exported as `@hamro-pasal/db/testing`. Not for production code.
 * Each package uses its own database suffix, so parallel `test:integration` runs never share
 * or drop each other's database.
 */

const ROOT_ENV_FILE = path.resolve(__dirname, '..', '..', '..', '.env');

/**
 * Resolves the test database URL: `TEST_DATABASE_URL` if set, otherwise DATABASE_URL (from the
 * root .env) with `_<suffix>` appended to the database name. The name must end in `_test`,
 * because preparation DROPs and recreates it.
 */
export function resolveTestDatabaseUrl(suffix = 'test'): string {
  if (existsSync(ROOT_ENV_FILE)) {
    process.loadEnvFile(ROOT_ENV_FILE);
  }

  const explicit = process.env.TEST_DATABASE_URL;
  const base = process.env.DATABASE_URL;
  let url: URL;
  if (explicit !== undefined && explicit !== '') {
    url = new URL(explicit);
  } else if (base !== undefined && base !== '') {
    url = new URL(base);
    url.pathname = `${databaseName(url)}_${suffix}`;
  } else {
    throw new Error('Set TEST_DATABASE_URL or DATABASE_URL to run integration tests');
  }

  const name = databaseName(url);
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to use "${name}" as a test database: name must end in "_test"`);
  }
  return url.toString();
}

/** Drops and recreates the test database, then applies every migration (like a fresh deploy). */
export async function prepareTestDatabase(suffix = 'test'): Promise<string> {
  const testUrl = resolveTestDatabaseUrl(suffix);
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
  return testUrl;
}

function databaseName(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\//, ''));
}
