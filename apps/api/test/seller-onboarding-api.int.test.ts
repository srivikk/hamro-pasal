import { randomInt } from 'node:crypto';

import {
  auditLogs,
  outboxEvents,
  platformSettings,
  pricingPlans,
  userRoles,
  users,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import {
  adminVendorCreatedResponseSchema,
  authTokensResponseSchema,
  feedResponseSchema,
  roleNotGrantedDetailsSchema,
  sellerSignupOptionsResponseSchema,
  sellerSignupResponseSchema,
  sellerApplicationResponseSchema,
  tokenRefreshResponseSchema,
  tutorialListResponseSchema,
  tutorialResponseSchema,
} from '@hamro-pasal/shared-types';
import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import request from 'supertest';

import { verifyAccessToken } from '../src/auth/access-token';
import { createCategory, createProduct, createUser, createVendor } from './support/fixtures';
import { ACCESS_SECRET, bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

const phone = () => `+9779${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;

const SHOP = {
  business_name: 'Thamel Kirana Pasal',
  municipality_palika_string: 'Kathmandu Metropolitan City',
  location: { lat: 27.7154, lng: 85.3123 },
};

/**
 * Step 7.7 / 7.8 (SPEC core 11, verification 32): one account with several roles, Seller app
 * signup, admin onboarding and approval, and the tutorial videos. Real Express + PostgreSQL.
 */
describe('Seller onboarding and tutorials', () => {
  let t: TestApp;
  let db: Database;
  let admin: string;
  let verifierId: string;

  beforeAll(async () => {
    // No resend cooldown: these tests sign the same number in several times in a row.
    t = buildTestApp({ otpOptions: { cooldownMs: 50 } });
    db = t.container.db;
    verifierId = await createUser(db, 'SUPER_ADMIN');
    admin = bearer(verifierId, 'SUPER_ADMIN');
    // A LIVE shop takes the default Commission plan; other suites may have published one already.
    const [existing] = await db
      .select({ id: pricingPlans.id })
      .from(pricingPlans)
      .where(eq(pricingPlans.is_default, true));
    if (existing === undefined) {
      await db.insert(pricingPlans).values({
        name: `Default Commission ${String(randomInt(0, 1_000_000))}`,
        model: 'COMMISSION',
        commission_rate: 10,
        is_default: true,
        created_by_user_id: verifierId,
      });
    }
  });

  afterAll(async () => {
    await t.container.close();
  });

  function codeSentTo(number: string): string {
    const message = t.sms.sent.filter((m) => m.to === number).at(-1);
    const code = /\b([0-9]{6})\b/.exec(message?.text ?? '')?.[1];
    if (code === undefined) throw new Error(`No OTP SMS to ${number}`);
    return code;
  }

  async function signIn(number: string, app?: 'CUSTOMER' | 'SELLER') {
    await new Promise((resolve) => setTimeout(resolve, 60));
    const sent = await request(t.app).post('/api/auth/otp/send').send({ phone: number });
    expect(sent.status).toBe(200);
    return request(t.app)
      .post('/api/auth/otp/verify')
      .send({ phone: number, code: codeSentTo(number), ...(app === undefined ? {} : { app }) });
  }

  const roleOf = (accessToken: string) => verifyAccessToken(accessToken, ACCESS_SECRET).role;

  async function signupToken(number: string): Promise<string> {
    const res = await signIn(number, 'SELLER');
    expect(res.status).toBe(403);
    expect(errorOf(res).code).toBe('ROLE_NOT_GRANTED');
    return roleNotGrantedDetailsSchema.parse(errorOf(res).details).signup_token;
  }

  async function signUp(number: string) {
    const res = await request(t.app)
      .post('/api/seller/signup')
      .send({ signup_token: await signupToken(number), ...SHOP });
    expect(res.status).toBe(201);
    return res;
  }

  describe('one account, several roles', () => {
    it('lets a customer become a seller with the same number, each app with its own role', async () => {
      const number = phone();
      const customer = bodyOf(authTokensResponseSchema, await signIn(number, 'CUSTOMER'));
      expect(customer.user).toMatchObject({ role: 'CUSTOMER', roles: ['CUSTOMER'] });

      const res = await signUp(number);
      const seller = bodyOf(sellerSignupResponseSchema, res);
      expect(roleOf(seller.access_token)).toBe('VENDOR');
      expect(seller.user.id).toBe(customer.user.id);
      expect([...(seller.user.roles ?? [])].sort()).toEqual(['CUSTOMER', 'VENDOR']);
      const [shop] = await db.select().from(vendors).where(eq(vendors.user_id, customer.user.id));
      expect(shop).toMatchObject({
        status: 'SANDBOXED',
        business_name: SHOP.business_name,
        phone: number,
      });

      // Each app signs the same number in with its own role.
      const again = bodyOf(authTokensResponseSchema, await signIn(number, 'SELLER'));
      expect(roleOf(again.access_token)).toBe('VENDOR');
      const shopping = bodyOf(authTokensResponseSchema, await signIn(number, 'CUSTOMER'));
      expect(roleOf(shopping.access_token)).toBe('CUSTOMER');

      // A refresh keeps the role the session signed in with.
      const refreshed = bodyOf(
        tokenRefreshResponseSchema,
        await request(t.app)
          .post('/api/auth/token/refresh')
          .send({ refresh_token: again.refresh_token }),
      );
      expect(roleOf(refreshed.access_token)).toBe('VENDOR');
    });

    it('gives a vendor-only account the customer role in the customer app', async () => {
      const vendorId = await createVendor(db);
      const [shop] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
      const [owner] = await db
        .select()
        .from(users)
        .where(eq(users.id, shop?.user_id ?? ''));
      const res = bodyOf(authTokensResponseSchema, await signIn(owner?.phone ?? '', 'CUSTOMER'));

      expect(roleOf(res.access_token)).toBe('CUSTOMER');
      expect([...(res.user.roles ?? [])].sort()).toEqual(['CUSTOMER', 'VENDOR']);
      // Without an app (the web, older apps), the primary role as before.
      expect(
        roleOf(bodyOf(authTokensResponseSchema, await signIn(owner?.phone ?? '')).access_token),
      ).toBe('VENDOR');
    });

    it('ends a refresh whose role the account no longer holds', async () => {
      const number = phone();
      const seller = bodyOf(sellerSignupResponseSchema, await signUp(number));
      await db
        .delete(userRoles)
        .where(and(eq(userRoles.user_id, seller.user.id), eq(userRoles.role, 'VENDOR')));
      const res = await request(t.app)
        .post('/api/auth/token/refresh')
        .send({ refresh_token: seller.refresh_token });
      expect(res.status).toBe(401);
    });

    it('refuses a forged or reused-as-access signup token, and a second shop', async () => {
      const bad = await request(t.app)
        .post('/api/seller/signup')
        .send({ signup_token: 'not-a-token', ...SHOP });
      expect(bad.status).toBe(401);
      expect(errorOf(bad).code).toBe('INVALID_SIGNUP_TOKEN');

      const number = phone();
      const token = await signupToken(number);
      expect(
        (
          await request(t.app)
            .post('/api/seller/signup')
            .send({ signup_token: token, ...SHOP })
        ).status,
      ).toBe(201);
      const twice = await request(t.app)
        .post('/api/seller/signup')
        .send({ signup_token: token, ...SHOP });
      expect(twice.status).toBe(409);
      expect(errorOf(twice).code).toBe('ALREADY_A_SELLER');
    });
  });

  describe('self-signup', () => {
    it('is audited, announced, and shows what the application still needs', async () => {
      const number = phone();
      const res = await signUp(number);
      const seller = bodyOf(sellerSignupResponseSchema, res);
      const [shop] = await db.select().from(vendors).where(eq(vendors.user_id, seller.user.id));
      const vendorId = shop?.id ?? '';

      expect(
        await db
          .select()
          .from(auditLogs)
          .where(and(eq(auditLogs.action, 'VENDOR_SIGNED_UP'), eq(auditLogs.entity_id, vendorId))),
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(outboxEvents)
          .where(
            and(
              eq(outboxEvents.event_type, 'vendor.signed_up'),
              eq(outboxEvents.aggregate_id, vendorId),
            ),
          ),
      ).toHaveLength(1);

      const application = bodyOf(
        sellerApplicationResponseSchema,
        await request(t.app)
          .get('/api/seller/application')
          .set('authorization', `Bearer ${seller.access_token}`),
      ).application;
      expect(application).toMatchObject({
        status: 'SANDBOXED',
        pan_document_uploaded: false,
        citizenship_document_uploaded: false,
        ready_for_review: false,
      });
      expect(application.vendor_code).toMatch(/^HPV-\d{5,}$/);
    });
  });

  describe('delivery modes at signup follow the platform switches (2026-10-20)', () => {
    const setModes = (self: boolean, fleet: boolean) =>
      db
        .update(platformSettings)
        .set({ self_delivery_enabled: self, platform_fleet_enabled: fleet });

    afterEach(async () => {
      await setModes(true, true);
    });

    const options = async () => {
      const res = await request(t.app).get('/api/seller/signup-options');
      expect(res.status).toBe(200);
      return bodyOf(sellerSignupOptionsResponseSchema, res);
    };

    const signupWith = async (number: string, fulfillmentMode?: string) =>
      request(t.app)
        .post('/api/seller/signup')
        .send({
          signup_token: await signupToken(number),
          ...SHOP,
          ...(fulfillmentMode === undefined ? {} : { fulfillment_mode: fulfillmentMode }),
        });

    /** Nothing was created for the number: no shop, no vendor role. */
    const nothingFor = async (number: string) => {
      const [user] = await db.select().from(users).where(eq(users.phone, number));
      if (user === undefined) throw new Error('account missing');
      expect(await db.select().from(vendors).where(eq(vendors.user_id, user.id))).toEqual([]);
      expect(
        await db
          .select()
          .from(userRoles)
          .where(and(eq(userRoles.user_id, user.id), eq(userRoles.role, 'VENDOR'))),
      ).toEqual([]);
    };

    it('tells the app, without a token, which modes a new shop may choose', async () => {
      expect(await options()).toEqual({
        self_delivery_enabled: true,
        platform_fleet_enabled: true,
        signups_open: true,
      });
      await setModes(false, true);
      expect(await options()).toEqual({
        self_delivery_enabled: false,
        platform_fleet_enabled: true,
        signups_open: true,
      });
      await setModes(false, false);
      expect((await options()).signups_open).toBe(false);
    });

    it('refuses a mode switched off platform-wide with 422, creating nothing, and takes the other', async () => {
      await setModes(false, true);
      const number = phone();

      const refused = await signupWith(number, 'SELF_DELIVERY');

      expect(refused.status).toBe(422);
      expect(errorOf(refused)).toMatchObject({
        code: 'DELIVERY_MODE_DISABLED',
        details: { fulfillment_mode: 'SELF_DELIVERY' },
      });
      await nothingFor(number);

      const accepted = await signupWith(number, 'PLATFORM_FLEET');
      expect(accepted.status).toBe(201);
      const [shop] = await db
        .select({ mode: vendors.fulfillment_mode })
        .from(vendors)
        .where(eq(vendors.id, bodyOf(sellerSignupResponseSchema, accepted).application.vendor_id));
      expect(shop?.mode).toBe('PLATFORM_FLEET');
    });

    it('refuses the default mode (self delivery) too when it is off', async () => {
      await setModes(false, true);
      const number = phone();

      const refused = await signupWith(number);

      expect(refused.status).toBe(422);
      expect(errorOf(refused).code).toBe('DELIVERY_MODE_DISABLED');
      await nothingFor(number);
    });

    it('refuses riders when only riders are off', async () => {
      await setModes(true, false);
      const number = phone();

      const refused = await signupWith(number, 'PLATFORM_FLEET');

      expect(refused.status).toBe(422);
      expect(errorOf(refused).details).toEqual({ fulfillment_mode: 'PLATFORM_FLEET' });
      await nothingFor(number);
    });

    it('pauses registrations with 409 while both modes are off, and reopens them after', async () => {
      await setModes(false, false);
      const number = phone();

      for (const mode of ['SELF_DELIVERY', 'PLATFORM_FLEET']) {
        const paused = await signupWith(number, mode);
        expect(paused.status).toBe(409);
        expect(errorOf(paused)).toMatchObject({
          code: 'SELLER_SIGNUPS_PAUSED',
          message: 'New shop registrations are currently paused',
        });
      }
      await nothingFor(number);

      await setModes(true, false);
      expect((await signupWith(number, 'SELF_DELIVERY')).status).toBe(201);
    });
  });

  describe('admin onboarding and approval', () => {
    it('makes a shop with a verified PAN LIVE at once', async () => {
      const { vendorId } = await shopWithKyc();
      await db
        .update(vendors)
        .set({ pan_verified_at: new Date(), pan_verified_by_user_id: verifierId })
        .where(eq(vendors.id, vendorId));

      const res = await request(t.app)
        .post(`/api/admin/vendors/${vendorId}/approve`)
        .set('authorization', admin);

      expect(res.body).toEqual({ vendor_id: vendorId, status: 'LIVE' });
      const [shop] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
      expect(shop?.status_before_compliance_suspension).toBeNull();
    });

    it('gives a shop created without a plan the default Commission plan when it is approved', async () => {
      const { vendorId } = await shopWithKyc();
      await db
        .update(vendors)
        .set({ pricing_model: null, pricing_plan_id: null, commission_rate: 0 })
        .where(eq(vendors.id, vendorId));
      const [plan] = await db.select().from(pricingPlans).where(eq(pricingPlans.is_default, true));

      const res = await request(t.app)
        .post(`/api/admin/vendors/${vendorId}/approve`)
        .set('authorization', admin);

      expect(res.status).toBe(200);
      const [shop] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
      expect(shop).toMatchObject({ pricing_model: 'COMMISSION', pricing_plan_id: plan?.id });
    });

    it('refuses with 409 DEFAULT_PLAN_REQUIRED, changing nothing, while no default plan is published', async () => {
      const { vendorId } = await shopWithKyc();
      await db
        .update(vendors)
        .set({ pricing_model: null, pricing_plan_id: null, commission_rate: 0 })
        .where(eq(vendors.id, vendorId));
      const [plan] = await db.select().from(pricingPlans).where(eq(pricingPlans.is_default, true));
      await db
        .update(pricingPlans)
        .set({ is_default: false })
        .where(eq(pricingPlans.is_default, true));
      try {
        const res = await request(t.app)
          .post(`/api/admin/vendors/${vendorId}/approve`)
          .set('authorization', admin);

        expect(res.status).toBe(409);
        expect(errorOf(res).code).toBe('DEFAULT_PLAN_REQUIRED');
        const [shop] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
        expect(shop?.status).toBe('SANDBOXED');
      } finally {
        if (plan !== undefined) {
          await db
            .update(pricingPlans)
            .set({ is_default: true })
            .where(eq(pricingPlans.id, plan.id));
        }
      }
    });

    it('approves a shop left APPROVED by the earlier rule, which nothing took further', async () => {
      const { vendorId } = await shopWithKyc();
      await db.update(vendors).set({ status: 'APPROVED' }).where(eq(vendors.id, vendorId));

      const res = await request(t.app)
        .post(`/api/admin/vendors/${vendorId}/approve`)
        .set('authorization', admin);

      expect(res.body).toEqual({ vendor_id: vendorId, status: 'SUSPENDED_COMPLIANCE' });
    });

    /**
     * The state reported on 2026-10-20: approved by the admin, switched Online, national delivery,
     * one active product in stock in an active root category. It must reach the customer feed,
     * here asked from a Palika far from the shop, once its PAN is verified.
     */
    it('lists an approved, online, national shop with one product in the feed, wherever the customer is', async () => {
      const { seller, vendorId } = await shopWithKyc({ delivery_scope: 'NATION_WIDE' });
      const electronics = await createCategory(db, { name: 'Electronics' });
      await createProduct(db, vendorId, 5, 2500, { name: 'Headphone', category_id: electronics });
      const online = await request(t.app)
        .put('/api/vendor/availability')
        .set('authorization', `Bearer ${seller.access_token}`)
        .send({ mode: 'OPEN' });
      expect(online.status).toBe(200);

      // From Pokhara, with a Palika: a national shop delivers anywhere in Nepal.
      const feed = async () =>
        bodyOf(
          feedResponseSchema,
          await request(t.app).get('/api/vendors').query({
            lat: '28.2096',
            lng: '83.9856',
            municipality_palika_string: 'Pokhara Metropolitan City',
          }),
        );
      const listed = async () =>
        (await feed()).serviceable.find((entry) => entry.vendor.id === vendorId);

      const approve = await request(t.app)
        .post(`/api/admin/vendors/${vendorId}/approve`)
        .set('authorization', admin);
      expect(approve.status).toBe(200);
      // Not yet: the PAN is saved but not verified (SPEC core 10).
      expect(await listed()).toBeUndefined();

      const verify = await request(t.app)
        .post(`/api/admin/vendors/${vendorId}/pan-verification`)
        .set('authorization', admin);
      expect(verify.status).toBe(200);

      const entry = await listed();
      expect(entry).toMatchObject({ serviceable: true, vendor: { delivery_scope: 'NATION_WIDE' } });
      const [shop] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
      expect(shop?.status).toBe('LIVE');
    });

    it('creates the shop and its account, invites by SMS, and the owner signs in with the number', async () => {
      const number = phone();
      const res = await request(t.app)
        .post('/api/admin/vendors')
        .set('authorization', admin)
        .send({ phone: number, ...SHOP });

      expect(res.status).toBe(201);
      const created = bodyOf(adminVendorCreatedResponseSchema, res);
      expect(created).toMatchObject({
        status: 'SANDBOXED',
        account_created: true,
        invite_sent: true,
      });
      const invite = t.sms.sent.filter((m) => m.to === number).at(-1);
      expect(invite?.text).toContain(created.vendor_code);
      expect(invite?.text).toMatch(/Seller app/);

      const session = bodyOf(authTokensResponseSchema, await signIn(number, 'SELLER'));
      expect(roleOf(session.access_token)).toBe('VENDOR');
      expect(session.user.id).toBe(created.user_id);
    });

    it('adds a shop to an existing customer account instead of a second account', async () => {
      const userId = await createUser(db);
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      const res = await request(t.app)
        .post('/api/admin/vendors')
        .set('authorization', admin)
        .send({ phone: user?.phone, ...SHOP, status: 'APPROVED' });

      // "Approved" by the admin is LIVE through the PAN gate: no verified PAN yet, so it waits.
      expect(bodyOf(adminVendorCreatedResponseSchema, res)).toMatchObject({
        user_id: userId,
        status: 'SUSPENDED_COMPLIANCE',
        account_created: false,
      });
      const [shop] = await db.select().from(vendors).where(eq(vendors.user_id, userId));
      expect(shop?.status_before_compliance_suspension).toBe('LIVE');
      const [primary] = await db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, userId));
      expect(primary?.role).toBe('CUSTOMER');
    });

    /** A self-signed-up shop with every KYC document in (the PAN saved, not yet verified). */
    async function shopWithKyc(scope: Record<string, unknown> = {}) {
      const number = phone();
      const res = await request(t.app)
        .post('/api/seller/signup')
        .send({ signup_token: await signupToken(number), ...SHOP, ...scope });
      expect(res.status).toBe(201);
      const seller = bodyOf(sellerSignupResponseSchema, res);
      const [shop] = await db.select().from(vendors).where(eq(vendors.user_id, seller.user.id));
      const vendorId = shop?.id ?? '';
      await db
        .update(vendors)
        .set({
          citizenship_document_url: `kyc/citizenship/${vendorId}/${vendorId}.jpg`,
          pan_document_url: `kyc/pan/${vendorId}/${vendorId}.jpg`,
          tax_id: '302118845',
        })
        .where(eq(vendors.id, vendorId));
      return { seller, vendorId };
    }

    it('approves a SANDBOXED shop only once its KYC documents are in', async () => {
      const number = phone();
      const seller = bodyOf(sellerSignupResponseSchema, await signUp(number));
      const [shop] = await db.select().from(vendors).where(eq(vendors.user_id, seller.user.id));
      const vendorId = shop?.id ?? '';
      const approve = () =>
        request(t.app).post(`/api/admin/vendors/${vendorId}/approve`).set('authorization', admin);

      const early = await approve();
      expect(early.status).toBe(422);
      expect(errorOf(early)).toMatchObject({
        code: 'KYC_INCOMPLETE',
        details: { missing: ['PAN_DOCUMENT', 'CITIZENSHIP_DOCUMENT', 'TAX_ID'] },
      });

      const jpeg = await sharp({
        create: { width: 64, height: 64, channels: 3, background: '#c33' },
      })
        .jpeg()
        .toBuffer();
      const upload = await request(t.app)
        .post('/api/vendor/kyc/citizenship-document')
        .set('authorization', `Bearer ${seller.access_token}`)
        .attach('document', jpeg, { filename: 'citizenship.jpg', contentType: 'image/jpeg' });
      expect(upload.status).toBe(200);
      expect(
        bodyOf(sellerApplicationResponseSchema, upload).application.citizenship_document_uploaded,
      ).toBe(true);
      await db
        .update(vendors)
        .set({ pan_document_url: `kyc/pan/${vendorId}/${vendorId}.jpg`, tax_id: '302118845' })
        .where(eq(vendors.id, vendorId));

      const ok = await approve();
      expect(ok.status).toBe(200);
      // Approval takes the shop LIVE through the PAN gate (decided 2026-10-20): unverified, it
      // waits offline in SUSPENDED_COMPLIANCE, remembering LIVE.
      expect(ok.body).toEqual({ vendor_id: vendorId, status: 'SUSPENDED_COMPLIANCE' });
      const [approved] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
      expect(approved?.status_before_compliance_suspension).toBe('LIVE');
      expect((await approve()).status).toBe(409);
      expect(
        (
          await request(t.app)
            .post(`/api/admin/vendors/${vendorId}/approve`)
            .set('authorization', `Bearer ${seller.access_token}`)
        ).status,
      ).toBe(403);
    });
  });

  describe('tutorials', () => {
    it('are managed by a Super Admin and listed per app, active ones in order', async () => {
      const create = (body: object) =>
        request(t.app).post('/api/admin/tutorials').set('authorization', admin).send(body);
      const first = bodyOf(
        tutorialResponseSchema,
        await create({
          app: 'SELLER',
          youtube_video_id: 'dQw4w9WgXcQ',
          title: 'Add a product',
          display_order: 2,
        }),
      ).tutorial;
      const second = bodyOf(
        tutorialResponseSchema,
        await create({
          app: 'SELLER',
          youtube_video_id: 'aBcDeFgHiJ_',
          title: 'Accept an order',
          display_order: 1,
        }),
      ).tutorial;
      await create({ app: 'CUSTOMER', youtube_video_id: 'zYxWvUtSrQ-', title: 'Place an order' });

      const list = async (app: string) =>
        bodyOf(
          tutorialListResponseSchema,
          await request(t.app).get('/api/tutorials').query({ app }),
        ).tutorials;
      const seller = (await list('SELLER')).filter((v) => [first.id, second.id].includes(v.id));
      expect(seller.map((v) => v.title)).toEqual(['Accept an order', 'Add a product']);

      await request(t.app)
        .put(`/api/admin/tutorials/${first.id}`)
        .set('authorization', admin)
        .send({
          app: 'SELLER',
          youtube_video_id: 'dQw4w9WgXcQ',
          title: 'Add a product',
          is_active: false,
        });
      expect((await list('SELLER')).map((v) => v.id)).not.toContain(first.id);

      expect(
        (
          await request(t.app)
            .delete(`/api/admin/tutorials/${second.id}`)
            .set('authorization', admin)
        ).status,
      ).toBe(204);
      expect((await list('SELLER')).map((v) => v.id)).not.toContain(second.id);
      expect(
        await db.select().from(auditLogs).where(eq(auditLogs.entity_id, first.id)),
      ).toHaveLength(2);
    });

    it('refuses something that is not a YouTube video id, and a caller who is not an admin', async () => {
      expect(
        (
          await request(t.app)
            .post('/api/admin/tutorials')
            .set('authorization', admin)
            .send({ app: 'CUSTOMER', youtube_video_id: 'https://youtu.be/x', title: 'Bad' })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(t.app)
            .post('/api/admin/tutorials')
            .set('authorization', bearer(await createUser(db)))
            .send({ app: 'CUSTOMER', youtube_video_id: 'dQw4w9WgXcQ', title: 'Nope' })
        ).status,
      ).toBe(403);
      expect((await request(t.app).get('/api/tutorials').query({ app: 'DRIVER' })).status).toBe(
        400,
      );
    });
  });
});
