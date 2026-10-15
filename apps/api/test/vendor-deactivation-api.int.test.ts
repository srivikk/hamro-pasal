import { randomUUID } from 'node:crypto';

import {
  adProducts,
  adPurchases,
  auditLogs,
  campaignOptIns,
  deviceTokens,
  orders,
  outboxEvents,
  payoutRequests,
  users,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import { LedgerService, WalletService } from '@hamro-pasal/ledger';
import {
  adminCampaignResponseSchema,
  adPurchaseResponseSchema,
  feedResponseSchema,
  taxIdentityResponseSchema,
  vendorDeactivateResponseSchema,
  type AdBillingModel,
  type SettlementModel,
  type UserRole,
} from '@hamro-pasal/shared-types';
import { and, asc, eq, sql } from 'drizzle-orm';
import request from 'supertest';

import { signRefreshToken } from '../src/auth/refresh-token';
import { createOrder, createUser, createVendor, vendorUserIdOf } from './support/fixtures';
import {
  bearer,
  bodyOf,
  buildTestApp,
  errorOf,
  REFRESH_SECRET,
  type TestApp,
} from './support/http';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * Phase 36 on real PostgreSQL and Redis: POST /api/vendor/account/deactivate (the soft delete of
 * a shop), what it refuses, what it closes with the shop, and that the account can no longer
 * sign in; and the `vendor.compliance_restored` event of a PAN that lifts a suspension.
 */
describe('Vendor deactivation API', () => {
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

  const credit = (vendorId: string, amountNpr: number) =>
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

  async function shop(options: { model?: SettlementModel; balance?: number } = {}) {
    const vendorId = await createVendor(db);
    const userId = await vendorUserIdOf(db, vendorId);
    if (options.model !== undefined) {
      await db
        .update(vendors)
        .set({ settlement_model: options.model })
        .where(eq(vendors.id, vendorId));
    }
    if (options.balance !== undefined && options.balance !== 0) {
      await credit(vendorId, options.balance);
    }
    return { vendorId, userId, token: bearer(userId, 'VENDOR') };
  }

  const deactivate = (token: string | null, body: unknown = { confirm: true }) => {
    const req = request(t.app).post('/api/vendor/account/deactivate');
    return (token === null ? req : req.set('authorization', token)).send(body as object);
  };

  const vendorRow = async (vendorId: string) => {
    const [row] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
    if (row === undefined) throw new Error('vendor not found');
    return row;
  };

  const audit = (entityId: string) =>
    db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entity_id, entityId))
      .orderBy(asc(auditLogs.occurred_at));

  /** An ad bought through the API. `startsInDays` 0 = already running (a minute ago). */
  async function ad(
    token: string,
    options: { billing: AdBillingModel; price: number; budget?: number; startsInDays?: number },
  ) {
    const [product] = await db
      .insert(adProducts)
      .values({
        name: `Ad ${randomUUID()}`,
        slot: options.billing === 'FLAT_RATE' ? 'CAROUSEL' : 'FEED_LISTING',
        billing_model: options.billing,
        price_npr: options.price,
        duration_days: 7,
        created_by_user_id: adminId,
      })
      .returning();
    const startsAt = Date.now() + (options.startsInDays ?? 0) * DAY - MINUTE;
    const res = await request(t.app)
      .post('/api/vendor/ads/purchases')
      .set('authorization', token)
      .send({
        ad_product_id: product?.id,
        starts_at: new Date(
          options.startsInDays === undefined ? startsAt : startsAt + 2 * MINUTE,
        ).toISOString(),
        ...(options.budget === undefined ? {} : { budget_npr: options.budget }),
        idempotency_key: randomUUID(),
        agreed: true,
      });
    expect(res.status).toBe(201);
    return bodyOf(adPurchaseResponseSchema, res).purchase;
  }

  const adRow = async (id: string) =>
    (await db.select().from(adPurchases).where(eq(adPurchases.id, id)))[0];

  /** A published campaign the shop has opted in to; returns the opt-in's id. */
  async function optedIn(token: string) {
    const created = await request(t.app)
      .post('/api/admin/campaigns')
      .set('authorization', admin)
      .send({
        name: `Campaign ${randomUUID()}`,
        kind: 'PERCENTAGE',
        value: 10,
        max_discount_npr: null,
        min_cart_npr: 0,
        vendor_share_percent: 50,
        starts_at: new Date(Date.now() + DAY).toISOString(),
        ends_at: new Date(Date.now() + 10 * DAY).toISOString(),
        is_active: true,
      });
    const campaignId = bodyOf(adminCampaignResponseSchema, created).campaign.id;
    const res = await request(t.app)
      .post(`/api/vendor/campaigns/${campaignId}/opt-in`)
      .set('authorization', token)
      .send({ terms_version: 1 });
    expect(res.status).toBe(201);
    return campaignId;
  }

  const optInsOf = (vendorId: string) =>
    db.select().from(campaignOptIns).where(eq(campaignOptIns.vendor_id, vendorId));

  describe('POST /api/vendor/account/deactivate', () => {
    it('closes a shop that owes nothing: DEACTIVATED, audited, the row and its money kept', async () => {
      const { vendorId, userId, token } = await shop({ balance: 640 });

      const res = await deactivate(token);

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = bodyOf(vendorDeactivateResponseSchema, res);
      expect(body).toMatchObject({
        vendor_id: vendorId,
        status: 'DEACTIVATED',
        cancelled_ad_count: 0,
        returned_npr: 0,
        closed_opt_in_count: 0,
        wallet_balance_npr: 640,
      });
      // Soft delete: the row, the account and the balance the platform owes are all still there.
      expect(await vendorRow(vendorId)).toMatchObject({
        status: 'DEACTIVATED',
        wallet_balance_npr: 640,
        status_before_debt_suspension: null,
        status_before_admin_suspension: null,
        status_before_compliance_suspension: null,
      });
      expect(await db.select().from(users).where(eq(users.id, userId))).toHaveLength(1);
      const entries = await audit(vendorId);
      expect(entries.at(-1)).toMatchObject({
        action: 'VENDOR_DEACTIVATED',
        actor_user_id: userId,
        actor_role: 'VENDOR',
        before_state: { status: 'LIVE', wallet_balance_npr: 640 },
        after_state: { status: 'DEACTIVATED', cancelled_ad_count: 0, closed_opt_in_count: 0 },
      });
    });

    it('takes the shop out of the feed', async () => {
      const { vendorId, token } = await shop();
      const feed = async () => {
        const res = await request(t.app).get('/api/vendors?lat=27.7154&lng=85.3123');
        const body = bodyOf(feedResponseSchema, res);
        return [...body.serviceable, ...body.explore_further].some((e) => e.vendor.id === vendorId);
      };
      // Only when the shared test feed has room for it is there something to compare.
      const listedBefore = await feed();

      expect((await deactivate(token)).status).toBe(200);

      expect(await feed()).toBe(false);
      const menu = await request(t.app).get(
        `/api/vendors/${vendorId}/products?lat=27.7154&lng=85.3123`,
      );
      expect(menu.status).toBe(404);
      expect(typeof listedBefore).toBe('boolean');
    });

    it('needs the explicit confirmation, and names no shop', async () => {
      const { vendorId, token } = await shop();
      const other = await shop();

      for (const body of [
        {},
        { confirm: false },
        { confirm: 'true' },
        { confirm: true, vendor_id: other.vendorId },
        { confirm: true, status: 'DEACTIVATED' },
      ]) {
        const res = await deactivate(token, body);
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
      expect((await vendorRow(vendorId)).status).toBe('LIVE');
      expect((await vendorRow(other.vendorId)).status).toBe('LIVE');
    });

    it('answers the same on repeat, and five requests at once close the shop once', async () => {
      const { vendorId, token } = await shop({ balance: 100 });

      const answers = await Promise.all(Array.from({ length: 5 }, () => deactivate(token)));
      const again = await deactivate(token);

      for (const res of [...answers, again]) {
        expect(res.status).toBe(200);
        expect(bodyOf(vendorDeactivateResponseSchema, res)).toMatchObject({
          vendor_id: vendorId,
          status: 'DEACTIVATED',
          wallet_balance_npr: 100,
        });
      }
      const closed = (await audit(vendorId)).filter((e) => e.action === 'VENDOR_DEACTIVATED');
      expect(closed).toHaveLength(1);
      expect(bodyOf(vendorDeactivateResponseSchema, again).deactivated_at).toBe(
        closed[0]?.occurred_at.toISOString(),
      );
    });

    it('serves vendors with a shop only', async () => {
      expect((await deactivate(null)).status).toBe(401);
      for (const role of ['CUSTOMER', 'DRIVER', 'SUPER_ADMIN'] satisfies UserRole[]) {
        expect((await deactivate(bearer(await createUser(db, role), role))).status).toBe(403);
      }
      const shopless = await deactivate(bearer(await createUser(db, 'VENDOR'), 'VENDOR'));
      expect(shopless.status).toBe(404);
      expect(errorOf(shopless).code).toBe('VENDOR_NOT_FOUND');
    });
  });

  describe('what stands in the way', () => {
    async function refused(token: string) {
      const res = await deactivate(token);
      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('SHOP_NOT_DEACTIVATABLE');
      return (errorOf(res).details as { blockers: string[] }).blockers;
    }

    it('refuses a shop in debt, and closes it once the dues are cleared', async () => {
      const { vendorId, token } = await shop({ balance: -100 });

      expect(await refused(token)).toEqual(['NEGATIVE_BALANCE']);
      expect((await vendorRow(vendorId)).status).toBe('LIVE');
      expect((await audit(vendorId)).map((e) => e.action)).not.toContain('VENDOR_DEACTIVATED');

      await credit(vendorId, 100);
      expect((await deactivate(token)).status).toBe(200);
    });

    it.each(['PLACED', 'PREPARING', 'OUT_FOR_DELIVERY', 'DISPUTED'] as const)(
      'refuses while an order is %s',
      async (state) => {
        const { vendorId, token } = await shop();
        const order = await createOrder(db, { vendorId, customerId: await createUser(db) });
        await db
          .update(orders)
          .set({
            state,
            placed_at: sql`now()`,
            ...(state === 'DISPUTED' ? { delivered_at: sql`now()`, delivery_otp: null } : {}),
          })
          .where(eq(orders.id, order.id));

        expect(await refused(token)).toEqual(['ACTIVE_ORDERS']);

        await db
          .update(orders)
          .set({ state: 'DELIVERED', delivered_at: sql`now()`, delivery_otp: null })
          .where(eq(orders.id, order.id));
        expect((await deactivate(token)).status).toBe(200);
      },
    );

    it('counts an unpaid checkout only while its 600-second lock can still be claimed', async () => {
      const { vendorId, token } = await shop();
      const order = await createOrder(db, { vendorId, customerId: await createUser(db) });

      expect(await refused(token)).toEqual(['ACTIVE_ORDERS']);

      await db
        .update(orders)
        .set({ created_at: sql`now() - interval '601 seconds'` })
        .where(eq(orders.id, order.id));
      expect((await deactivate(token)).status).toBe(200);
    });

    it('refuses while a payout is requested or with the bank', async () => {
      const { vendorId, token } = await shop({ balance: 500 });
      const requested = await request(t.app)
        .post('/api/vendor/finance/payout')
        .set('authorization', token)
        .send({ idempotency_key: randomUUID(), amount_npr: 200 });
      expect(requested.status).toBe(201);

      expect(await refused(token)).toEqual(['PENDING_PAYOUT']);

      // The run's payout that is with the bank blocks too; a settled one does not.
      await db
        .update(payoutRequests)
        .set({
          status: 'APPROVED',
          transfer_state: 'PROCESSING_BANK_TRANSFER',
          system_actor: 'SETTLEMENT_PAYOUT_RUN',
          decided_at: sql`now()`,
        })
        .where(eq(payoutRequests.vendor_id, vendorId));
      expect(await refused(token)).toEqual(['PENDING_PAYOUT']);

      await db
        .update(payoutRequests)
        .set({
          transfer_state: 'COMPLETED',
          bank_reference: 'NIC-1',
          decided_by_user_id: adminId,
        })
        .where(eq(payoutRequests.vendor_id, vendorId));
      expect((await deactivate(token)).status).toBe(200);
    });

    it('names every reason at once, and changes nothing while refusing', async () => {
      const { vendorId, userId, token } = await shop({ balance: -50 });
      const order = await createOrder(db, { vendorId, customerId: await createUser(db) });
      await db
        .update(orders)
        .set({ state: 'PREPARING', placed_at: sql`now()` })
        .where(eq(orders.id, order.id));
      await db.insert(deviceTokens).values({
        user_id: userId,
        token: `ExponentPushToken[${randomUUID()}]`,
        platform: 'ANDROID',
      });

      expect(await refused(token)).toEqual(['NEGATIVE_BALANCE', 'ACTIVE_ORDERS']);

      expect((await vendorRow(vendorId)).status).toBe('LIVE');
      expect(
        await db.select().from(deviceTokens).where(eq(deviceTokens.user_id, userId)),
      ).toHaveLength(1);
    });
  });

  describe('what closes with the shop', () => {
    it('cancels a per-order ad and returns its unused held budget', async () => {
      const { vendorId, token } = await shop({ model: 'COD_CREDIT', balance: 400 });
      const purchase = await ad(token, { billing: 'PER_ORDER_PREMIUM', price: 25, budget: 300 });
      expect((await vendorRow(vendorId)).wallet_balance_npr).toBe(100);

      const res = await deactivate(token);

      expect(bodyOf(vendorDeactivateResponseSchema, res)).toMatchObject({
        cancelled_ad_count: 1,
        returned_npr: 300,
        wallet_balance_npr: 400,
      });
      expect((await adRow(purchase.id))?.status).toBe('CANCELLED');
      const cancelled = (await audit(purchase.id)).find((e) => e.action === 'AD_CANCELLED');
      expect(cancelled).toMatchObject({
        vendor_id: vendorId,
        before_state: { status: 'ACTIVE' },
        after_state: { status: 'CANCELLED', returned_npr: 300, reason: 'VENDOR_DEACTIVATED' },
      });
    });

    it('refunds a flat-rate ad that has not started, and keeps the fee of one that has', async () => {
      const { vendorId, token } = await shop({ model: 'COD_CREDIT', balance: 1000 });
      const running = await ad(token, { billing: 'FLAT_RATE', price: 300 });
      const booked = await ad(token, { billing: 'FLAT_RATE', price: 200, startsInDays: 3 });
      expect((await vendorRow(vendorId)).wallet_balance_npr).toBe(500);

      const res = await deactivate(token);

      expect(bodyOf(vendorDeactivateResponseSchema, res)).toMatchObject({
        cancelled_ad_count: 2,
        returned_npr: 200,
        wallet_balance_npr: 700,
      });
      // The ad that ran was delivered: its fee stays paid (decided 2026-10-08).
      expect(await adRow(running.id)).toMatchObject({ status: 'CANCELLED', amount_paid_npr: 300 });
      expect(await adRow(booked.id)).toMatchObject({ status: 'CANCELLED', amount_paid_npr: 0 });
    });

    it('takes a flat fee still owed from the wallet first, and refuses while one stays owed', async () => {
      // Model B: the ad is sold against escrow, so its fee can be due with an empty wallet.
      const { vendorId, token } = await shop();
      const order = await createOrder(db, {
        vendorId,
        customerId: await createUser(db),
        paymentMethod: 'ESEWA',
      });
      await db
        .update(orders)
        .set({ state: 'PLACED', placed_at: sql`now()`, payment_status: 'PAID' })
        .where(eq(orders.id, order.id));
      const purchase = await ad(token, { billing: 'FLAT_RATE', price: 300 });
      // The order is delivered, but only 120 of its money has reached the wallet so far.
      await db
        .update(orders)
        .set({ state: 'DELIVERED', delivered_at: sql`now()`, delivery_otp: null })
        .where(eq(orders.id, order.id));
      await credit(vendorId, 120);

      const res = await deactivate(token);

      expect(res.status).toBe(409);
      expect((errorOf(res).details as { blockers: string[] }).blockers).toEqual(['AD_FEES_DUE']);
      // Refused: the collection it attempted was rolled back with it.
      expect((await vendorRow(vendorId)).wallet_balance_npr).toBe(120);
      expect(await adRow(purchase.id)).toMatchObject({ status: 'ACTIVE', amount_paid_npr: 0 });

      await credit(vendorId, 280);
      const closed = await deactivate(token);

      expect(closed.status).toBe(200);
      // 400 in the wallet, 300 of it the fee that was owed.
      expect(bodyOf(vendorDeactivateResponseSchema, closed).wallet_balance_npr).toBe(100);
      expect(await adRow(purchase.id)).toMatchObject({ status: 'CANCELLED', amount_paid_npr: 300 });
    });

    it('closes the shop’s live campaign opt-ins as its own opt-out, and removes its devices', async () => {
      const { vendorId, userId, token } = await shop();
      const other = await shop();
      const campaignId = await optedIn(token);
      await request(t.app)
        .post(`/api/vendor/campaigns/${campaignId}/opt-in`)
        .set('authorization', other.token)
        .send({ terms_version: 1 });
      await db.insert(deviceTokens).values({
        user_id: userId,
        token: `ExponentPushToken[${randomUUID()}]`,
        platform: 'ANDROID',
      });

      const res = await deactivate(token);

      expect(bodyOf(vendorDeactivateResponseSchema, res).closed_opt_in_count).toBe(1);
      const [mine] = await optInsOf(vendorId);
      expect(mine).toMatchObject({ status: 'OPTED_OUT', closed_by_user_id: userId });
      expect(mine?.closed_at).toBeInstanceOf(Date);
      // Another shop's consent to the same campaign is its own.
      expect((await optInsOf(other.vendorId))[0]?.status).toBe('ACTIVE');
      expect((await audit(mine?.id ?? '')).at(-1)).toMatchObject({
        action: 'CAMPAIGN_OPTED_OUT',
        actor_user_id: userId,
        after_state: { status: 'OPTED_OUT', reason: 'VENDOR_DEACTIVATED' },
      });
      expect(await db.select().from(deviceTokens).where(eq(deviceTokens.user_id, userId))).toEqual(
        [],
      );
    });

    it('lets a shop an admin suspended close itself, and forgets what a Restore would return to', async () => {
      const { vendorId, token } = await shop();
      const suspended = await request(t.app)
        .post(`/api/admin/vendors/${vendorId}/suspend`)
        .set('authorization', admin);
      expect(suspended.status).toBe(200);

      expect((await deactivate(token)).status).toBe(200);

      expect(await vendorRow(vendorId)).toMatchObject({
        status: 'DEACTIVATED',
        status_before_admin_suspension: null,
      });
      // Neither override can bring a closed shop back.
      for (const action of ['suspend', 'restore']) {
        const res = await request(t.app)
          .post(`/api/admin/vendors/${vendorId}/${action}`)
          .set('authorization', admin);
        expect(res.status).toBe(409);
        expect(errorOf(res).code).toBe('VENDOR_STATUS_CONFLICT');
      }
      expect((await vendorRow(vendorId)).status).toBe('DEACTIVATED');
    });
  });

  describe('a deactivated account cannot sign in', () => {
    const phoneOf = async (userId: string) => {
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      if (user === undefined) throw new Error('user not found');
      return user.phone;
    };
    const send = (phone: string) => request(t.app).post('/api/auth/otp/send').send({ phone });
    const verify = (phone: string, code: string) =>
      request(t.app).post('/api/auth/otp/verify').send({ phone, code });
    const codeSentTo = (phone: string) => {
      const message = t.sms.sent.filter((m) => m.to === phone).at(-1);
      return /\b([0-9]{6})\b/.exec(message?.text ?? '')?.[1] ?? null;
    };

    it('is sent no code and given no token', async () => {
      const { userId, token } = await shop();
      const phone = await phoneOf(userId);
      expect((await deactivate(token)).status).toBe(200);

      const res = await send(phone);

      expect(res.status).toBe(403);
      expect(errorOf(res).code).toBe('ACCOUNT_DEACTIVATED');
      // No SMS was sent (or billed), and no cooldown was started for the number.
      expect(codeSentTo(phone)).toBeNull();
      expect((await send(phone)).status).toBe(403);
    });

    it('cannot use a code that was sent just before the shop was closed', async () => {
      const { userId, token } = await shop();
      const phone = await phoneOf(userId);
      expect((await send(phone)).status).toBe(200);
      const code = codeSentTo(phone);
      expect((await deactivate(token)).status).toBe(200);

      const res = await verify(phone, code ?? '');

      expect(res.status).toBe(403);
      expect(errorOf(res).code).toBe('ACCOUNT_DEACTIVATED');
      expect(JSON.stringify(res.body)).not.toContain('access_token');
    });

    it('gets no new access token from its refresh token', async () => {
      const { userId, token } = await shop();
      const refresh = (refreshToken: string) =>
        request(t.app).post('/api/auth/token/refresh').send({ refresh_token: refreshToken });
      const refreshToken = signRefreshToken(userId, REFRESH_SECRET);
      expect((await refresh(refreshToken)).status).toBe(200);

      expect((await deactivate(token)).status).toBe(200);

      const res = await refresh(refreshToken);
      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe('REFRESH_TOKEN_INVALID');
    });

    it('leaves every other account alone: a live vendor and a customer still sign in', async () => {
      const live = await shop();
      const closed = await shop();
      expect((await deactivate(closed.token)).status).toBe(200);

      expect((await send(await phoneOf(live.userId))).status).toBe(200);
      expect((await send(await phoneOf(await createUser(db)))).status).toBe(200);
    });
  });

  describe('a checkout racing the deactivation', () => {
    it('is refused once the shop is closed, also when the cart was priced before', async () => {
      const { vendorId, token } = await shop();
      expect((await deactivate(token)).status).toBe(200);
      const customerId = await createUser(db);

      const res = await request(t.app)
        .post('/api/cart/checkout')
        .set('authorization', bearer(customerId, 'CUSTOMER'))
        .send({
          idempotency_key: randomUUID(),
          vendor_id: vendorId,
          payment_method: 'COD',
          items: [{ product_id: randomUUID(), quantity: 1 }],
          delivery_address: {
            province_id: 3,
            district_string: 'Kathmandu',
            municipality_palika_string: 'Kathmandu Metropolitan City',
            ward_number: 26,
            tole_locality: 'Thamel',
            landmark: 'Near Kathmandu Guest House',
            exact_lat: 27.7154,
            exact_lng: 85.3123,
          },
        });

      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe('VENDOR_UNAVAILABLE');
      expect(await db.select().from(orders).where(eq(orders.vendor_id, vendorId))).toEqual([]);
    });
  });

  describe('POST /api/admin/vendors/:id/reactivate', () => {
    const reactivate = (vendorId: string, token: string | null = admin) => {
      const req = request(t.app).post(`/api/admin/vendors/${vendorId}/reactivate`);
      return token === null ? req : req.set('authorization', token);
    };

    it('reopens a closed shop with a PAN as LIVE, audits it, and the vendor can sign in again', async () => {
      const { vendorId, userId, token } = await shop({ balance: 250 });
      await db.update(vendors).set({ tax_id: '302118845' }).where(eq(vendors.id, vendorId));
      expect((await deactivate(token)).status).toBe(200);
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      const send = () => request(t.app).post('/api/auth/otp/send').send({ phone: user?.phone });
      expect((await send()).status).toBe(403);

      const res = await reactivate(vendorId);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        previous_status: 'DEACTIVATED',
        vendor: { id: vendorId, status: 'LIVE', wallet_balance_npr: 250 },
      });
      expect(await vendorRow(vendorId)).toMatchObject({
        status: 'LIVE',
        status_before_compliance_suspension: null,
      });
      expect((await audit(vendorId)).at(-1)).toMatchObject({
        action: 'VENDOR_REACTIVATED',
        actor_user_id: adminId,
        actor_role: 'SUPER_ADMIN',
        before_state: { status: 'DEACTIVATED' },
        after_state: { status: 'LIVE', has_pan: true },
      });
      expect((await send()).status).toBe(200);
    });

    it('reopens a shop without a PAN as SUSPENDED_COMPLIANCE, which saving the PAN then lifts', async () => {
      const { vendorId, token } = await shop();
      expect((await deactivate(token)).status).toBe(200);

      const res = await reactivate(vendorId);

      expect(res.status).toBe(200);
      expect(await vendorRow(vendorId)).toMatchObject({
        status: 'SUSPENDED_COMPLIANCE',
        status_before_compliance_suspension: 'LIVE',
      });
      // No path sets LIVE without a PAN; the vendor's own save brings the shop back.
      const saved = await request(t.app)
        .put('/api/vendor/tax-identity')
        .set('authorization', token)
        .send({ tax_id: '302118845', is_vat_registered: false });
      expect(saved.status).toBe(200);
      expect((await vendorRow(vendorId)).status).toBe('LIVE');
    });

    it('leaves the ads and opt-ins that closed with the shop closed', async () => {
      const { vendorId, token } = await shop({ model: 'COD_CREDIT', balance: 400 });
      const purchase = await ad(token, { billing: 'PER_ORDER_PREMIUM', price: 25, budget: 300 });
      await optedIn(token);
      expect((await deactivate(token)).status).toBe(200);

      expect((await reactivate(vendorId)).status).toBe(200);

      expect((await adRow(purchase.id))?.status).toBe('CANCELLED');
      expect((await optInsOf(vendorId))[0]?.status).toBe('OPTED_OUT');
      expect((await vendorRow(vendorId)).wallet_balance_npr).toBe(400);
    });

    it('refuses any shop that is not deactivated, and reopens one once under five requests', async () => {
      const live = await shop();
      const refused = await reactivate(live.vendorId);
      expect(refused.status).toBe(409);
      expect(errorOf(refused).code).toBe('VENDOR_STATUS_CONFLICT');
      expect((await vendorRow(live.vendorId)).status).toBe('LIVE');

      const closed = await shop();
      await db.update(vendors).set({ tax_id: '302118845' }).where(eq(vendors.id, closed.vendorId));
      expect((await deactivate(closed.token)).status).toBe(200);
      const answers = await Promise.all(
        Array.from({ length: 5 }, () => reactivate(closed.vendorId)),
      );

      expect(answers.map((res) => res.status).sort()).toEqual([200, 409, 409, 409, 409]);
      const entries = (await audit(closed.vendorId)).filter(
        (entry) => entry.action === 'VENDOR_REACTIVATED',
      );
      expect(entries).toHaveLength(1);
    });

    it('serves Super Admins only, and answers 404 / 400 for an unknown or malformed id', async () => {
      const { vendorId, token } = await shop();
      expect((await deactivate(token)).status).toBe(200);

      expect((await reactivate(vendorId, null)).status).toBe(401);
      // The vendor cannot reopen its own shop.
      expect((await reactivate(vendorId, token)).status).toBe(403);
      expect((await reactivate(vendorId, bearer(await createUser(db), 'CUSTOMER'))).status).toBe(
        403,
      );
      expect((await vendorRow(vendorId)).status).toBe('DEACTIVATED');

      const unknown = await reactivate(randomUUID());
      expect(unknown.status).toBe(404);
      expect(errorOf(unknown).code).toBe('VENDOR_NOT_FOUND');
      expect((await reactivate('not-a-uuid')).status).toBe(400);
    });
  });

  describe('vendor.deactivated and vendor.reactivated', () => {
    const events = (vendorId: string, type: 'vendor.deactivated' | 'vendor.reactivated') =>
      db
        .select()
        .from(outboxEvents)
        .where(and(eq(outboxEvents.aggregate_id, vendorId), eq(outboxEvents.event_type, type)));
    const reactivate = (vendorId: string) =>
      request(t.app).post(`/api/admin/vendors/${vendorId}/reactivate`).set('authorization', admin);

    it('writes vendor.deactivated once, with what the platform still holds, however often it is asked', async () => {
      const { vendorId, token } = await shop({ model: 'COD_CREDIT', balance: 400 });
      await ad(token, { billing: 'PER_ORDER_PREMIUM', price: 25, budget: 300 });

      expect((await deactivate(token)).status).toBe(200);
      expect((await deactivate(token)).status).toBe(200);

      const [event, ...more] = await events(vendorId, 'vendor.deactivated');
      expect(more).toEqual([]);
      expect(event).toMatchObject({
        topic: 'notifications.broadcast',
        published_at: null,
        payload: {
          vendor_id: vendorId,
          vendor_phone: (await vendorRow(vendorId)).phone,
          wallet_balance_npr: 400,
          cancelled_ad_count: 1,
          returned_npr: 300,
        },
      });
    });

    it('writes no vendor.deactivated for a refused closure', async () => {
      const { vendorId, token } = await shop();
      await credit(vendorId, -150);

      expect((await deactivate(token)).status).toBe(409);

      expect(await events(vendorId, 'vendor.deactivated')).toEqual([]);
    });

    it('writes vendor.reactivated once, saying whether the shop came back LIVE', async () => {
      const withPan = await shop();
      await db.update(vendors).set({ tax_id: '302118845' }).where(eq(vendors.id, withPan.vendorId));
      expect((await deactivate(withPan.token)).status).toBe(200);

      const answers = await Promise.all(
        Array.from({ length: 4 }, () => reactivate(withPan.vendorId)),
      );

      expect(answers.filter((res) => res.status === 200)).toHaveLength(1);
      const [event, ...more] = await events(withPan.vendorId, 'vendor.reactivated');
      expect(more).toEqual([]);
      expect(event).toMatchObject({
        topic: 'notifications.broadcast',
        payload: {
          vendor_id: withPan.vendorId,
          vendor_phone: (await vendorRow(withPan.vendorId)).phone,
          status: 'LIVE',
          reactivated_by_user_id: adminId,
        },
      });

      const noPan = await shop();
      expect((await deactivate(noPan.token)).status).toBe(200);
      expect((await reactivate(noPan.vendorId)).status).toBe(200);
      const [offline] = await events(noPan.vendorId, 'vendor.reactivated');
      expect(offline?.payload).toMatchObject({ status: 'SUSPENDED_COMPLIANCE' });

      // A shop that was never closed is refused, and nothing is announced.
      const live = await shop();
      expect((await reactivate(live.vendorId)).status).toBe(409);
      expect(await events(live.vendorId, 'vendor.reactivated')).toEqual([]);
    });
  });

  describe('vendor.compliance_restored', () => {
    const save = (token: string, taxId = '302118845') =>
      request(t.app)
        .put('/api/vendor/tax-identity')
        .set('authorization', token)
        .send({ tax_id: taxId, is_vat_registered: false });
    const events = (vendorId: string) =>
      db
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.aggregate_id, vendorId),
            eq(outboxEvents.event_type, 'vendor.compliance_restored'),
          ),
        );
    const sweep = (vendorId: string) =>
      db.execute(
        sql`UPDATE vendors SET status = 'SUSPENDED_COMPLIANCE', status_before_compliance_suspension = status
            WHERE id = ${vendorId}`,
      );

    it('is written when a saved PAN lifts the suspension, with the shop back LIVE', async () => {
      const { vendorId, token } = await shop();
      await sweep(vendorId);

      const res = await save(token);

      expect(bodyOf(taxIdentityResponseSchema, res)).toMatchObject({
        status: 'LIVE',
        compliance_suspension_lifted: true,
      });
      const [event, ...more] = await events(vendorId);
      expect(more).toEqual([]);
      expect(event).toMatchObject({
        topic: 'notifications.broadcast',
        published_at: null,
        payload: {
          vendor_id: vendorId,
          vendor_phone: (await vendorRow(vendorId)).phone,
          status: 'LIVE',
          waiting_invoices_issued: 0,
        },
      });
    });

    it('says the shop is still SUSPENDED when another suspension lies on top', async () => {
      const { vendorId, token } = await shop();
      await sweep(vendorId);
      await db
        .update(vendors)
        .set({ status: 'SUSPENDED', status_before_admin_suspension: 'SUSPENDED_COMPLIANCE' })
        .where(eq(vendors.id, vendorId));

      expect((await save(token)).status).toBe(200);

      const [event] = await events(vendorId);
      expect(event?.payload).toMatchObject({ status: 'SUSPENDED' });
      expect((await vendorRow(vendorId)).status).toBe('SUSPENDED');
    });

    it('is not written for a shop that was never suspended, a repeat, or a refused PAN', async () => {
      const never = await shop();
      expect((await save(never.token)).status).toBe(200);
      expect((await save(never.token, '609871234')).status).toBe(200);
      expect(await events(never.vendorId)).toEqual([]);

      const swept = await shop();
      await sweep(swept.vendorId);
      expect((await save(swept.token, '12345')).status).toBe(400);
      expect(await events(swept.vendorId)).toEqual([]);

      expect((await save(swept.token)).status).toBe(200);
      expect((await save(swept.token)).status).toBe(200);
      expect(await Promise.all(Array.from({ length: 4 }, () => save(swept.token)))).toHaveLength(4);
      expect(await events(swept.vendorId)).toHaveLength(1);
    });

    it('is never written by the admin’s verification, which lifts nothing', async () => {
      const { vendorId } = await shop();
      await db
        .update(vendors)
        .set({
          tax_id: '302118845',
          pan_document_url: `kyc/pan/${vendorId}/${randomUUID()}.webp`,
          status: 'SUSPENDED',
          status_before_compliance_suspension: 'LIVE',
        })
        .where(eq(vendors.id, vendorId));

      const res = await request(t.app)
        .post(`/api/admin/vendors/${vendorId}/pan-verification`)
        .set('authorization', admin);

      expect(res.status).toBe(200);
      expect((await vendorRow(vendorId)).status).toBe('SUSPENDED');
      expect(await events(vendorId)).toEqual([]);
    });
  });
});
