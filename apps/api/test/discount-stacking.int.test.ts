import { randomUUID } from 'node:crypto';

import {
  invoices,
  ledgerAccounts,
  orders,
  platformCampaigns,
  vendorOffers,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import {
  cartQuoteResponseSchema,
  checkoutResponseSchema,
  esewaInitiateResponseSchema,
  paymentStatusResponseSchema,
  quoteChangedDetailsSchema,
  vendorOfferResponseSchema,
  vendorWalletBalanceResponseSchema,
  type PaymentMethod,
} from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
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
 * Phase 33 on real Express + PostgreSQL + Redis: a vendor offer stacked with a platform campaign
 * (SPEC core 7 and 9), from the quote to the gateway amount, the order row, the settlement and
 * the fiscal invoice. SPEC verification 5 in full: total 860, commission 85.50 on a base of 855.
 */
describe('discount stacking: vendor offer, then platform campaign', () => {
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

  /** A SELF_DELIVERY shop with a PAN, 10% commission, fee 50, one product at 500. */
  async function setup() {
    const customerId = await createUser(db);
    const vendorId = await createVendor(db, { baseDeliveryFee: 50 });
    await db
      .update(vendors)
      .set({ tax_id: '302118845', is_vat_registered: true })
      .where(eq(vendors.id, vendorId));
    const vendorUserId = await vendorUserIdOf(db, vendorId);
    const productId = await createProduct(db, vendorId, 20, 500);
    return { customerId, vendorId, vendorUserId, productId };
  }
  type Setup = Awaited<ReturnType<typeof setup>>;

  /** The shop's own account creates an offer, through the API. */
  async function offer(
    s: Setup,
    body: {
      kind: 'FLAT' | 'PERCENTAGE';
      value: number;
      min_cart_npr?: number;
      max_discount_npr?: number | null;
    },
  ) {
    const res = await request(t.app)
      .post('/api/vendor/offers')
      .set('authorization', bearer(s.vendorUserId, 'VENDOR'))
      .send(body);
    expect(res.status).toBe(201);
    return bodyOf(vendorOfferResponseSchema, res).offer;
  }

  const endOffer = (s: Setup, offerId: string) =>
    request(t.app)
      .post(`/api/vendor/offers/${offerId}/end`)
      .set('authorization', bearer(s.vendorUserId, 'VENDOR'));

  /** A running campaign of 10% (the vendor bears half) the shop has opted in to. */
  async function campaign(s: Setup, terms: { value?: number; minCart?: number } = {}) {
    const [row] = await db
      .insert(platformCampaigns)
      .values({
        name: 'Dashain 10%',
        kind: 'PERCENTAGE',
        value: terms.value ?? 10,
        min_cart_npr: terms.minCart ?? 0,
        vendor_share_percent: 50,
        starts_at: new Date(Date.now() - 3_600_000),
        ends_at: new Date(Date.now() + 24 * 3_600_000),
        created_by_user_id: adminId,
      })
      .returning({ id: platformCampaigns.id });
    if (row === undefined) throw new Error('campaign not created');
    const res = await request(t.app)
      .post(`/api/vendor/campaigns/${row.id}/opt-in`)
      .set('authorization', bearer(s.vendorUserId, 'VENDOR'))
      .send({ terms_version: 1 });
    expect(res.status).toBe(201);
    return row.id;
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

  const checkout = (
    s: Setup,
    paymentMethod: PaymentMethod,
    extra: { expected_total_npr?: number } = {},
  ) =>
    request(t.app)
      .post('/api/cart/checkout')
      .set('authorization', bearer(s.customerId))
      .send({
        ...cartOf(s),
        idempotency_key: randomUUID(),
        payment_method: paymentMethod,
        ...extra,
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
    let fields: Record<string, string> = {};
    if (method === 'ESEWA') {
      const initiate = await request(t.app)
        .post('/api/payments/esewa/initiate')
        .set('authorization', bearer(s.customerId))
        .send({ order_id: body.order.id });
      fields = bodyOf(esewaInitiateResponseSchema, initiate).fields;
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
    return { orderId: body.order.id, otp: body.delivery_otp, view: body.order, fields };
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
  const ordersOf = (vendorId: string) =>
    db.select().from(orders).where(eq(orders.vendor_id, vendorId));
  const promoExpense = async () =>
    (
      await db
        .select({ balance: ledgerAccounts.balance_npr })
        .from(ledgerAccounts)
        .where(eq(ledgerAccounts.account_type, 'PROMO_EXPENSE'))
    )[0]?.balance ?? 0;

  describe('the quote', () => {
    it('applies the shop’s own offer to the subtotal, and none of another shop’s', async () => {
      const s = await setup();
      const other = await setup();
      const created = await offer(s, { kind: 'FLAT', value: 100, min_cart_npr: 100 });

      expect(await quote(s)).toMatchObject({
        subtotal_npr: 1000,
        vendor_offer: { id: created.id, label: 'Flat Rs. 100 OFF', discount_npr: 100 },
        platform_promo: null,
        // The delivery fee is never discounted.
        delivery_fee_npr: 50,
        total_npr: 950,
      });
      expect(await quote(other)).toMatchObject({ vendor_offer: null, total_npr: 1050 });
    });

    it('takes a percentage up to its cap, and nothing below the minimum cart', async () => {
      const capped = await setup();
      await offer(capped, { kind: 'PERCENTAGE', value: 20, max_discount_npr: 150 });
      expect((await quote(capped)).vendor_offer?.discount_npr).toBe(150);

      const minimum = await setup();
      await offer(minimum, { kind: 'PERCENTAGE', value: 10, min_cart_npr: 1000.01 });
      expect((await quote(minimum)).vendor_offer).toBeNull();
      // Three units reach it: 1500 x 10%.
      expect(await quote(minimum, 3)).toMatchObject({
        vendor_offer: { discount_npr: 150 },
        total_npr: 1400,
      });
    });

    it('takes the larger of the shop’s offers, never two; between equal ones the older', async () => {
      const s = await setup();
      await offer(s, { kind: 'PERCENTAGE', value: 5 });
      const flat = await offer(s, { kind: 'FLAT', value: 80, min_cart_npr: 80 });
      expect(await quote(s)).toMatchObject({
        vendor_offer: { id: flat.id, discount_npr: 80 },
        total_npr: 970,
      });

      // 8% of 1000 is the same 80: the offer created first keeps the order.
      await offer(s, { kind: 'PERCENTAGE', value: 8 });
      expect((await quote(s)).vendor_offer?.id).toBe(flat.id);
    });

    it('ignores an offer the shop ended, and one whose end date has passed', async () => {
      const s = await setup();
      const created = await offer(s, { kind: 'FLAT', value: 100, min_cart_npr: 100 });
      expect((await endOffer(s, created.id)).status).toBe(200);
      expect(await quote(s)).toMatchObject({ vendor_offer: null, total_npr: 1050 });

      const expired = await setup();
      await db.insert(vendorOffers).values({
        vendor_id: expired.vendorId,
        kind: 'FLAT',
        value: 100,
        min_cart_npr: 100,
        label: 'Flat Rs. 100 OFF',
        starts_at: new Date(Date.now() - 3 * 3_600_000),
        ends_at: new Date(Date.now() - 3_600_000),
        created_by_user_id: expired.vendorUserId,
      });
      expect((await quote(expired)).vendor_offer).toBeNull();
    });

    it('stacks the campaign on what is left after the vendor offer (SPEC verification 5)', async () => {
      const s = await setup();
      const created = await offer(s, { kind: 'FLAT', value: 100, min_cart_npr: 100 });
      const campaignId = await campaign(s);

      expect(await quote(s)).toMatchObject({
        subtotal_npr: 1000,
        vendor_offer: { id: created.id, discount_npr: 100 },
        // 10% of the remaining 900, not of 1000.
        platform_promo: { id: campaignId, discount_npr: 90 },
        delivery_fee_npr: 50,
        total_npr: 860,
      });
    });

    it('judges the campaign’s minimum cart on what is left after the vendor offer', async () => {
      const s = await setup();
      await campaign(s, { minCart: 950 });
      // Without an offer the cart of 1000 reaches the campaign's 950.
      expect((await quote(s)).platform_promo?.discount_npr).toBe(100);

      await offer(s, { kind: 'FLAT', value: 100, min_cart_npr: 100 });
      // 900 is left: the campaign no longer applies, the vendor offer still does.
      expect(await quote(s)).toMatchObject({
        vendor_offer: { discount_npr: 100 },
        platform_promo: null,
        total_npr: 950,
      });
    });
  });

  describe('SPEC verification 5, end to end', () => {
    it('charges 860, takes commission 85.50 on a base of 855, and invoices 860', async () => {
      const s = await setup();
      const created = await offer(s, { kind: 'FLAT', value: 100, min_cart_npr: 100 });
      await campaign(s);
      const [revenueBefore, promoBefore, escrowBefore] = [
        (await balanceOf(db, 'PLATFORM_REVENUE')) ?? 0,
        await promoExpense(),
        (await balanceOf(db, 'SYSTEM_ESCROW')) ?? 0,
      ];

      const order = await placed(s, 'ESEWA', 860);

      expect(order.view).toMatchObject({
        subtotal_npr: 1000,
        vendor_offer_discount_npr: 100,
        platform_promo_discount_npr: 90,
        delivery_fee_npr: 50,
        total_npr: 860,
      });
      // The eSewa form is signed for 860; its goods amount is 810 (total = amount + delivery).
      expect(order.fields.total_amount).toBe('860');
      expect(order.fields.amount).toBe('810');
      expect(await orderRow(order.orderId)).toMatchObject({
        vendor_offer_id: created.id,
        vendor_offer_discount_npr: 100,
        platform_promo_discount_npr: 90,
        platform_promo_vendor_share_npr: 45,
        // 10% of S - Dv - Dpv = 1000 - 100 - 45 = 855.
        platform_commission_amount: 85.5,
      });
      expect(await balanceOf(db, 'SYSTEM_ESCROW')).toBe(escrowBefore + 860);

      // On its way to the vendor: 855 - 85.50 + its own 50 delivery fee.
      const wallet = await request(t.app)
        .get('/api/vendors/wallet/balance')
        .set('authorization', bearer(s.vendorUserId, 'VENDOR'));
      expect(bodyOf(vendorWalletBalanceResponseSchema, wallet).pending_escrow_npr).toBe(819.5);

      await delivered(s, order);

      // vendor 769.50 + 50 delivery, platform 85.50 - 45: 819.50 + 40.50 = 860.
      // Step 7.3: a delivered prepaid order is credited to the dispute hold for 7 days.
      expect(await balanceOf(db, { holdVendorId: s.vendorId })).toBe(819.5);
      expect(await balanceOf(db, 'PLATFORM_REVENUE')).toBe(revenueBefore + 85.5);
      expect(await promoExpense()).toBe(promoBefore - 45);
      expect(await balanceOf(db, 'SYSTEM_ESCROW')).toBe(escrowBefore);

      const [invoice, ...rest] = await db
        .select()
        .from(invoices)
        .where(eq(invoices.vendor_id, s.vendorId));
      expect(rest).toHaveLength(0);
      // Every discount lowers the taxable amount: both, 190 in all.
      expect(invoice).toMatchObject({
        subtotal_npr: 1000,
        discount_npr: 190,
        delivery_charge_npr: 50,
        grand_total_npr: 860,
        amount_in_words: 'Rupees Eight Hundred Sixty Only',
      });
      expect(
        Math.round(((invoice?.taxable_amount_npr ?? 0) + (invoice?.vat_amount_npr ?? 0)) * 100),
      ).toBe(86_000);
    });

    it('settles a cash order: the wallet moves by the platform’s share less the commission', async () => {
      const s = await setup();
      await offer(s, { kind: 'FLAT', value: 100, min_cart_npr: 100 });
      await campaign(s);

      const order = await placed(s, 'COD', 860);
      expect(order.view.total_npr).toBe(860);
      await delivered(s, order);

      // The shop collected 860 in cash and is entitled to 819.50: wallet +45 - 85.50.
      expect(await balanceOf(db, { vendorId: s.vendorId })).toBe(-40.5);
    });

    it('a vendor offer alone moves no platform money: commission on S - Dv', async () => {
      const s = await setup();
      await offer(s, { kind: 'PERCENTAGE', value: 10 });
      const promoBefore = await promoExpense();

      const order = await placed(s, 'ESEWA', 950);
      expect(await orderRow(order.orderId)).toMatchObject({
        vendor_offer_discount_npr: 100,
        platform_promo_discount_npr: 0,
        platform_commission_amount: 90,
        campaign_opt_in_id: null,
      });
      await delivered(s, order);

      // 1000 - 100 - 90 + 50 delivery.
      expect(await balanceOf(db, { holdVendorId: s.vendorId })).toBe(860);
      expect(await promoExpense()).toBe(promoBefore);
    });
  });

  describe('an offer that ends during checkout', () => {
    it('refuses the order when the offer ended between the price and the order (409 QUOTE_CHANGED)', async () => {
      const s = await setup();
      const created = await offer(s, { kind: 'FLAT', value: 100, min_cart_npr: 100 });
      let pending: Promise<request.Response> | undefined;

      // The shop ends the offer: its row is written, then the commit.
      await db.transaction(async (tx) => {
        await tx
          .update(vendorOffers)
          .set({ ended_at: new Date(), ended_by_user_id: s.vendorUserId })
          .where(eq(vendorOffers.id, created.id));
        // Priced while the offer still reads as running; then it waits on that row.
        pending = checkout(s, 'COD').then((res) => res);
        await new Promise((resolve) => setTimeout(resolve, 400));
      });

      const refused = await pending;
      expect(refused?.status).toBe(409);
      expect(errorOf(refused ?? { body: null }).code).toBe('QUOTE_CHANGED');
      expect(await ordersOf(s.vendorId)).toEqual([]);
      // Its inventory hold was released, and the next checkout pays the full price.
      expect(await stockOf(db, s.productId)).toBe(20);
      const next = await checkout(s, 'COD');
      expect(bodyOf(checkoutResponseSchema, next).order.total_npr).toBe(1050);
    });

    it('compares the total the customer was quoted, and answers the new quote when it differs', async () => {
      const s = await setup();
      const created = await offer(s, { kind: 'FLAT', value: 100, min_cart_npr: 100 });
      const quoted = await quote(s);
      expect(quoted.total_npr).toBe(950);
      expect((await endOffer(s, created.id)).status).toBe(200);

      const refused = await checkout(s, 'COD', { expected_total_npr: quoted.total_npr });
      expect(refused.status).toBe(409);
      const error = errorOf(refused);
      expect(error.code).toBe('QUOTE_CHANGED');
      expect(quoteChangedDetailsSchema.parse(error.details).quote).toMatchObject({
        subtotal_npr: 1000,
        vendor_offer: null,
        total_npr: 1050,
      });
      expect(await ordersOf(s.vendorId)).toEqual([]);
      expect(await stockOf(db, s.productId)).toBe(20);

      // The customer accepts the new total.
      const accepted = await checkout(s, 'COD', { expected_total_npr: 1050 });
      expect(accepted.status).toBe(201);
    });

    it('never takes the sent total as a price', async () => {
      const s = await setup();
      const refused = await checkout(s, 'COD', { expected_total_npr: 1 });
      expect(refused.status).toBe(409);
      expect(await ordersOf(s.vendorId)).toEqual([]);
    });

    it('keeps the discount of an order already priced when its offer ends later', async () => {
      const s = await setup();
      const created = await offer(s, { kind: 'FLAT', value: 100, min_cart_npr: 100 });
      const order = await placed(s, 'COD', 950);
      expect((await endOffer(s, created.id)).status).toBe(200);
      await delivered(s, order);

      expect(await orderRow(order.orderId)).toMatchObject({
        vendor_offer_id: created.id,
        vendor_offer_discount_npr: 100,
      });
      // Cash: the shop holds 950; only the commission of 90 is owed.
      expect(await balanceOf(db, { vendorId: s.vendorId })).toBe(-90);
    });
  });

  describe('the database', () => {
    it('refuses a vendor offer discount without its offer, and discounts above the goods', async () => {
      const s = await setup();
      const created = await offer(s, { kind: 'FLAT', value: 100, min_cart_npr: 100 });
      const order = await placed(s, 'COD', 950);
      const set = (values: Partial<typeof orders.$inferInsert>) =>
        db.update(orders).set(values).where(eq(orders.id, order.orderId));

      await expect(set({ vendor_offer_id: null })).rejects.toThrow();
      await expect(set({ vendor_offer_discount_npr: 0 })).rejects.toThrow();
      await expect(set({ vendor_offer_discount_npr: 1000.01 })).rejects.toThrow();
      expect((await orderRow(order.orderId))?.vendor_offer_id).toBe(created.id);
    });
  });
});
