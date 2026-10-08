import { randomUUID } from 'node:crypto';

import { auditLogs, pricingPlans, vendors, type Database } from '@hamro-pasal/db';
import {
  adminPricingPlanListResponseSchema,
  adminPricingPlanResponseSchema,
  type PricingPlanView,
} from '@hamro-pasal/shared-types';
import { asc, eq } from 'drizzle-orm';
import request from 'supertest';

import { createUser, createVendor } from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * Phase 26: the pricing plans a Super Admin offers (SPEC core 4, SPEC verification 21): immutable
 * terms and exactly one default, on real PostgreSQL. Other suites insert plans into the shared
 * database too, so the tests assert on their own plans and on the table-wide invariant.
 */
describe('admin pricing plans API', () => {
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

  const name = (label: string) => `${label} ${randomUUID()}`;

  const commission = (overrides: Record<string, unknown> = {}) => ({
    name: name('Commission'),
    model: 'COMMISSION',
    commission_rate: 10,
    monthly_fee_npr: 0,
    duration_cycles: null,
    is_offered: true,
    is_default: false,
    ...overrides,
  });

  const post = (body: unknown, token: string | null = admin) => {
    const req = request(t.app).post('/api/admin/pricing-plans');
    return (token === null ? req : req.set('Authorization', token)).send(body as object);
  };

  const patch = (id: string, body: unknown, token: string | null = admin) => {
    const req = request(t.app).patch(`/api/admin/pricing-plans/${id}`);
    return (token === null ? req : req.set('Authorization', token)).send(body as object);
  };

  const list = (token: string | null = admin) => {
    const req = request(t.app).get('/api/admin/pricing-plans');
    return token === null ? req : req.set('Authorization', token);
  };

  async function created(body: Record<string, unknown>): Promise<PricingPlanView> {
    const res = await post(body);
    expect(res.status).toBe(201);
    return bodyOf(adminPricingPlanResponseSchema, res).plan;
  }

  async function plans(): Promise<PricingPlanView[]> {
    const res = await list();
    expect(res.status).toBe(200);
    return bodyOf(adminPricingPlanListResponseSchema, res).plans;
  }

  const defaults = async () => (await plans()).filter((plan) => plan.is_default);

  const planRow = async (id: string) => {
    const [row] = await db.select().from(pricingPlans).where(eq(pricingPlans.id, id));
    if (row === undefined) throw new Error('plan not found');
    return row;
  };

  const entries = (planId: string) =>
    db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entity_id, planId))
      .orderBy(asc(auditLogs.occurred_at), asc(auditLogs.id));

  /** Makes sure the table has a default, so a test may create ordinary plans. */
  async function ensureDefault(): Promise<PricingPlanView> {
    const [current] = await defaults();
    return current ?? created(commission({ is_default: true }));
  }

  describe('POST /api/admin/pricing-plans', () => {
    it('needs the first plan to be the default, then keeps exactly one', async () => {
      await db
        .update(pricingPlans)
        .set({ is_default: false })
        .where(eq(pricingPlans.is_default, true));

      const noDefault = await post(commission());
      expect(noDefault.status).toBe(409);
      expect(errorOf(noDefault).code).toBe('DEFAULT_PLAN_REQUIRED');

      const first = await created(commission({ is_default: true }));
      expect(first).toMatchObject({ is_default: true, is_offered: true, vendor_count: 0 });
      expect((await defaults()).map((plan) => plan.id)).toEqual([first.id]);
    });

    it('stores each model with its own terms, and audits the creation', async () => {
      await ensureDefault();
      const res = await post(commission({ name: '  Standard 12%  ', commission_rate: 12 }));

      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const plan = bodyOf(adminPricingPlanResponseSchema, res).plan;
      expect(plan).toMatchObject({
        name: 'Standard 12%',
        model: 'COMMISSION',
        commission_rate: 12,
        monthly_fee_npr: 0,
        duration_cycles: null,
        is_offered: true,
        is_default: false,
        vendor_count: 0,
      });
      expect((await planRow(plan.id)).created_by_user_id).toBe(adminId);
      expect(await entries(plan.id)).toEqual([
        expect.objectContaining({
          action: 'PRICING_PLAN_CREATED',
          actor_user_id: adminId,
          actor_role: 'SUPER_ADMIN',
          entity_type: 'pricing_plan',
          vendor_id: null,
          before_state: null,
          after_state: {
            name: 'Standard 12%',
            model: 'COMMISSION',
            commission_rate: 12,
            monthly_fee_npr: 0,
            duration_cycles: null,
            is_offered: true,
            is_default: false,
          },
          request_id: res.headers['x-request-id'],
        }),
      ]);
      await db.execute(`DELETE FROM pricing_plans WHERE id = '${plan.id}'`);

      const subscription = await created({
        name: name('Subscription'),
        model: 'SUBSCRIPTION',
        commission_rate: 0,
        monthly_fee_npr: 1500,
        duration_cycles: null,
        is_offered: true,
        is_default: false,
      });
      expect(subscription).toMatchObject({ model: 'SUBSCRIPTION', monthly_fee_npr: 1500 });
      const free = await created({
        name: name('Free'),
        model: 'FREE',
        commission_rate: 0,
        monthly_fee_npr: 0,
        duration_cycles: 3,
        is_offered: false,
        is_default: false,
      });
      expect(free).toMatchObject({ model: 'FREE', duration_cycles: 3, is_offered: false });
    });

    it('moves the default to a new default plan in the same transaction', async () => {
      const previous = await ensureDefault();

      const next = await created(commission({ is_default: true }));

      expect((await defaults()).map((plan) => plan.id)).toEqual([next.id]);
      expect(await planRow(previous.id)).toMatchObject({ is_default: false, is_offered: true });
      // The plan that lost the default has its own entry.
      expect((await entries(previous.id)).at(-1)).toMatchObject({
        action: 'PRICING_PLAN_UPDATED',
        actor_user_id: adminId,
        before_state: { is_default: true },
        after_state: { is_default: false },
      });
    });

    it('refuses terms that do not belong to the model', async () => {
      await ensureDefault();
      const before = (await plans()).length;
      for (const body of [
        commission({ commission_rate: 0 }),
        commission({ commission_rate: 100.01 }),
        commission({ monthly_fee_npr: 500 }),
        commission({ duration_cycles: 3 }),
        commission({ name: '   ' }),
        commission({ name: 'x'.repeat(81) }),
        commission({ model: 'FLAT' }),
        commission({ vendor_id: randomUUID() }),
        { ...commission(), model: 'SUBSCRIPTION', commission_rate: 0, monthly_fee_npr: 0 },
        { ...commission(), model: 'SUBSCRIPTION', commission_rate: 5, monthly_fee_npr: 1500 },
        { ...commission(), model: 'FREE', commission_rate: 0 },
        { ...commission(), model: 'FREE', commission_rate: 0, duration_cycles: 0 },
        { ...commission(), model: 'FREE', commission_rate: 0, duration_cycles: 37 },
        // Only an offered Commission plan can be the default.
        commission({ is_default: true, is_offered: false }),
        {
          ...commission({ is_default: true }),
          model: 'SUBSCRIPTION',
          commission_rate: 0,
          monthly_fee_npr: 1500,
        },
      ]) {
        const res = await post(body);
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
      expect(await plans()).toHaveLength(before);
    });

    it('keeps names unique without regard to case', async () => {
      await ensureDefault();
      const planName = name('Unique');
      await created(commission({ name: planName }));

      const res = await post(commission({ name: planName.toUpperCase() }));

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('PRICING_PLAN_NAME_TAKEN');
    });

    it('keeps one default when five default plans are created at once', async () => {
      await ensureDefault();

      const results = await Promise.all(
        [1, 2, 3, 4, 5].map(() => post(commission({ is_default: true }))),
      );

      expect(results.map((res) => res.status)).toEqual([201, 201, 201, 201, 201]);
      expect(await defaults()).toHaveLength(1);
    });
  });

  describe('PATCH /api/admin/pricing-plans/:id', () => {
    const edit = (plan: PricingPlanView, overrides: Record<string, unknown> = {}) => ({
      name: plan.name,
      is_offered: plan.is_offered,
      is_default: plan.is_default,
      ...overrides,
    });

    it('renames and withdraws a plan, auditing the change, and never touches its terms', async () => {
      await ensureDefault();
      const plan = await created(commission({ commission_rate: 8.5 }));
      const renamed = name('Renamed');

      const res = await patch(plan.id, edit(plan, { name: renamed, is_offered: false }));

      expect(res.status).toBe(200);
      expect(bodyOf(adminPricingPlanResponseSchema, res).plan).toMatchObject({
        id: plan.id,
        name: renamed,
        is_offered: false,
        is_default: false,
        model: 'COMMISSION',
        commission_rate: 8.5,
      });
      expect((await entries(plan.id)).map((entry) => entry.action)).toEqual([
        'PRICING_PLAN_CREATED',
        'PRICING_PLAN_UPDATED',
      ]);
      expect((await entries(plan.id)).at(-1)).toMatchObject({
        before_state: { name: plan.name, is_offered: true, commission_rate: 8.5 },
        after_state: { name: renamed, is_offered: false, commission_rate: 8.5 },
      });
    });

    it.each([
      ['model', { model: 'SUBSCRIPTION' }],
      ['commission rate', { commission_rate: 5 }],
      ['monthly fee', { monthly_fee_npr: 999 }],
      ['duration', { duration_cycles: 6 }],
    ])('answers 400 for an attempt to change the %s, and changes nothing', async (_term, terms) => {
      await ensureDefault();
      const plan = await created(commission());
      const before = await planRow(plan.id);

      const res = await patch(plan.id, edit(plan, terms));

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      expect(await planRow(plan.id)).toEqual(before);
      expect(await entries(plan.id)).toHaveLength(1);
    });

    it('makes a plan the default and takes it from the previous one', async () => {
      const previous = await ensureDefault();
      const plan = await created(commission());

      const res = await patch(plan.id, edit(plan, { is_default: true }));

      expect(res.status).toBe(200);
      expect(bodyOf(adminPricingPlanResponseSchema, res).plan.is_default).toBe(true);
      expect((await defaults()).map((p) => p.id)).toEqual([plan.id]);
      expect((await planRow(previous.id)).is_default).toBe(false);
      expect((await entries(previous.id)).at(-1)).toMatchObject({
        action: 'PRICING_PLAN_UPDATED',
        after_state: { is_default: false },
      });
    });

    it('never leaves the table without a default', async () => {
      await ensureDefault();
      const current = await created(commission({ is_default: true }));

      // Switched off directly.
      const off = await patch(current.id, edit(current, { is_default: false }));
      expect(off.status).toBe(409);
      expect(errorOf(off).code).toBe('DEFAULT_PLAN_REQUIRED');
      // Withdrawn while still the default: refused by the contract itself.
      const withdrawn = await patch(current.id, edit(current, { is_offered: false }));
      expect(withdrawn.status).toBe(400);
      // Withdrawn and un-defaulted in one go.
      const both = await patch(current.id, {
        ...edit(current),
        is_offered: false,
        is_default: false,
      });
      expect(both.status).toBe(409);
      expect(errorOf(both).code).toBe('DEFAULT_PLAN_REQUIRED');

      expect((await defaults()).map((plan) => plan.id)).toEqual([current.id]);
      expect(await planRow(current.id)).toMatchObject({ is_default: true, is_offered: true });
      // It can still be renamed.
      expect((await patch(current.id, edit(current, { name: name('Default') }))).status).toBe(200);
    });

    it('lets only a Commission plan become the default', async () => {
      const current = await ensureDefault();
      const subscription = await created({
        name: name('Subscription'),
        model: 'SUBSCRIPTION',
        commission_rate: 0,
        monthly_fee_npr: 1500,
        duration_cycles: null,
        is_offered: true,
        is_default: false,
      });

      const res = await patch(subscription.id, edit(subscription, { is_default: true }));

      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe('DEFAULT_PLAN_NOT_COMMISSION');
      expect((await defaults()).map((plan) => plan.id)).toEqual([current.id]);
      // A withdrawn Commission plan cannot be it either.
      const withdrawn = await created(commission({ is_offered: false }));
      expect((await patch(withdrawn.id, edit(withdrawn, { is_default: true }))).status).toBe(400);
    });

    it('keeps one default when several plans are made the default at once', async () => {
      await ensureDefault();
      const candidates = await Promise.all([1, 2, 3, 4].map(() => created(commission())));

      const results = await Promise.all(
        candidates.map((plan) => patch(plan.id, edit(plan, { is_default: true }))),
      );

      expect(results.map((res) => res.status)).toEqual([200, 200, 200, 200]);
      const now = await defaults();
      expect(now).toHaveLength(1);
      expect(candidates.map((plan) => plan.id)).toContain(now[0]?.id);
    });

    it('changes and records nothing when the stored values are saved again', async () => {
      await ensureDefault();
      const plan = await created(commission());

      const res = await patch(plan.id, edit(plan));

      expect(res.status).toBe(200);
      expect(bodyOf(adminPricingPlanResponseSchema, res).plan).toEqual(plan);
      expect(await entries(plan.id)).toHaveLength(1);
    });

    it('refuses a taken name, a partial body, an unknown plan and a malformed id', async () => {
      await ensureDefault();
      const plan = await created(commission());
      const other = await created(commission());

      const taken = await patch(plan.id, edit(plan, { name: other.name.toLowerCase() }));
      expect(taken.status).toBe(409);
      expect(errorOf(taken).code).toBe('PRICING_PLAN_NAME_TAKEN');
      // Its own name in another case is not a clash.
      expect((await patch(plan.id, edit(plan, { name: plan.name.toUpperCase() }))).status).toBe(
        200,
      );

      expect((await patch(plan.id, { name: 'Only a name' })).status).toBe(400);
      const unknown = await patch(randomUUID(), edit(plan, { name: name('Ghost') }));
      expect(unknown.status).toBe(404);
      expect(errorOf(unknown).code).toBe('PRICING_PLAN_NOT_FOUND');
      expect((await patch('not-a-uuid', edit(plan))).status).toBe(400);
    });
  });

  describe('GET /api/admin/pricing-plans', () => {
    it('lists every plan by name, withdrawn ones included, with the vendors on each', async () => {
      await ensureDefault();
      const used = await created(commission({ name: name('AAA used') }));
      const withdrawn = await created(
        commission({ name: name('AAB withdrawn'), is_offered: false }),
      );
      for (let i = 0; i < 2; i += 1) {
        const vendorId = await createVendor(db);
        await db.update(vendors).set({ pricing_plan_id: used.id }).where(eq(vendors.id, vendorId));
      }

      const res = await list();

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const all = bodyOf(adminPricingPlanListResponseSchema, res).plans;
      expect(all.find((plan) => plan.id === used.id)).toMatchObject({ vendor_count: 2 });
      expect(all.find((plan) => plan.id === withdrawn.id)).toMatchObject({
        is_offered: false,
        vendor_count: 0,
      });
      const names = all.map((plan) => plan.name.toLowerCase());
      expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
      expect(all.filter((plan) => plan.is_default)).toHaveLength(1);
    });

    it('has no route that deletes a plan or replaces its terms', async () => {
      await ensureDefault();
      const plan = await created(commission());

      for (const call of [
        request(t.app).delete(`/api/admin/pricing-plans/${plan.id}`),
        request(t.app).put(`/api/admin/pricing-plans/${plan.id}`).send(commission()),
      ]) {
        const res = await call.set('Authorization', admin);
        expect(res.status).toBe(404);
        expect(errorOf(res).code).toBe('NOT_FOUND');
      }
      expect(await planRow(plan.id)).toMatchObject({ commission_rate: 10 });
    });
  });

  it('serves Super Admins only', async () => {
    const plan = await ensureDefault();
    const vendorId = await createVendor(db);
    const [vendor] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
    const tokens = [
      bearer(vendor?.user_id ?? '', 'VENDOR'),
      bearer(await createUser(db), 'CUSTOMER'),
      bearer(await createUser(db, 'DRIVER'), 'DRIVER'),
    ];
    const calls = [
      (token: string | null) => list(token),
      (token: string | null) => post(commission(), token),
      (token: string | null) =>
        patch(plan.id, { name: 'x', is_offered: true, is_default: true }, token),
    ];
    for (const call of calls) {
      expect((await call(null)).status).toBe(401);
      for (const token of tokens) {
        const res = await call(token);
        expect(res.status).toBe(403);
        expect(errorOf(res).code).toBe('FORBIDDEN');
      }
    }
  });
});
