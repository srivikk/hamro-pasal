import type { Pool } from 'pg';

import { createTestPool } from './support/fixtures';

/**
 * Phase 23 (migration 0020): the index audit, kept as a test. A foreign key whose column leads no
 * index makes every delete or key update of the referenced row scan the referencing table.
 */
describe('foreign key indexes', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createTestPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('leaves no foreign key without an index led by its columns', async () => {
    const { rows } = await pool.query<{ table_name: string; constraint_name: string }>(`
      SELECT c.conrelid::regclass::text AS table_name, c.conname AS constraint_name
      FROM pg_constraint c
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
        AND NOT EXISTS (
          SELECT 1 FROM pg_index i
          WHERE i.indrelid = c.conrelid AND i.indisvalid
            AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey
        )
      ORDER BY 1, 2`);

    expect(rows).toEqual([]);
  });

  it('creates the seven audit indexes, partial where the column is usually null', async () => {
    const { rows } = await pool.query<{ indexname: string; partial: boolean }>(
      `SELECT indexname, indexdef LIKE '% WHERE %' AS partial FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = ANY($1) ORDER BY indexname`,
      [
        [
          'chat_messages_sender_user_id_idx',
          'dead_letter_events_retry_requested_by_idx',
          'disputes_opened_by_user_id_idx',
          'disputes_resolved_by_user_id_idx',
          'orders_driver_user_id_idx',
          'payout_requests_decided_by_user_id_idx',
          'payout_requests_reversal_transaction_id_idx',
        ],
      ],
    );

    expect(rows).toEqual([
      { indexname: 'chat_messages_sender_user_id_idx', partial: false },
      { indexname: 'dead_letter_events_retry_requested_by_idx', partial: true },
      { indexname: 'disputes_opened_by_user_id_idx', partial: false },
      { indexname: 'disputes_resolved_by_user_id_idx', partial: true },
      { indexname: 'orders_driver_user_id_idx', partial: true },
      { indexname: 'payout_requests_decided_by_user_id_idx', partial: true },
      { indexname: 'payout_requests_reversal_transaction_id_idx', partial: true },
    ]);
  });

  it('can serve the foreign key lookup on a nullable column from its partial index', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The test table is tiny, so the planner is told not to prefer a sequential scan.
      await client.query('SET LOCAL enable_seqscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT 1 FROM orders WHERE driver_user_id = gen_random_uuid() FOR KEY SHARE`,
      );
      expect(rows.map((row) => row['QUERY PLAN']).join('\n')).toContain(
        'orders_driver_user_id_idx',
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
