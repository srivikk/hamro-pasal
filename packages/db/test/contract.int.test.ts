import { randomUUID } from 'node:crypto';

import {
  customerAddressSchema,
  disputeSchema,
  orderItemSchema,
  orderSchema,
  platformSettingsSchema,
  productSchema,
  reviewSchema,
  userSchema,
  vendorSchema,
  walletLedgerSchema,
} from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';

import { createDatabase, type Database } from '../src/client';
import {
  customerAddresses,
  disputes,
  orderItems,
  orders,
  platformSettings,
  products,
  reviews,
  users,
  vendors,
  walletLedgers,
} from '../src/schema';
import { BCRYPT_OTP_HASH, uniqueNepalPhone } from './support/fixtures';

/**
 * Runtime half of the schema contract (the compile-time half is src/schema/contract.ts):
 * real rows read back through Drizzle must parse with the strict Zod schemas in shared-types.
 */
describe('Drizzle rows satisfy the shared-types Zod schemas', () => {
  let db: Database;

  beforeAll(() => {
    db = createDatabase(process.env.TEST_DATABASE_URL ?? '');
  });

  afterAll(async () => {
    await db.$client.end();
  });

  function one<T>(rows: T[]): T {
    const [row] = rows;
    if (row === undefined) throw new Error('Expected a row');
    return row;
  }

  it('round-trips every table', async () => {
    const customer = one(
      await db
        .insert(users)
        .values({
          phone: uniqueNepalPhone(),
          role: 'CUSTOMER',
          first_name: 'Aarav',
          last_name: 'Shrestha',
        })
        .returning(),
    );
    const owner = one(
      await db
        .insert(users)
        .values({ phone: uniqueNepalPhone(), role: 'VENDOR', first_name: 'Ram' })
        .returning(),
    );
    const address = one(
      await db
        .insert(customerAddresses)
        .values({
          user_id: customer.id,
          province_id: 3,
          district_string: 'Kathmandu',
          municipality_palika_string: 'Kathmandu Metropolitan City',
          ward_number: 26,
          tole_locality: 'Thamel',
          landmark: 'Near Kathmandu Guest House',
          exact_lat: 27.7149,
          exact_lng: 85.3106,
        })
        .returning(),
    );
    const vendor = one(
      await db
        .insert(vendors)
        .values({
          user_id: owner.id,
          business_name: 'Thamel Kirana Pasal',
          phone: owner.phone,
          status: 'LIVE',
          pricing_model: 'COMMISSION',
          commission_rate: 0.1,
          delivery_scope: 'RADIUS_BOUND',
          radius_km: 5,
          city_string: 'Kathmandu',
          min_order_value: 500,
          base_delivery_fee_npr: 50,
          location: { x: 85.3123, y: 27.7154 },
        })
        .returning(),
    );
    const product = one(
      await db
        .insert(products)
        .values({
          vendor_id: vendor.id,
          name: 'Ilam Tea 500g',
          price_npr: 450.5,
          stock_quantity: 10,
        })
        .returning(),
    );
    const order = one(
      await db
        .insert(orders)
        .values({
          idempotency_key: randomUUID(),
          customer_id: customer.id,
          vendor_id: vendor.id,
          subtotal: 901,
          delivery_fee: 50,
          platform_commission_amount: 90.1,
          fulfillment_locked: 'SELF_DELIVERY',
          payment_method: 'COD',
          delivery_otp: BCRYPT_OTP_HASH,
        })
        .returning(),
    );
    const item = one(
      await db
        .insert(orderItems)
        .values({
          order_id: order.id,
          product_id: product.id,
          product_name: product.name,
          unit_price_npr: 450.5,
          quantity: 2,
        })
        .returning(),
    );
    const ledger = one(
      await db
        .insert(walletLedgers)
        .values({
          vendor_id: vendor.id,
          order_id: order.id,
          entry_type: 'COD_COMMISSION',
          amount_npr: -90.1,
        })
        .returning(),
    );
    const dispute = one(
      await db
        .insert(disputes)
        .values({ order_id: order.id, opened_by_user_id: customer.id, reason: 'Item missing' })
        .returning(),
    );
    const review = one(
      await db
        .insert(reviews)
        .values({ order_id: order.id, direction: 'CUSTOMER_TO_VENDOR', rating: 5 })
        .returning(),
    );

    const read = async <T>(query: Promise<T[]>) => one(await query);
    const reloadedVendor = await read(db.select().from(vendors).where(eq(vendors.id, vendor.id)));

    expect(
      userSchema.parse(await read(db.select().from(users).where(eq(users.id, customer.id)))),
    ).toBeDefined();
    expect(
      customerAddressSchema.parse(
        await read(db.select().from(customerAddresses).where(eq(customerAddresses.id, address.id))),
      ).location,
    ).toEqual({ x: 85.3106, y: 27.7149 });
    expect(vendorSchema.parse(reloadedVendor).location).toEqual({ x: 85.3123, y: 27.7154 });
    expect(reloadedVendor.wallet_balance_npr).toBe(-90.1);
    expect(reloadedVendor.commission_rate).toBe(0.1);
    expect(
      productSchema.parse(await read(db.select().from(products).where(eq(products.id, product.id))))
        .price_npr,
    ).toBe(450.5);
    expect(
      orderSchema.parse(await read(db.select().from(orders).where(eq(orders.id, order.id)))),
    ).toBeDefined();
    expect(
      orderItemSchema.parse(
        await read(db.select().from(orderItems).where(eq(orderItems.id, item.id))),
      ),
    ).toBeDefined();
    expect(
      walletLedgerSchema.parse(
        await read(db.select().from(walletLedgers).where(eq(walletLedgers.id, ledger.id))),
      ).amount_npr,
    ).toBe(-90.1);
    expect(
      disputeSchema.parse(
        await read(db.select().from(disputes).where(eq(disputes.id, dispute.id))),
      ),
    ).toBeDefined();
    expect(
      reviewSchema.parse(await read(db.select().from(reviews).where(eq(reviews.id, review.id)))),
    ).toBeDefined();
    expect(
      platformSettingsSchema.parse(await read(db.select().from(platformSettings))),
    ).toMatchObject({
      id: true,
      vendor_wallet_suspension_limit_npr: -2000,
    });
  });

  it('bumps updated_at on update', async () => {
    const user = one(
      await db
        .insert(users)
        .values({ phone: uniqueNepalPhone(), role: 'CUSTOMER', first_name: 'Sita' })
        .returning(),
    );

    const updated = one(
      await db
        .update(users)
        .set({ first_name: 'Sita Devi' })
        .where(eq(users.id, user.id))
        .returning(),
    );

    expect(updated.updated_at.getTime()).toBeGreaterThan(user.updated_at.getTime());
    expect(updated.created_at).toEqual(user.created_at);
  });
});
