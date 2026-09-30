import { randomUUID } from 'node:crypto';

import { orders } from '@hamro-pasal/db';
import {
  checkoutResponseSchema,
  esewaInitiateResponseSchema,
  khaltiInitiateResponseSchema,
  paymentStatusResponseSchema,
} from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import { esewaSignatureMessage, signEsewaRequest } from '../src/payments/esewa/signature';
import {
  balanceOf,
  createProduct,
  createUser,
  createVendor,
  DELIVERY_ADDRESS,
  outboxFor,
  stockOf,
} from './support/fixtures';
import {
  bearer,
  bodyOf,
  buildTestApp,
  errorOf,
  esewaCallback,
  ESEWA_UAT_SECRET,
  FakeKhalti,
  type TestApp,
} from './support/http';

/** eSewa / Khalti verification over real Express + PostgreSQL + Redis (gateway HTTP faked). */
describe('payments API', () => {
  const khalti = new FakeKhalti();
  let t: TestApp;

  beforeAll(() => {
    t = buildTestApp({ khaltiFetch: khalti.fetch });
  });

  afterAll(async () => {
    await t.container.close();
  });

  const db = () => t.container.db;
  const escrow = async () => (await balanceOf(db(), 'SYSTEM_ESCROW')) ?? 0;

  /** A prepaid order (subtotal 1000 + delivery 50 = 1050 NPR) with a live 600 s lock. */
  async function pendingOrder(paymentMethod: 'ESEWA' | 'KHALTI', app: TestApp = t) {
    const customerId = await createUser(db());
    const vendorId = await createVendor(db(), { baseDeliveryFee: 50 });
    const productId = await createProduct(db(), vendorId, 5, 500);
    const res = await request(app.app)
      .post('/api/cart/checkout')
      .set('authorization', bearer(customerId))
      .send({
        idempotency_key: randomUUID(),
        vendor_id: vendorId,
        payment_method: paymentMethod,
        items: [{ product_id: productId, quantity: 2 }],
        delivery_address: DELIVERY_ADDRESS,
      });
    expect(res.status).toBe(201);
    return {
      customerId,
      vendorId,
      productId,
      orderId: bodyOf(checkoutResponseSchema, res).order.id,
    };
  }

  async function orderRow(orderId: string) {
    const [order] = await db().select().from(orders).where(eq(orders.id, orderId));
    return order;
  }

  describe('eSewa', () => {
    const initiateRes = (customerId: string, orderId: string, app = t.app) =>
      request(app)
        .post('/api/payments/esewa/initiate')
        .set('authorization', bearer(customerId))
        .send({ order_id: orderId });

    const initiate = async (customerId: string, orderId: string, app = t.app) =>
      bodyOf(esewaInitiateResponseSchema, await initiateRes(customerId, orderId, app)).fields;

    const webhook = (data: string, app = t.app) =>
      request(app).post('/api/payments/esewa/webhook').send({ data });

    const paid = (transactionUuid: string | undefined, totalAmount: string) =>
      esewaCallback({ transaction_uuid: transactionUuid ?? '', total_amount: totalAmount });

    it('returns a correctly signed ePay v2 form for the order total', async () => {
      const { customerId, orderId } = await pendingOrder('ESEWA');

      const res = await initiateRes(customerId, orderId);

      expect(res.status).toBe(200);
      const { fields } = bodyOf(esewaInitiateResponseSchema, res);
      const transactionUuid = fields.transaction_uuid ?? '';
      expect(fields).toMatchObject({
        amount: '1000',
        tax_amount: '0',
        product_service_charge: '0',
        product_delivery_charge: '50',
        total_amount: '1050',
        product_code: 'EPAYTEST',
        signed_field_names: 'total_amount,transaction_uuid,product_code',
      });
      expect(
        esewaSignatureMessage(fields, ['total_amount', 'transaction_uuid', 'product_code']),
      ).toBe(`total_amount=1050,transaction_uuid=${transactionUuid},product_code=EPAYTEST`);
      expect(fields.signature).toBe(
        signEsewaRequest(
          { total_amount: '1050', transaction_uuid: transactionUuid, product_code: 'EPAYTEST' },
          ESEWA_UAT_SECRET,
        ),
      );
      expect((await orderRow(orderId))?.payment_gateway_ref).toBe(transactionUuid);
    });

    it('credits escrow, marks PAID, claims the lock and places the order on a valid callback', async () => {
      const { customerId, orderId, productId } = await pendingOrder('ESEWA');
      const fields = await initiate(customerId, orderId);
      const escrowBefore = await escrow();

      const res = await webhook(paid(fields.transaction_uuid, '1050.0'));

      expect(res.status).toBe(200);
      expect(bodyOf(paymentStatusResponseSchema, res)).toEqual({
        status: 'COMPLETE',
        payment: {
          order_id: orderId,
          order_state: 'PLACED',
          payment_status: 'PAID',
          duplicate: false,
        },
      });
      expect((await escrow()) - escrowBefore).toBeCloseTo(1050, 2);
      expect(await stockOf(db(), productId)).toBe(3);
      const events = (await outboxFor(db(), orderId)).map((e) => e.event_type).sort();
      // order.state_changed twice: creation (PENDING_PAYMENT) and placement (PLACED).
      expect(events).toEqual([
        'ledger.mutated',
        'order.placed',
        'order.state_changed',
        'order.state_changed',
      ]);
    });

    it('credits exactly once under duplicate and concurrent callbacks (SELECT ... FOR UPDATE)', async () => {
      const { customerId, orderId } = await pendingOrder('ESEWA');
      const fields = await initiate(customerId, orderId);
      const data = paid(fields.transaction_uuid, '1050.0');
      const escrowBefore = await escrow();

      const concurrent = await Promise.all(Array.from({ length: 6 }, () => webhook(data)));
      const replay = bodyOf(paymentStatusResponseSchema, await webhook(data));

      expect(concurrent.every((r) => r.status === 200)).toBe(true);
      const firstCredits = concurrent.filter(
        (r) => bodyOf(paymentStatusResponseSchema, r).payment?.duplicate === false,
      );
      expect(firstCredits).toHaveLength(1);
      expect(replay.payment).toMatchObject({ order_state: 'PLACED', duplicate: true });
      expect((await escrow()) - escrowBefore).toBeCloseTo(1050, 2);
      const captures = (await outboxFor(db(), orderId)).filter(
        (e) => e.event_type === 'ledger.mutated',
      );
      expect(captures).toHaveLength(1);
    });

    it('accepts an amount within 0.01 NPR and rejects anything further off', async () => {
      const within = await pendingOrder('ESEWA');
      const withinFields = await initiate(within.customerId, within.orderId);
      const off = await pendingOrder('ESEWA');
      const offFields = await initiate(off.customerId, off.orderId);

      const ok = await webhook(paid(withinFields.transaction_uuid, '1049.99'));
      const mismatch = await webhook(paid(offFields.transaction_uuid, '1049.98'));

      expect(ok.status).toBe(200);
      expect(mismatch.status).toBe(409);
      expect(errorOf(mismatch)).toMatchObject({
        code: 'PAYMENT_AMOUNT_MISMATCH',
        details: { expected_npr: 1050, paid_npr: 1049.98 },
      });
      expect(await orderRow(off.orderId)).toMatchObject({
        payment_status: 'PENDING',
        state: 'PENDING_PAYMENT',
      });
    });

    it('rejects forged or tampered callbacks without crediting anything', async () => {
      const { customerId, orderId } = await pendingOrder('ESEWA');
      const fields = await initiate(customerId, orderId);
      const transactionUuid = fields.transaction_uuid ?? '';

      const wrongSecret = await webhook(
        esewaCallback(
          { transaction_uuid: transactionUuid, total_amount: '1050.0' },
          'guessed-secret',
        ),
      );
      const otherProduct = await webhook(
        esewaCallback({
          transaction_uuid: transactionUuid,
          total_amount: '1050.0',
          product_code: 'SOMEONE_ELSE',
        }),
      );
      const garbage = await webhook('bm90IGpzb24=');

      expect([wrongSecret.status, otherProduct.status, garbage.status]).toEqual([400, 400, 400]);
      expect(errorOf(wrongSecret).code).toBe('INVALID_PAYMENT_CALLBACK');
      expect((await orderRow(orderId))?.payment_status).toBe('PENDING');
    });

    it('does not credit non-COMPLETE statuses or unknown transactions', async () => {
      const { customerId, orderId } = await pendingOrder('ESEWA');
      const fields = await initiate(customerId, orderId);

      const pending = await webhook(
        esewaCallback({
          transaction_uuid: fields.transaction_uuid ?? '',
          total_amount: '1050.0',
          status: 'PENDING',
        }),
      );
      const unknown = await webhook(paid(randomUUID(), '1050.0'));

      expect(bodyOf(paymentStatusResponseSchema, pending)).toEqual({
        status: 'PENDING',
        payment: null,
      });
      expect(unknown.status).toBe(404);
      expect((await orderRow(orderId))?.payment_status).toBe('PENDING');
    });

    it('only lets the owner initiate, and only for eSewa orders', async () => {
      const esewaOrder = await pendingOrder('ESEWA');
      const khaltiOrder = await pendingOrder('KHALTI');

      const stranger = await initiateRes(await createUser(db()), esewaOrder.orderId);
      const wrongGateway = await initiateRes(khaltiOrder.customerId, khaltiOrder.orderId);
      const anonymous = await request(t.app)
        .post('/api/payments/esewa/initiate')
        .send({ order_id: esewaOrder.orderId });

      expect(stranger.status).toBe(404);
      expect(wrongGateway.status).toBe(409);
      expect(errorOf(wrongGateway).code).toBe('WRONG_PAYMENT_METHOD');
      expect(anonymous.status).toBe(401);
    });

    it('marks the order FAILED (refund required) if payment arrives after the lock expired', async () => {
      const short = buildTestApp({ lockTtlMs: 1_500 });
      try {
        const { customerId, orderId, productId } = await pendingOrder('ESEWA', short);
        const fields = await initiate(customerId, orderId, short.app);
        await new Promise((resolve) => setTimeout(resolve, 1_800));

        const res = await webhook(paid(fields.transaction_uuid, '1050.0'), short.app);

        expect(res.status).toBe(409);
        expect(errorOf(res)).toMatchObject({
          code: 'PAID_AFTER_SESSION_EXPIRED',
          details: { order_id: orderId, refund_required: true },
        });
        expect(await orderRow(orderId)).toMatchObject({ state: 'FAILED', payment_status: 'PAID' });
        expect(await stockOf(db(), productId)).toBe(5);
      } finally {
        await short.container.close();
      }
    });
  });

  describe('Khalti', () => {
    const initiate = async (customerId: string, orderId: string) => {
      const res = await request(t.app)
        .post('/api/payments/khalti/initiate')
        .set('authorization', bearer(customerId))
        .send({ order_id: orderId });
      expect(res.status).toBe(200);
      return bodyOf(khaltiInitiateResponseSchema, res);
    };

    const lookup = (customerId: string, pidx: string) =>
      request(t.app)
        .post('/api/payments/khalti/lookup')
        .set('authorization', bearer(customerId))
        .send({ pidx });

    it('initiates with the total in paisa and Key authorization, storing the pidx', async () => {
      const { customerId, orderId } = await pendingOrder('KHALTI');

      const { pidx, payment_url: paymentUrl } = await initiate(customerId, orderId);

      expect(paymentUrl).toContain(pidx);
      const call = khalti.requests.at(-1);
      expect(call?.authorization).toBe('Key test_khalti_secret');
      expect(call?.body).toMatchObject({ amount: 105_000, purchase_order_id: orderId });
      expect((await orderRow(orderId))?.payment_gateway_ref).toBe(pidx);
    });

    it('credits escrow and places the order only when the lookup says Completed', async () => {
      const { customerId, orderId } = await pendingOrder('KHALTI');
      const { pidx } = await initiate(customerId, orderId);

      const beforePaying = bodyOf(paymentStatusResponseSchema, await lookup(customerId, pidx));
      khalti.settle(pidx, 'Completed');
      const afterPaying = bodyOf(paymentStatusResponseSchema, await lookup(customerId, pidx));
      const again = bodyOf(paymentStatusResponseSchema, await lookup(customerId, pidx));

      expect(beforePaying).toEqual({ status: 'Initiated', payment: null });
      expect(afterPaying.payment).toMatchObject({
        order_state: 'PLACED',
        payment_status: 'PAID',
        duplicate: false,
      });
      expect(again.payment?.duplicate).toBe(true);
      expect(khalti.requests.filter((r) => r.url.endsWith('/lookup/')).at(-1)?.body).toEqual({
        pidx,
      });
    });

    it('rejects a Completed payment for the wrong amount', async () => {
      const { customerId, orderId } = await pendingOrder('KHALTI');
      const { pidx } = await initiate(customerId, orderId);
      khalti.settle(pidx, 'Completed', 100);

      const res = await lookup(customerId, pidx);

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('PAYMENT_AMOUNT_MISMATCH');
      expect((await orderRow(orderId))?.payment_status).toBe('PENDING');
    });

    it('does not reveal or verify another customer’s pidx', async () => {
      const { customerId, orderId } = await pendingOrder('KHALTI');
      const { pidx } = await initiate(customerId, orderId);
      khalti.settle(pidx, 'Completed');

      const res = await lookup(await createUser(db()), pidx);

      expect(res.status).toBe(404);
      expect((await orderRow(orderId))?.payment_status).toBe('PENDING');
    });
  });
});
