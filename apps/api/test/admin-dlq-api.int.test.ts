import { randomInt, randomUUID } from 'node:crypto';

import { deadLetterEvents, type Database } from '@hamro-pasal/db';
import {
  adminDeadLetterListResponseSchema,
  adminDeadLetterRetryResponseSchema,
  type DeadLetterView,
} from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';
import { createUser } from './support/fixtures';

type NewRow = typeof deadLetterEvents.$inferInsert;

/**
 * Phase 15: the Super Admin's DLQ monitor over `dead_letter_events` (real PostgreSQL). Rows are
 * written here the way the worker's DatabaseDeadLetterStore writes them; the republish itself is
 * the worker's DeadLetterReplayer (apps/worker/test/dead-letter-replayer.int.test.ts).
 */
describe('Admin DLQ API', () => {
  let testApp: TestApp;
  let db: Database;
  let adminId: string;
  let admin: string;

  beforeAll(async () => {
    testApp = buildTestApp();
    db = testApp.container.db;
    adminId = await createUser(db, 'SUPER_ADMIN');
    admin = bearer(adminId, 'SUPER_ADMIN');
  });

  afterAll(async () => {
    await testApp.container.close();
  });

  const event = {
    event_id: randomUUID(),
    event_type: 'vendor.suspended_for_debt',
    event_version: 1,
    occurred_at: '2026-10-01T06:00:00.000Z',
    aggregate_id: randomUUID(),
    payload: { vendor_id: randomUUID(), wallet_balance_npr: -2500 },
  };

  /** A stored dead letter, as the worker writes it after the 4th failed attempt. */
  async function deadLetter(overrides: Partial<NewRow> = {}) {
    const [row] = await db
      .insert(deadLetterEvents)
      .values({
        consumer: 'vendor-notifications',
        source_topic: 'notifications.broadcast',
        source_partition: 1,
        source_offset: String(randomInt(0, 1_000_000_000)),
        dead_letter_topic: 'notifications.dlq',
        message_key: Buffer.from(event.aggregate_id),
        message_value: Buffer.from(JSON.stringify(event)),
        headers: { event_id: event.event_id, event_type: event.event_type, event_version: '1' },
        event_id: event.event_id,
        event_type: event.event_type,
        attempts: 4,
        error_name: 'SmsDeliveryError',
        error_message: 'SPARROW SMS failed: HTTP 503',
        failed_at: new Date(),
        ...overrides,
      })
      .returning();
    if (row === undefined) throw new Error('dead letter not created');
    return row;
  }

  async function rowOf(id: string) {
    const [row] = await db.select().from(deadLetterEvents).where(eq(deadLetterEvents.id, id));
    if (row === undefined) throw new Error('row vanished');
    return row;
  }

  function list(query: Record<string, string> = {}, token = admin) {
    return request(testApp.app).get('/api/admin/dlq').query(query).set('Authorization', token);
  }

  function retry(id: string, token = admin) {
    return request(testApp.app).post(`/api/admin/dlq/${id}/retry`).set('Authorization', token);
  }

  /** Every row of the listing, following next_cursor. */
  async function listAll(query: Record<string, string>): Promise<DeadLetterView[]> {
    const all: DeadLetterView[] = [];
    let cursor: string | null = null;
    for (;;) {
      const res = await list(cursor === null ? query : { ...query, cursor });
      expect(res.status).toBe(200);
      const body = bodyOf(adminDeadLetterListResponseSchema, res);
      all.push(...body.dead_letters);
      if (body.next_cursor === null) return all;
      expect(body.next_cursor).toBe(body.dead_letters.at(-1)?.id);
      cursor = body.next_cursor;
    }
  }

  describe('GET /api/admin/dlq', () => {
    it('shows the failure, the source and the decoded event', async () => {
      const row = await deadLetter();

      const res = await list();

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const view = bodyOf(adminDeadLetterListResponseSchema, res).dead_letters.find(
        (letter) => letter.id === row.id,
      );
      expect(view).toEqual({
        id: row.id,
        status: 'PENDING',
        consumer: 'vendor-notifications',
        source_topic: 'notifications.broadcast',
        source_partition: 1,
        source_offset: row.source_offset,
        dead_letter_topic: 'notifications.dlq',
        message_key: event.aggregate_id,
        event_id: event.event_id,
        event_type: 'vendor.suspended_for_debt',
        payload: event,
        raw_value: JSON.stringify(event),
        headers: { event_id: event.event_id, event_type: event.event_type, event_version: '1' },
        attempts: 4,
        error_name: 'SmsDeliveryError',
        error_message: 'SPARROW SMS failed: HTTP 503',
        failed_at: row.failed_at.toISOString(),
        retry_requested_at: null,
        retry_requested_by: null,
        replayed_at: null,
        replay_attempts: 0,
        last_replay_error: null,
        replay_of_id: null,
      });
    });

    it('shows a poison pill as raw text with no payload', async () => {
      const poison = '{"event_type":"vendor.restored","payload":';
      const row = await deadLetter({
        message_key: null,
        message_value: Buffer.from(poison),
        headers: {},
        event_id: null,
        event_type: null,
        attempts: 1,
        error_name: 'PoisonMessageError',
      });

      const view = (await listAll({})).find((letter) => letter.id === row.id);

      expect(view).toMatchObject({
        message_key: null,
        payload: null,
        raw_value: poison,
        event_id: null,
        attempts: 1,
      });
    });

    it('pages newest failure first without gaps or repeats, and filters by status', async () => {
      // Far-future failure times, so these five are the newest rows whatever else exists.
      const base = Date.parse('2099-01-01T00:00:00.000Z') + randomInt(0, 1_000_000) * 60_000;
      const rows = [];
      for (let i = 0; i < 5; i += 1) {
        rows.push(await deadLetter({ failed_at: new Date(base + i * 1_000) }));
      }
      const newestFirst = rows.map((row) => row.id).reverse();

      const firstPage = bodyOf(adminDeadLetterListResponseSchema, await list({ limit: '2' }));
      expect(firstPage.dead_letters.map((letter) => letter.id)).toEqual(newestFirst.slice(0, 2));

      const all = await listAll({ limit: '2' });
      const ids = all.map((letter) => letter.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.filter((id) => newestFirst.includes(id))).toEqual(newestFirst);
      const failedAt = all.map((letter) => Date.parse(letter.failed_at));
      expect(failedAt).toEqual([...failedAt].sort((a, b) => b - a));

      expect((await retry(rows[0]?.id ?? '')).status).toBe(202);
      const requested = await listAll({ status: 'RETRY_REQUESTED' });
      expect(requested.map((letter) => letter.id)).toContain(rows[0]?.id);
      expect(requested.every((letter) => letter.status === 'RETRY_REQUESTED')).toBe(true);
      const pending = await listAll({ status: 'PENDING' });
      expect(pending.map((letter) => letter.id)).not.toContain(rows[0]?.id);
    });

    it('rejects a bad status, limit or cursor', async () => {
      for (const query of [{ status: 'LOST' }, { limit: '0' }, { limit: '101' }, { cursor: 'x' }]) {
        const res = await list(query);
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
      const unknown = await list({ cursor: randomUUID() });
      expect(unknown.status).toBe(400);
      expect(errorOf(unknown).code).toBe('INVALID_CURSOR');
    });
  });

  describe('POST /api/admin/dlq/:id/retry', () => {
    it('queues a PENDING dead letter for the worker (202, RETRY_REQUESTED, who and when)', async () => {
      const row = await deadLetter();

      const res = await retry(row.id);

      expect(res.status).toBe(202);
      expect(res.headers['cache-control']).toBe('no-store');
      const { dead_letter } = bodyOf(adminDeadLetterRetryResponseSchema, res);
      expect(dead_letter).toMatchObject({
        id: row.id,
        status: 'RETRY_REQUESTED',
        retry_requested_by: adminId,
        replayed_at: null,
      });
      expect(dead_letter.retry_requested_at).not.toBeNull();
      const stored = await rowOf(row.id);
      expect(stored.status).toBe('RETRY_REQUESTED');
      expect(stored.retry_requested_by).toBe(adminId);
    });

    it('answers a repeated request with the same queued row', async () => {
      const row = await deadLetter();
      const first = bodyOf(adminDeadLetterRetryResponseSchema, await retry(row.id));

      const again = await retry(row.id);

      expect(again.status).toBe(202);
      expect(bodyOf(adminDeadLetterRetryResponseSchema, again).dead_letter).toEqual(
        first.dead_letter,
      );
    });

    it('queues a row once when several admins press Retry at the same time', async () => {
      const row = await deadLetter();
      const otherAdmin = await createUser(db, 'SUPER_ADMIN');

      const results = await Promise.all([
        retry(row.id),
        retry(row.id, bearer(otherAdmin, 'SUPER_ADMIN')),
        retry(row.id),
        retry(row.id, bearer(otherAdmin, 'SUPER_ADMIN')),
      ]);

      expect(results.map((res) => res.status)).toEqual([202, 202, 202, 202]);
      const views = results.map(
        (res) => bodyOf(adminDeadLetterRetryResponseSchema, res).dead_letter,
      );
      expect(new Set(views.map((view) => view.retry_requested_at)).size).toBe(1);
      expect(new Set(views.map((view) => view.retry_requested_by)).size).toBe(1);
    });

    it('waits for a retry request holding the row, then answers with it unchanged', async () => {
      const row = await deadLetter();
      const otherAdmin = await createUser(db, 'SUPER_ADMIN');
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let lockTaken = (): void => undefined;
      const locked = new Promise<void>((resolve) => {
        lockTaken = resolve;
      });
      // Another admin's request, still uncommitted, holding the row lock.
      const first = db.transaction(async (tx) => {
        await tx
          .select({ id: deadLetterEvents.id })
          .from(deadLetterEvents)
          .where(eq(deadLetterEvents.id, row.id))
          .for('update');
        await tx
          .update(deadLetterEvents)
          .set({
            status: 'RETRY_REQUESTED',
            retry_requested_at: new Date(),
            retry_requested_by: otherAdmin,
          })
          .where(eq(deadLetterEvents.id, row.id));
        lockTaken();
        await held;
      });
      await locked;

      const second = retry(row.id).then((res) => res);
      await new Promise((resolve) => setTimeout(resolve, 200));
      release();
      await first;
      const res = await second;

      // Without the lock it would read PENDING and overwrite who asked.
      expect(res.status).toBe(202);
      expect(bodyOf(adminDeadLetterRetryResponseSchema, res).dead_letter.retry_requested_by).toBe(
        otherAdmin,
      );
      expect((await rowOf(row.id)).retry_requested_by).toBe(otherAdmin);
    });

    it('re-arms a retry the worker keeps failing to publish', async () => {
      const row = await deadLetter({
        status: 'RETRY_REQUESTED',
        retry_requested_at: new Date(Date.now() - 60_000),
        retry_requested_by: adminId,
        replay_attempts: 10,
        last_replay_error: 'KafkaJSError: broker down',
      });

      const res = await retry(row.id);

      expect(res.status).toBe(202);
      expect(bodyOf(adminDeadLetterRetryResponseSchema, res).dead_letter).toMatchObject({
        status: 'RETRY_REQUESTED',
        replay_attempts: 0,
        retry_requested_at: row.retry_requested_at?.toISOString(),
        last_replay_error: 'KafkaJSError: broker down',
      });
    });

    it('refuses a dead letter that was already replayed', async () => {
      const row = await deadLetter({
        status: 'REPLAYED',
        retry_requested_at: new Date(),
        retry_requested_by: adminId,
        replayed_at: new Date(),
      });

      const res = await retry(row.id);

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('DEAD_LETTER_ALREADY_REPLAYED');
      expect((await rowOf(row.id)).status).toBe('REPLAYED');
    });

    it('answers 404 for an unknown id and 400 for a malformed one', async () => {
      const unknown = await retry(randomUUID());
      expect(unknown.status).toBe(404);
      expect(errorOf(unknown).code).toBe('DEAD_LETTER_NOT_FOUND');
      const malformed = await retry('42');
      expect(malformed.status).toBe(400);
      expect(errorOf(malformed).code).toBe('VALIDATION_FAILED');
    });
  });

  it('serves Super Admins only', async () => {
    const row = await deadLetter();
    const tokens = [
      bearer(await createUser(db), 'CUSTOMER'),
      bearer(await createUser(db, 'VENDOR'), 'VENDOR'),
      bearer(await createUser(db, 'DRIVER'), 'DRIVER'),
    ];

    expect((await request(testApp.app).get('/api/admin/dlq')).status).toBe(401);
    expect((await request(testApp.app).post(`/api/admin/dlq/${row.id}/retry`)).status).toBe(401);
    for (const token of tokens) {
      expect((await list({}, token)).status).toBe(403);
      const res = await retry(row.id, token);
      expect(res.status).toBe(403);
      expect(errorOf(res).code).toBe('FORBIDDEN');
    }
    expect((await rowOf(row.id)).status).toBe('PENDING');
  });

  it('keeps retry bookkeeping consistent with the status (CHECK constraint)', async () => {
    await expect(deadLetter({ status: 'RETRY_REQUESTED' })).rejects.toThrow();
    await expect(
      deadLetter({ status: 'REPLAYED', retry_requested_at: new Date() }),
    ).rejects.toThrow();
    await expect(deadLetter({ retry_requested_at: new Date() })).rejects.toThrow();
  });
});
