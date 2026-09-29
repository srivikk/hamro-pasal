import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import {
  createOrder,
  createTestPool,
  createUser,
  createVendor,
  firstRow,
  orderInsertParams,
  orderInsertSql,
  pgError,
} from './support/fixtures';

describe('order idempotency guards', () => {
  let pool: Pool;
  let customerId: string;
  let vendorId: string;

  beforeAll(async () => {
    pool = createTestPool();
    customerId = await createUser(pool);
    vendorId = await createVendor(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  const countByKey = async (key: string): Promise<number> =>
    Number(
      firstRow(
        (
          await pool.query<{ n: string }>(
            'SELECT count(*) AS n FROM orders WHERE idempotency_key = $1',
            [key],
          )
        ).rows,
      ).n,
    );

  it('rejects a second order with the same idempotency key', async () => {
    const key = randomUUID();
    await createOrder(pool, { vendorId, customerId, idempotencyKey: key });

    const error = await pgError(createOrder(pool, { vendorId, customerId, idempotencyKey: key }));

    expect(error.code).toBe('23505');
    expect(error.constraint).toBe('orders_idempotency_key_key');
    expect(await countByKey(key)).toBe(1);
  });

  it('lets a retried checkout resolve to the original order via ON CONFLICT', async () => {
    const key = randomUUID();
    const originalId = await createOrder(pool, { vendorId, customerId, idempotencyKey: key });

    const retry = await pool.query<{ id: string }>(
      orderInsertSql.replace(
        'RETURNING id',
        'ON CONFLICT (idempotency_key) DO NOTHING RETURNING id',
      ),
      orderInsertParams({ vendorId, customerId, idempotencyKey: key }),
    );
    const existing = await pool.query<{ id: string }>(
      'SELECT id FROM orders WHERE idempotency_key = $1',
      [key],
    );

    expect(retry.rowCount).toBe(0);
    expect(firstRow(existing.rows).id).toBe(originalId);
  });

  it('creates exactly one order under concurrent duplicate submissions', async () => {
    const key = randomUUID();

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        createOrder(pool, { vendorId, customerId, idempotencyKey: key }),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await countByKey(key)).toBe(1);
  });

  it('rejects a second order for the same payment gateway transaction', async () => {
    const pidx = `pidx-${randomUUID()}`;
    await createOrder(pool, {
      vendorId,
      customerId,
      paymentMethod: 'KHALTI',
      paymentGatewayRef: pidx,
    });

    const duplicate = await pgError(
      createOrder(pool, { vendorId, customerId, paymentMethod: 'KHALTI', paymentGatewayRef: pidx }),
    );

    expect(duplicate.constraint).toBe('orders_payment_gateway_ref_key');
    // The same reference string on a different gateway is a different transaction.
    await expect(
      createOrder(pool, { vendorId, customerId, paymentMethod: 'ESEWA', paymentGatewayRef: pidx }),
    ).resolves.toEqual(expect.any(String));
  });

  it('rejects a gateway reference on a COD order', async () => {
    const error = await pgError(
      createOrder(pool, { vendorId, customerId, paymentMethod: 'COD', paymentGatewayRef: 'ref' }),
    );

    expect(error.constraint).toBe('orders_cod_has_no_gateway_ref_check');
  });

  it('refuses to store a raw delivery OTP', async () => {
    const error = await pgError(createOrder(pool, { vendorId, customerId, deliveryOtp: '4821' }));

    expect(error.constraint).toBe('orders_delivery_otp_bcrypt_check');
  });

  it('flags a refund only on an order whose payment was captured', async () => {
    const orderId = await createOrder(pool, { vendorId, customerId, paymentMethod: 'COD' });

    const error = await pgError(
      pool.query('UPDATE orders SET refund_required = true WHERE id = $1', [orderId]),
    );
    const paid = await pool.query(
      `UPDATE orders SET payment_status = 'PAID', refund_required = true WHERE id = $1`,
      [orderId],
    );

    expect(error.constraint).toBe('orders_refund_required_paid_check');
    expect(paid.rowCount).toBe(1);
  });

  it('requires placed_at exactly when an order has been placed', async () => {
    const orderId = await createOrder(pool, { vendorId, customerId });
    const setState = (state: string, placedAt: 'now()' | 'NULL') =>
      pool.query(`UPDATE orders SET state = $2, placed_at = ${placedAt} WHERE id = $1`, [
        orderId,
        state,
      ]);

    expect((await pgError(setState('PENDING_PAYMENT', 'now()'))).constraint).toBe(
      'orders_placed_at_check',
    );
    expect((await pgError(setState('PLACED', 'NULL'))).constraint).toBe('orders_placed_at_check');
    expect((await pgError(setState('DELIVERED', 'NULL'))).constraint).toBe(
      'orders_placed_at_check',
    );
    // Paid after the lock expired: FAILED without ever being placed.
    expect((await setState('FAILED', 'NULL')).rowCount).toBe(1);
    expect((await setState('PLACED', 'now()')).rowCount).toBe(1);
    // Delivery failed (ghost customer): FAILED after placement keeps its timestamp.
    expect((await setState('FAILED', 'now()')).rowCount).toBe(1);
  });

  it('keeps one Nepal delivery address per order, with a generated PostGIS point', async () => {
    const orderId = await createOrder(pool, { vendorId, customerId });
    const insert = (ward: number, province = 3) =>
      pool.query(
        `INSERT INTO order_addresses (order_id, province_id, district_string,
           municipality_palika_string, ward_number, tole_locality, landmark, exact_lat, exact_lng)
         VALUES ($1, $2, 'Kathmandu', 'Kathmandu Metropolitan City', $3, 'Thamel', 'Chowk', 27.7149, 85.3106)`,
        [orderId, province, ward],
      );

    expect((await pgError(insert(0))).constraint).toBe('order_addresses_ward_check');
    expect((await pgError(insert(26, 8))).constraint).toBe('order_addresses_province_check');
    await insert(26);
    expect((await pgError(insert(27))).constraint).toBe('order_addresses_pkey');

    const { rows } = await pool.query<{ srid: number; lng: number; lat: number }>(
      `SELECT ST_SRID(location) AS srid, ST_X(location) AS lng, ST_Y(location) AS lat
         FROM order_addresses WHERE order_id = $1`,
      [orderId],
    );
    expect(firstRow(rows)).toEqual({ srid: 4326, lng: 85.3106, lat: 27.7149 });
  });

  it('rejects the same product twice in one order', async () => {
    const orderId = await createOrder(pool, { vendorId, customerId });
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO products (vendor_id, name, price_npr, stock_quantity) VALUES ($1, $2, 100, 5) RETURNING id`,
      [vendorId, `Product ${randomUUID()}`],
    );
    const productId = firstRow(rows).id;
    const addItem = () =>
      pool.query(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price_npr, quantity)
         VALUES ($1, $2, 'Item', 100, 1)`,
        [orderId, productId],
      );

    await addItem();
    const error = await pgError(addItem());

    expect(error.constraint).toBe('order_items_order_id_product_id_key');
  });

  it('allows one review per side per order, quarantined by default', async () => {
    const orderId = await createOrder(pool, { vendorId, customerId });
    const review = (direction: string) =>
      pool.query<{ is_published: boolean; published_at: Date | null }>(
        `INSERT INTO reviews (order_id, direction, rating) VALUES ($1, $2, 4) RETURNING is_published, published_at`,
        [orderId, direction],
      );

    expect(firstRow((await review('CUSTOMER_TO_VENDOR')).rows)).toEqual({
      is_published: false,
      published_at: null,
    });
    await review('VENDOR_TO_CUSTOMER');
    const duplicate = await pgError(review('CUSTOMER_TO_VENDOR'));

    expect(duplicate.constraint).toBe('reviews_order_id_direction_key');
  });
});
