import { userSchema, vendorSchema } from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';

import { createDatabase, type Database } from '../src/client';
import { recordNotificationMessage } from '../src/notification-centre';
import { notificationMessages, notificationRecipients, users, vendors } from '../src/schema';
import { resolveTestDatabaseUrl } from '../src/testing';
import { createTestPool, createUser, createVendor, firstRow, pgError } from './support/fixtures';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

describe('migration 0039: account settings, vendor code, notification centre', () => {
  let pool: Pool;
  let db: Database;

  beforeAll(() => {
    pool = createTestPool();
    db = createDatabase(process.env.TEST_DATABASE_URL ?? resolveTestDatabaseUrl());
  });

  afterAll(async () => {
    await db.$client.end();
    await pool.end();
  });

  const userRow = async (id: string) =>
    firstRow(await db.select().from(users).where(eq(users.id, id)));

  describe('users', () => {
    it('gives a new account the defaults, and matches the contract', async () => {
      const row = await userRow(await createUser(pool));
      expect(row).toMatchObject({
        email: null,
        language_preference: 'en',
        terms_accepted_at: null,
        whatsapp_opt_in: false,
        account_status: 'ACTIVE',
        deletion_requested_at: null,
      });
      expect(userSchema.safeParse(row).success).toBe(true);
    });

    it('stores an email lower-cased only, and once among all accounts', async () => {
      const [first, second] = [await createUser(pool), await createUser(pool)];
      const setEmail = (id: string, email: string) =>
        pool.query('UPDATE users SET email = $2 WHERE id = $1', [id, email]);

      expect((await pgError(setEmail(first, 'Sita@Example.com'))).code).toBe(CHECK_VIOLATION);
      expect((await pgError(setEmail(first, ' sita@example.com'))).code).toBe(CHECK_VIOLATION);
      expect((await pgError(setEmail(first, 'not-an-address'))).code).toBe(CHECK_VIOLATION);

      const email = `owner-${first.slice(0, 8)}@example.com`;
      await setEmail(first, email);
      const taken = await pgError(setEmail(second, email));
      expect(taken.code).toBe(UNIQUE_VIOLATION);
      expect(taken.constraint).toBe('users_email_uidx');
      // Accounts without an email never clash.
      await pool.query('UPDATE users SET email = NULL WHERE id = $1', [second]);
    });

    it('ties a deletion request to its time', async () => {
      const id = await createUser(pool);
      const set = (status: string, at: string | null) =>
        pool.query(
          'UPDATE users SET account_status = $2, deletion_requested_at = $3 WHERE id = $1',
          [id, status, at],
        );
      expect((await pgError(set('DELETED_REQUESTED', null))).code).toBe(CHECK_VIOLATION);
      expect((await pgError(set('ACTIVE', new Date().toISOString()))).code).toBe(CHECK_VIOLATION);
      await set('DELETED_REQUESTED', new Date().toISOString());
    });
  });

  describe('vendors.vendor_code', () => {
    const codeOf = async (id: string) =>
      firstRow(
        await db.select({ code: vendors.vendor_code }).from(vendors).where(eq(vendors.id, id)),
      ).code;

    it('gives each new shop the next HPV- code, permanent and unique, and matches the contract', async () => {
      const [a, b] = [await createVendor(pool), await createVendor(pool)];
      const [codeA, codeB] = [await codeOf(a), await codeOf(b)];

      expect(codeA).toMatch(/^HPV-\d{5,}$/);
      expect(Number(codeB.slice(4))).toBeGreaterThan(Number(codeA.slice(4)));
      expect(
        vendorSchema.safeParse(firstRow(await db.select().from(vendors).where(eq(vendors.id, a))))
          .success,
      ).toBe(true);

      const taken = await pgError(
        pool.query('UPDATE vendors SET vendor_code = $2 WHERE id = $1', [b, codeA]),
      );
      expect(taken.code).toBe(UNIQUE_VIOLATION);
      const malformed = await pgError(
        pool.query("UPDATE vendors SET vendor_code = 'V-1' WHERE id = $1", [b]),
      );
      expect(malformed.code).toBe(CHECK_VIOLATION);
    });

    it('never truncates past 99999', async () => {
      const { rows } = await pool.query<{ code: string }>(`
        SELECT 'HPV-' || CASE WHEN n < 100000 THEN lpad(n::text, 5, '0') ELSE n::text END AS code
          FROM (VALUES (42::bigint), (99999), (100000), (1234567)) AS t(n)`);
      expect(rows.map((row) => row.code)).toEqual([
        'HPV-00042',
        'HPV-99999',
        'HPV-100000',
        'HPV-1234567',
      ]);
      const { rows: def } = await pool.query<{ src: string }>(
        "SELECT pg_get_functiondef('next_vendor_code'::regproc) AS src",
      );
      expect(def[0]?.src).toContain('ELSE n::text');
    });

    it('was given to every existing shop by the backfill (no shop is without one)', async () => {
      const { rows } = await pool.query<{ missing: number }>(
        'SELECT count(*)::int AS missing FROM vendors WHERE vendor_code IS NULL',
      );
      expect(rows[0]?.missing).toBe(0);
    });
  });

  describe('recordNotificationMessage', () => {
    it('stores a targeted message with its recipients, once per dedupe key', async () => {
      const [a, b] = [await createUser(pool, 'VENDOR'), await createUser(pool, 'VENDOR')];
      const key = `notice:test:${a}`;
      const message = {
        audience: 'VENDOR' as const,
        source: 'SYSTEM' as const,
        title: 'Your ad has ended',
        body: 'Open Marketing to book your next ad.',
        data: { event_type: 'marketing.ad_ended' },
        dedupeKey: key,
        recipientUserIds: [a, b, a],
      };

      const first = await recordNotificationMessage(db, message);
      const again = await recordNotificationMessage(db, message);
      const concurrent = await Promise.all(
        Array.from({ length: 4 }, () => recordNotificationMessage(db, message)),
      );

      expect(first.created).toBe(true);
      expect(again).toEqual({ id: first.id, created: false });
      expect(concurrent.every((each) => each.id === first.id)).toBe(true);
      const recipients = await db
        .select()
        .from(notificationRecipients)
        .where(eq(notificationRecipients.message_id, first.id));
      expect(recipients.map((row) => row.user_id).sort()).toEqual([a, b].sort());
      expect(
        await db
          .select()
          .from(notificationMessages)
          .where(eq(notificationMessages.dedupe_key, key)),
      ).toHaveLength(1);
    });

    it('stores a broadcast once with no recipient rows, and refuses mixed shapes', async () => {
      const admin = await createUser(pool, 'SUPER_ADMIN');
      const { id } = await recordNotificationMessage(db, {
        audience: 'ALL_CUSTOMERS',
        source: 'ADMIN',
        title: 'Dashain offers',
        body: 'Shops near you have Dashain offers.',
        createdByUserId: admin,
        recipientUserIds: [],
      });
      expect(
        await db
          .select()
          .from(notificationRecipients)
          .where(eq(notificationRecipients.message_id, id)),
      ).toEqual([]);

      await expect(
        recordNotificationMessage(db, {
          audience: 'ALL_CUSTOMERS',
          source: 'ADMIN',
          title: 'T',
          body: 'B',
          createdByUserId: admin,
          recipientUserIds: [admin],
        }),
      ).rejects.toThrow(RangeError);
      await expect(
        recordNotificationMessage(db, {
          audience: 'VENDOR',
          source: 'SYSTEM',
          title: 'T',
          body: 'B',
          recipientUserIds: [],
        }),
      ).rejects.toThrow(RangeError);
    });

    it('refuses an admin message without its admin, a system one with one, and empty text', async () => {
      const admin = await createUser(pool, 'SUPER_ADMIN');
      const insert = (source: string, createdBy: string | null, title = 'T') =>
        pool.query(
          `INSERT INTO notification_messages (audience, source, title, body, created_by_user_id)
           VALUES ('ALL_CUSTOMERS', $1, $2, 'B', $3)`,
          [source, title, createdBy],
        );
      expect((await pgError(insert('ADMIN', null))).code).toBe(CHECK_VIOLATION);
      expect((await pgError(insert('SYSTEM', admin))).code).toBe(CHECK_VIOLATION);
      expect((await pgError(insert('SYSTEM', null, '   '))).code).toBe(CHECK_VIOLATION);
      expect((await pgError(insert('SYSTEM', null, 'x'.repeat(61)))).code).toBe(CHECK_VIOLATION);
    });
  });
});
