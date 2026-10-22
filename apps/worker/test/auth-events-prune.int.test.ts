import { randomInt } from 'node:crypto';

import { authEvents, createDatabase, type Database } from '@hamro-pasal/db';
import { inArray, sql } from 'drizzle-orm';

import { AuthEventsPruneService } from '../src/auth/auth-events-prune';
import { createTimerHandlers } from '../src/queues/processors';

/**
 * 2026-10-22 (Task 6) on real PostgreSQL: the nightly AUTH_EVENTS_PRUNE deletes Authentication Log
 * rows older than 30 days, on the database clock, and nothing younger.
 */
describe('auth log prune (real PostgreSQL)', () => {
  let db: Database;
  beforeAll(() => {
    db = createDatabase(process.env.TEST_DATABASE_URL ?? '', { max: 4 });
  });

  afterAll(async () => {
    await db.$client.end();
  });

  const phone = () => `+9779${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;

  /** One row per age (days before now), returning their ids in the same order. */
  async function rowsAged(days: readonly number[]): Promise<string[]> {
    const rows = await db
      .insert(authEvents)
      .values(
        days.map((d) => ({
          phone: phone(),
          kind: 'OTP_SENT' as const,
          created_at: sql`now() - make_interval(secs => ${d * 86_400})`,
        })),
      )
      .returning({ id: authEvents.id });
    return rows.map((row) => row.id);
  }

  async function remaining(ids: readonly string[]): Promise<string[]> {
    const rows = await db
      .select({ id: authEvents.id })
      .from(authEvents)
      .where(inArray(authEvents.id, [...ids]));
    return rows.map((row) => row.id);
  }

  it('deletes rows older than 30 days and keeps the rest', async () => {
    const [old, ancient, edge, young, fresh] = await rowsAged([31, 400, 29.99, 10, 0]);
    const deleted = await new AuthEventsPruneService(db).run();

    expect(deleted).toBeGreaterThanOrEqual(2);
    expect((await remaining([old, ancient, edge, young, fresh] as string[])).sort()).toEqual(
      [edge, young, fresh].sort(),
    );
  });

  it('works through more rows than one batch, and a second run finds nothing', async () => {
    const ids = await rowsAged(Array.from({ length: 23 }, () => 45));
    await new AuthEventsPruneService(db, 30, 5).run();
    expect(await remaining(ids)).toEqual([]);
    expect(await new AuthEventsPruneService(db, 30, 5).run()).toBe(0);
  });

  it('runs as the midnight task, also twice at once', async () => {
    const ids = await rowsAged([60, 61, 62]);
    const prune = new AuthEventsPruneService(db, 30, 1);
    const handlers = createTimerHandlers({
      escalation: { escalateIfUnanswered: () => Promise.resolve('NOT_PENDING') },
      debtReconciliation: { suspendIndebtedVendors: () => Promise.resolve([]) },
      orderReconciliation: {
        reconcileDeliveredOrders: () => Promise.resolve({ reconciled: [], discrepancies: [] }),
      },
      authEventsPrune: prune,
    });
    await Promise.all([
      handlers.runMidnightTask('AUTH_EVENTS_PRUNE'),
      handlers.runMidnightTask('AUTH_EVENTS_PRUNE'),
    ]);
    expect(await remaining(ids)).toEqual([]);
  });
});
