import { randomUUID } from 'node:crypto';

import {
  adProducts,
  adPurchases,
  auditLogs,
  campaignOptIns,
  orders,
  settlementModelChangeRequests,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import {
  adminCampaignResponseSchema,
  adminModelChangeDecisionResponseSchema,
  adminModelChangeRequestListResponseSchema,
  campaignOptInResponseSchema,
  vendorCampaignListResponseSchema,
  vendorModelChangeRequestResponseSchema,
  type AuditAction,
} from '@hamro-pasal/shared-types';
import { and, asc, eq, sql } from 'drizzle-orm';
import request from 'supertest';

import { LedgerService } from '../src/ledger/ledger-service';
import { WalletService } from '../src/wallet/wallet-service';
import { createOrder, createUser, createVendor, vendorUserIdOf } from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * Phase 27: a vendor's settlement model change request and the Super Admin's decision (SPEC core
 * 5, verification 20), and the vendor's own view of campaigns with its opt-out (SPEC core 7),
 * over HTTP on real PostgreSQL.
 */
describe('settlement model requests and vendor campaigns API', () => {
  let t: TestApp;
  let db: Database;
  let adminId: string;
  let admin: string;
  const ledger = new LedgerService(new WalletService());

  beforeAll(async () => {
    t = buildTestApp();
    db = t.container.db;
    adminId = await createUser(db, 'SUPER_ADMIN');
    admin = bearer(adminId, 'SUPER_ADMIN');
  });

  afterAll(async () => {
    await t.container.close();
  });

  const call = (
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    token: string | null,
    body?: unknown,
  ) => {
    const req = request(t.app)[method](path);
    const authed = token === null ? req : req.set('Authorization', token);
    return body === undefined ? authed : authed.send(body as object);
  };

  const entries = (entityId: string, action: AuditAction) =>
    db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entity_id, entityId), eq(auditLogs.action, action)))
      .orderBy(asc(auditLogs.occurred_at));

  async function shop() {
    const vendorId = await createVendor(db);
    const userId = await vendorUserIdOf(db, vendorId);
    return { vendorId, userId, token: bearer(userId, 'VENDOR') };
  }

  const modelOf = async (vendorId: string) =>
    (
      await db
        .select({ model: vendors.settlement_model })
        .from(vendors)
        .where(eq(vendors.id, vendorId))
    )[0]?.model;

  const ask = (token: string | null, model: unknown = 'COD_CREDIT') =>
    call('post', '/api/vendor/ledger/settlement-model', token, { model });

  /** A shop with a PENDING request to move from Model B to Model A. */
  async function pending() {
    const owner = await shop();
    const res = await ask(owner.token);
    expect(res.status).toBe(201);
    return { ...owner, requestId: bodyOf(vendorModelChangeRequestResponseSchema, res).request.id };
  }

  const decide = (
    requestId: string,
    decision: 'approve' | 'reject',
    token: string | null,
    body?: unknown,
  ) => call('post', `/api/admin/settlement-model-requests/${requestId}/${decision}`, token, body);

  async function placedOrder(vendorId: string) {
    const order = await createOrder(db, { vendorId, customerId: await createUser(db) });
    await db
      .update(orders)
      .set({ state: 'PLACED', placed_at: sql`now()` })
      .where(eq(orders.id, order.id));
    return order.id;
  }

  async function runningAd(vendorId: string, userId: string) {
    const [product] = await db
      .insert(adProducts)
      .values({
        name: `Carousel ${randomUUID()}`,
        slot: 'CAROUSEL',
        billing_model: 'FLAT_RATE',
        price_npr: 5000,
        duration_days: 7,
        created_by_user_id: adminId,
      })
      .returning();
    if (product === undefined) throw new Error('no product');
    const [purchase] = await db
      .insert(adPurchases)
      .values({
        vendor_id: vendorId,
        ad_product_id: product.id,
        billing_model: 'FLAT_RATE',
        price_npr: 5000,
        settlement_model: 'PLATFORM_ESCROW',
        starts_at: new Date(),
        ends_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        agreed_by_user_id: userId,
        idempotency_key: randomUUID(),
      })
      .returning();
    if (purchase === undefined) throw new Error('no purchase');
    return purchase.id;
  }

  const setWallet = (vendorId: string, amountNpr: number) =>
    db.transaction((tx) =>
      ledger.post(tx, {
        kind: 'ADJUSTMENT',
        idempotencyKey: `seed:${vendorId}:${randomUUID()}`,
        orderId: null,
        postings: [
          {
            account: { type: 'VENDOR_WALLET', vendorId },
            amountPaisa: Math.round(amountNpr * 100),
          },
          { account: { type: 'PLATFORM_REVENUE' }, amountPaisa: -Math.round(amountNpr * 100) },
        ],
      }),
    );

  describe('POST /api/vendor/ledger/settlement-model', () => {
    it("files a PENDING request for the caller's own shop, audited, and changes nothing yet", async () => {
      const { vendorId, userId, token } = await shop();
      const res = await ask(token);

      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const view = bodyOf(vendorModelChangeRequestResponseSchema, res).request;
      expect(view).toMatchObject({
        from_model: 'PLATFORM_ESCROW',
        requested_model: 'COD_CREDIT',
        status: 'PENDING',
        decided_at: null,
        rejection_reason: null,
      });
      expect(await modelOf(vendorId)).toBe('PLATFORM_ESCROW');

      const [entry] = await entries(view.id, 'SETTLEMENT_MODEL_CHANGE_REQUESTED');
      expect(entry).toMatchObject({
        actor_user_id: userId,
        actor_role: 'VENDOR',
        vendor_id: vendorId,
        before_state: null,
        after_state: {
          from_model: 'PLATFORM_ESCROW',
          requested_model: 'COD_CREDIT',
          status: 'PENDING',
        },
      });
    });

    it('allows one PENDING request per shop, also for five at once', async () => {
      const { requestId, token, vendorId } = await pending();
      const again = await ask(token);
      expect(again.status).toBe(409);
      expect(errorOf(again)).toMatchObject({
        code: 'SETTLEMENT_MODEL_REQUEST_PENDING',
        details: { request_id: requestId },
      });

      const other = await shop();
      const statuses = (await Promise.all(Array.from({ length: 5 }, () => ask(other.token)))).map(
        (res) => res.status,
      );
      expect(statuses.filter((status) => status === 201)).toHaveLength(1);
      expect(statuses.filter((status) => status === 409)).toHaveLength(4);
      const rows = await db
        .select()
        .from(settlementModelChangeRequests)
        .where(eq(settlementModelChangeRequests.vendor_id, vendorId));
      expect(rows).toHaveLength(1);
    });

    it('refuses the model the shop is already on, and a malformed body', async () => {
      const { token, vendorId } = await shop();

      const same = await ask(token, 'PLATFORM_ESCROW');
      expect(same.status).toBe(422);
      expect(errorOf(same).code).toBe('SETTLEMENT_MODEL_UNCHANGED');

      for (const body of [{}, { model: 'FREE' }, { model: 'COD_CREDIT', vendor_id: vendorId }]) {
        const res = await call('post', '/api/vendor/ledger/settlement-model', token, body);
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
      const rows = await db
        .select()
        .from(settlementModelChangeRequests)
        .where(eq(settlementModelChangeRequests.vendor_id, vendorId));
      expect(rows).toHaveLength(0);
    });

    it('serves vendors only, and an admin has no route that files a request', async () => {
      expect((await ask(null)).status).toBe(401);
      expect((await ask(admin)).status).toBe(403);
      expect((await ask(bearer(await createUser(db), 'CUSTOMER'))).status).toBe(403);
      // A vendor account without a shop.
      const shopless = await ask(bearer(await createUser(db, 'VENDOR'), 'VENDOR'));
      expect(shopless.status).toBe(404);

      const { vendorId } = await shop();
      for (const [method, path] of [
        ['post', '/api/admin/settlement-model-requests'],
        ['post', `/api/admin/vendors/${vendorId}/settlement-model`],
        ['put', `/api/admin/vendors/${vendorId}/settlement-model`],
      ] as const) {
        const res = await call(method, path, admin, { vendor_id: vendorId, model: 'COD_CREDIT' });
        expect(res.status).toBe(404);
      }
      expect(await modelOf(vendorId)).toBe('PLATFORM_ESCROW');
    });
  });

  describe('GET /api/admin/settlement-model-requests', () => {
    it('lists each request with its shop and what stands in the way, and filters by status', async () => {
      const blocked = await pending();
      await placedOrder(blocked.vendorId);
      await runningAd(blocked.vendorId, blocked.userId);
      await setWallet(blocked.vendorId, -450);
      const rejected = await pending();
      await decide(rejected.requestId, 'reject', admin, { reason: 'Dues outstanding' });

      const all = bodyOf(
        adminModelChangeRequestListResponseSchema,
        await call('get', '/api/admin/settlement-model-requests', admin),
      ).requests;
      expect(all.find((row) => row.id === blocked.requestId)).toMatchObject({
        vendor_id: blocked.vendorId,
        current_model: 'PLATFORM_ESCROW',
        from_model: 'PLATFORM_ESCROW',
        requested_model: 'COD_CREDIT',
        status: 'PENDING',
        open_order_count: 1,
        ledger_balance_npr: -450,
        active_ad_count: 1,
      });
      // Pending requests come before decided ones.
      const statuses = all.map((row) => row.status);
      expect(statuses.lastIndexOf('PENDING')).toBeLessThan(
        statuses.findIndex((status) => status !== 'PENDING'),
      );

      const onlyRejected = bodyOf(
        adminModelChangeRequestListResponseSchema,
        await call('get', '/api/admin/settlement-model-requests?status=REJECTED', admin),
      ).requests;
      expect(onlyRejected.every((row) => row.status === 'REJECTED')).toBe(true);
      expect(onlyRejected.find((row) => row.id === rejected.requestId)?.rejection_reason).toBe(
        'Dues outstanding',
      );

      const bad = await call('get', '/api/admin/settlement-model-requests?status=DONE', admin);
      expect(bad.status).toBe(400);
    });

    it('does not count an unpaid checkout whose lock has expired as an open order', async () => {
      const { vendorId, requestId } = await pending();
      const fresh = await createOrder(db, { vendorId, customerId: await createUser(db) });
      const stale = await createOrder(db, { vendorId, customerId: await createUser(db) });
      await db
        .update(orders)
        .set({ created_at: sql`now() - interval '601 seconds'` })
        .where(eq(orders.id, stale.id));

      const row = bodyOf(
        adminModelChangeRequestListResponseSchema,
        await call('get', '/api/admin/settlement-model-requests?status=PENDING', admin),
      ).requests.find((candidate) => candidate.id === requestId);
      expect(row?.open_order_count).toBe(1);
      expect(fresh.id).not.toBe(stale.id);
    });
  });

  describe('POST …/:id/approve', () => {
    it('moves a clear shop to the model it asked for, closes the request and audits, in one go', async () => {
      const { vendorId, requestId } = await pending();
      const res = await decide(requestId, 'approve', admin);

      expect(res.status).toBe(200);
      const view = bodyOf(adminModelChangeDecisionResponseSchema, res).request;
      expect(view).toMatchObject({
        status: 'APPROVED',
        current_model: 'COD_CREDIT',
        from_model: 'PLATFORM_ESCROW',
        requested_model: 'COD_CREDIT',
        rejection_reason: null,
      });
      expect(view.decided_at).not.toBeNull();
      expect(await modelOf(vendorId)).toBe('COD_CREDIT');

      const [entry] = await entries(vendorId, 'SETTLEMENT_MODEL_CHANGED');
      expect(entry).toMatchObject({
        actor_user_id: adminId,
        actor_role: 'SUPER_ADMIN',
        vendor_id: vendorId,
        entity_type: 'vendor_ledger',
        before_state: { settlement_model: 'PLATFORM_ESCROW' },
        after_state: { settlement_model: 'COD_CREDIT', request_id: requestId },
      });

      // A repeat answers the same request and records nothing more.
      const repeat = await decide(requestId, 'approve', admin);
      expect(repeat.status).toBe(200);
      expect(bodyOf(adminModelChangeDecisionResponseSchema, repeat).request.decided_at).toBe(
        view.decided_at,
      );
      expect(await entries(vendorId, 'SETTLEMENT_MODEL_CHANGED')).toHaveLength(1);
    });

    it.each([
      ['an open order', 'OPEN_ORDERS'],
      ['a negative ledger', 'NEGATIVE_BALANCE'],
      ['an ad running', 'ACTIVE_AD'],
    ] as const)('refuses while the shop has %s, and changes nothing', async (_name, blocker) => {
      const { vendorId, userId, requestId } = await pending();
      if (blocker === 'OPEN_ORDERS') await placedOrder(vendorId);
      if (blocker === 'NEGATIVE_BALANCE') await setWallet(vendorId, -0.01);
      if (blocker === 'ACTIVE_AD') await runningAd(vendorId, userId);

      const res = await decide(requestId, 'approve', admin);
      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'SETTLEMENT_CHANGE_BLOCKED',
        details: { blockers: [blocker] },
      });
      expect(await modelOf(vendorId)).toBe('PLATFORM_ESCROW');
      const [row] = await db
        .select()
        .from(settlementModelChangeRequests)
        .where(eq(settlementModelChangeRequests.id, requestId));
      expect(row).toMatchObject({ status: 'PENDING', decided_at: null, decided_by_user_id: null });
      expect(await entries(vendorId, 'SETTLEMENT_MODEL_CHANGED')).toHaveLength(0);
    });

    it('names every blocker at once, and approves once they are gone', async () => {
      const { vendorId, userId, requestId } = await pending();
      const orderId = await placedOrder(vendorId);
      const purchaseId = await runningAd(vendorId, userId);
      await setWallet(vendorId, -100);

      expect(errorOf(await decide(requestId, 'approve', admin)).details).toEqual({
        blockers: ['OPEN_ORDERS', 'NEGATIVE_BALANCE', 'ACTIVE_AD'],
      });

      await db.update(orders).set({ state: 'CANCELED' }).where(eq(orders.id, orderId));
      await db.update(adPurchases).set({ status: 'ENDED' }).where(eq(adPurchases.id, purchaseId));
      await setWallet(vendorId, 100);
      // A ledger at exactly 0 is clear.
      expect((await decide(requestId, 'approve', admin)).status).toBe(200);
      expect(await modelOf(vendorId)).toBe('COD_CREDIT');
    });

    it('cannot name a model: the body is ignored and the shop gets what it asked for', async () => {
      const { vendorId, requestId } = await pending();
      const res = await decide(requestId, 'approve', admin, { model: 'DIRECT_PREPAID' });
      expect(res.status).toBe(200);
      expect(await modelOf(vendorId)).toBe('COD_CREDIT');
    });

    it('approves Model C only once the prepaid balance is at the Fixed Reserve (2026-10-21)', async () => {
      const { vendorId, userId } = await shop();
      const [row] = await db
        .insert(settlementModelChangeRequests)
        .values({
          vendor_id: vendorId,
          from_model: 'PLATFORM_ESCROW',
          requested_model: 'DIRECT_PREPAID',
          requested_by_user_id: userId,
        })
        .returning();
      if (row === undefined) throw new Error('no request');

      const res = await decide(row.id, 'approve', admin);
      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'SETTLEMENT_CHANGE_BLOCKED',
        details: { blockers: ['BELOW_PREPAID_RESERVE'] },
      });
      expect(await modelOf(vendorId)).toBe('PLATFORM_ESCROW');
    });

    it('approves once when five admins press at the same moment', async () => {
      const { vendorId, requestId } = await pending();
      const statuses = (
        await Promise.all(Array.from({ length: 5 }, () => decide(requestId, 'approve', admin)))
      ).map((res) => res.status);
      expect(statuses).toEqual([200, 200, 200, 200, 200]);
      expect(await entries(vendorId, 'SETTLEMENT_MODEL_CHANGED')).toHaveLength(1);
    });
  });

  describe('POST …/:id/reject', () => {
    it('leaves the shop on its model, keeps the reason for the vendor and audits', async () => {
      const { vendorId, requestId, token } = await pending();
      const res = await decide(requestId, 'reject', admin, { reason: '  Dues outstanding  ' });

      expect(res.status).toBe(200);
      expect(bodyOf(adminModelChangeDecisionResponseSchema, res).request).toMatchObject({
        status: 'REJECTED',
        current_model: 'PLATFORM_ESCROW',
        rejection_reason: 'Dues outstanding',
      });
      expect(await modelOf(vendorId)).toBe('PLATFORM_ESCROW');
      const [entry] = await entries(requestId, 'SETTLEMENT_MODEL_CHANGE_REJECTED');
      expect(entry).toMatchObject({
        actor_user_id: adminId,
        before_state: { status: 'PENDING' },
        after_state: { status: 'REJECTED', rejection_reason: 'Dues outstanding' },
      });

      // A repeat keeps the first reason; the shop may then ask again.
      const repeat = await decide(requestId, 'reject', admin, { reason: 'Another reason' });
      expect(bodyOf(adminModelChangeDecisionResponseSchema, repeat).request.rejection_reason).toBe(
        'Dues outstanding',
      );
      expect(await entries(requestId, 'SETTLEMENT_MODEL_CHANGE_REJECTED')).toHaveLength(1);
      expect((await ask(token)).status).toBe(201);
    });

    it('takes no body, a blank reason as none, and refuses one over 500 characters', async () => {
      const first = await pending();
      const noBody = await decide(first.requestId, 'reject', admin);
      expect(noBody.status).toBe(200);
      expect(
        bodyOf(adminModelChangeDecisionResponseSchema, noBody).request.rejection_reason,
      ).toBeNull();

      const second = await pending();
      const tooLong = await decide(second.requestId, 'reject', admin, { reason: 'x'.repeat(501) });
      expect(tooLong.status).toBe(400);
      const blank = await decide(second.requestId, 'reject', admin, { reason: '   ' });
      expect(
        bodyOf(adminModelChangeDecisionResponseSchema, blank).request.rejection_reason,
      ).toBeNull();
    });

    it('is final in both directions, and exactly one of approve and reject wins a race', async () => {
      const approved = await pending();
      await decide(approved.requestId, 'approve', admin);
      const late = await decide(approved.requestId, 'reject', admin);
      expect(late.status).toBe(409);
      expect(errorOf(late)).toMatchObject({
        code: 'REQUEST_ALREADY_DECIDED',
        details: { status: 'APPROVED' },
      });

      const rejected = await pending();
      await decide(rejected.requestId, 'reject', admin);
      expect(errorOf(await decide(rejected.requestId, 'approve', admin)).details).toEqual({
        status: 'REJECTED',
      });
      expect(await modelOf(rejected.vendorId)).toBe('PLATFORM_ESCROW');

      for (let round = 0; round < 5; round += 1) {
        const raced = await pending();
        const [a, r] = await Promise.all([
          decide(raced.requestId, 'approve', admin),
          decide(raced.requestId, 'reject', admin),
        ]);
        expect([a.status, r.status].sort()).toEqual([200, 409]);
        expect(await modelOf(raced.vendorId)).toBe(
          a.status === 200 ? 'COD_CREDIT' : 'PLATFORM_ESCROW',
        );
      }
    });

    it('answers 404 for an unknown request, 400 for a bad id, and serves Super Admins only', async () => {
      const { requestId, token } = await pending();
      for (const decision of ['approve', 'reject'] as const) {
        expect((await decide(randomUUID(), decision, admin)).status).toBe(404);
        expect((await decide('nope', decision, admin)).status).toBe(400);
        expect((await decide(requestId, decision, null)).status).toBe(401);
        expect((await decide(requestId, decision, token)).status).toBe(403);
      }
      expect((await call('get', '/api/admin/settlement-model-requests', token)).status).toBe(403);
    });
  });

  // The vendor's view of campaigns ----------------------------------------------------------

  const DAY = 24 * 60 * 60 * 1000;
  const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString();

  async function campaign(overrides: Record<string, unknown> = {}) {
    const res = await call('post', '/api/admin/campaigns', admin, {
      name: `Dashain ${randomUUID()}`,
      kind: 'PERCENTAGE',
      value: 10,
      max_discount_npr: 200,
      min_cart_npr: 500,
      vendor_share_percent: 50,
      starts_at: inDays(1),
      ends_at: inDays(15),
      is_active: true,
      ...overrides,
    });
    expect(res.status).toBe(201);
    return bodyOf(adminCampaignResponseSchema, res).campaign;
  }

  const optIn = (campaignId: string, token: string, version = 1) =>
    call('post', `/api/vendor/campaigns/${campaignId}/opt-in`, token, { terms_version: version });
  const optOut = (campaignId: string, token: string | null) =>
    call('post', `/api/vendor/campaigns/${campaignId}/opt-out`, token);
  const invites = async (token: string) =>
    bodyOf(vendorCampaignListResponseSchema, await call('get', '/api/vendor/campaigns', token))
      .campaigns;

  describe('GET /api/vendor/campaigns', () => {
    it('shows a published campaign as an invite with its terms, then as joined by this shop only', async () => {
      const created = await campaign();
      const owner = await shop();
      const other = await shop();

      expect((await invites(owner.token)).find((row) => row.id === created.id)).toEqual({
        id: created.id,
        name: created.name,
        kind: 'PERCENTAGE',
        value: 10,
        max_discount_npr: 200,
        min_cart_npr: 500,
        vendor_share_percent: 50,
        terms_version: 1,
        starts_at: created.starts_at,
        ends_at: created.ends_at,
        opt_in_status: null,
        opt_in_terms_version: null,
        opted_in_at: null,
      });

      await optIn(created.id, owner.token);
      const joined = (await invites(owner.token)).find((row) => row.id === created.id);
      expect(joined).toMatchObject({ opt_in_status: 'ACTIVE', opt_in_terms_version: 1 });
      expect(joined?.opted_in_at).not.toBeNull();
      // Nothing is on by default, and one shop's opt-in is not another's.
      expect(
        (await invites(other.token)).find((row) => row.id === created.id)?.opt_in_status,
      ).toBeNull();
    });

    it('hides unpublished and ended campaigns, but keeps an unpublished one the shop is still in', async () => {
      const owner = await shop();
      const draft = await campaign({ is_active: false });
      const ended = await campaign();
      await db.execute(
        sql`UPDATE platform_campaigns SET starts_at = now() - interval '3 days', ends_at = now() - interval '1 day', terms_version = terms_version + 1 WHERE id = ${ended.id}`,
      );
      const joined = await campaign();
      await optIn(joined.id, owner.token);
      await call('put', `/api/admin/campaigns/${joined.id}`, admin, {
        name: joined.name,
        kind: joined.kind,
        value: joined.value,
        max_discount_npr: joined.max_discount_npr,
        min_cart_npr: joined.min_cart_npr,
        vendor_share_percent: joined.vendor_share_percent,
        starts_at: joined.starts_at,
        ends_at: joined.ends_at,
        is_active: false,
      });

      const ids = (await invites(owner.token)).map((row) => row.id);
      expect(ids).not.toContain(draft.id);
      expect(ids).not.toContain(ended.id);
      expect(ids).toContain(joined.id);
      // A shop that never joined it does not see the unpublished campaign.
      expect((await invites((await shop()).token)).map((row) => row.id)).not.toContain(joined.id);
    });

    it('shows a voided opt-in with the new version to agree to', async () => {
      const created = await campaign();
      const owner = await shop();
      await optIn(created.id, owner.token);
      await call('put', `/api/admin/campaigns/${created.id}`, admin, {
        name: created.name,
        kind: created.kind,
        value: created.value,
        max_discount_npr: created.max_discount_npr,
        min_cart_npr: created.min_cart_npr,
        vendor_share_percent: 60,
        starts_at: created.starts_at,
        ends_at: created.ends_at,
        is_active: true,
      });

      expect((await invites(owner.token)).find((row) => row.id === created.id)).toMatchObject({
        vendor_share_percent: 60,
        terms_version: 2,
        opt_in_status: 'VOIDED',
        opt_in_terms_version: 1,
        opted_in_at: null,
      });
    });

    it('serves vendors with a shop only', async () => {
      expect((await call('get', '/api/vendor/campaigns', null)).status).toBe(401);
      expect((await call('get', '/api/vendor/campaigns', admin)).status).toBe(403);
      const shopless = bearer(await createUser(db, 'VENDOR'), 'VENDOR');
      expect((await call('get', '/api/vendor/campaigns', shopless)).status).toBe(404);
    });
  });

  describe('POST /api/vendor/campaigns/:id/opt-out', () => {
    it("closes the shop's own opt-in as OPTED_OUT, audited, and the shop may join again", async () => {
      const created = await campaign();
      const owner = await shop();
      const joined = bodyOf(
        campaignOptInResponseSchema,
        await optIn(created.id, owner.token),
      ).opt_in;

      const res = await optOut(created.id, owner.token);
      expect(res.status).toBe(200);
      expect(bodyOf(campaignOptInResponseSchema, res).opt_in).toMatchObject({
        id: joined.id,
        status: 'OPTED_OUT',
      });
      const [row] = await db.select().from(campaignOptIns).where(eq(campaignOptIns.id, joined.id));
      expect(row).toMatchObject({ status: 'OPTED_OUT', closed_by_user_id: owner.userId });
      expect(row?.closed_at).not.toBeNull();
      const [entry] = await entries(joined.id, 'CAMPAIGN_OPTED_OUT');
      expect(entry).toMatchObject({
        actor_user_id: owner.userId,
        actor_role: 'VENDOR',
        vendor_id: owner.vendorId,
        before_state: { status: 'ACTIVE' },
        after_state: { status: 'OPTED_OUT', campaign_id: created.id },
      });

      // A repeat answers the same closed opt-in and records nothing more.
      const repeat = await optOut(created.id, owner.token);
      expect(repeat.status).toBe(200);
      expect(bodyOf(campaignOptInResponseSchema, repeat).opt_in.id).toBe(joined.id);
      expect(await entries(joined.id, 'CAMPAIGN_OPTED_OUT')).toHaveLength(1);

      expect((await invites(owner.token)).find((c) => c.id === created.id)?.opt_in_status).toBe(
        'OPTED_OUT',
      );
      const rejoined = await optIn(created.id, owner.token);
      expect(rejoined.status).toBe(201);
      expect(bodyOf(campaignOptInResponseSchema, rejoined).opt_in.id).not.toBe(joined.id);
    });

    it("never touches another shop's opt-in", async () => {
      const created = await campaign();
      const owner = await shop();
      const other = await shop();
      const joined = bodyOf(
        campaignOptInResponseSchema,
        await optIn(created.id, owner.token),
      ).opt_in;

      const res = await optOut(created.id, other.token);
      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('CAMPAIGN_NOT_OPTED_IN');
      const [row] = await db.select().from(campaignOptIns).where(eq(campaignOptIns.id, joined.id));
      expect(row?.status).toBe('ACTIVE');
    });

    it('refuses a shop that never joined or whose opt-in was voided, and an unknown campaign', async () => {
      const created = await campaign();
      const owner = await shop();
      expect(errorOf(await optOut(created.id, owner.token)).code).toBe('CAMPAIGN_NOT_OPTED_IN');
      const unknown = await optOut(randomUUID(), owner.token);
      expect(unknown.status).toBe(404);
      expect(errorOf(unknown).code).toBe('CAMPAIGN_NOT_FOUND');
      expect((await optOut('nope', owner.token)).status).toBe(400);
    });

    it('closes the opt-in once when pressed five times at the same moment', async () => {
      const created = await campaign();
      const owner = await shop();
      const joined = bodyOf(
        campaignOptInResponseSchema,
        await optIn(created.id, owner.token),
      ).opt_in;
      const statuses = (
        await Promise.all(Array.from({ length: 5 }, () => optOut(created.id, owner.token)))
      ).map((res) => res.status);
      expect(statuses).toEqual([200, 200, 200, 200, 200]);
      expect(await entries(joined.id, 'CAMPAIGN_OPTED_OUT')).toHaveLength(1);
    });

    it('serves vendors only: no admin can opt a shop out', async () => {
      const created = await campaign();
      expect((await optOut(created.id, null)).status).toBe(401);
      expect((await optOut(created.id, admin)).status).toBe(403);
    });
  });
});
