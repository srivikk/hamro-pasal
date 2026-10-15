import { randomInt, randomUUID } from 'node:crypto';

import {
  auditLogs,
  createDatabase,
  orderItems,
  orders,
  outboxEvents,
  products,
  users,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import { and, eq, sql } from 'drizzle-orm';

import { VendorAcceptanceExpiryService } from '../src/sla/vendor-acceptance-expiry';

/**
 * Step 7.3 (decided 2026-10-15): an order unanswered 5 minutes after it was placed is cancelled
 * and counts as missed; three in a row pause the shop. Real PostgreSQL.
 */
describe('vendor acceptance expiry and Auto-Pause (real PostgreSQL)', () => {
  let db: Database;
  let expiry: VendorAcceptanceExpiryService;

  beforeAll(() => {
    db = createDatabase(process.env.TEST_DATABASE_URL ?? '', { max: 10 });
    expiry = new VendorAcceptanceExpiryService(db);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  async function user(role: 'CUSTOMER' | 'VENDOR'): Promise<string> {
    const phone = `+9779${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
    const [row] = await db.insert(users).values({ phone, role }).returning({ id: users.id });
    if (row === undefined) throw new Error('user not created');
    return row.id;
  }

  async function shop(): Promise<{ vendorId: string; productId: string }> {
    const [vendor] = await db
      .insert(vendors)
      .values({
        user_id: await user('VENDOR'),
        business_name: 'Thamel Kirana Pasal',
        phone: '+9779800000011',
        status: 'LIVE',
        pricing_model: 'COMMISSION',
        commission_rate: 0.1,
        delivery_scope: 'RADIUS_BOUND',
        fulfillment_mode: 'SELF_DELIVERY',
        radius_km: 5,
        municipality_palika_string: 'Kathmandu Metropolitan City',
        min_order_value: 0,
        base_delivery_fee_npr: 50,
        location: { x: 85.3123, y: 27.7154 },
      })
      .returning({ id: vendors.id });
    if (vendor === undefined) throw new Error('vendor not created');
    const [product] = await db
      .insert(products)
      .values({
        vendor_id: vendor.id,
        name: `Rice ${randomUUID()}`,
        price_npr: 500,
        stock_quantity: 10,
      })
      .returning({ id: products.id });
    if (product === undefined) throw new Error('product not created');
    return { vendorId: vendor.id, productId: product.id };
  }

  /** A PLACED cash order of 2 units (stock already taken), placed 5 minutes ago. */
  async function placed(vendorId: string, productId: string): Promise<string> {
    const [order] = await db
      .insert(orders)
      .values({
        idempotency_key: randomUUID(),
        customer_id: await user('CUSTOMER'),
        vendor_id: vendorId,
        state: 'PLACED',
        placed_at: sql`now() - interval '300 seconds'`,
        subtotal: 1000,
        delivery_fee: 50,
        platform_commission_amount: 100,
        fulfillment_locked: 'SELF_DELIVERY',
        payment_method: 'COD',
        delivery_otp: '$2b$10$abcdefghijklmnopqrstuuM3bJ0n9ZkZ2p9Y5o0t7m6c1QwV8e2yG',
      })
      .returning({ id: orders.id });
    if (order === undefined) throw new Error('order not created');
    await db.insert(orderItems).values({
      order_id: order.id,
      product_id: productId,
      product_name: 'Rice',
      unit_price_npr: 500,
      quantity: 2,
    });
    return order.id;
  }

  const job = (orderId: string, vendorId: string) => ({
    order_id: orderId,
    vendor_id: vendorId,
    kind: 'EXPIRE' as const,
  });
  const vendorRow = async (id: string) =>
    (await db.select().from(vendors).where(eq(vendors.id, id)))[0];
  const eventsOf = (aggregateId: string, type: string) =>
    db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.aggregate_id, aggregateId), eq(outboxEvents.event_type, type)));

  it('cancels an order still PLACED, puts its stock back, announces it, and counts it as missed', async () => {
    const { vendorId, productId } = await shop();
    const orderId = await placed(vendorId, productId);

    expect(await expiry.cancelIfUnanswered(job(orderId, vendorId))).toEqual({
      kind: 'CANCELLED',
      paused: false,
    });

    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(order?.state).toBe('CANCELED');
    const [product] = await db.select().from(products).where(eq(products.id, productId));
    expect(product?.stock_quantity).toBe(12);
    expect(await eventsOf(orderId, 'order.state_changed')).toHaveLength(1);
    expect((await vendorRow(vendorId))?.consecutive_missed_orders).toBe(1);
  });

  it('leaves an order the vendor answered alone, and counts nothing', async () => {
    const { vendorId, productId } = await shop();
    const orderId = await placed(vendorId, productId);
    await db.update(orders).set({ state: 'PREPARING' }).where(eq(orders.id, orderId));

    expect(await expiry.cancelIfUnanswered(job(orderId, vendorId))).toEqual({
      kind: 'NOT_PENDING',
    });
    expect((await vendorRow(vendorId))?.consecutive_missed_orders).toBe(0);
  });

  it('pauses the shop at the third missed order in a row, once, with its audit entry and event', async () => {
    const { vendorId, productId } = await shop();
    const ids = [
      await placed(vendorId, productId),
      await placed(vendorId, productId),
      await placed(vendorId, productId),
      await placed(vendorId, productId),
    ];

    const outcomes = [];
    for (const id of ids) outcomes.push(await expiry.cancelIfUnanswered(job(id, vendorId)));

    expect(outcomes).toEqual([
      { kind: 'CANCELLED', paused: false },
      { kind: 'CANCELLED', paused: false },
      { kind: 'CANCELLED', paused: true },
      { kind: 'CANCELLED', paused: false },
    ]);
    const vendor = await vendorRow(vendorId);
    expect(vendor?.auto_paused_at).not.toBeNull();
    expect(vendor?.status).toBe('LIVE'); // the pause never changes the status
    const paused = await eventsOf(vendorId, 'vendor.auto_paused');
    expect(paused).toHaveLength(1);
    expect(paused[0]?.payload).toMatchObject({ vendor_id: vendorId, missed_orders: 3 });
    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entity_id, vendorId), eq(auditLogs.action, 'VENDOR_AUTO_PAUSED')));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_user_id: null,
      system_actor: 'VENDOR_ACCEPTANCE_EXPIRY',
    });
  });

  it('cancels an order once when the job runs five times at once', async () => {
    const { vendorId, productId } = await shop();
    const orderId = await placed(vendorId, productId);

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => expiry.cancelIfUnanswered(job(orderId, vendorId))),
    );

    expect(outcomes.filter((outcome) => outcome.kind === 'CANCELLED')).toHaveLength(1);
    expect((await vendorRow(vendorId))?.consecutive_missed_orders).toBe(1);
    const [product] = await db.select().from(products).where(eq(products.id, productId));
    expect(product?.stock_quantity).toBe(12);
  });
});
