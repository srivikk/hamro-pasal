import { randomInt } from 'node:crypto';

import {
  auditLogs,
  createDatabase,
  irdPanChecks,
  outboxEvents,
  users,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import { requestIrdPanCheck } from '@hamro-pasal/ledger';
import { and, eq } from 'drizzle-orm';

import { IrdTransientError, type IrdLookupResult, type IrdPanLookup } from '../src/kyc/ird-lookup';
import { IrdPanVerificationService } from '../src/kyc/ird-pan-verification';

/**
 * The automated IRD PAN verification on real PostgreSQL (2026-10-21): the ird_pan_checks state
 * machine, with the IRD itself replaced by a scripted lookup.
 */
describe('IRD PAN verification state machine (real PostgreSQL)', () => {
  let db: Database;

  beforeAll(() => {
    db = createDatabase(process.env.TEST_DATABASE_URL ?? '', { max: 10 });
  });

  afterAll(async () => {
    await db.$client.end();
  });

  /** Answers (or throws) in order, one per lookup, and counts the calls. */
  class ScriptedLookup implements IrdPanLookup {
    calls = 0;
    constructor(private readonly script: ((pan: string) => Promise<IrdLookupResult>)[]) {}
    lookup(pan: string): Promise<IrdLookupResult> {
      const step = this.script[this.calls] ?? this.script[this.script.length - 1];
      this.calls += 1;
      if (step === undefined) throw new Error('empty script');
      return step(pan);
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
  }

  const found =
    (businessName: string, statuses = ['Active']) =>
    () =>
      Promise.resolve<IrdLookupResult>({
        kind: 'FOUND',
        businessName,
        registrationDate: '2078-09-10',
        accountStatuses: statuses,
      });
  const notFound = () => Promise.resolve<IrdLookupResult>({ kind: 'NOT_FOUND' });
  const timeout = () => Promise.reject(new IrdTransientError('the IRD page timed out after 30 s'));

  const service = (lookup: IrdPanLookup | null) =>
    new IrdPanVerificationService({ db, lookup, retryDelaysMs: [0, 0] });

  async function user(role: 'VENDOR' | 'SUPER_ADMIN'): Promise<string> {
    const phone = `+9779${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
    const [row] = await db.insert(users).values({ phone, role }).returning({ id: users.id });
    if (row === undefined) throw new Error('user not created');
    return row.id;
  }

  function pan(): string {
    return String(randomInt(100_000_000, 999_999_999));
  }

  /** A checkable vendor (PAN + document, unverified) and its requested check. */
  async function checkableVendor(
    values: Partial<typeof vendors.$inferInsert> = {},
  ): Promise<{ vendorId: string; checkId: string; taxId: string }> {
    const taxId = values.tax_id ?? pan();
    const [row] = await db
      .insert(vendors)
      .values({
        user_id: await user('VENDOR'),
        business_name: 'Thamel Kirana Pasal',
        legal_name: 'Thamel Kirana Pasal Pvt. Ltd.',
        phone: '+9779800000000',
        status: 'SUSPENDED_COMPLIANCE',
        status_before_compliance_suspension: 'LIVE',
        pricing_model: 'COMMISSION',
        commission_rate: 0.1,
        delivery_scope: 'RADIUS_BOUND',
        fulfillment_mode: 'SELF_DELIVERY',
        radius_km: 5,
        municipality_palika_string: 'Kathmandu Metropolitan City',
        min_order_value: 0,
        location: { x: 85.3123, y: 27.7154 },
        tax_id: taxId,
        pan_document_url: 'kyc/pan/test/document.webp',
        ...values,
      })
      .returning();
    if (row === undefined) throw new Error('vendor not created');
    const checkId = await db.transaction((tx) => requestIrdPanCheck(tx, row));
    if (checkId === null) throw new Error('no check requested');
    return { vendorId: row.id, checkId, taxId };
  }

  const checkRow = async (checkId: string) => {
    const [row] = await db.select().from(irdPanChecks).where(eq(irdPanChecks.id, checkId));
    if (row === undefined) throw new Error('check not found');
    return row;
  };
  const vendorRow = async (vendorId: string) => {
    const [row] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
    if (row === undefined) throw new Error('vendor not found');
    return row;
  };

  it('a request writes a QUEUED check and its outbox event in the same transaction', async () => {
    const { vendorId, checkId, taxId } = await checkableVendor();
    expect((await checkRow(checkId)).status).toBe('QUEUED');
    const [event] = await db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.aggregate_id, vendorId),
          eq(outboxEvents.event_type, 'vendor.pan_check_requested'),
        ),
      );
    expect(event?.payload).toMatchObject({ check_id: checkId, vendor_id: vendorId, tax_id: taxId });
  });

  it('verifies the PAN on a name match: the job is the verifier, the shop goes back LIVE', async () => {
    const { vendorId, checkId } = await checkableVendor();
    const lookup = new ScriptedLookup([found('THAMEL KIRANA PASAL PVT. LTD.')]);
    await expect(service(lookup).run(checkId)).resolves.toEqual({
      status: 'VERIFIED',
      similarity: 1,
    });

    const vendor = await vendorRow(vendorId);
    expect(vendor.pan_verified_at).not.toBeNull();
    expect(vendor.pan_verified_by_job).toBe('IRD_PAN_VERIFICATION');
    expect(vendor.pan_verified_by_user_id).toBeNull();
    expect(vendor.status).toBe('LIVE');
    expect(await checkRow(checkId)).toMatchObject({
      status: 'VERIFIED',
      attempts: 1,
      ird_business_name: 'THAMEL KIRANA PASAL PVT. LTD.',
      ird_registration_date: '2078-09-10',
      name_similarity: 1,
    });
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.vendor_id, vendorId));
    expect(audit.map((entry) => [entry.action, entry.system_actor])).toEqual(
      expect.arrayContaining([
        ['PAN_VERIFIED', 'IRD_PAN_VERIFICATION'],
        ['IRD_PAN_CHECK_COMPLETED', 'IRD_PAN_VERIFICATION'],
      ]),
    );
    const restored = await db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.aggregate_id, vendorId),
          eq(outboxEvents.event_type, 'vendor.compliance_restored'),
        ),
      );
    expect(restored).toHaveLength(1);
  });

  it('sends a name mismatch to manual review, the shop untouched', async () => {
    const { vendorId, checkId } = await checkableVendor();
    const outcome = await service(new ScriptedLookup([found('Boudha Fresh Mart')])).run(checkId);
    expect(outcome).toEqual({ status: 'MANUAL_REVIEW', reason: 'NAME_MISMATCH' });
    const check = await checkRow(checkId);
    expect(check).toMatchObject({ status: 'MANUAL_REVIEW', review_reason: 'NAME_MISMATCH' });
    expect(check.name_similarity).toBeLessThan(0.85);
    const vendor = await vendorRow(vendorId);
    expect(vendor.pan_verified_at).toBeNull();
    expect(vendor.status).toBe('SUSPENDED_COMPLIANCE');
  });

  it('retries a timeout and verifies on the second attempt', async () => {
    const { checkId } = await checkableVendor();
    const lookup = new ScriptedLookup([timeout, found('Thamel Kirana Pasal')]);
    await expect(service(lookup).run(checkId)).resolves.toMatchObject({ status: 'VERIFIED' });
    expect(lookup.calls).toBe(2);
    expect((await checkRow(checkId)).attempts).toBe(2);
  });

  it('stops after exactly 3 failed attempts and routes to manual review with the last error', async () => {
    const { vendorId, checkId } = await checkableVendor();
    const lookup = new ScriptedLookup([timeout]);
    const outcome = await service(lookup).run(checkId);
    expect(outcome).toEqual({ status: 'MANUAL_REVIEW', reason: 'SCRAPER_FAILED' });
    expect(lookup.calls).toBe(3);
    expect(await checkRow(checkId)).toMatchObject({
      attempts: 3,
      last_error: 'the IRD page timed out after 30 s',
    });
    expect((await vendorRow(vendorId)).pan_verified_at).toBeNull();
  });

  it('three "invalid information" answers are PAN_NOT_FOUND', async () => {
    const { checkId } = await checkableVendor();
    const lookup = new ScriptedLookup([notFound]);
    await expect(service(lookup).run(checkId)).resolves.toEqual({
      status: 'MANUAL_REVIEW',
      reason: 'PAN_NOT_FOUND',
    });
    expect(lookup.calls).toBe(3);
  });

  it('a changed page goes to manual review at once, without retrying', async () => {
    const { checkId } = await checkableVendor();
    const lookup = new ScriptedLookup([
      () => Promise.resolve({ kind: 'LAYOUT_CHANGED', detail: 'no PAN field' }),
    ]);
    await expect(service(lookup).run(checkId)).resolves.toEqual({
      status: 'MANUAL_REVIEW',
      reason: 'LAYOUT_CHANGED',
    });
    expect(lookup.calls).toBe(1);
    expect((await checkRow(checkId)).last_error).toBe('no PAN field');
  });

  it('an account with no Active registration is not verified, even with the right name', async () => {
    const { vendorId, checkId } = await checkableVendor();
    const outcome = await service(
      new ScriptedLookup([found('Thamel Kirana Pasal', ['Closed'])]),
    ).run(checkId);
    expect(outcome).toEqual({ status: 'MANUAL_REVIEW', reason: 'IRD_ACCOUNT_INACTIVE' });
    expect((await vendorRow(vendorId)).pan_verified_at).toBeNull();
  });

  it('with the automation disabled, every check waits for a person', async () => {
    const { checkId } = await checkableVendor();
    await expect(service(null).run(checkId)).resolves.toEqual({
      status: 'MANUAL_REVIEW',
      reason: 'AUTOMATION_DISABLED',
    });
  });

  it('never verifies a PAN the vendor changed while the lookup ran', async () => {
    const { vendorId, checkId } = await checkableVendor();
    const lookup = new ScriptedLookup([
      async () => {
        // The vendor saves another PAN mid-lookup: the request supersedes the running check.
        const [after] = await db
          .update(vendors)
          .set({ tax_id: pan() })
          .where(eq(vendors.id, vendorId))
          .returning();
        if (after === undefined) throw new Error('vendor vanished');
        await db.transaction((tx) => requestIrdPanCheck(tx, after));
        return found('Thamel Kirana Pasal')();
      },
    ]);
    await expect(service(lookup).run(checkId)).resolves.toEqual({ status: 'SUPERSEDED' });
    expect((await checkRow(checkId)).status).toBe('SUPERSEDED');
    expect((await vendorRow(vendorId)).pan_verified_at).toBeNull();
  });

  it('a matched name with the document gone goes to manual review', async () => {
    const { vendorId, checkId } = await checkableVendor();
    const lookup = new ScriptedLookup([
      async () => {
        await db.update(vendors).set({ pan_document_url: null }).where(eq(vendors.id, vendorId));
        return found('Thamel Kirana Pasal')();
      },
    ]);
    await expect(service(lookup).run(checkId)).resolves.toEqual({
      status: 'MANUAL_REVIEW',
      reason: 'DOCUMENT_MISSING',
    });
  });

  it('runs a check once: a second job for it does nothing', async () => {
    const { checkId } = await checkableVendor();
    const lookup = new ScriptedLookup([found('Thamel Kirana Pasal')]);
    await service(lookup).run(checkId);
    await expect(service(lookup).run(checkId)).resolves.toEqual({ status: 'SKIPPED' });
    expect(lookup.calls).toBe(1);
  });

  it('two workers on one check: exactly one claims it', async () => {
    const { checkId } = await checkableVendor();
    const lookup = new ScriptedLookup([found('Thamel Kirana Pasal')]);
    const outcomes = await Promise.all([
      service(lookup).run(checkId),
      service(lookup).run(checkId),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['SKIPPED', 'VERIFIED']);
    expect(lookup.calls).toBe(1);
  });

  it('keeps one check in flight per PAN, and a new PAN supersedes the old one', async () => {
    const { vendorId, checkId } = await checkableVendor();
    const vendor = await vendorRow(vendorId);
    await expect(db.transaction((tx) => requestIrdPanCheck(tx, vendor))).resolves.toBeNull();

    const [changed] = await db
      .update(vendors)
      .set({ tax_id: pan() })
      .where(eq(vendors.id, vendorId))
      .returning();
    if (changed === undefined) throw new Error('vendor vanished');
    const newCheck = await db.transaction((tx) => requestIrdPanCheck(tx, changed));
    expect(newCheck).not.toBeNull();
    expect((await checkRow(checkId)).status).toBe('SUPERSEDED');
  });

  it('the database refuses two open checks for one vendor', async () => {
    const { vendorId, taxId } = await checkableVendor();
    await expect(
      db.insert(irdPanChecks).values({ vendor_id: vendorId, tax_id: taxId }),
    ).rejects.toThrow();
  });
});
