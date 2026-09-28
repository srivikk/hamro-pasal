import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';

import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema> & { $client: Pool };

export function createDatabase(connectionString: string, poolConfig: PoolConfig = {}): Database {
  const pool = new Pool({ connectionString, ...poolConfig });
  return drizzle({ client: pool, schema, casing: 'snake_case' });
}
