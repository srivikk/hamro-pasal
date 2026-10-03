import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { deliveries, ledgerTransactions, orders } from '@hamro-pasal/db';
import {
  categoryListResponseSchema,
  checkoutResponseSchema,
  deliveryConfirmedResponseSchema,
  deliveryListResponseSchema,
  deliveryResponseSchema,
  esewaInitiateResponseSchema,
  feedResponseSchema,
  lockStatusResponseSchema,
  orderDetailResponseSchema,
  orderStateChangedPayloadSchema,
  paymentStatusResponseSchema,
  productListResponseSchema,
  vendorFinanceLedgerResponseSchema,
  vendorMenuSchema,
  vendorOrderDecisionResponseSchema,
  vendorOrderDispatchResponseSchema,
  vendorOrderListResponseSchema,
} from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import {
  backdatePlacement,
  balanceOf,
  createCategory,
  createProduct,
  createUser,
  createVendor,
  DELIVERY_ADDRESS,
  outboxFor,
  stockOf,
  vendorUserIdOf,
} from './support/fixtures';
import { bearer, bodyOf, buildTestApp, esewaCallback, type TestApp } from './support/http';

const run = promisify(execFile);

/** apps/worker, where the manual reconciliation command lives. */
const WORKER_DIR = resolve(__dirname, '..', '..', 'worker');

/**
 * `pnpm --filter @hamro-pasal/worker reconcile:orders` against the test database: the same script
 * the package command runs (the ORDER_RECONCILIATION midnight task, without BullMQ), in its own
 * process. Every variable is given here, so the run does not depend on a local .env.
 */
async function runMidnightReconciliation(): Promise<string> {
  const { stdout } = await run(
    process.execPath,
    [require.resolve('tsx/cli'), 'src/scripts/reconcile-orders.ts'],
    {
      cwd: WORKER_DIR,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        COUNTRY_CODE: 'NP',
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        REDIS_URL: process.env.TEST_REDIS_URL,
        KAFKA_BROKERS: '127.0.0.1:9092',
        KAFKA_CLIENT_ID: 'hamro-pasal-e2e',
        KAFKA_CONSUMER_GROUP_ID: 'hamro-pasal-e2e',
        JWT_ACCESS_SECRET: 'e2e-access-secret-0123456789abcdef-0123',
        JWT_REFRESH_SECRET: 'e2e-refresh-secret-fedcba9876543210-3210',
        ESEWA_PRODUCT_CODE: 'EPAYTEST',
        ESEWA_SECRET_KEY: 'esewa-secret',
        ESEWA_PAYMENT_URL: 'https://rc-epay.esewa.com.np/api/epay/main/v2/form',
        ESEWA_STATUS_CHECK_URL: 'https://rc.esewa.com.np/api/epay/transaction/status/',
        ESEWA_SUCCESS_URL: 'https://app.hamropasal.test/payments/esewa/success',
        ESEWA_FAILURE_URL: 'https://app.hamropasal.test/payments/esewa/failure',
        KHALTI_SECRET_KEY: 'khalti-secret',
        KHALTI_BASE_URL: 'https://a.khalti.com/api/v2',
        KHALTI_RETURN_URL: 'https://app.hamropasal.test/payments/khalti/return',
        KHALTI_WEBSITE_URL: 'https://hamropasal.test',
        SMS_PROVIDER: 'MOCK',
      },
    },
  );
  return stdout;
}

/**
 * Phase 23: one order through the whole platform, every step through the public HTTP API over real
 * PostgreSQL + Redis, in the order a customer, a shop and a rider would take it. The steps share
 * state and must run in sequence.
 *
 * A prepaid (eSewa) order from a PLATFORM_FLEET shop at 10 % commission:
 * 2 × 500 NPR + 50 NPR delivery fee = 1050 NPR.
 *
 * The one thing the test does not wait for is the customer's 60 s cancellation window: the order's
 * placement is moved 61 s into the past before the shop dispatches.
 */
describe('end-to-end order lifecycle', () => {
  const STOCK = 10;
  let t: TestApp;

  let customerId: string;
  let riderId: string;
  let vendorId: string;
  let vendorUserId: string;
  let categoryId: string;
  let productId: string;

  let orderId: string;
  let deliveryOtp: string;
  let deliveryId: string;
  let escrowAtStart: number;
  let revenueAtStart: number;

  beforeAll(async () => {
    t = buildTestApp();
    const db = t.container.db;
    customerId = await createUser(db);
    riderId = await createUser(db, 'DRIVER');
    vendorId = await createVendor(db, {
      businessName: 'Lifecycle Kirana Pasal',
      fulfillmentMode: 'PLATFORM_FLEET',
      commissionRate: 0.1,
      baseDeliveryFee: 50,
      minOrderValue: 500,
    });
    vendorUserId = await vendorUserIdOf(db, vendorId);
    categoryId = await createCategory(db, { name: 'Lifecycle Groceries' });
    productId = await createProduct(db, vendorId, STOCK, 500, { category_id: categoryId });
    escrowAtStart = (await balanceOf(db, 'SYSTEM_ESCROW')) ?? 0;
    revenueAtStart = (await balanceOf(db, 'PLATFORM_REVENUE')) ?? 0;
  });

  afterAll(async () => {
    await t.container.close();
  });

  const db = () => t.container.db;
  const asCustomer = () => bearer(customerId);
  const asVendor = () => bearer(vendorUserId, 'VENDOR');
  const asRider = () => bearer(riderId, 'DRIVER');
  const here = { lat: DELIVERY_ADDRESS.exact_lat, lng: DELIVERY_ADDRESS.exact_lng };

  async function orderRow() {
    const [row] = await db().select().from(orders).where(eq(orders.id, orderId));
    if (row === undefined) throw new Error(`order ${orderId} not found`);
    return row;
  }

  async function settlementJournals() {
    return (
      await db().select().from(ledgerTransactions).where(eq(ledgerTransactions.order_id, orderId))
    ).filter((row) => row.kind === 'ORDER_SETTLEMENT');
  }

  it('1. the customer browses the catalogue: category, product, shop feed and menu', async () => {
    const categories = bodyOf(
      categoryListResponseSchema,
      await request(t.app).get('/api/categories'),
    );
    expect(categories.categories.map((category) => category.id)).toContain(categoryId);

    const listed = bodyOf(
      productListResponseSchema,
      await request(t.app).get('/api/products').query({ category_id: categoryId }),
    );
    expect(listed.products).toHaveLength(1);
    expect(listed.products[0]).toMatchObject({
      id: productId,
      vendor: { id: vendorId, business_name: 'Lifecycle Kirana Pasal' },
      price_npr: 500,
      in_stock: true,
      stock_quantity: STOCK,
    });

    const feed = bodyOf(
      feedResponseSchema,
      await request(t.app)
        .get('/api/vendors')
        .set('authorization', asCustomer())
        .query({
          ...here,
          municipality_palika_string: DELIVERY_ADDRESS.municipality_palika_string,
        }),
    );
    expect(feed.serviceable.map((entry) => entry.vendor.id)).toContain(vendorId);

    const menu = bodyOf(
      vendorMenuSchema,
      await request(t.app)
        .get(`/api/vendors/${vendorId}/products`)
        .set('authorization', asCustomer())
        .query(here),
    );
    expect(menu.serviceable).toBe(true);
    expect(menu.products).toEqual([
      expect.objectContaining({ id: productId, price_npr: 500, stock_quantity: STOCK }),
    ]);
  });

  it('2. checkout locks the cart for 600 s and creates the order awaiting payment', async () => {
    const res = await request(t.app)
      .post('/api/cart/checkout')
      .set('authorization', asCustomer())
      .send({
        idempotency_key: randomUUID(),
        vendor_id: vendorId,
        payment_method: 'ESEWA',
        items: [{ product_id: productId, quantity: 2 }],
        delivery_address: DELIVERY_ADDRESS,
      });

    expect(res.status).toBe(201);
    const body = bodyOf(checkoutResponseSchema, res);
    expect(body.order).toMatchObject({
      state: 'PENDING_PAYMENT',
      payment_method: 'ESEWA',
      payment_status: 'PENDING',
      fulfillment: 'PLATFORM_FLEET',
      subtotal_npr: 1000,
      delivery_fee_npr: 50,
      total_npr: 1050,
    });
    expect(body.reservation.id).not.toBeNull();
    expect(body.delivery_otp).toMatch(/^[0-9]{4}$/);
    orderId = body.order.id;
    deliveryOtp = body.delivery_otp ?? '';

    const lock = bodyOf(
      lockStatusResponseSchema,
      await request(t.app)
        .get('/api/cart/lock-status')
        .set('authorization', asCustomer())
        .query({ order_id: orderId }),
    );
    expect(lock.lock.status).toBe('ACTIVE');
    expect(lock.lock.ttl_ms).toBeGreaterThan(590_000);
    expect(lock.lock.ttl_ms).toBeLessThanOrEqual(600_000);
    // Held in Redis only: PostgreSQL stock moves when the payment is confirmed.
    expect(await stockOf(db(), productId)).toBe(STOCK);
  });

  it('3. the eSewa payment places the order: escrow funded, inventory decreased', async () => {
    const initiate = await request(t.app)
      .post('/api/payments/esewa/initiate')
      .set('authorization', asCustomer())
      .send({ order_id: orderId });
    expect(initiate.status).toBe(200);
    const { fields } = bodyOf(esewaInitiateResponseSchema, initiate);

    const paid = await request(t.app)
      .post('/api/payments/esewa/webhook')
      .send({
        data: esewaCallback({
          transaction_uuid: fields.transaction_uuid ?? '',
          total_amount: '1050.0',
        }),
      });

    expect(paid.status).toBe(200);
    expect(bodyOf(paymentStatusResponseSchema, paid).payment).toMatchObject({
      order_id: orderId,
      order_state: 'PLACED',
      payment_status: 'PAID',
      duplicate: false,
    });
    expect(await stockOf(db(), productId)).toBe(STOCK - 2);
    expect(await balanceOf(db(), 'SYSTEM_ESCROW')).toBe(escrowAtStart + 1050);
    // Nothing reaches the shop before delivery (SPEC §5).
    expect(await balanceOf(db(), { vendorId })).toBe(0);
  });

  it('4. the vendor sees the order and accepts it', async () => {
    const open = bodyOf(
      vendorOrderListResponseSchema,
      await request(t.app).get('/api/vendors/orders').set('authorization', asVendor()),
    );
    expect(open.orders.map((order) => order.id)).toEqual([orderId]);

    const accepted = await request(t.app)
      .post(`/api/vendors/orders/${orderId}/accept`)
      .set('authorization', asVendor());

    expect(accepted.status).toBe(200);
    expect(bodyOf(vendorOrderDecisionResponseSchema, accepted)).toEqual({
      order_id: orderId,
      state: 'PREPARING',
      refund_required: false,
    });
  });

  it('5. the vendor dispatches after the 60 s window, which opens the gig for riders', async () => {
    const early = await request(t.app)
      .post(`/api/vendors/orders/${orderId}/dispatch`)
      .set('authorization', asVendor());
    expect(early.status).toBe(422);

    await backdatePlacement(db(), orderId, 61);
    const dispatched = await request(t.app)
      .post(`/api/vendors/orders/${orderId}/dispatch`)
      .set('authorization', asVendor());

    expect(dispatched.status).toBe(200);
    expect(bodyOf(vendorOrderDispatchResponseSchema, dispatched).state).toBe('OUT_FOR_DELIVERY');
    const [delivery] = await db().select().from(deliveries).where(eq(deliveries.order_id, orderId));
    expect(delivery).toMatchObject({ state: 'OFFERED', rider_id: null });
    deliveryId = delivery?.id ?? '';
  });

  it('6. the rider accepts the delivery and picks it up', async () => {
    const accepted = await request(t.app)
      .post(`/api/deliveries/${deliveryId}/accept`)
      .set('authorization', asRider());
    expect(accepted.status).toBe(200);
    expect(bodyOf(deliveryResponseSchema, accepted).delivery).toMatchObject({
      id: deliveryId,
      state: 'ASSIGNED',
      assigned_to_me: true,
    });

    const mine = bodyOf(
      deliveryListResponseSchema,
      await request(t.app).get('/api/deliveries').set('authorization', asRider()),
    ).deliveries.filter((delivery) => delivery.assigned_to_me);
    expect(mine.map((delivery) => delivery.id)).toEqual([deliveryId]);
    expect(mine[0]?.order.vendor_business_name).toBe('Lifecycle Kirana Pasal');

    const pickedUp = await request(t.app)
      .post(`/api/deliveries/${deliveryId}/pickup`)
      .set('authorization', asRider());
    expect(pickedUp.status).toBe(200);
    expect(bodyOf(deliveryResponseSchema, pickedUp).delivery.state).toBe('PICKED_UP');
    expect((await orderRow()).driver_user_id).toBe(riderId);
  });

  it("7. the rider enters the customer's code: delivered, and escrow splits in that commit", async () => {
    const res = await request(t.app)
      .post(`/api/deliveries/${deliveryId}/complete`)
      .set('authorization', asRider())
      .send({ delivery_otp: deliveryOtp });

    expect(res.status).toBe(200);
    expect(bodyOf(deliveryConfirmedResponseSchema, res)).toMatchObject({
      order_id: orderId,
      state: 'DELIVERED',
    });

    const row = await orderRow();
    expect(row).toMatchObject({
      state: 'DELIVERED',
      payment_status: 'PAID',
      delivery_otp: null,
      reconciled_at: null,
    });
    expect(row.delivered_at).not.toBeNull();

    // 1050 leaves escrow: 900 to the shop (1000 − 10 %), 100 to the platform, 50 to the rider.
    expect(await settlementJournals()).toHaveLength(1);
    expect(await balanceOf(db(), { vendorId })).toBe(900);
    expect(await balanceOf(db(), { driverUserId: riderId })).toBe(50);
    expect(await balanceOf(db(), 'PLATFORM_REVENUE')).toBe(revenueAtStart + 100);
    expect(await balanceOf(db(), 'SYSTEM_ESCROW')).toBe(escrowAtStart);

    const tracked = bodyOf(
      orderDetailResponseSchema,
      await request(t.app).get(`/api/orders/${orderId}`).set('authorization', asCustomer()),
    );
    expect(tracked.order.state).toBe('DELIVERED');

    const transitions = (await outboxFor(db(), orderId))
      .filter((event) => event.event_type === 'order.state_changed')
      .sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime())
      .map((event) => orderStateChangedPayloadSchema.parse(event.payload).to_state);
    expect(transitions).toEqual([
      'PENDING_PAYMENT',
      'PLACED',
      'PREPARING',
      'OUT_FOR_DELIVERY',
      'DELIVERED',
    ]);
  });

  it('8. the midnight reconciliation, run by hand, verifies the settlement and pays nobody twice', async () => {
    const before = bodyOf(
      vendorFinanceLedgerResponseSchema,
      await request(t.app).get('/api/vendor/finance/ledger').set('authorization', asVendor()),
    );
    expect(before).toMatchObject({
      available_balance_npr: 900,
      unreconciled_order_count: 1,
      reconciled_orders: [],
    });

    const log = await runMidnightReconciliation();

    expect(log).toMatch(/order reconciliation: \d+ order\(s\) reconciled/);
    expect((await orderRow()).reconciled_at).not.toBeNull();
    expect(await settlementJournals()).toHaveLength(1);
    expect(await balanceOf(db(), { vendorId })).toBe(900);
    expect(await balanceOf(db(), { driverUserId: riderId })).toBe(50);

    const after = bodyOf(
      vendorFinanceLedgerResponseSchema,
      await request(t.app).get('/api/vendor/finance/ledger').set('authorization', asVendor()),
    );
    expect(after).toMatchObject({
      available_balance_npr: 900,
      pending_balance_npr: 0,
      unreconciled_order_count: 0,
    });
    expect(after.reconciled_orders).toEqual([
      expect.objectContaining({
        order_id: orderId,
        payment_method: 'ESEWA',
        fulfillment: 'PLATFORM_FLEET',
        subtotal_npr: 1000,
        commission_npr: 100,
        vendor_cut_npr: 900,
        wallet_amount_npr: 900,
      }),
    ]);

    // A second run finds nothing left to do for this order.
    const reconciledAt = (await orderRow()).reconciled_at;
    await runMidnightReconciliation();
    expect((await orderRow()).reconciled_at).toEqual(reconciledAt);
    expect(await balanceOf(db(), { vendorId })).toBe(900);
  });
});
