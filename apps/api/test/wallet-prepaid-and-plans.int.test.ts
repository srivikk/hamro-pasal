import { randomInt, randomUUID } from 'node:crypto';

import {
  auditLogs,
  ledgerAccounts,
  orders,
  platformSettings,
  pricingPlans,
  vendorGatewayAccounts,
  vendorSettingChanges,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import {
  adminPlanAssignResponseSchema,
  billingChangeResponseSchema,
  cartQuoteResponseSchema,
  checkoutResponseSchema,
  customerWalletViewSchema,
  esewaInitiateResponseSchema,
  gatewayAccountListResponseSchema,
  gatewayAccountResponseSchema,
  paymentStatusResponseSchema,
  vendorBillingViewSchema,
  walletRechargeConfirmResponseSchema,
  walletRechargeInitiateResponseSchema,
  type PaymentMethod,
  type SettlementModel,
} from '@hamro-pasal/shared-types';
import { and, desc, eq } from 'drizzle-orm';
import request from 'supertest';

import {
  balanceOf,
  createProduct,
  createUser,
  createVendor,
  DELIVERY_ADDRESS,
  stockOf,
  vendorUserIdOf,
  verifiedPanColumns,
} from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, esewaCallback, type TestApp } from './support/http';

/**
 * 2026-10-21 (SPEC core 4, 5, 9 and 12) on real Express + PostgreSQL + Redis: the customer's
 * stored-value wallet, settlement Model C with the shop's own merchant account and Fixed Reserve,
 * a shop's eSewa recharge, Subscription-only self-selection and the Super Admin's plan assignment.
 */
describe('wallets, Model C and pricing plans', () => {
  let t: TestApp;
  let db: Database;
  let adminId: string;

  beforeAll(async () => {
    t = buildTestApp();
    db = t.container.db;
    adminId = await createUser(db, 'SUPER_ADMIN');
  });

  afterAll(async () => {
    await t.container.close();
  });

  const walletBalance = async (customerId: string) =>
    (
      await db
        .select({ balance: ledgerAccounts.balance_npr })
        .from(ledgerAccounts)
        .where(eq(ledgerAccounts.customer_user_id, customerId))
    )[0]?.balance ?? 0;

  const shopOf = async (vendorId: string) => {
    const [shop] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
    if (shop === undefined) throw new Error('no shop');
    return shop;
  };

  /** Recharges a customer's wallet through the real initiate + signed eSewa confirmation. */
  async function recharge(customerId: string, amount: number) {
    const started = bodyOf(
      walletRechargeInitiateResponseSchema,
      await request(t.app)
        .post('/api/wallet/recharge/esewa/initiate')
        .set('authorization', bearer(customerId))
        .send({ idempotency_key: randomUUID(), amount_npr: amount }),
    );
    const uuid = started.fields.transaction_uuid ?? '';
    return request(t.app)
      .post('/api/wallet/recharge/esewa/confirm')
      .set('authorization', bearer(customerId))
      .send({ data: esewaCallback({ transaction_uuid: uuid, total_amount: String(amount) }) });
  }

  /** Recharges a shop's ledger the same way (VENDOR). */
  async function rechargeShop(vendorUserId: string, amount: number) {
    const started = bodyOf(
      walletRechargeInitiateResponseSchema,
      await request(t.app)
        .post('/api/vendors/wallet/recharge/esewa/initiate')
        .set('authorization', bearer(vendorUserId, 'VENDOR'))
        .send({ idempotency_key: randomUUID(), amount_npr: amount }),
    );
    const res = await request(t.app)
      .post('/api/vendors/wallet/recharge/esewa/confirm')
      .set('authorization', bearer(vendorUserId, 'VENDOR'))
      .send({
        data: esewaCallback({
          transaction_uuid: started.fields.transaction_uuid ?? '',
          total_amount: String(amount),
        }),
      });
    return bodyOf(walletRechargeConfirmResponseSchema, res);
  }

  async function setup(model: SettlementModel = 'PLATFORM_ESCROW', commission = 0.1) {
    const customerId = await createUser(db);
    const vendorId = await createVendor(db, { baseDeliveryFee: 50 });
    await db
      .update(vendors)
      .set({ settlement_model: model, commission_rate: commission })
      .where(eq(vendors.id, vendorId));
    const vendorUserId = await vendorUserIdOf(db, vendorId);
    const productId = await createProduct(db, vendorId, 10, 500);
    return { customerId, vendorId, vendorUserId, productId };
  }
  type Setup = Awaited<ReturnType<typeof setup>>;

  const cartOf = (s: Setup, quantity = 2) => ({
    vendor_id: s.vendorId,
    items: [{ product_id: s.productId, quantity }],
    delivery_address: DELIVERY_ADDRESS,
  });

  const quote = async (s: Setup) =>
    bodyOf(
      cartQuoteResponseSchema,
      await request(t.app)
        .post('/api/cart/quote')
        .set('authorization', bearer(s.customerId))
        .send(cartOf(s)),
    ).payment_options;

  const checkout = (s: Setup, paymentMethod: PaymentMethod, quantity = 2) =>
    request(t.app)
      .post('/api/cart/checkout')
      .set('authorization', bearer(s.customerId))
      .send({
        ...cartOf(s, quantity),
        idempotency_key: randomUUID(),
        payment_method: paymentMethod,
      });

  /** Puts a shop's ledger at an exact balance through a balanced recharge from the gateway. */
  async function fundShop(s: Setup, amount: number) {
    const confirmed = await rechargeShop(s.vendorUserId, amount);
    expect(confirmed.credited).toBe(true);
  }

  describe('the customer wallet', () => {
    it('is recharged through eSewa once, from the gateway clearing account', async () => {
      const customerId = await createUser(db);
      const clearingBefore = await balanceOf(db, 'GATEWAY_CLEARING:ESEWA');
      const started = bodyOf(
        walletRechargeInitiateResponseSchema,
        await request(t.app)
          .post('/api/wallet/recharge/esewa/initiate')
          .set('authorization', bearer(customerId))
          .send({ idempotency_key: randomUUID(), amount_npr: 1500 }),
      );
      expect(started.recharge.status).toBe('PENDING');
      expect(started.fields).toMatchObject({ total_amount: '1500', product_code: 'EPAYTEST' });

      const data = esewaCallback({
        transaction_uuid: started.fields.transaction_uuid ?? '',
        total_amount: '1500',
      });
      const first = bodyOf(
        walletRechargeConfirmResponseSchema,
        await request(t.app)
          .post('/api/wallet/recharge/esewa/confirm')
          .set('authorization', bearer(customerId))
          .send({ data }),
      );
      expect(first).toMatchObject({ credited: true, balance_npr: 1500 });
      expect(first.recharge.status).toBe('COMPLETED');
      // Five repeats at once credit nothing more.
      const repeats = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(t.app)
            .post('/api/wallet/recharge/esewa/confirm')
            .set('authorization', bearer(customerId))
            .send({ data }),
        ),
      );
      for (const repeat of repeats) {
        expect(bodyOf(walletRechargeConfirmResponseSchema, repeat).credited).toBe(false);
      }
      expect(await walletBalance(customerId)).toBe(1500);
      expect(await balanceOf(db, 'GATEWAY_CLEARING:ESEWA')).toBe((clearingBefore ?? 0) - 1500);

      const view = bodyOf(
        customerWalletViewSchema,
        await request(t.app).get('/api/wallet').set('authorization', bearer(customerId)),
      );
      expect(view.balance_npr).toBe(1500);
      expect(view.entries).toMatchObject([{ kind: 'RECHARGE', amount_npr: 1500, order_id: null }]);
    });

    it('refuses a forged confirmation and another customer', async () => {
      const customerId = await createUser(db);
      const started = bodyOf(
        walletRechargeInitiateResponseSchema,
        await request(t.app)
          .post('/api/wallet/recharge/esewa/initiate')
          .set('authorization', bearer(customerId))
          .send({ idempotency_key: randomUUID(), amount_npr: 100 }),
      );
      const uuid = started.fields.transaction_uuid ?? '';
      const forged = await request(t.app)
        .post('/api/wallet/recharge/esewa/confirm')
        .set('authorization', bearer(customerId))
        .send({
          data: esewaCallback({ transaction_uuid: uuid, total_amount: '100' }, 'wrong-key'),
        });
      expect(forged.status).toBe(400);
      const someoneElse = await request(t.app)
        .post('/api/wallet/recharge/esewa/confirm')
        .set('authorization', bearer(await createUser(db)))
        .send({ data: esewaCallback({ transaction_uuid: uuid, total_amount: '100' }) });
      expect(someoneElse.status).toBe(404);
      const short = await request(t.app)
        .post('/api/wallet/recharge/esewa/confirm')
        .set('authorization', bearer(customerId))
        .send({ data: esewaCallback({ transaction_uuid: uuid, total_amount: '99' }) });
      expect(short.status).toBe(409);
      expect(await walletBalance(customerId)).toBe(0);
    });

    it('keeps an idempotency key to its amount and caps the balance', async () => {
      const customerId = await createUser(db);
      const key = randomUUID();
      const send = (amount: number, k = key) =>
        request(t.app)
          .post('/api/wallet/recharge/esewa/initiate')
          .set('authorization', bearer(customerId))
          .send({ idempotency_key: k, amount_npr: amount });
      expect((await send(200)).status).toBe(201);
      expect((await send(200)).status).toBe(200);
      expect(errorOf(await send(300))).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      for (let i = 0; i < 4; i++) expect((await recharge(customerId, 25_000)).status).toBe(200);
      expect(errorOf(await send(1, randomUUID()))).toMatchObject({ code: 'WALLET_BALANCE_LIMIT' });
    });

    it('pays a Model B order into escrow, at once, and places it', async () => {
      const s = await setup();
      await recharge(s.customerId, 2000);
      expect((await quote(s)).find((o) => o.method === 'WALLET')).toEqual({
        method: 'WALLET',
        available: true,
      });
      const escrowBefore = (await balanceOf(db, 'SYSTEM_ESCROW')) ?? 0;

      const res = await checkout(s, 'WALLET');
      expect(res.status).toBe(201);
      const { order } = bodyOf(checkoutResponseSchema, res);
      expect(order).toMatchObject({ state: 'PLACED', payment_status: 'PAID', total_npr: 1050 });
      expect(await walletBalance(s.customerId)).toBe(950);
      expect(await balanceOf(db, 'SYSTEM_ESCROW')).toBe(escrowBefore + 1050);
      expect(await stockOf(db, s.productId)).toBe(8);
    });

    it('refuses an order the wallet cannot cover, creating nothing', async () => {
      const s = await setup();
      await recharge(s.customerId, 1000);
      expect((await quote(s)).find((o) => o.method === 'WALLET')).toEqual({
        method: 'WALLET',
        available: false,
        reason: 'INSUFFICIENT_WALLET_BALANCE',
      });
      const refused = await checkout(s, 'WALLET');
      expect(refused.status).toBe(422);
      expect(errorOf(refused).code).toBe('INSUFFICIENT_WALLET_BALANCE');
      expect(await db.select().from(orders).where(eq(orders.vendor_id, s.vendorId))).toEqual([]);
      expect(await stockOf(db, s.productId)).toBe(10);
      expect(await walletBalance(s.customerId)).toBe(1000);
    });

    it('never overdraws a wallet when two checkouts race', async () => {
      const s = await setup();
      await recharge(s.customerId, 1500);
      const results = await Promise.all([checkout(s, 'WALLET'), checkout(s, 'WALLET')]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
      expect(await walletBalance(s.customerId)).toBe(450);
      expect(await stockOf(db, s.productId)).toBe(8);
    });

    it('refunds a cancelled wallet order to the wallet at once (no refund owed)', async () => {
      const s = await setup();
      await recharge(s.customerId, 2000);
      const { order } = bodyOf(checkoutResponseSchema, await checkout(s, 'WALLET'));
      const cancelled = await request(t.app)
        .post(`/api/orders/${order.id}/cancel`)
        .set('authorization', bearer(s.customerId));
      expect(cancelled.status).toBe(200);
      expect(cancelled.body).toMatchObject({ state: 'CANCELED', refund_required: false });
      expect(await walletBalance(s.customerId)).toBe(2000);
      expect(await stockOf(db, s.productId)).toBe(10);
    });

    it('is not offered by a shop that takes cash only', async () => {
      const s = await setup();
      await db
        .update(vendors)
        .set({ accepted_payment_methods: ['COD'] })
        .where(eq(vendors.id, s.vendorId));
      expect((await quote(s)).find((o) => o.method === 'WALLET')?.reason).toBe(
        'NOT_ACCEPTED_BY_SHOP',
      );
    });
  });

  describe('a shop ledger recharge', () => {
    it('credits the shop wallet from the gateway clearing account', async () => {
      const s = await setup();
      const clearingBefore = (await balanceOf(db, 'GATEWAY_CLEARING:ESEWA')) ?? 0;
      const confirmed = await rechargeShop(s.vendorUserId, 750);
      expect(confirmed).toMatchObject({ credited: true, balance_npr: 750 });
      expect((await shopOf(s.vendorId)).wallet_balance_npr).toBe(750);
      expect(await balanceOf(db, 'GATEWAY_CLEARING:ESEWA')).toBe(clearingBefore - 750);
      // A customer cannot use the shop route, nor a vendor the customer one.
      const customerTried = await request(t.app)
        .post('/api/vendors/wallet/recharge/esewa/initiate')
        .set('authorization', bearer(s.customerId))
        .send({ idempotency_key: randomUUID(), amount_npr: 10 });
      expect(customerTried.status).toBe(403);
    });
  });

  describe('Model C (direct prepaid)', () => {
    const merchant = () => `HP${String(randomInt(0, 1_000_000_000))}`;

    async function prepaidShop(balance: number, commission = 0.1) {
      const s = await setup('PLATFORM_ESCROW', commission);
      if (balance > 0) await fundShop(s, balance);
      // A verified PAN, so a lifted suspension lands on LIVE (the PAN gate, SPEC core 10).
      await db
        .update(vendors)
        .set({
          settlement_model: 'DIRECT_PREPAID',
          tax_id: '123456789',
          ...(await verifiedPanColumns(db)),
        })
        .where(eq(vendors.id, s.vendorId));
      return s;
    }

    async function saveAccount(
      s: Setup,
      gateway: 'ESEWA' | 'KHALTI',
      code: string,
      secret: string,
    ) {
      const res = await request(t.app)
        .put(`/api/vendor/gateway-accounts/${gateway}`)
        .set('authorization', bearer(s.vendorUserId, 'VENDOR'))
        .send({ merchant_code: code, secret_key: secret });
      return bodyOf(gatewayAccountResponseSchema, res).account;
    }

    const verify = (s: Setup, gateway: 'ESEWA' | 'KHALTI') =>
      request(t.app)
        .post(`/api/admin/vendors/${s.vendorId}/gateway-accounts/${gateway}/verify`)
        .set('authorization', bearer(adminId, 'SUPER_ADMIN'));

    it('can be requested, and is approved only at the Fixed Reserve', async () => {
      const s = await setup();
      const requested = await request(t.app)
        .post('/api/vendor/ledger/settlement-model')
        .set('authorization', bearer(s.vendorUserId, 'VENDOR'))
        .send({ model: 'DIRECT_PREPAID' });
      expect(requested.status).toBe(201);
      const requestId = (requested.body as { request: { id: string } }).request.id;
      const approve = () =>
        request(t.app)
          .post(`/api/admin/settlement-model-requests/${requestId}/approve`)
          .set('authorization', bearer(adminId, 'SUPER_ADMIN'));
      const blocked = await approve();
      expect(blocked.status).toBe(409);
      expect(errorOf(blocked).details).toEqual({ blockers: ['BELOW_PREPAID_RESERVE'] });

      await fundShop(s, 5000);
      expect((await approve()).status).toBe(200);
      expect((await shopOf(s.vendorId)).settlement_model).toBe('DIRECT_PREPAID');
    });

    it('stores a merchant secret sealed, never shows it, and audits without it', async () => {
      const s = await prepaidShop(6000);
      const code = merchant();
      const account = await saveAccount(s, 'ESEWA', code, 'super-secret-key-1234');
      expect(account).toMatchObject({ gateway: 'ESEWA', merchant_code: code, secret_hint: '1234' });
      expect(account.verified_at).toBeNull();
      const [row] = await db
        .select()
        .from(vendorGatewayAccounts)
        .where(eq(vendorGatewayAccounts.vendor_id, s.vendorId));
      expect(row?.secret_ciphertext.toString('utf8')).not.toContain('super-secret');
      const listed = bodyOf(
        gatewayAccountListResponseSchema,
        await request(t.app)
          .get('/api/vendor/gateway-accounts')
          .set('authorization', bearer(s.vendorUserId, 'VENDOR')),
      );
      expect(JSON.stringify(listed)).not.toContain('super-secret');
      const entries = await db
        .select()
        .from(auditLogs)
        .where(
          and(eq(auditLogs.vendor_id, s.vendorId), eq(auditLogs.action, 'GATEWAY_ACCOUNT_SAVED')),
        );
      expect(JSON.stringify(entries)).not.toContain('super-secret');

      // Another shop cannot take the same merchant account.
      const other = await prepaidShop(6000);
      const taken = await request(t.app)
        .put('/api/vendor/gateway-accounts/ESEWA')
        .set('authorization', bearer(other.vendorUserId, 'VENDOR'))
        .send({ merchant_code: code, secret_key: 'another-secret-5678' });
      expect(taken.status).toBe(409);
    });

    it('offers a gateway only once the Super Admin verified the shop account; a change clears it', async () => {
      const s = await prepaidShop(6000);
      await saveAccount(s, 'ESEWA', merchant(), 'merchant-secret-aaaa');
      expect((await quote(s)).find((o) => o.method === 'ESEWA')?.reason).toBe(
        'GATEWAY_NOT_VERIFIED',
      );
      expect((await verify(s, 'ESEWA')).status).toBe(200);
      expect((await quote(s)).find((o) => o.method === 'ESEWA')).toEqual({
        method: 'ESEWA',
        available: true,
      });
      await saveAccount(s, 'ESEWA', merchant(), 'merchant-secret-bbbb');
      expect((await quote(s)).find((o) => o.method === 'ESEWA')?.reason).toBe(
        'GATEWAY_NOT_VERIFIED',
      );
    });

    it('debits the fee from the prepaid balance as a cash order is placed', async () => {
      const s = await prepaidShop(6000);
      const revenueBefore = (await balanceOf(db, 'PLATFORM_REVENUE')) ?? 0;
      const res = await checkout(s, 'COD');
      expect(res.status).toBe(201);
      expect(bodyOf(checkoutResponseSchema, res).order.state).toBe('PLACED');
      // 2 x 500 = 1000 at 10%: Rs. 100 leaves the prepaid balance.
      expect((await shopOf(s.vendorId)).wallet_balance_npr).toBe(5900);
      expect(await balanceOf(db, 'PLATFORM_REVENUE')).toBe(revenueBefore + 100);
    });

    it('takes a wallet payment straight to the shop, never through escrow', async () => {
      const s = await prepaidShop(6000);
      await recharge(s.customerId, 2000);
      const escrowBefore = (await balanceOf(db, 'SYSTEM_ESCROW')) ?? 0;
      const res = await checkout(s, 'WALLET');
      expect(res.status).toBe(201);
      expect((await shopOf(s.vendorId)).wallet_balance_npr).toBe(6000 + 1050 - 100);
      expect(await walletBalance(s.customerId)).toBe(950);
      expect(await balanceOf(db, 'SYSTEM_ESCROW')).toBe(escrowBefore);

      // Cancelled within the window: the fee back to the shop, the payment back to the wallet.
      const { order } = bodyOf(checkoutResponseSchema, res);
      const cancelled = await request(t.app)
        .post(`/api/orders/${order.id}/cancel`)
        .set('authorization', bearer(s.customerId));
      expect(cancelled.status).toBe(200);
      expect((await shopOf(s.vendorId)).wallet_balance_npr).toBe(6000);
      expect(await walletBalance(s.customerId)).toBe(2000);
    });

    it('signs and verifies an eSewa payment with the shop own merchant account', async () => {
      const s = await prepaidShop(6000);
      const code = merchant();
      await saveAccount(s, 'ESEWA', code, 'shop-own-esewa-secret');
      await verify(s, 'ESEWA');
      const escrowBefore = (await balanceOf(db, 'SYSTEM_ESCROW')) ?? 0;
      const { order } = bodyOf(checkoutResponseSchema, await checkout(s, 'ESEWA'));
      const form = bodyOf(
        esewaInitiateResponseSchema,
        await request(t.app)
          .post('/api/payments/esewa/initiate')
          .set('authorization', bearer(s.customerId))
          .send({ order_id: order.id }),
      );
      expect(form.fields.product_code).toBe(code);
      const uuid = form.fields.transaction_uuid ?? '';

      // A callback signed with the platform key is refused for this order.
      const platformSigned = await request(t.app)
        .post('/api/payments/esewa/webhook')
        .send({
          data: esewaCallback({ transaction_uuid: uuid, total_amount: '1050', product_code: code }),
        });
      expect(platformSigned.status).toBe(400);

      const paid = bodyOf(
        paymentStatusResponseSchema,
        await request(t.app)
          .post('/api/payments/esewa/webhook')
          .send({
            data: esewaCallback(
              { transaction_uuid: uuid, total_amount: '1050', product_code: code },
              'shop-own-esewa-secret',
            ),
          }),
      );
      expect(paid.payment).toMatchObject({ order_state: 'PLACED', payment_status: 'PAID' });
      expect(await balanceOf(db, 'SYSTEM_ESCROW')).toBe(escrowBefore);
      expect((await shopOf(s.vendorId)).wallet_balance_npr).toBe(5900);
    });

    it('takes no order whose fee would cross the reserve', async () => {
      const s = await prepaidShop(5050);
      expect(new Set((await quote(s)).map((o) => o.reason))).toEqual(
        new Set(['BELOW_PREPAID_RESERVE']),
      );
      const refused = await checkout(s, 'COD');
      expect(refused.status).toBe(422);
      expect(errorOf(refused).details).toMatchObject({ reason: 'BELOW_PREPAID_RESERVE' });
    });

    it('is suspended below the reserve and restored by a recharge back to it', async () => {
      const s = await prepaidShop(6000);
      // The fee of 100 takes 6000 to 5900.
      expect((await checkout(s, 'COD')).status).toBe(201);
      try {
        // The Super Admin raises the reserve above the balance: the next journal suspends.
        await db.update(platformSettings).set({ prepaid_reserve_npr: 5950 });
        await fundShop(s, 10);
        const suspended = await shopOf(s.vendorId);
        expect(suspended).toMatchObject({
          status: 'SUSPENDED',
          status_before_debt_suspension: 'LIVE',
          wallet_balance_npr: 5910,
        });
        await fundShop(s, 39.99);
        expect((await shopOf(s.vendorId)).status).toBe('SUSPENDED');
        await fundShop(s, 0.01);
        expect((await shopOf(s.vendorId)).status).toBe('LIVE');
      } finally {
        await db.update(platformSettings).set({ prepaid_reserve_npr: 5000 });
      }
    });
  });

  describe('pricing plans', () => {
    async function plan(model: 'COMMISSION' | 'SUBSCRIPTION' | 'FREE') {
      const [row] = await db
        .insert(pricingPlans)
        .values({
          name: `${model} ${String(randomInt(0, 1_000_000_000))}`,
          model,
          commission_rate: model === 'COMMISSION' ? 8 : 0,
          monthly_fee_npr: model === 'SUBSCRIPTION' ? 1500 : 0,
          duration_cycles: model === 'FREE' ? 3 : null,
          is_offered: true,
          is_default: false,
          created_by_user_id: adminId,
        })
        .returning();
      if (row === undefined) throw new Error('no plan');
      return row;
    }

    it('lets a shop queue a Subscription plan only', async () => {
      const s = await setup();
      await db
        .update(vendors)
        .set({
          billing_cycle_started_at: new Date(Date.now() - 86_400_000),
          billing_cycle_ends_at: new Date(Date.now() + 86_400_000),
        })
        .where(eq(vendors.id, s.vendorId));
      const ask = (planId: string) =>
        request(t.app)
          .post('/api/vendor/billing/changes')
          .set('authorization', bearer(s.vendorUserId, 'VENDOR'))
          .send({ setting: 'PRICING_PLAN', value: { pricing_plan_id: planId } });
      for (const model of ['COMMISSION', 'FREE'] as const) {
        const refused = await ask((await plan(model)).id);
        expect(refused.status).toBe(422);
        expect(errorOf(refused).code).toBe('PRICING_PLAN_ADMIN_ONLY');
      }
      const queued = await ask((await plan('SUBSCRIPTION')).id);
      expect(queued.status).toBe(202);
      expect(bodyOf(billingChangeResponseSchema, queued).change?.setting).toBe('PRICING_PLAN');

      const view = bodyOf(
        vendorBillingViewSchema,
        await request(t.app)
          .get('/api/vendor/billing')
          .set('authorization', bearer(s.vendorUserId, 'VENDOR')),
      );
      expect(view.pending_changes).toHaveLength(1);
      expect(view.self_selectable_plans.every((p) => p.model === 'SUBSCRIPTION')).toBe(true);
      expect(view.prepaid_reserve_npr).toBe(5000);
      expect(view.dues).toBeNull();
    });

    it('lets a Super Admin assign any plan: at once without a cycle, queued with one', async () => {
      const s = await setup();
      await db
        .update(vendors)
        .set({ billing_cycle_started_at: null, billing_cycle_ends_at: null })
        .where(eq(vendors.id, s.vendorId));
      const free = await plan('FREE');
      const assign = (planId: string) =>
        request(t.app)
          .put(`/api/admin/vendors/${s.vendorId}/pricing-plan`)
          .set('authorization', bearer(adminId, 'SUPER_ADMIN'))
          .send({ pricing_plan_id: planId });
      const now = bodyOf(adminPlanAssignResponseSchema, await assign(free.id));
      expect(now).toMatchObject({ effective: 'NOW', effective_from: null });
      expect((await shopOf(s.vendorId)).pricing_model).toBe('FREE');

      const endsAt = new Date(Date.now() + 86_400_000);
      await db
        .update(vendors)
        .set({
          billing_cycle_started_at: new Date(Date.now() - 86_400_000),
          billing_cycle_ends_at: endsAt,
        })
        .where(eq(vendors.id, s.vendorId));
      const commission = await plan('COMMISSION');
      const queued = bodyOf(adminPlanAssignResponseSchema, await assign(commission.id));
      expect(queued.effective).toBe('NEXT_CYCLE');
      expect((await shopOf(s.vendorId)).pricing_model).toBe('FREE');
      const [change] = await db
        .select()
        .from(vendorSettingChanges)
        .where(eq(vendorSettingChanges.vendor_id, s.vendorId))
        .orderBy(desc(vendorSettingChanges.requested_at));
      expect(change).toMatchObject({ status: 'PENDING', requested_by_user_id: adminId });
      const audited = await db
        .select()
        .from(auditLogs)
        .where(
          and(eq(auditLogs.vendor_id, s.vendorId), eq(auditLogs.action, 'PRICING_PLAN_ASSIGNED')),
        );
      expect(audited).toHaveLength(2);

      const vendorTried = await request(t.app)
        .put(`/api/admin/vendors/${s.vendorId}/pricing-plan`)
        .set('authorization', bearer(s.vendorUserId, 'VENDOR'))
        .send({ pricing_plan_id: commission.id });
      expect(vendorTried.status).toBe(403);
    });
  });
});
