import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';

import { createDatabase, exportJobs, users, vendors, type Database } from '@hamro-pasal/db';
import { MockMailGateway } from '@hamro-pasal/mail';
import { LocalObjectStore } from '@hamro-pasal/storage';
import { eq } from 'drizzle-orm';
import { strFromU8, unzipSync } from 'fflate';

import { ExportJobService, exportFileKey } from '../src/exports/export-job';

/** Step 7.6 (SPEC core 11, verification 30): building and emailing queued exports. */
describe('queued data exports (real PostgreSQL)', () => {
  let db: Database;
  let dir: string;
  let files: LocalObjectStore;

  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL ?? '', { max: 5 });
    dir = await mkdtemp(join(tmpdir(), 'hp-exports-'));
    files = new LocalObjectStore(dir);
  });

  afterAll(async () => {
    await db.$client.end();
    await rm(dir, { recursive: true, force: true });
  });

  const phone = () => `+9779${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;

  async function admin(): Promise<string> {
    const [row] = await db
      .insert(users)
      .values({
        phone: phone(),
        role: 'SUPER_ADMIN',
        email: `admin${String(randomInt(0, 1e9))}@hamropasal.test`,
      })
      .returning({ id: users.id });
    if (row === undefined) throw new Error('admin not created');
    return row.id;
  }

  /** A shop created today with this name (VENDORS exports are by creation date). */
  async function shop(name: string): Promise<string> {
    const [owner] = await db
      .insert(users)
      .values({ phone: phone(), role: 'VENDOR' })
      .returning({ id: users.id });
    const [row] = await db
      .insert(vendors)
      .values({
        user_id: owner?.id ?? '',
        business_name: name,
        phone: '+9779800000011',
        status: 'LIVE',
        pricing_model: 'COMMISSION',
        commission_rate: 0.1,
        delivery_scope: 'RADIUS_BOUND',
        fulfillment_mode: 'SELF_DELIVERY',
        radius_km: 5,
        municipality_palika_string: 'Kathmandu Metropolitan City',
        min_order_value: 0,
        base_delivery_fee_npr: 50,
        location: { x: 85.3123, y: 27.7154 },
      })
      .returning({ id: vendors.id });
    return row?.id ?? '';
  }

  const today = (): string => {
    const npt = new Date(Date.now() + (5 * 60 + 45) * 60_000);
    return npt.toISOString().slice(0, 10);
  };

  async function queued(adminId: string): Promise<string> {
    const [job] = await db
      .insert(exportJobs)
      .values({
        requested_by_user_id: adminId,
        role: 'SUPER_ADMIN',
        kind: 'VENDORS',
        params: { from: today(), to: today() },
        email: 'admin@hamropasal.test',
      })
      .returning({ id: exportJobs.id });
    return job?.id ?? '';
  }

  const jobRow = async (id: string) =>
    (await db.select().from(exportJobs).where(eq(exportJobs.id, id)))[0];

  function service(mail: MockMailGateway | null, attachmentLimitBytes?: number) {
    return new ExportJobService({
      db,
      mail,
      files,
      apiBaseUrl: 'https://api.hamropasal.test/',
      ...(attachmentLimitBytes === undefined ? {} : { attachmentLimitBytes }),
    });
  }

  it('attaches a small export as a zipped CSV, escaped against formulas, and marks it DONE', async () => {
    const adminId = await admin();
    const evil = `=HYPERLINK("http://evil.example") ${randomUUID().slice(0, 6)}`;
    await shop(evil);
    const id = await queued(adminId);
    const mail = new MockMailGateway();

    const outcome = await service(mail).run(id, { finalAttempt: false });

    expect(outcome).toMatchObject({ status: 'ATTACHED' });
    const [sent] = mail.sent;
    expect(sent?.to).toBe('admin@hamropasal.test');
    expect(sent?.subject).toMatch(/vendors export/);
    const attachment = sent?.attachments?.[0];
    expect(attachment?.contentType).toBe('application/zip');
    const unzipped = unzipSync(new Uint8Array(attachment?.content ?? Buffer.alloc(0)));
    const [csvName] = Object.keys(unzipped);
    expect(csvName).toMatch(/^hamro-pasal-vendors-.*\.csv$/);
    const bytes = unzipped[csvName ?? ''] ?? new Uint8Array();
    // The UTF-8 BOM first (Excel then reads Devanagari), then the header.
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    // TextDecoder drops the BOM itself.
    const csv = strFromU8(bytes);
    expect(csv.startsWith('vendor_code,business_name,')).toBe(true);
    // The formula is written as text: prefixed with ' (and quoted, for its quotes).
    expect(csv).toContain(`"'${evil.replace(/"/g, '""')}"`);
    expect(csv).not.toContain(`,${evil}`);

    const row = await jobRow(id);
    expect(row).toMatchObject({ status: 'DONE', delivery: 'ATTACHMENT', file_key: null });
    expect(row?.row_count).toBeGreaterThan(0);

    // Taken once: a redelivered job does nothing.
    await expect(service(mail).run(id, { finalAttempt: false })).resolves.toEqual({
      status: 'SKIPPED',
    });
    expect(mail.sent).toHaveLength(1);
  });

  it('links an export too large to attach: stored privately for 7 days, then swept', async () => {
    const adminId = await admin();
    await shop(`Big Export Pasal ${randomUUID().slice(0, 6)}`);
    const id = await queued(adminId);
    const mail = new MockMailGateway();

    const outcome = await service(mail, 10).run(id, { finalAttempt: false });

    expect(outcome).toMatchObject({ status: 'LINKED' });
    expect(mail.sent[0]?.attachments ?? []).toEqual([]);
    expect(mail.sent[0]?.text).toContain(
      `https://api.hamropasal.test/api/admin/exports/${id}/download`,
    );
    const row = await jobRow(id);
    expect(row).toMatchObject({ status: 'DONE', delivery: 'LINK', file_key: exportFileKey(id) });
    const days = ((row?.expires_at?.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThanOrEqual(7);
    expect(await files.get(exportFileKey(id))).not.toBeNull();

    // Not expired yet: kept.
    await service(mail).sweepExpired();
    expect(await files.get(exportFileKey(id))).not.toBeNull();

    await db
      .update(exportJobs)
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where(eq(exportJobs.id, id));
    await expect(service(mail).sweepExpired()).resolves.toBeGreaterThanOrEqual(1);
    expect(await files.get(exportFileKey(id))).toBeNull();
    expect((await jobRow(id))?.file_key).toBeNull();
  });

  it('puts a failed export back for a retry, and marks it FAILED on the last attempt', async () => {
    const adminId = await admin();
    const id = await queued(adminId);

    await expect(service(null).run(id, { finalAttempt: false })).rejects.toThrow(
      'MAIL_PROVIDER=DISABLED',
    );
    expect(await jobRow(id)).toMatchObject({ status: 'QUEUED' });

    await expect(service(null).run(id, { finalAttempt: true })).resolves.toMatchObject({
      status: 'FAILED',
    });
    const row = await jobRow(id);
    expect(row?.status).toBe('FAILED');
    expect(row?.error).toMatch(/MAIL_PROVIDER=DISABLED/);
  });
});
