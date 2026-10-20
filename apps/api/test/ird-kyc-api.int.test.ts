import { auditLogs, irdPanChecks, outboxEvents, vendors, type Database } from '@hamro-pasal/db';
import {
  adminIrdCheckRetryResponseSchema,
  adminIrdManualReviewListResponseSchema,
  mod11_2CheckCharacter,
} from '@hamro-pasal/shared-types';
import { and, asc, eq, sql } from 'drizzle-orm';
import request from 'supertest';

import { createUser, createVendor, vendorUserIdOf } from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';
import { photo } from './support/images';

/**
 * Automated IRD PAN verification, the API side (2026-10-21):
 * - PUT /api/vendor/tax-identity refuses a PAN that fails the MOD 11-2 check digit, but only with
 *   PAN_CHECKSUM_ENFORCED (off by default: the IRD has published no such rule);
 * - a PAN and its document on file request an IRD check (a QUEUED row and
 *   `vendor.pan_check_requested`, in the transaction of the change); a changed PAN supersedes it;
 * - GET /api/admin/kyc/manual-review lists what the worker could not settle, and
 *   POST /api/admin/kyc/checks/:id/retry queues one again; a Super Admin's verification resolves it.
 */
describe('IRD KYC API', () => {
  let t: TestApp;
  let enforcing: TestApp;
  let db: Database;
  let adminId: string;

  beforeAll(async () => {
    t = buildTestApp();
    enforcing = buildTestApp({ panChecksumEnforced: true });
    db = t.container.db;
    adminId = await createUser(db, 'SUPER_ADMIN');
  });

  afterAll(async () => {
    await t.container.close();
    await enforcing.container.close();
  });

  async function shop() {
    const vendorId = await createVendor(db, {});
    const userId = await vendorUserIdOf(db, vendorId);
    return { vendorId, token: bearer(userId, 'VENDOR') };
  }

  /** A PAN whose ninth digit is (or deliberately is not) its MOD 11-2 check digit. */
  function pan(valid: boolean): string {
    for (let n = 30_211_884 + Math.floor(Math.random() * 1_000_000); ; n += 1) {
      const payload = String(n);
      const check = mod11_2CheckCharacter(payload);
      if (check === 'X') continue;
      return valid ? `${payload}${check}` : `${payload}${String((Number(check) + 1) % 10)}`;
    }
  }

  const savePan = (app: TestApp, token: string, taxId: string, legalName?: string) =>
    request(app.app)
      .put('/api/vendor/tax-identity')
      .set('authorization', token)
      .send({
        tax_id: taxId,
        is_vat_registered: false,
        ...(legalName === undefined ? {} : { legal_name: legalName }),
      });

  const uploadDocument = async (token: string) =>
    request(t.app)
      .post('/api/vendor/tax-identity/document')
      .set('authorization', token)
      .attach('document', await photo(), { filename: 'pan.jpg', contentType: 'image/jpeg' });

  const checksOf = (vendorId: string) =>
    db
      .select()
      .from(irdPanChecks)
      .where(eq(irdPanChecks.vendor_id, vendorId))
      .orderBy(asc(irdPanChecks.created_at));

  const requestedEvents = (vendorId: string) =>
    db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.aggregate_id, vendorId),
          eq(outboxEvents.event_type, 'vendor.pan_check_requested'),
        ),
      );

  describe('PAN pre-validation (MOD 11-2)', () => {
    it('refuses a PAN that fails the check digit when enforced, writing nothing', async () => {
      const { vendorId, token } = await shop();
      const res = await savePan(enforcing, token, pan(false));
      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe('PAN_CHECKSUM_INVALID');
      const [row] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
      expect(row?.tax_id).toBeNull();
      expect(await checksOf(vendorId)).toEqual([]);
    });

    it('accepts a PAN that passes it when enforced', async () => {
      const { token } = await shop();
      expect((await savePan(enforcing, token, pan(true))).status).toBe(200);
    });

    it('is off by default: any nine digits are accepted', async () => {
      const { token } = await shop();
      expect((await savePan(t, token, pan(false))).status).toBe(200);
    });
  });

  describe('requesting the IRD check', () => {
    it('starts one when the PAN and its document are both on file, not before', async () => {
      const { vendorId, token } = await shop();
      const taxId = pan(true);
      expect((await savePan(t, token, taxId)).status).toBe(200);
      expect(await checksOf(vendorId)).toEqual([]);

      expect((await uploadDocument(token)).status).toBe(201);
      const checks = await checksOf(vendorId);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ status: 'QUEUED', tax_id: taxId, attempts: 0 });
      const events = await requestedEvents(vendorId);
      expect(events.map((event) => event.payload)).toEqual([
        expect.objectContaining({ check_id: checks[0]?.id, vendor_id: vendorId, tax_id: taxId }),
      ]);
    });

    it('a document first, then the PAN, starts it too', async () => {
      const { vendorId, token } = await shop();
      expect((await uploadDocument(token)).status).toBe(201);
      expect(await checksOf(vendorId)).toEqual([]);
      expect((await savePan(t, token, pan(true))).status).toBe(200);
      // A first PAN keeps the document uploaded before it: now both are on file.
      expect((await checksOf(vendorId)).map((check) => check.status)).toEqual(['QUEUED']);
    });

    it('a changed PAN supersedes the old check (its document goes with it)', async () => {
      const { vendorId, token } = await shop();
      await savePan(t, token, pan(true));
      await uploadDocument(token);
      expect((await savePan(t, token, pan(true))).status).toBe(200);
      expect((await checksOf(vendorId)).map((check) => check.status)).toEqual(['SUPERSEDED']);
      // The new PAN needs its own document; uploading it starts a new check.
      await uploadDocument(token);
      expect((await checksOf(vendorId)).map((check) => check.status)).toEqual([
        'SUPERSEDED',
        'QUEUED',
      ]);
    });

    it('a new legal name re-runs a check that ended in manual review', async () => {
      const { vendorId, token } = await shop();
      await savePan(t, token, pan(true));
      await uploadDocument(token);
      const [first] = await checksOf(vendorId);
      await db
        .update(irdPanChecks)
        .set({ status: 'MANUAL_REVIEW', review_reason: 'NAME_MISMATCH', completed_at: sql`now()` })
        .where(eq(irdPanChecks.id, first?.id ?? ''));

      const taxId = (await db.select().from(vendors).where(eq(vendors.id, vendorId)))[0]?.tax_id;
      expect((await savePan(t, token, taxId ?? '', 'Thamel Kirana Pasal Pvt. Ltd.')).status).toBe(
        200,
      );
      expect((await checksOf(vendorId)).map((check) => check.status)).toEqual([
        'SUPERSEDED',
        'QUEUED',
      ]);
    });
  });

  describe('the manual review queue', () => {
    async function inReview(reason: 'NAME_MISMATCH' | 'SCRAPER_FAILED') {
      const { vendorId, token } = await shop();
      await savePan(t, token, pan(true));
      await uploadDocument(token);
      const [check] = await checksOf(vendorId);
      if (check === undefined) throw new Error('no check');
      await db
        .update(irdPanChecks)
        .set({
          status: 'MANUAL_REVIEW',
          review_reason: reason,
          attempts: 3,
          ird_business_name: 'Boudha Fresh Mart',
          name_similarity: 0.31,
          last_error: reason === 'SCRAPER_FAILED' ? 'the IRD page timed out after 30 s' : null,
          completed_at: sql`now()`,
        })
        .where(eq(irdPanChecks.id, check.id));
      return { vendorId, checkId: check.id };
    }

    const admin = () => bearer(adminId, 'SUPER_ADMIN');

    it('lists the checks waiting for a person, with what the IRD said', async () => {
      const { vendorId, checkId } = await inReview('NAME_MISMATCH');
      const res = await request(t.app)
        .get('/api/admin/kyc/manual-review')
        .set('authorization', admin());
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const entry = bodyOf(adminIrdManualReviewListResponseSchema, res).checks.find(
        (check) => check.check_id === checkId,
      );
      expect(entry).toMatchObject({
        vendor_id: vendorId,
        reason: 'NAME_MISMATCH',
        attempts: 3,
        ird_business_name: 'Boudha Fresh Mart',
        name_similarity: 0.31,
      });
    });

    it('queues a check again: attempts start over, with the event and an audit entry', async () => {
      const { vendorId, checkId } = await inReview('SCRAPER_FAILED');
      const res = await request(t.app)
        .post(`/api/admin/kyc/checks/${checkId}/retry`)
        .set('authorization', admin());
      expect(res.status).toBe(202);
      expect(bodyOf(adminIrdCheckRetryResponseSchema, res)).toEqual({
        check_id: checkId,
        status: 'QUEUED',
      });
      const [check] = await checksOf(vendorId);
      expect(check).toMatchObject({
        status: 'QUEUED',
        attempts: 0,
        review_reason: null,
        last_error: null,
      });
      expect(await requestedEvents(vendorId)).toHaveLength(2);
      const audit = await db
        .select()
        .from(auditLogs)
        .where(
          and(eq(auditLogs.entity_id, checkId), eq(auditLogs.action, 'IRD_PAN_CHECK_RETRIED')),
        );
      expect(audit).toHaveLength(1);

      const again = await request(t.app)
        .post(`/api/admin/kyc/checks/${checkId}/retry`)
        .set('authorization', admin());
      expect(again.status).toBe(409);
      expect(errorOf(again).code).toBe('IRD_CHECK_NOT_IN_REVIEW');
    });

    it("a Super Admin's verification resolves the check, by them", async () => {
      const { vendorId, checkId } = await inReview('NAME_MISMATCH');
      const res = await request(t.app)
        .post(`/api/admin/vendors/${vendorId}/pan-verification`)
        .set('authorization', admin());
      expect(res.status).toBe(200);
      const [check] = await db.select().from(irdPanChecks).where(eq(irdPanChecks.id, checkId));
      expect(check).toMatchObject({ status: 'RESOLVED', resolved_by_user_id: adminId });
      const [vendor] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
      expect(vendor).toMatchObject({ pan_verified_by_user_id: adminId, pan_verified_by_job: null });
    });

    it('404s an unknown check and refuses everyone but a Super Admin', async () => {
      const unknown = await request(t.app)
        .post('/api/admin/kyc/checks/7b1f0c8e-0000-4000-8000-000000000000/retry')
        .set('authorization', admin());
      expect(unknown.status).toBe(404);
      expect(errorOf(unknown).code).toBe('IRD_CHECK_NOT_FOUND');
      const { token } = await shop();
      expect(
        (await request(t.app).get('/api/admin/kyc/manual-review').set('authorization', token))
          .status,
      ).toBe(403);
      expect((await request(t.app).get('/api/admin/kyc/manual-review')).status).toBe(401);
    });
  });
});
