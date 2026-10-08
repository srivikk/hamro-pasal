import { randomUUID } from 'node:crypto';

import {
  campaignOptIns,
  invoices,
  ledgerAccounts,
  orders,
  platformCampaigns,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import {
  cartQuoteResponseSchema,
  checkoutResponseSchema,
  esewaInitiateResponseSchema,
  paymentStatusResponseSchema,
  vendorWalletBalanceResponseSchema,
  type PaymentMethod,
} from '@hamro-pasal/shared-types';
import { asc, eq } from 'drizzle-orm';
import request from 'supertest';

import {
  backdatePlacement,
  balanceOf,
  createProduct,
  createUser,
  createVendor,
  DELIVERY_ADDRESS,
  stockOf,
  vendorUserIdOf,
} from './support/fixtures';
import { bearer, bodyOf, buildTestApp, esewaCallback, errorOf, type TestApp } from './support/http';

/**
 * Phase 31 on real Express + PostgreSQL + Redis: a platform campaign discount from the quote to
 * the gateway amount, the settlement and the fiscal invoice (SPEC core 7, 9 and 10; verification
 * 5 without a vendor offer, verification 6), and the invoice issued by the delivery itself.
 */
describe('campaign discounts and the invoice at delivery', () => {
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

  /** A SELF_DELIVERY shop at 10% commission, fee 50, one product at 500; a PAN unless told not. */
  async function setup(options: { pan?: boolean; vat?: boolean } = {}) {
    const customerId = await createUser(db);
    const vendorId = await createVendor(db, { baseDeliveryFee: 50 });
    if (options.pan !== false) {
      await db
        .update(vendors)
        .set({ tax_id: '302118845', is_vat_registered: options.vat ?? true })
        .where(eq(vendors.id, vendorId));
    }
    const vendorUserId = await vendorUserIdOf(db, vendorId);
    const productId = await createProduct(db, vendorId, 20, 500);
    return { customerId, vendorId, vendorUserId, productId };
  }
  type Setup = Awaited<ReturnType<typeof setup>>;

  interface Terms {
    kind?: 'FLAT' | 'PERCENTAGE';
    value?: number;
    max?: number | null;
    minCart?: number;
    vendorShare?: number;
    /** Hours from now; negative is the past. */
    startsIn?: number;
    endsIn?: number;
    published?: boolean;
  }

  /** A campaign as an admin would publish it; running now unless told otherwise. */
  async function campaign(terms: Terms = {}): Promise<string> {
    const kind = terms.kind ?? 'PERCENTAGE';
    const [row] = await db
      .insert(platformCampaigns)
      .values({
        name: 'Dashain 10%',
        kind,
        value: terms.value ?? 10,
        max_discount_npr: kind === 'PERCENTAGE' ? (terms.max ?? null) : null,
        min_cart_npr: terms.minCart ?? 0,
        vendor_share_percent: terms.vendorShare ?? 50,
        starts_at: new Date(Date.now() + (terms.startsIn ?? -1) * 3_600_000),
        ends_at: new Date(Date.now() + (terms.endsIn ?? 24) * 3_600_000),
        is_active: terms.published ?? true,
        created_by_user_id: adminId,
      })
      .returning({ id: platformCampaigns.id });
    if (row === undefined) throw new Error('campaign not created');
    return row.id;
  }

  /** The shop's own account opts in, through the API. */
  async function optIn(s: Setup, campaignId: string): Promise<void> {
    const res = await request(t.app)
      .post(`/api/vendor/campaigns/${campaignId}/opt-in`)
      .set('authorization', bearer(s.vendorUserId, 'VENDOR'))
      .send({ terms_version: 1 });
    expect(res.status).toBe(201);
  }

  const cartOf = (s: Setup, quantity = 2) => ({
    vendor_id: s.vendorId,
    items: [{ product_id: s.productId, quantity }],
    delivery_address: DELIVERY_ADDRESS,
  });

  const quote = async (s: Setup, quantity = 2) =>
    bodyOf(
      cartQuoteResponseSchema,
      await request(t.app)
        .post('/api/cart/quote')
        .set('authorization', bearer(s.customerId))
        .send(cartOf(s, quantity)),
    );

  const checkout = (s: Setup, paymentMethod: PaymentMethod, quantity = 2) =>
    request(t.app)
      .post('/api/cart/checkout')
      .set('authorization', bearer(s.customerId))
      .send({
        ...cartOf(s, quantity),
        idempotency_key: randomUUID(),
        payment_method: paymentMethod,
      });

  const vendorPost = (s: Setup, orderId: string, action: string) =>
    request(t.app)
      .post(`/api/vendors/orders/${orderId}/${action}`)
      .set('authorization', bearer(s.vendorUserId, 'VENDOR'));

  async function placed(s: Setup, method: 'COD' | 'ESEWA', totalNpr: number) {
    const res = await checkout(s, method);
    expect(res.status).toBe(201);
    const body = bodyOf(checkoutResponseSchema, res);
    if (body.delivery_otp === null) throw new Error('checkout returned no delivery code');
    let signedTotal: string | undefined;
    let signedGoods: string | undefined;
    if (method === 'ESEWA') {
      const initiate = await request(t.app)
        .post('/api/payments/esewa/initiate')
        .set('authorization', bearer(s.customerId))
        .send({ order_id: body.order.id });
      const { fields } = bodyOf(esewaInitiateResponseSchema, initiate);
      signedTotal = fields.total_amount;
      signedGoods = fields.amount;
      const paid = await request(t.app)
        .post('/api/payments/esewa/webhook')
        .send({
          data: esewaCallback({
            transaction_uuid: fields.transaction_uuid ?? '',
            total_amount: `${String(totalNpr)}.0`,
          }),
        });
      expect(bodyOf(paymentStatusResponseSchema, paid).payment?.order_state).toBe('PLACED');
    }
    return {
      orderId: body.order.id,
      otp: body.delivery_otp,
      view: body.order,
      signedTotal,
      signedGoods,
    };
  }

  async function delivered(s: Setup, order: { orderId: string; otp: string }) {
    expect((await vendorPost(s, order.orderId, 'accept')).status).toBe(200);
    await backdatePlacement(db, order.orderId, 61);
    expect((await vendorPost(s, order.orderId, 'dispatch')).status).toBe(200);
    const res = await vendorPost(s, order.orderId, 'deliver').send({ delivery_otp: order.otp });
    expect(res.status).toBe(200);
  }

  const orderRow = async (orderId: string) =>
    (await db.select().from(orders).where(eq(orders.id, orderId)))[0];
  const invoicesOf = (vendorId: string) =>
    db
      .select()
      .from(invoices)
      .where(eq(invoices.vendor_id, vendorId))
      .orderBy(asc(invoices.bill_number));
  const promoExpense = async () =>
    (
      await db
        .select({ balance: ledgerAccounts.balance_npr })
        .from(ledgerAccounts)
        .where(eq(ledgerAccounts.account_type, 'PROMO_EXPENSE'))
    )[0]?.balance ?? 0;

  describe('the quote', () => {
    it('applies the campaign the shop itself opted in to, and nothing without that opt-in', async () => {
      const s = await setup();
      const campaignId = await campaign();

      // Published and running, but this shop has not opted in (SPEC verification 6).
      expect(await quote(s)).toMatchObject({ platform_promo: null, total_npr: 1050 });

      await optIn(s, campaignId);
      expect(await quote(s)).toMatchObject({
        subtotal_npr: 1000,
        vendor_offer: null,
        platform_promo: { id: campaignId, label: 'Dashain 10%', discount_npr: 100 },
        // The delivery fee is never discounted.
        delivery_fee_npr: 50,
        total_npr: 950,
      });

      // Opting out stops it for the next cart.
      const out = await request(t.app)
        .post(`/api/vendor/campaigns/${campaignId}/opt-out`)
        .set('authorization', bearer(s.vendorUserId, 'VENDOR'));
      expect(out.status).toBe(200);
      expect(await quote(s)).toMatchObject({ platform_promo: null, total_npr: 1050 });
    });

    it('caps a percentage, takes a flat amount, and needs the minimum cart', async () => {
      const capped = await setup();
      await optIn(capped, await campaign({ value: 10, max: 60 }));
      expect((await quote(capped)).platform_promo?.discount_npr).toBe(60);

      const flat = await setup();
      await optIn(flat, await campaign({ kind: 'FLAT', value: 120 }));
      expect(await quote(flat)).toMatchObject({
        platform_promo: { discount_npr: 120 },
        total_npr: 930,
      });

      const minimum = await setup();
      await optIn(minimum, await campaign({ minCart: 1000.01 }));
      expect((await quote(minimum)).platform_promo).toBeNull();
      // Three units reach it: 1500 x 10%.
      expect((await quote(minimum, 3)).platform_promo?.discount_npr).toBe(150);
    });

    it('ignores a campaign that has not started, has ended or is unpublished', async () => {
      for (const terms of [{ startsIn: 1 }, { startsIn: -3, endsIn: -1 }, { published: false }]) {
        const s = await setup();
        const campaignId = await campaign({ ...terms, published: true });
        await optIn(s, campaignId).catch(() => undefined);
        // Opted in while it could be; then put into the state under test.
        await db
          .insert(campaignOptIns)
          .values({
            campaign_id: campaignId,
            vendor_id: s.vendorId,
            opt_in_terms_version: 1,
            terms_snapshot: {},
            opted_in_by_user_id: s.vendorUserId,
          })
          .onConflictDoNothing();
        if ('published' in terms) {
          await db
            .update(platformCampaigns)
            .set({ is_active: false })
            .where(eq(platformCampaigns.id, campaignId));
        }
        expect((await quote(s)).platform_promo).toBeNull();
      }
    });

    it('takes the larger of two campaigns, never both', async () => {
      const s = await setup();
      await optIn(s, await campaign({ value: 5 }));
      const better = await campaign({ kind: 'FLAT', value: 80 });
      await optIn(s, better);

      expect(await quote(s)).toMatchObject({
        platform_promo: { id: better, discount_npr: 80 },
        total_npr: 970,
      });
    });
  });

  describe('a discounted order, end to end', () => {
    it('charges 950 at the gateway, pays the vendor on what it sold for, and invoices 950', async () => {
      const s = await setup();
      const campaignId = await campaign({ value: 10, vendorShare: 50 });
      await optIn(s, campaignId);
      const [revenueBefore, promoBefore, escrowBefore] = [
        await balanceOf(db, 'PLATFORM_REVENUE'),
        await promoExpense(),
        await balanceOf(db, 'SYSTEM_ESCROW'),
      ];

      const order = await placed(s, 'ESEWA', 950);

      // The quote's total is the order's, and the eSewa form is signed for it.
      expect(order.view).toMatchObject({
        subtotal_npr: 1000,
        delivery_fee_npr: 50,
        total_npr: 950,
      });
      expect(order.signedTotal).toBe('950');
      // eSewa checks total_amount = amount + delivery charge: the goods are the discounted 900.
      expect(order.signedGoods).toBe('900');
      const row = await orderRow(order.orderId);
      expect(row).toMatchObject({
        platform_promo_discount_npr: 100,
        platform_promo_vendor_share_npr: 50,
        // 10% of what the vendor sells for: 1000 - its 50 share of the discount.
        platform_commission_amount: 95,
      });
      expect(row?.campaign_opt_in_id).not.toBeNull();
      expect(row?.discount_snapshot).toMatchObject({
        campaign_id: campaignId,
        kind: 'PERCENTAGE',
        value: 10,
        vendor_share_percent: 50,
        terms_version: 1,
      });
      expect((await balanceOf(db, 'SYSTEM_ESCROW')) ?? 0).toBe((escrowBefore ?? 0) + 950);

      // What the vendor is told is on its way: 1000 - 50 - 95 + its own 50 delivery fee.
      const wallet = await request(t.app)
        .get('/api/vendors/wallet/balance')
        .set('authorization', bearer(s.vendorUserId, 'VENDOR'));
      expect(bodyOf(vendorWalletBalanceResponseSchema, wallet).pending_escrow_npr).toBe(905);

      await delivered(s, order);

      expect(await balanceOf(db, { vendorId: s.vendorId })).toBe(905);
      expect((await balanceOf(db, 'PLATFORM_REVENUE')) ?? 0).toBe((revenueBefore ?? 0) + 95);
      // The platform's half of the discount is its marketing cost.
      expect(await promoExpense()).toBe(promoBefore - 50);
      expect(await balanceOf(db, 'SYSTEM_ESCROW')).toBe(escrowBefore);

      const [invoice, ...rest] = await invoicesOf(s.vendorId);
      expect(rest).toHaveLength(0);
      expect(invoice).toMatchObject({
        order_id: order.orderId,
        bill_number: 1,
        payment_method: 'ESEWA',
        seller_tax_id: '302118845',
        subtotal_npr: 1000,
        discount_npr: 100,
        delivery_charge_npr: 50,
        // 900 of goods: 796.46 + 103.54. Delivery 50: 44.25 + 5.75.
        taxable_amount_npr: 840.71,
        vat_amount_npr: 109.29,
        grand_total_npr: 950,
        amount_in_words: 'Rupees Nine Hundred Fifty Only',
      });
    });

    it('settles a cash order: the platform owes the shop its share of the discount, less commission', async () => {
      const s = await setup();
      await optIn(s, await campaign({ value: 10, vendorShare: 50 }));
      const promoBefore = await promoExpense();

      const order = await placed(s, 'COD', 950);
      expect(order.view.total_npr).toBe(950);
      await delivered(s, order);

      // The shop collected 950 in cash and is entitled to 905: wallet +50 (platform share) - 95.
      expect(await balanceOf(db, { vendorId: s.vendorId })).toBe(-45);
      expect(await promoExpense()).toBe(promoBefore - 50);
      expect((await invoicesOf(s.vendorId))[0]).toMatchObject({
        grand_total_npr: 950,
        payment_method: 'COD',
      });
    });

    it('refuses a checkout whose offer ended between the price and the order (409 QUOTE_CHANGED)', async () => {
      const s = await setup();
      const campaignId = await campaign();
      await optIn(s, campaignId);
      let pending: Promise<request.Response> | undefined;

      // The shop opts out: its opt-in row is closed, then the commit.
      await db.transaction(async (tx) => {
        await tx
          .update(campaignOptIns)
          .set({ status: 'OPTED_OUT', closed_at: new Date(), closed_by_user_id: s.vendorUserId })
          .where(eq(campaignOptIns.vendor_id, s.vendorId));
        // Priced while the opt-in still reads ACTIVE; then it waits on that row.
        pending = checkout(s, 'COD').then((res) => res);
        await new Promise((resolve) => setTimeout(resolve, 400));
      });

      const refused = await pending;
      expect(refused?.status).toBe(409);
      expect(errorOf(refused ?? { body: null }).code).toBe('QUOTE_CHANGED');
      expect(await db.select().from(orders).where(eq(orders.vendor_id, s.vendorId))).toEqual([]);
      // Its inventory hold was released, and the next checkout pays the full price.
      expect(await stockOf(db, s.productId)).toBe(20);
      const next = await checkout(s, 'COD', 20);
      expect(next.status).toBe(201);
      expect(bodyOf(checkoutResponseSchema, next).order.total_npr).toBe(10_050);
    });
  });

  describe('the invoice at delivery', () => {
    it('issues one invoice per delivered order, numbered 1, 2 for the shop, and none on a retry', async () => {
      const s = await setup({ vat: false });

      const first = await placed(s, 'COD', 1050);
      await delivered(s, first);
      const second = await placed(s, 'COD', 1050);
      await delivered(s, second);
      // A retried delivery answers 200 and issues nothing more.
      const retry = await vendorPost(s, first.orderId, 'deliver').send({ delivery_otp: first.otp });
      expect(retry.status).toBe(200);

      const issued = await invoicesOf(s.vendorId);
      expect(issued.map((invoice) => [invoice.order_id, invoice.bill_number])).toEqual([
        [first.orderId, 1],
        [second.orderId, 2],
      ]);
      expect(issued[0]).toMatchObject({
        seller_is_vat_registered: false,
        vat_amount_npr: 0,
        exempt_amount_npr: 1050,
        grand_total_npr: 1050,
      });
      expect(issued[0]?.invoice_sequence).toMatch(/^HP-\d{4}-000001$/);
      expect(issued[0]?.line_items).toHaveLength(2);
    });

    it('issues none before delivery, and none for a wrong code', async () => {
      const s = await setup();
      const order = await placed(s, 'COD', 1050);
      expect((await vendorPost(s, order.orderId, 'accept')).status).toBe(200);
      await backdatePlacement(db, order.orderId, 61);
      expect((await vendorPost(s, order.orderId, 'dispatch')).status).toBe(200);
      expect(await invoicesOf(s.vendorId)).toEqual([]);

      const wrong = order.otp === '0000' ? '0001' : '0000';
      const refused = await vendorPost(s, order.orderId, 'deliver').send({ delivery_otp: wrong });
      expect(refused.status).toBe(401);
      expect(await invoicesOf(s.vendorId)).toEqual([]);
    });

    it('delivers the order of a shop without a PAN, without an invoice', async () => {
      const s = await setup({ pan: false });
      const order = await placed(s, 'COD', 1050);

      await delivered(s, order);

      expect((await orderRow(order.orderId))?.state).toBe('DELIVERED');
      expect(await invoicesOf(s.vendorId)).toEqual([]);
    });

    it('numbers simultaneous deliveries of one shop without a gap', async () => {
      const s = await setup();
      const all = [];
      for (let i = 0; i < 4; i += 1) all.push(await placed(s, 'COD', 1050));
      for (const order of all) {
        expect((await vendorPost(s, order.orderId, 'accept')).status).toBe(200);
        await backdatePlacement(db, order.orderId, 61);
        expect((await vendorPost(s, order.orderId, 'dispatch')).status).toBe(200);
      }

      const answers = await Promise.all(
        all.map((order) =>
          vendorPost(s, order.orderId, 'deliver').send({ delivery_otp: order.otp }),
        ),
      );

      expect(answers.map((res) => res.status)).toEqual([200, 200, 200, 200]);
      expect((await invoicesOf(s.vendorId)).map((invoice) => invoice.bill_number)).toEqual([
        1, 2, 3, 4,
      ]);
    });
  });
});
