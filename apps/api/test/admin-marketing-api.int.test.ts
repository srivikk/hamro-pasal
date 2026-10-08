import { randomUUID } from 'node:crypto';

import {
  adProducts,
  auditLogs,
  campaignOptIns,
  categories,
  homePromotions,
  platformCampaigns,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import {
  adminAdProductListResponseSchema,
  adminAdProductResponseSchema,
  adminCampaignListResponseSchema,
  adminCampaignResponseSchema,
  adminPromotionListResponseSchema,
  adminPromotionResponseSchema,
  campaignOptInResponseSchema,
  type AdminCampaignView,
  type AdminPromotionView,
  type AdProductView,
} from '@hamro-pasal/shared-types';
import { asc, eq } from 'drizzle-orm';
import request from 'supertest';

import { createCategory, createUser, createVendor, vendorUserIdOf } from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * Phase 26: platform campaigns with the shop's own opt-in, the ad price list and the Home
 * promotions (SPEC core 7 and 8, SPEC verifications 6, 19 and 21), over HTTP on real PostgreSQL.
 */
describe('admin marketing API', () => {
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

  const entries = (entityId: string) =>
    db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entity_id, entityId))
      .orderBy(asc(auditLogs.occurred_at), asc(auditLogs.id));

  async function shop() {
    const vendorId = await createVendor(db);
    const userId = await vendorUserIdOf(db, vendorId);
    return { vendorId, userId, token: bearer(userId, 'VENDOR') };
  }

  // Campaigns -----------------------------------------------------------------------------

  const DAY = 24 * 60 * 60 * 1000;
  const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString();

  const campaignBody = (overrides: Record<string, unknown> = {}) => ({
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

  async function campaign(overrides: Record<string, unknown> = {}) {
    const body = campaignBody(overrides);
    const res = await call('post', '/api/admin/campaigns', admin, body);
    expect(res.status).toBe(201);
    return { body, view: bodyOf(adminCampaignResponseSchema, res).campaign };
  }

  const putCampaign = (id: string, body: unknown, token: string | null = admin) =>
    call('put', `/api/admin/campaigns/${id}`, token, body);

  const optIn = (token: string | null, campaignId: string, termsVersion = 1) =>
    call('post', `/api/vendor/campaigns/${campaignId}/opt-in`, token, {
      terms_version: termsVersion,
    });

  const optInRows = (campaignId: string) =>
    db
      .select()
      .from(campaignOptIns)
      .where(eq(campaignOptIns.campaign_id, campaignId))
      .orderBy(asc(campaignOptIns.opted_in_at));

  async function listedCampaign(id: string): Promise<AdminCampaignView> {
    const res = await call('get', '/api/admin/campaigns', admin);
    expect(res.status).toBe(200);
    const found = bodyOf(adminCampaignListResponseSchema, res).campaigns.find((c) => c.id === id);
    if (found === undefined) throw new Error('campaign not listed');
    return found;
  }

  describe('campaigns', () => {
    it('creates a campaign at terms version 1 with no shop in it, and audits it', async () => {
      const body = campaignBody({ name: '  Tihar Offer  ' });

      const res = await call('post', '/api/admin/campaigns', admin, body);

      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const view = bodyOf(adminCampaignResponseSchema, res).campaign;
      expect(view).toMatchObject({
        name: 'Tihar Offer',
        kind: 'PERCENTAGE',
        value: 10,
        max_discount_npr: 200,
        min_cart_npr: 500,
        vendor_share_percent: 50,
        terms_version: 1,
        is_active: true,
        opt_in_count: 0,
        starts_at: body.starts_at,
        ends_at: body.ends_at,
      });
      const [row] = await db
        .select()
        .from(platformCampaigns)
        .where(eq(platformCampaigns.id, view.id));
      expect(row?.created_by_user_id).toBe(adminId);
      expect(await entries(view.id)).toEqual([
        expect.objectContaining({
          action: 'CAMPAIGN_CREATED',
          actor_user_id: adminId,
          entity_type: 'platform_campaign',
          vendor_id: null,
          before_state: null,
          after_state: expect.objectContaining({
            name: 'Tihar Offer',
            terms_version: 1,
          }) as unknown,
          request_id: res.headers['x-request-id'],
        }),
      ]);
      expect(await listedCampaign(view.id)).toEqual(view);
    });

    it('takes no vendor, opt-in or version from an admin, and no malformed rule', async () => {
      const before = await db.select({ id: platformCampaigns.id }).from(platformCampaigns);
      for (const overrides of [
        { vendor_id: randomUUID() },
        { vendor_ids: [randomUUID()] },
        { opt_ins: [] },
        { terms_version: 5 },
        { value: 0 },
        { value: 101 },
        { kind: 'FLAT', value: 100 }, // a cap on a flat discount
        { max_discount_npr: 0 },
        { min_cart_npr: -1 },
        { vendor_share_percent: 100.5 },
        { ends_at: inDays(1) },
        { starts_at: '2026-10-10' },
        { name: '   ' },
      ]) {
        const res = await call('post', '/api/admin/campaigns', admin, campaignBody(overrides));
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
      expect(await db.select({ id: platformCampaigns.id }).from(platformCampaigns)).toHaveLength(
        before.length,
      );
      // A flat discount without a cap is fine.
      await campaign({ kind: 'FLAT', value: 150, max_discount_npr: null, vendor_share_percent: 0 });
    });

    it('has no admin route that enrols a shop', async () => {
      const { view } = await campaign();
      const { vendorId } = await shop();

      for (const path of [
        `/api/admin/campaigns/${view.id}/opt-in`,
        `/api/admin/campaigns/${view.id}/opt-ins`,
        `/api/admin/campaigns/${view.id}/vendors/${vendorId}`,
      ]) {
        const res = await call('post', path, admin, { vendor_id: vendorId, terms_version: 1 });
        expect(res.status).toBe(404);
      }
      // And an admin token is not a vendor on the vendor route.
      expect((await optIn(admin, view.id)).status).toBe(403);
      expect(await optInRows(view.id)).toEqual([]);
    });

    it('lets a shop’s own account opt in to the terms it was shown, and audits who and when', async () => {
      const { view, body } = await campaign();
      const { vendorId, userId, token } = await shop();

      const res = await optIn(token, view.id);

      expect(res.status).toBe(201);
      const joined = bodyOf(campaignOptInResponseSchema, res).opt_in;
      expect(joined).toMatchObject({
        campaign_id: view.id,
        vendor_id: vendorId,
        opt_in_terms_version: 1,
        status: 'ACTIVE',
        terms: {
          kind: 'PERCENTAGE',
          value: 10,
          max_discount_npr: 200,
          min_cart_npr: 500,
          vendor_share_percent: 50,
          starts_at: body.starts_at,
          ends_at: body.ends_at,
        },
      });
      const [row] = await optInRows(view.id);
      expect(row).toMatchObject({ opted_in_by_user_id: userId, status: 'ACTIVE' });
      expect(await entries(joined.id)).toEqual([
        expect.objectContaining({
          action: 'CAMPAIGN_OPTED_IN',
          actor_user_id: userId,
          actor_role: 'VENDOR',
          entity_type: 'campaign_opt_in',
          vendor_id: vendorId,
          before_state: null,
          after_state: expect.objectContaining({
            campaign_id: view.id,
            opt_in_terms_version: 1,
            opted_in_at: row?.opted_in_at.toISOString(),
          }) as unknown,
          request_id: res.headers['x-request-id'],
        }),
      ]);
      expect((await listedCampaign(view.id)).opt_in_count).toBe(1);

      // Asking again changes nothing: 200, the same opt-in, no second row or entry.
      const again = await optIn(token, view.id);
      expect(again.status).toBe(200);
      expect(bodyOf(campaignOptInResponseSchema, again).opt_in).toEqual(joined);
      expect(await optInRows(view.id)).toHaveLength(1);
      expect(await entries(joined.id)).toHaveLength(1);
    });

    it('refuses an opt-in whose terms version is not the current one', async () => {
      const { view, body } = await campaign();
      const { token } = await shop();
      expect((await putCampaign(view.id, { ...body, value: 15 })).status).toBe(200);

      const stale = await optIn(token, view.id, 1);

      expect(stale.status).toBe(409);
      expect(errorOf(stale)).toMatchObject({
        code: 'CAMPAIGN_TERMS_CHANGED',
        details: { terms_version: 2 },
      });
      // Not a version that does not exist yet, either.
      expect((await optIn(token, view.id, 3)).status).toBe(409);
      expect(await optInRows(view.id)).toEqual([]);

      const current = await optIn(token, view.id, 2);
      expect(current.status).toBe(201);
      expect(bodyOf(campaignOptInResponseSchema, current).opt_in).toMatchObject({
        opt_in_terms_version: 2,
        terms: { value: 15 },
      });
    });

    it.each([
      ['discount value', { value: 12 }],
      ['discount kind', { kind: 'FLAT', value: 100, max_discount_npr: null }],
      ['cap', { max_discount_npr: 300 }],
      ['minimum cart', { min_cart_npr: 800 }],
      ['vendor share', { vendor_share_percent: 40 }],
      ['start date', { starts_at: inDays(2) }],
      ['end date', { ends_at: inDays(14) }],
    ])('raises the version and voids every opt-in when the %s changes', async (_term, change) => {
      const { view, body } = await campaign();
      const first = await shop();
      const second = await shop();
      expect((await optIn(first.token, view.id)).status).toBe(201);
      expect((await optIn(second.token, view.id)).status).toBe(201);

      const res = await putCampaign(view.id, { ...body, ...change });

      expect(res.status).toBe(200);
      expect(bodyOf(adminCampaignResponseSchema, res).campaign).toMatchObject({
        terms_version: 2,
        opt_in_count: 0,
      });
      const rows = await optInRows(view.id);
      expect(rows.map((row) => row.status)).toEqual(['VOIDED', 'VOIDED']);
      expect(rows.every((row) => row.closed_at !== null && row.closed_by_user_id === null)).toBe(
        true,
      );
      expect((await entries(view.id)).at(-1)).toMatchObject({
        action: 'CAMPAIGN_TERMS_CHANGED',
        actor_user_id: adminId,
        before_state: { terms_version: 1 },
        after_state: { terms_version: 2, voided_opt_in_count: 2 },
      });
      // The shop sees the campaign again only by accepting the new terms.
      expect((await optIn(first.token, view.id, 2)).status).toBe(201);
      expect((await listedCampaign(view.id)).opt_in_count).toBe(1);
    });

    it('keeps the version and the opt-ins when it is renamed or unpublished', async () => {
      const { view, body } = await campaign();
      const { token } = await shop();
      expect((await optIn(token, view.id)).status).toBe(201);

      const res = await putCampaign(view.id, { ...body, name: 'Renamed', is_active: false });

      expect(res.status).toBe(200);
      expect(bodyOf(adminCampaignResponseSchema, res).campaign).toMatchObject({
        name: 'Renamed',
        is_active: false,
        terms_version: 1,
        opt_in_count: 1,
      });
      expect((await optInRows(view.id)).map((row) => row.status)).toEqual(['ACTIVE']);
      expect((await entries(view.id)).at(-1)).toMatchObject({ action: 'CAMPAIGN_UPDATED' });

      // Saving the same again records nothing.
      await putCampaign(view.id, { ...body, name: 'Renamed', is_active: false });
      expect(await entries(view.id)).toHaveLength(2);
    });

    it('does not let a request set the version, and answers 404 for an unknown campaign', async () => {
      const { view, body } = await campaign();

      const res = await putCampaign(view.id, { ...body, terms_version: 9 });
      expect(res.status).toBe(400);
      expect((await listedCampaign(view.id)).terms_version).toBe(1);

      const unknown = await putCampaign(randomUUID(), body);
      expect(unknown.status).toBe(404);
      expect(errorOf(unknown).code).toBe('CAMPAIGN_NOT_FOUND');
      expect((await putCampaign('not-a-uuid', body)).status).toBe(400);
    });

    it('hides an unpublished campaign from shops and refuses an ended one', async () => {
      const { token } = await shop();
      const hidden = await campaign({ is_active: false });
      const res = await optIn(token, hidden.view.id);
      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('CAMPAIGN_NOT_FOUND');
      expect((await optIn(token, randomUUID())).status).toBe(404);

      const over = await campaign();
      await db.execute(
        `ALTER TABLE platform_campaigns DISABLE TRIGGER platform_campaigns_terms_version`,
      );
      try {
        await db
          .update(platformCampaigns)
          .set({ starts_at: new Date(Date.now() - 2 * DAY), ends_at: new Date(Date.now() - DAY) })
          .where(eq(platformCampaigns.id, over.view.id));
      } finally {
        await db.execute(
          `ALTER TABLE platform_campaigns ENABLE TRIGGER platform_campaigns_terms_version`,
        );
      }
      const ended = await optIn(token, over.view.id);
      expect(ended.status).toBe(422);
      expect(errorOf(ended).code).toBe('CAMPAIGN_ENDED');
    });

    it('opts a shop in once when its request arrives five times at once', async () => {
      const { view } = await campaign();
      const { token } = await shop();

      const results = await Promise.all([1, 2, 3, 4, 5].map(() => optIn(token, view.id)));

      expect(results.map((res) => res.status).sort()).toEqual([200, 200, 200, 200, 201]);
      expect(await optInRows(view.id)).toHaveLength(1);
    });

    it('never leaves a live opt-in on old terms when an opt-in races a terms change', async () => {
      for (let round = 0; round < 5; round += 1) {
        const { view, body } = await campaign();
        const { token } = await shop();

        const [joined, changed] = await Promise.all([
          optIn(token, view.id),
          putCampaign(view.id, { ...body, vendor_share_percent: 60 }),
        ]);

        expect(changed.status).toBe(200);
        // Either the opt-in came first and was voided, or it came second and was refused.
        expect([201, 409]).toContain(joined.status);
        const live = (await optInRows(view.id)).filter((row) => row.status === 'ACTIVE');
        expect(live).toEqual([]);
        expect((await listedCampaign(view.id)).terms_version).toBe(2);
      }
    });

    it('refuses malformed opt-in bodies', async () => {
      const { view } = await campaign();
      const { token } = await shop();
      for (const body of [
        {},
        { terms_version: 0 },
        { terms_version: '1' },
        { terms_version: 1.5 },
        { terms_version: 1, vendor_id: randomUUID() },
        { opt_in_terms_version: 1 },
      ]) {
        const res = await call('post', `/api/vendor/campaigns/${view.id}/opt-in`, token, body);
        expect(res.status).toBe(400);
      }
      expect(await optInRows(view.id)).toEqual([]);
    });
  });

  // Ad products ---------------------------------------------------------------------------

  const adBody = (overrides: Record<string, unknown> = {}) => ({
    name: `Carousel ${randomUUID()}`,
    slot: 'CAROUSEL',
    billing_model: 'FLAT_RATE',
    price_npr: 5000,
    duration_days: 7,
    is_active: true,
    ...overrides,
  });

  async function adProduct(overrides: Record<string, unknown> = {}): Promise<AdProductView> {
    const res = await call('post', '/api/admin/ads/products', admin, adBody(overrides));
    expect(res.status).toBe(201);
    return bodyOf(adminAdProductResponseSchema, res).product;
  }

  const patchAd = (id: string, body: unknown, token: string | null = admin) =>
    call('patch', `/api/admin/ads/products/${id}`, token, body);

  describe('ad products', () => {
    it('publishes a price list entry that names no vendor, and audits it', async () => {
      const res = await call(
        'post',
        '/api/admin/ads/products',
        admin,
        adBody({ slot: 'FEED_LISTING', billing_model: 'PER_ORDER_PREMIUM', price_npr: 15.5 }),
      );

      expect(res.status).toBe(201);
      const product = bodyOf(adminAdProductResponseSchema, res).product;
      expect(product).toMatchObject({
        slot: 'FEED_LISTING',
        billing_model: 'PER_ORDER_PREMIUM',
        price_npr: 15.5,
        duration_days: 7,
        is_active: true,
        active_purchase_count: 0,
      });
      expect(await entries(product.id)).toEqual([
        expect.objectContaining({
          action: 'AD_PRODUCT_CREATED',
          actor_user_id: adminId,
          entity_type: 'ad_product',
          vendor_id: null,
          before_state: null,
          after_state: expect.objectContaining({
            price_npr: 15.5,
            slot: 'FEED_LISTING',
          }) as unknown,
        }),
      ]);
      const listed = bodyOf(
        adminAdProductListResponseSchema,
        await call('get', '/api/admin/ads/products', admin),
      ).products;
      expect(listed.find((p) => p.id === product.id)).toEqual(product);
    });

    it('refuses a vendor key, an unknown placement, a percentage and a bad price or duration', async () => {
      for (const overrides of [
        { vendor_id: randomUUID() },
        { slot: 'FEATURED' },
        { slot: 'SEARCH' },
        { billing_model: 'PERCENT_PREMIUM' },
        { price_npr: 0 },
        { price_npr: -5 },
        { price_npr: 10.005 },
        { duration_days: 0 },
        { duration_days: 91 },
        { duration_days: 7.5 },
        { name: '  ' },
        { price_percent: 5 },
      ]) {
        const res = await call('post', '/api/admin/ads/products', admin, adBody(overrides));
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
    });

    it.each([
      ['price', { price_npr: 4999 }],
      ['duration', { duration_days: 30 }],
      ['placement', { slot: 'FEED_LISTING' }],
      ['billing model', { billing_model: 'PER_ORDER_PREMIUM' }],
    ])('answers 400 for an attempt to change the %s, and changes nothing', async (_term, terms) => {
      const product = await adProduct();

      const res = await patchAd(product.id, { name: product.name, is_active: true, ...terms });

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      const [row] = await db.select().from(adProducts).where(eq(adProducts.id, product.id));
      expect(row).toMatchObject({
        slot: 'CAROUSEL',
        billing_model: 'FLAT_RATE',
        price_npr: 5000,
        duration_days: 7,
      });
      expect(await entries(product.id)).toHaveLength(1);
    });

    it('renames a product and takes it off sale, keeping its terms', async () => {
      const product = await adProduct();

      const res = await patchAd(product.id, { name: 'Carousel (retired price)', is_active: false });

      expect(res.status).toBe(200);
      expect(bodyOf(adminAdProductResponseSchema, res).product).toEqual({
        ...product,
        name: 'Carousel (retired price)',
        is_active: false,
      });
      expect((await entries(product.id)).at(-1)).toMatchObject({
        action: 'AD_PRODUCT_UPDATED',
        before_state: { is_active: true, price_npr: 5000 },
        after_state: { is_active: false, price_npr: 5000 },
      });
      // The same again records nothing; a new price is a new product.
      await patchAd(product.id, { name: 'Carousel (retired price)', is_active: false });
      expect(await entries(product.id)).toHaveLength(2);
      expect((await adProduct({ price_npr: 4500 })).id).not.toBe(product.id);
    });

    it('answers 404 for an unknown product and has no delete or replace route', async () => {
      const product = await adProduct();
      const unknown = await patchAd(randomUUID(), { name: 'x', is_active: true });
      expect(unknown.status).toBe(404);
      expect(errorOf(unknown).code).toBe('AD_PRODUCT_NOT_FOUND');
      expect((await patchAd(product.id, { name: 'only a name' })).status).toBe(400);
      expect((await call('delete', `/api/admin/ads/products/${product.id}`, admin)).status).toBe(
        404,
      );
      expect(
        (await call('put', `/api/admin/ads/products/${product.id}`, admin, adBody())).status,
      ).toBe(404);
    });
  });

  // Promotions ----------------------------------------------------------------------------

  const promotionBody = (overrides: Record<string, unknown> = {}) => ({
    placement: 'FEATURED',
    image_url: null,
    title: '10% OFF',
    subtitle: 'Selected shops',
    target_type: 'DISCOUNT_TAG',
    target_value: '10% OFF',
    display_order: 0,
    is_active: true,
    starts_at: null,
    ends_at: null,
    is_sponsored: false,
    ad_purchase_id: null,
    ...overrides,
  });

  const postPromotion = (body: unknown, token: string | null = admin) =>
    call('post', '/api/admin/promotions', token, body);

  async function promotion(overrides: Record<string, unknown> = {}): Promise<AdminPromotionView> {
    const res = await postPromotion(promotionBody(overrides));
    expect(res.status).toBe(201);
    return bodyOf(adminPromotionResponseSchema, res).promotion;
  }

  async function activeSlug(options: { isActive?: boolean; parentId?: string } = {}) {
    const id = await createCategory(db, options);
    const [row] = await db.select().from(categories).where(eq(categories.id, id));
    if (row === undefined) throw new Error('category not found');
    return { id, slug: row.slug };
  }

  describe('promotions', () => {
    it('creates a promotion for each target type, and one that is not tappable', async () => {
      const { vendorId } = await shop();
      const { slug } = await activeSlug();

      const banner = await postPromotion(
        promotionBody({
          placement: 'CAROUSEL',
          image_url: 'https://cdn.hamropasal.test/promotions/dashain.webp',
          title: null,
          subtitle: null,
          target_type: 'CATEGORY',
          target_value: slug,
          starts_at: inDays(1),
          ends_at: inDays(10),
        }),
      );
      expect(banner.status).toBe(201);
      expect(banner.headers['cache-control']).toBe('no-store');
      const view = bodyOf(adminPromotionResponseSchema, banner).promotion;
      expect(view).toMatchObject({
        placement: 'CAROUSEL',
        target_type: 'CATEGORY',
        target_value: slug,
        is_sponsored: false,
        ad_purchase_id: null,
      });
      expect(await entries(view.id)).toEqual([
        expect.objectContaining({
          action: 'PROMOTION_CREATED',
          actor_user_id: adminId,
          entity_type: 'home_promotion',
          before_state: null,
          after_state: expect.objectContaining({
            target_type: 'CATEGORY',
            target_value: slug,
          }) as unknown,
        }),
      ]);

      expect(await promotion({ target_type: 'SHOP', target_value: vendorId })).toMatchObject({
        target_type: 'SHOP',
        target_value: vendorId,
      });
      // A label is trimmed by nobody but checked for its length: exactly 40 characters is fine.
      const tag = 'x'.repeat(40);
      expect(await promotion({ target_value: tag })).toMatchObject({ target_value: tag });
      expect(await promotion({ target_type: null, target_value: null })).toMatchObject({
        target_type: null,
        target_value: null,
      });
    });

    it('fits the target value to its type', async () => {
      const { vendorId } = await shop();
      for (const overrides of [
        // DISCOUNT_TAG: a label of 1 to 40 characters.
        { target_value: 'x'.repeat(41) },
        { target_value: '   ' },
        { target_value: null },
        // SHOP: a uuid.
        { target_type: 'SHOP', target_value: 'thamel-kirana' },
        { target_type: 'SHOP', target_value: '10% OFF' },
        // CATEGORY: a slug.
        { target_type: 'CATEGORY', target_value: 'Festive Offers' },
        { target_type: 'CATEGORY', target_value: vendorId.toUpperCase() },
        { target_type: 'CATEGORY', target_value: 'festive_offers' },
        // A value without a type, and an unknown type.
        { target_type: null, target_value: 'festive' },
        { target_type: 'PRODUCT', target_value: vendorId },
        // The API's name for the field is target_value.
        { target_id: vendorId },
      ]) {
        const res = await postPromotion(promotionBody(overrides));
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
    });

    it('needs a live shop and an active category behind a well-formed target', async () => {
      const approved = await createVendor(db, { status: 'APPROVED' });
      const hidden = await activeSlug({ isActive: false });
      const hiddenParent = await activeSlug({ isActive: false });
      const child = await activeSlug({ parentId: hiddenParent.id });

      for (const [overrides, type] of [
        [{ target_type: 'SHOP', target_value: randomUUID() }, 'SHOP'],
        [{ target_type: 'SHOP', target_value: approved }, 'SHOP'],
        [{ target_type: 'CATEGORY', target_value: 'no-such-category' }, 'CATEGORY'],
        [{ target_type: 'CATEGORY', target_value: hidden.slug }, 'CATEGORY'],
        // Active itself, but under a hidden category: customers cannot reach it.
        [{ target_type: 'CATEGORY', target_value: child.slug }, 'CATEGORY'],
      ] as const) {
        const res = await postPromotion(promotionBody(overrides));
        expect(res.status).toBe(422);
        expect(errorOf(res)).toMatchObject({
          code: 'PROMOTION_TARGET_NOT_FOUND',
          details: { target_type: type },
        });
      }
    });

    it('needs an image for a banner, a title for an offer, and an end after the start', async () => {
      for (const overrides of [
        { placement: 'CAROUSEL', image_url: null },
        { title: null },
        { image_url: 'ftp://cdn.hamropasal.test/a.webp' },
        { image_url: 'not a url' },
        { starts_at: inDays(5), ends_at: inDays(5) },
        { display_order: -1 },
        { display_order: 1.5 },
        { discount_percent: 10 },
        { price_npr: 100 },
      ]) {
        const res = await postPromotion(promotionBody(overrides));
        expect(res.status).toBe(400);
      }
    });

    it('cannot be marked as an ad by an admin: no purchase, no sponsorship', async () => {
      const { vendorId } = await shop();
      const shopTarget = { target_type: 'SHOP', target_value: vendorId };

      // Sponsored without naming a purchase, and the reverse: the contract refuses both.
      for (const overrides of [
        { ...shopTarget, is_sponsored: true },
        { ...shopTarget, ad_purchase_id: randomUUID() },
      ]) {
        expect((await postPromotion(promotionBody(overrides))).status).toBe(400);
      }
      // Naming a purchase: none exists, because no vendor has bought one.
      const res = await postPromotion(
        promotionBody({ ...shopTarget, is_sponsored: true, ad_purchase_id: randomUUID() }),
      );
      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe('AD_PURCHASE_MISMATCH');

      const plain = await promotion(shopTarget);
      const edited = await call(
        'put',
        `/api/admin/promotions/${plain.id}`,
        admin,
        promotionBody({ ...shopTarget, is_sponsored: true, ad_purchase_id: randomUUID() }),
      );
      expect(edited.status).toBe(422);
      const [row] = await db.select().from(homePromotions).where(eq(homePromotions.id, plain.id));
      expect(row).toMatchObject({ is_sponsored: false, ad_purchase_id: null });
    });

    it('replaces every field on PUT, and audits the change', async () => {
      const { vendorId } = await shop();
      const created = await promotion({ subtitle: 'Old', display_order: 3 });

      const res = await call(
        'put',
        `/api/admin/promotions/${created.id}`,
        admin,
        promotionBody({
          title: 'New Road deals',
          subtitle: null,
          target_type: 'SHOP',
          target_value: vendorId,
          display_order: 1,
          is_active: false,
        }),
      );

      expect(res.status).toBe(200);
      expect(bodyOf(adminPromotionResponseSchema, res).promotion).toMatchObject({
        id: created.id,
        title: 'New Road deals',
        subtitle: null,
        target_type: 'SHOP',
        target_value: vendorId,
        display_order: 1,
        is_active: false,
      });
      expect((await entries(created.id)).at(-1)).toMatchObject({
        action: 'PROMOTION_UPDATED',
        before_state: { title: '10% OFF', target_type: 'DISCOUNT_TAG', display_order: 3 },
        after_state: { title: 'New Road deals', target_type: 'SHOP', display_order: 1 },
      });
      // The target is re-checked on every write.
      await db.update(vendors).set({ status: 'APPROVED' }).where(eq(vendors.id, vendorId));
      const dead = await call(
        'put',
        `/api/admin/promotions/${created.id}`,
        admin,
        promotionBody({ target_type: 'SHOP', target_value: vendorId }),
      );
      expect(dead.status).toBe(422);
    });

    it('lists every promotion, hidden ones included: the carousel first, each by its order', async () => {
      const tag = randomUUID().slice(0, 8);
      const image = 'https://cdn.hamropasal.test/promotions/a.webp';
      const later = await promotion({ title: `${tag} later`, display_order: 9 });
      const first = await promotion({ title: `${tag} first`, display_order: 2, is_active: false });
      const banner = await promotion({
        placement: 'CAROUSEL',
        image_url: image,
        title: `${tag} banner`,
        display_order: 50,
      });

      const res = await call('get', '/api/admin/promotions', admin);

      expect(res.status).toBe(200);
      const mine = bodyOf(adminPromotionListResponseSchema, res).promotions.filter((p) =>
        p.title?.startsWith(tag),
      );
      expect(mine.map((p) => p.id)).toEqual([banner.id, first.id, later.id]);
      expect(mine[1]?.is_active).toBe(false);
    });

    it('deletes a promotion and keeps what it was in the audit trail', async () => {
      const created = await promotion();

      const res = await call('delete', `/api/admin/promotions/${created.id}`, admin);

      expect(res.status).toBe(204);
      expect(
        await db.select().from(homePromotions).where(eq(homePromotions.id, created.id)),
      ).toEqual([]);
      expect((await entries(created.id)).map((entry) => entry.action)).toEqual([
        'PROMOTION_CREATED',
        'PROMOTION_DELETED',
      ]);
      expect((await entries(created.id)).at(-1)).toMatchObject({
        before_state: { title: '10% OFF', target_value: '10% OFF' },
        after_state: { deleted: true },
      });
      const again = await call('delete', `/api/admin/promotions/${created.id}`, admin);
      expect(again.status).toBe(404);
      expect(errorOf(again).code).toBe('PROMOTION_NOT_FOUND');
      expect(
        (await call('put', `/api/admin/promotions/${created.id}`, admin, promotionBody())).status,
      ).toBe(404);
    });
  });

  it('serves Super Admins only on the admin routes, and vendors only on the opt-in', async () => {
    const { view, body } = await campaign();
    const product = await adProduct();
    const created = await promotion();
    const { token: vendor } = await shop();
    const others = [
      vendor,
      bearer(await createUser(db), 'CUSTOMER'),
      bearer(await createUser(db, 'DRIVER'), 'DRIVER'),
    ];
    const adminCalls = [
      (as: string | null) => call('get', '/api/admin/campaigns', as),
      (as: string | null) => call('post', '/api/admin/campaigns', as, campaignBody()),
      (as: string | null) => putCampaign(view.id, { ...body, value: 99 }, as),
      (as: string | null) => call('get', '/api/admin/ads/products', as),
      (as: string | null) => call('post', '/api/admin/ads/products', as, adBody()),
      (as: string | null) => patchAd(product.id, { name: 'x', is_active: false }, as),
      (as: string | null) => call('get', '/api/admin/promotions', as),
      (as: string | null) => postPromotion(promotionBody(), as),
      (as: string | null) => call('delete', `/api/admin/promotions/${created.id}`, as),
    ];
    for (const adminCall of adminCalls) {
      expect((await adminCall(null)).status).toBe(401);
      for (const as of others) {
        const res = await adminCall(as);
        expect(res.status).toBe(403);
        expect(errorOf(res).code).toBe('FORBIDDEN');
      }
    }
    expect((await listedCampaign(view.id)).terms_version).toBe(1);

    expect((await optIn(null, view.id)).status).toBe(401);
    for (const as of [admin, others[1] ?? '', others[2] ?? '']) {
      expect((await optIn(as, view.id)).status).toBe(403);
    }
    // A vendor account without a shop has nothing to opt in.
    const shopless = bearer(await createUser(db, 'VENDOR'), 'VENDOR');
    expect((await optIn(shopless, view.id)).status).toBe(404);
  });
});
