import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';

import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema> & { $client: Pool };

/** A Drizzle transaction handle, as passed to `db.transaction(async (tx) => ...)`. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Anything that can run queries: the pooled database or an open transaction. */
export type Executor = Database | Transaction;

export function createDatabase(connectionString: string, poolConfig: PoolConfig = {}): Database {
  const pool = new Pool({ connectionString, ...poolConfig });
  return drizzle({ client: pool, schema, casing: 'snake_case' });
}
