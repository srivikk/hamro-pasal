import { randomUUID } from 'node:crypto';

import { auditLogSchema } from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';

import { InvalidAuditLogError, recordAuditLog, type NewAuditLog } from '../src/audit';
import { createDatabase, type Database } from '../src/client';
import { auditLogs, vendors } from '../src/schema';
import { resolveTestDatabaseUrl } from '../src/testing';
import { createTestPool, createUser, createVendor, firstRow, pgError } from './support/fixtures';

const APPEND_ONLY = '23000'; // integrity_constraint_violation, raised by the triggers
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';

describe('audit_logs', () => {
  let pool: Pool;
  let db: Database;
  let adminId: string;
  let vendorId: string;

  beforeAll(async () => {
    pool = createTestPool();
    db = createDatabase(process.env.TEST_DATABASE_URL ?? resolveTestDatabaseUrl());
    adminId = await createUser(pool, 'SUPER_ADMIN');
    vendorId = await createVendor(pool);
  });

  afterAll(async () => {
    await db.$client.end();
    await pool.end();
  });

  const panVerified = (overrides: Partial<NewAuditLog> = {}): NewAuditLog => ({
    actor: { kind: 'USER', user_id: adminId, role: 'SUPER_ADMIN' },
    action: 'PAN_VERIFIED',
    entityId: vendorId,
    vendorId,
    beforeState: { tax_id: '302118845', pan_verified_at: null },
    afterState: { tax_id: '302118845', pan_verified_at: '2026-10-07T06:00:00.000Z' },
    ...overrides,
  });

  const rowsFor = async (entityId: string) =>
    db.select().from(auditLogs).where(eq(auditLogs.entity_id, entityId));

  describe('recordAuditLog', () => {
    it('stores a user action with the record type of its action and the database clock', async () => {
      const before = new Date(Date.now() - 5000);
      const stored = await db.transaction((tx) =>
        recordAuditLog(
          tx,
          panVerified({
            context: {
              request_id: 'req_01JC7Q2M9X',
              ip_address: '103.10.28.14',
              user_agent: 'Mozilla/5.0 Chrome/141.0',
            },
          }),
        ),
      );

      expect(auditLogSchema.parse(stored)).toEqual(stored);
      expect(stored).toMatchObject({
        actor_user_id: adminId,
        actor_role: 'SUPER_ADMIN',
        system_actor: null,
        action: 'PAN_VERIFIED',
        entity_type: 'vendor',
        entity_id: vendorId,
        vendor_id: vendorId,
        before_state: { tax_id: '302118845', pan_verified_at: null },
        after_state: { tax_id: '302118845', pan_verified_at: '2026-10-07T06:00:00.000Z' },
        request_id: 'req_01JC7Q2M9X',
        ip_address: '103.10.28.14',
        user_agent: 'Mozilla/5.0 Chrome/141.0',
      });
      expect(stored.occurred_at.getTime()).toBeGreaterThan(before.getTime());
      expect((await db.select().from(auditLogs).where(eq(auditLogs.id, stored.id)))[0]).toEqual(
        stored,
      );
    });

    it('stores a job as the actor, a creation with no state before, and a platform-wide change', async () => {
      const campaignId = randomUUID();
      const stored = await db.transaction((tx) =>
        recordAuditLog(tx, {
          actor: { kind: 'SYSTEM', job: 'BILLING_CYCLE_RENEWAL' },
          action: 'CAMPAIGN_CREATED',
          entityId: campaignId,
          vendorId: null,
          beforeState: null,
          afterState: { name: 'Dashain 10%', terms: { value: 10, methods: ['COD'] } },
        }),
      );

      expect(stored).toMatchObject({
        actor_user_id: null,
        actor_role: null,
        system_actor: 'BILLING_CYCLE_RENEWAL',
        entity_type: 'platform_campaign',
        vendor_id: null,
        before_state: null,
        after_state: { name: 'Dashain 10%', terms: { value: 10, methods: ['COD'] } },
        request_id: null,
        ip_address: null,
        user_agent: null,
      });
    });

    it('only accepts a transaction: the pooled database does not type-check', () => {
      // @ts-expect-error -- an entry is written in the transaction of its change, never on its own.
      const misuse = (): Promise<unknown> => recordAuditLog(db, panVerified());
      expect(typeof misuse).toBe('function');
    });

    it('commits with the change it records, and rolls back with it', async () => {
      const entityId = randomUUID();
      const name = `Renamed ${entityId.slice(0, 8)}`;

      await db.transaction(async (tx) => {
        await tx.update(vendors).set({ business_name: name }).where(eq(vendors.id, vendorId));
        await recordAuditLog(tx, panVerified({ entityId }));
      });
      expect(await rowsFor(entityId)).toHaveLength(1);

      const rolledBack = randomUUID();
      await expect(
        db.transaction(async (tx) => {
          await tx.update(vendors).set({ business_name: 'Never' }).where(eq(vendors.id, vendorId));
          await recordAuditLog(tx, panVerified({ entityId: rolledBack }));
          throw new Error('the change failed after its entry was written');
        }),
      ).rejects.toThrow('the change failed');

      expect(await rowsFor(rolledBack)).toEqual([]);
      const [vendor] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
      expect(vendor?.business_name).toBe(name);
    });

    it('refuses an invalid entry before writing, and takes the change down with it', async () => {
      const entityId = randomUUID();
      const [vendorBefore] = await db.select().from(vendors).where(eq(vendors.id, vendorId));

      await expect(
        db.transaction(async (tx) => {
          await tx
            .update(vendors)
            .set({ business_name: 'Unaudited' })
            .where(eq(vendors.id, vendorId));
          await recordAuditLog(tx, panVerified({ entityId, vendorId: 'not-a-uuid' }));
        }),
      ).rejects.toThrow(InvalidAuditLogError);

      expect(await rowsFor(entityId)).toEqual([]);
      const [vendorAfter] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
      expect(vendorAfter?.business_name).toBe(vendorBefore?.business_name);
    });

    it('never stores a secret: a state naming one is refused, with the field named', async () => {
      const entityId = randomUUID();
      const attempt = db.transaction((tx) =>
        recordAuditLog(
          tx,
          panVerified({
            entityId,
            afterState: { tax_id: '302118845', gateway: { secret_key: '8gBm/:&EnhH.1/q' } },
          }),
        ),
      );
      await expect(attempt).rejects.toThrow(InvalidAuditLogError);
      await expect(attempt).rejects.toThrow('Secrets are never audited: gateway.secret_key');
      expect(await rowsFor(entityId)).toEqual([]);
    });

    it('refuses an action the contract does not know', async () => {
      const entry = { ...panVerified(), action: 'PLAN_EDITED' } as unknown as NewAuditLog;
      await expect(db.transaction((tx) => recordAuditLog(tx, entry))).rejects.toThrow(
        InvalidAuditLogError,
      );
    });

    it('stores every entry of 20 concurrent transactions, each with its own time', async () => {
      const entityId = randomUUID();
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          db.transaction((tx) =>
            recordAuditLog(tx, panVerified({ entityId, afterState: { attempt: index } })),
          ),
        ),
      );
      const rows = await rowsFor(entityId);
      expect(rows).toHaveLength(20);
      expect(new Set(rows.map((row) => row.id)).size).toBe(20);
      expect(
        rows.map((row) => row.after_state.attempt).sort((a, b) => Number(a) - Number(b)),
      ).toEqual(Array.from({ length: 20 }, (_, index) => index));
    });

    it('stamps the time of the insert, not of the start of the transaction', async () => {
      const entityId = randomUUID();
      const [first, second, transactionStart] = await db.transaction(async (tx) => {
        const { rows } = await tx.execute<{ now: Date }>('SELECT now() AS now');
        const one = await recordAuditLog(tx, panVerified({ entityId }));
        await tx.execute('SELECT pg_sleep(0.05)');
        const two = await recordAuditLog(tx, panVerified({ entityId }));
        return [one, two, new Date(firstRow(rows).now)] as const;
      });
      expect(first.occurred_at.getTime()).toBeGreaterThanOrEqual(transactionStart.getTime());
      expect(second.occurred_at.getTime()).toBeGreaterThan(first.occurred_at.getTime());
    });
  });

  describe('append-only, enforced by the database', () => {
    let entryId: string;

    beforeAll(async () => {
      const stored = await db.transaction((tx) => recordAuditLog(tx, panVerified()));
      entryId = stored.id;
    });

    const stored = async () =>
      firstRow(
        (
          await pool.query<Record<string, unknown>>('SELECT * FROM audit_logs WHERE id = $1', [
            entryId,
          ])
        ).rows,
      );

    it('refuses UPDATE, whatever column it touches', async () => {
      const before = await stored();
      for (const statement of [
        `UPDATE audit_logs SET after_state = '{"tampered": true}' WHERE id = $1`,
        `UPDATE audit_logs SET action = 'PAN_VERIFICATION_CLEARED' WHERE id = $1`,
        `UPDATE audit_logs SET occurred_at = now() - interval '1 year' WHERE id = $1`,
        `UPDATE audit_logs SET actor_user_id = actor_user_id WHERE id = $1`,
      ]) {
        const error = await pgError(pool.query(statement, [entryId]));
        expect(error.code).toBe(APPEND_ONLY);
        expect(error.message).toBe('audit_logs is append-only (UPDATE rejected)');
      }
      expect(await stored()).toEqual(before);
    });

    it('refuses DELETE', async () => {
      const error = await pgError(pool.query('DELETE FROM audit_logs WHERE id = $1', [entryId]));
      expect(error.code).toBe(APPEND_ONLY);
      expect(error.message).toBe('audit_logs is append-only (DELETE rejected)');
      expect(await stored()).toBeDefined();
    });

    it('refuses TRUNCATE, also through CASCADE from a referenced table', async () => {
      for (const statement of ['TRUNCATE audit_logs', 'TRUNCATE users CASCADE']) {
        const error = await pgError(pool.query(statement));
        expect(error.code).toBe(APPEND_ONLY);
        expect(error.message).toBe('audit_logs is append-only (TRUNCATE rejected)');
      }
      expect(await stored()).toBeDefined();
    });

    it('refuses the same through the application code path (Drizzle)', async () => {
      await expect(
        db.update(auditLogs).set({ user_agent: 'edited' }).where(eq(auditLogs.id, entryId)),
      ).rejects.toThrow();
      await expect(db.delete(auditLogs).where(eq(auditLogs.id, entryId))).rejects.toThrow();
      expect(await stored()).toBeDefined();
    });

    it('keeps the entries of an actor and a shop: neither can be deleted from under them', async () => {
      const actor = await createUser(pool, 'SUPER_ADMIN');
      const shop = await createVendor(pool);
      await db.transaction((tx) =>
        recordAuditLog(
          tx,
          panVerified({
            actor: { kind: 'USER', user_id: actor, role: 'SUPER_ADMIN' },
            entityId: shop,
            vendorId: shop,
          }),
        ),
      );
      expect((await pgError(pool.query('DELETE FROM users WHERE id = $1', [actor]))).code).toBe(
        FOREIGN_KEY_VIOLATION,
      );
      expect((await pgError(pool.query('DELETE FROM vendors WHERE id = $1', [shop]))).code).toBe(
        FOREIGN_KEY_VIOLATION,
      );
      expect(await rowsFor(shop)).toHaveLength(1);
    });
  });

  describe('constraints behind the writer', () => {
    const insert = (columns: Record<string, unknown>) => {
      const row = {
        actor_user_id: adminId,
        actor_role: 'SUPER_ADMIN',
        system_actor: null,
        action: 'PAN_VERIFIED',
        entity_type: 'vendor',
        entity_id: vendorId,
        after_state: '{}',
        ...columns,
      };
      const names = Object.keys(row);
      return pool.query(
        `INSERT INTO audit_logs (${names.join(', ')}) VALUES (${names.map((_, i) => `$${String(i + 1)}`).join(', ')})`,
        Object.values(row),
      );
    };

    it('needs exactly one kind of actor', async () => {
      await expect(insert({})).resolves.toBeDefined();
      await expect(
        insert({ actor_user_id: null, actor_role: null, system_actor: 'SWEEP' }),
      ).resolves.toBeDefined();
      for (const actor of [
        { actor_user_id: null, actor_role: null, system_actor: null },
        { system_actor: 'SWEEP' },
        { actor_role: null },
        { actor_user_id: null },
        { actor_user_id: null, actor_role: null, system_actor: 'nightly sweep' },
      ]) {
        expect((await pgError(insert(actor))).code).toBe(CHECK_VIOLATION);
      }
    });

    it('needs an actor who exists', async () => {
      expect((await pgError(insert({ actor_user_id: randomUUID() }))).code).toBe(
        FOREIGN_KEY_VIOLATION,
      );
    });

    it('takes a state that is a JSON object and an action in upper snake case', async () => {
      for (const columns of [
        { after_state: '[1, 2]' },
        { after_state: '"LIVE"' },
        { after_state: 'null' },
        { before_state: '[]' },
        { action: 'pan verified' },
        { entity_type: 'Vendor' },
      ]) {
        expect((await pgError(insert(columns))).code).toBe(CHECK_VIOLATION);
      }
    });
  });
});
