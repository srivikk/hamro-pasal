import { randomUUID } from 'node:crypto';

import {
  auditLogs,
  exportJobs,
  outboxEvents,
  users,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import { exportJobResponseSchema } from '@hamro-pasal/shared-types';
import { and, eq, sql } from 'drizzle-orm';
import request from 'supertest';

import { createOrder, createUser, createVendor, vendorUserIdOf } from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/** Today's date in Nepal Time, `YYYY-MM-DD`. */
function today(): string {
  return new Date(Date.now() + (5 * 60 + 45) * 60_000).toISOString().slice(0, 10);
}

/** The CSV body of a supertest response, as text. */
function csvOf(res: request.Response): string {
  return typeof res.text === 'string' && res.text !== '' ? res.text : String(res.body);
}

/**
 * Step 7.6 (SPEC core 11, verification 30): data exports through the API. Real Express +
 * PostgreSQL; the worker's side is tested in apps/worker.
 */
describe('Data export API', () => {
  let t: TestApp;
  let db: Database;
  let adminId: string;
  let admin: string;

  beforeAll(async () => {
    t = buildTestApp();
    db = t.container.db;
    adminId = await createUser(db, 'SUPER_ADMIN');
    admin = bearer(adminId, 'SUPER_ADMIN');
  });

  afterAll(async () => {
    await t.container.close();
  });

  const range = { from: today(), to: today() };

  async function shop() {
    const vendorId = await createVendor(db);
    const userId = await vendorUserIdOf(db, vendorId);
    return { vendorId, userId, token: bearer(userId, 'VENDOR') };
  }

  /** `count` orders of the shop, created now, in one statement. */
  async function orders(vendorId: string, count: number): Promise<void> {
    const customerId = await createUser(db);
    await db.execute(sql`
      INSERT INTO orders (idempotency_key, customer_id, vendor_id, subtotal, delivery_fee,
                          platform_commission_amount, fulfillment_locked, payment_method, delivery_otp)
      SELECT gen_random_uuid()::text, ${customerId}, ${vendorId}, 1000, 50, 100, 'SELF_DELIVERY', 'COD',
             '$2b$10$abcdefghijklmnopqrstuuM3bJ0n9ZkZ2p9Y5o0t7m6c1QwV8e2yG'
        FROM generate_series(1, ${count})`);
  }

  const exportAs = (token: string, path: 'vendor' | 'admin', body: object) =>
    request(t.app)
      .post(`/api/${path}/exports`)
      .set('authorization', token)
      .send(body)
      .buffer(true)
      .parse((res, done) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          data += chunk;
        });
        res.on('end', () => {
          done(null, data);
        });
      });

  describe('downloading at once', () => {
    it('streams up to 5 000 rows as CSV with a BOM, only the vendor’s own orders, and audits it', async () => {
      const mine = await shop();
      const other = await shop();
      await orders(mine.vendorId, 5000);
      await orders(other.vendorId, 3);

      const res = await exportAs(mine.token, 'vendor', { kind: 'ORDERS', ...range });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toMatch(
        /^attachment; filename="hamro-pasal-orders-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv"$/,
      );
      expect(res.headers['x-row-count']).toBe('5000');
      const csv = csvOf(res);
      expect(csv.startsWith('\uFEFForder_id,created_npt,')).toBe(true);
      // A vendor's export carries no customer identity.
      expect(csv.split('\r\n')[0]).not.toMatch(/customer/);
      expect(csv.trimEnd().split('\r\n')).toHaveLength(5001);

      const audit = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, 'DATA_EXPORTED'), eq(auditLogs.vendor_id, mine.vendorId)));
      expect(audit).toHaveLength(1);
      expect(audit[0]?.after_state).toMatchObject({
        kind: 'ORDERS',
        row_count: 5000,
        delivery: 'DOWNLOAD',
        filters: { from: range.from, to: range.to, vendor_id: mine.vendorId },
      });
    }, 120_000);

    it('escapes a cell a spreadsheet would run as a formula (admin VENDORS)', async () => {
      const name = `=HYPERLINK("http://evil.example") ${randomUUID().slice(0, 6)}`;
      const vendorId = await createVendor(db);
      await db.update(vendors).set({ business_name: name }).where(eq(vendors.id, vendorId));

      const res = await exportAs(admin, 'admin', { kind: 'VENDORS', ...range });

      expect(res.status).toBe(200);
      const csv = csvOf(res);
      expect(csv).toContain(`"'${name.replace(/"/g, '""')}"`);
      expect(csv).not.toContain(`,${name}`);
    });

    it('lets only a Super Admin export customers, and a vendor only its own kinds', async () => {
      const s = await shop();
      expect((await exportAs(s.token, 'vendor', { kind: 'CUSTOMERS', ...range })).status).toBe(400);
      expect(
        (
          await request(t.app)
            .post('/api/admin/exports')
            .set('authorization', s.token)
            .send({ kind: 'CUSTOMERS', ...range })
        ).status,
      ).toBe(403);
      const res = await exportAs(admin, 'admin', { kind: 'CUSTOMERS', ...range });
      expect(res.status).toBe(200);
      expect(csvOf(res).split('\r\n')[0]).toBe(
        '\uFEFFuser_id,phone,first_name,last_name,email,language,account_status,created_npt',
      );
    });

    it('refuses a reversed or over-long range', async () => {
      const s = await shop();
      expect(
        (
          await exportAs(s.token, 'vendor', {
            kind: 'ORDERS',
            from: '2026-10-16',
            to: '2026-10-01',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await exportAs(s.token, 'vendor', {
            kind: 'ORDERS',
            from: '2024-01-01',
            to: '2026-01-01',
          })
        ).status,
      ).toBe(400);
    });
  });

  describe('queued and emailed', () => {
    it('queues 5 001 rows: 202 with the job, audited and handed to the worker', async () => {
      const s = await shop();
      await db
        .update(users)
        .set({ email: `shop${randomUUID().slice(0, 8)}@hamropasal.test` })
        .where(eq(users.id, s.userId));
      await orders(s.vendorId, 5001);

      const res = await request(t.app)
        .post('/api/vendor/exports')
        .set('authorization', s.token)
        .send({ kind: 'ORDERS', ...range });

      expect(res.status).toBe(202);
      const { job } = bodyOf(exportJobResponseSchema, res);
      expect(job).toMatchObject({
        kind: 'ORDERS',
        status: 'QUEUED',
        row_count: 5001,
        downloadable: false,
      });
      const [row] = await db.select().from(exportJobs).where(eq(exportJobs.id, job.id));
      expect(row).toMatchObject({ role: 'VENDOR', params: { ...range, vendor_id: s.vendorId } });
      const events = await db
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.event_type, 'export.requested'),
            eq(outboxEvents.aggregate_id, job.id),
          ),
        );
      expect(events[0]?.payload).toEqual({ job_id: job.id });
      const audit = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, 'DATA_EXPORTED'), eq(auditLogs.entity_id, job.id)));
      expect(audit[0]?.after_state).toMatchObject({ row_count: 5001, delivery: 'EMAIL' });
    }, 120_000);

    it('needs an email address on the account to queue', async () => {
      const s = await shop();
      await orders(s.vendorId, 5001);

      const res = await request(t.app)
        .post('/api/vendor/exports')
        .set('authorization', s.token)
        .send({ kind: 'ORDERS', ...range });

      expect(res.status).toBe(422);
      expect(errorOf(res)).toMatchObject({ code: 'EMAIL_REQUIRED', details: { row_count: 5001 } });
      expect(
        await db.select().from(exportJobs).where(eq(exportJobs.requested_by_user_id, s.userId)),
      ).toEqual([]);
    }, 120_000);
  });

  describe('a linked export', () => {
    async function linked(userId: string, role: 'VENDOR' | 'SUPER_ADMIN', expiresInMs: number) {
      const id = randomUUID();
      const key = `exports/${id}.zip`;
      await t.container.exportFiles.put(key, Buffer.from('PK-zip-bytes'), {
        contentType: 'application/zip',
      });
      await db.insert(exportJobs).values({
        id,
        requested_by_user_id: userId,
        role,
        kind: 'ORDERS',
        params: range,
        email: 'shop@hamropasal.test',
        status: 'DONE',
        delivery: 'LINK',
        file_key: key,
        row_count: 9000,
        finished_at: new Date(),
        expires_at: new Date(Date.now() + expiresInMs),
      });
      return id;
    }

    it('downloads for the signed-in requester only, until it expires', async () => {
      const s = await shop();
      const id = await linked(s.userId, 'VENDOR', 7 * 86_400_000);

      const status = await request(t.app)
        .get(`/api/vendor/exports/${id}`)
        .set('authorization', s.token);
      expect(bodyOf(exportJobResponseSchema, status).job).toMatchObject({
        status: 'DONE',
        delivery: 'LINK',
        downloadable: true,
      });

      const ok = await request(t.app)
        .get(`/api/vendor/exports/${id}/download`)
        .set('authorization', s.token)
        .buffer(true);
      expect(ok.status).toBe(200);
      expect(ok.headers['content-type']).toBe('application/zip');
      expect(ok.headers['content-disposition']).toMatch(/\.zip"$/);

      // No sign-in, or another shop: no file.
      expect((await request(t.app).get(`/api/vendor/exports/${id}/download`)).status).toBe(401);
      const other = await shop();
      expect(
        (
          await request(t.app)
            .get(`/api/vendor/exports/${id}/download`)
            .set('authorization', other.token)
        ).status,
      ).toBe(404);
    });

    it('answers 410 once its 7 days are over', async () => {
      const id = await linked(adminId, 'SUPER_ADMIN', -1000);
      const res = await request(t.app)
        .get(`/api/admin/exports/${id}/download`)
        .set('authorization', admin);
      expect(res.status).toBe(410);
      expect(errorOf(res).code).toBe('EXPORT_EXPIRED');
    });

    it('has no download for an export that was attached to the email', async () => {
      const s = await shop();
      const [job] = await db
        .insert(exportJobs)
        .values({
          requested_by_user_id: s.userId,
          role: 'VENDOR',
          kind: 'STATEMENT',
          params: range,
          email: 'shop@hamropasal.test',
          status: 'DONE',
          delivery: 'ATTACHMENT',
          finished_at: new Date(),
        })
        .returning({ id: exportJobs.id });
      const res = await request(t.app)
        .get(`/api/vendor/exports/${job?.id ?? ''}/download`)
        .set('authorization', s.token);
      expect(res.status).toBe(404);
    });
  });

  it('exports a vendor statement with the BS date beside the Nepal Time date', async () => {
    const s = await shop();
    const order = await createOrder(db, { vendorId: s.vendorId, customerId: await createUser(db) });
    await db.execute(
      sql`UPDATE orders SET state = 'DELIVERED', placed_at = now(), delivered_at = now() WHERE id = ${order.id}`,
    );
    await t.container.settlement.settleOrder(order.id);

    const res = await exportAs(s.token, 'vendor', { kind: 'STATEMENT', ...range });

    expect(res.status).toBe(200);
    const body = csvOf(res);
    expect(body.charCodeAt(0)).toBe(0xfeff);
    const [header, first] = body.slice(1).split('\r\n');
    expect(header).toBe(
      'date_npt,date_bs,account,transaction,line,order_id,amount_npr,description',
    );
    expect(first).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2},20\d{2}-\d{2}-\d{2},WALLET,ORDER_SETTLEMENT,/,
    );
    expect(first).toContain(',-100,');
  });
});
