import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT_ENV_FILE = path.resolve(__dirname, '..', '..', '..', '..', '.env');

/**
 * Resolves the integration-test database URL: TEST_DATABASE_URL if set, otherwise DATABASE_URL
 * (from the root .env) with `_test` appended to the database name. The name must end in `_test`,
 * because global setup DROPs and recreates it.
 */
export function resolveTestDatabaseUrl(): string {
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
    url.pathname = `${url.pathname.replace(/^\//, '')}_test`;
  } else {
    throw new Error('Set TEST_DATABASE_URL or DATABASE_URL to run integration tests');
  }

  const name = databaseName(url);
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to use "${name}" as a test database: name must end in "_test"`);
  }
  return url.toString();
}

export function databaseName(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\//, ''));
}
