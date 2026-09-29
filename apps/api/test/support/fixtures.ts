import { randomInt, randomUUID } from 'node:crypto';

import {
  createDatabase,
  ledgerAccounts,
  orders,
  outboxEvents,
  products,
  users,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import type {
  FulfillmentMode,
  Order,
  PaymentMethod,
  PricingModel,
  UserRole,
  VendorFulfillmentMode,
} from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';

import { RedisConnectionPool } from '../../src/infra/redis-pool';

export const BCRYPT_OTP_HASH = '$2b$10$abcdefghijklmnopqrstuuM3bJ0n9ZkZ2p9Y5o0t7m6c1QwV8e2yG';

export function testDatabase(): Database {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined) throw new Error('TEST_DATABASE_URL not set (globalSetup did not run)');
  return createDatabase(url, { max: 30 });
}

export function testRedisUrl(): string {
  const url = process.env.TEST_REDIS_URL;
  if (url === undefined) throw new Error('TEST_REDIS_URL not set (globalSetup did not run)');
  return url;
}

export function testRedisPool(size = 20): RedisConnectionPool {
  const url = testRedisUrl();
  return new RedisConnectionPool(() => new Redis(url, { maxRetriesPerRequest: 3 }), size);
}

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('Expected a row');
  return row;
}

export async function createUser(db: Database, role: UserRole = 'CUSTOMER'): Promise<string> {
  const phone = `+9779${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
  return one(
    await db.insert(users).values({ phone, role, first_name: 'Test' }).returning({ id: users.id }),
  ).id;
}

export interface VendorFixture {
  pricingModel?: PricingModel;
  commissionRate?: number;
  fulfillmentMode?: VendorFulfillmentMode;
  minOrderValue?: number;
  baseDeliveryFee?: number;
}

export async function createVendor(db: Database, options: VendorFixture = {}): Promise<string> {
  const userId = await createUser(db, 'VENDOR');
  const pricingModel = options.pricingModel ?? 'COMMISSION';
  return one(
    await db
      .insert(vendors)
      .values({
        user_id: userId,
        business_name: 'Test Pasal',
        phone: '+9779800000000',
        status: 'LIVE',
        pricing_model: pricingModel,
        commission_rate: options.commissionRate ?? (pricingModel === 'SUBSCRIPTION' ? 0 : 0.1),
        delivery_scope: 'RADIUS_BOUND',
        fulfillment_mode: options.fulfillmentMode ?? 'SELF_DELIVERY',
        radius_km: 5,
        municipality_palika_string: 'Kathmandu Metropolitan City',
        min_order_value: options.minOrderValue ?? 0,
        base_delivery_fee_npr: options.baseDeliveryFee ?? 50,
        location: { x: 85.3123, y: 27.7154 },
      })
      .returning({ id: vendors.id }),
  ).id;
}

export async function createProduct(
  db: Database,
  vendorId: string,
  stock: number,
  priceNpr = 100,
): Promise<string> {
  return one(
    await db
      .insert(products)
      .values({
        vendor_id: vendorId,
        name: `Product ${randomUUID()}`,
        price_npr: priceNpr,
        stock_quantity: stock,
      })
      .returning({ id: products.id }),
  ).id;
}

export async function stockOf(db: Database, productId: string): Promise<number> {
  return one(await db.select().from(products).where(eq(products.id, productId))).stock_quantity;
}

export interface OrderFixture {
  vendorId: string;
  customerId: string;
  paymentMethod?: PaymentMethod;
  fulfillment?: FulfillmentMode;
  subtotal?: number;
  deliveryFee?: number;
  commission?: number;
}

export async function createOrder(db: Database, options: OrderFixture): Promise<Order> {
  return one(
    await db
      .insert(orders)
      .values({
        idempotency_key: randomUUID(),
        customer_id: options.customerId,
        vendor_id: options.vendorId,
        subtotal: options.subtotal ?? 1000,
        delivery_fee: options.deliveryFee ?? 50,
        platform_commission_amount: options.commission ?? 100,
        fulfillment_locked: options.fulfillment ?? 'SELF_DELIVERY',
        payment_method: options.paymentMethod ?? 'COD',
        delivery_otp: BCRYPT_OTP_HASH,
      })
      .returning(),
  );
}

export async function markDelivered(
  db: Database,
  orderId: string,
  driverUserId: string | null = null,
) {
  await db
    .update(orders)
    .set({ state: 'DELIVERED', delivered_at: new Date(), driver_user_id: driverUserId })
    .where(eq(orders.id, orderId));
}

export async function outboxFor(db: Database, aggregateId: string) {
  return db.select().from(outboxEvents).where(eq(outboxEvents.aggregate_id, aggregateId));
}

export type BalanceKey =
  'SYSTEM_ESCROW' | 'PLATFORM_REVENUE' | 'GATEWAY_CLEARING:ESEWA' | 'GATEWAY_CLEARING:KHALTI';

/** Current balance of a system account, or of the vendor/driver wallet owned by `ownerId`. */
export async function balanceOf(
  db: Database,
  key: BalanceKey | { vendorId: string } | { driverUserId: string },
) {
  let condition;
  if (typeof key === 'object') {
    condition =
      'vendorId' in key
        ? eq(ledgerAccounts.vendor_id, key.vendorId)
        : eq(ledgerAccounts.driver_user_id, key.driverUserId);
  } else if (key.startsWith('GATEWAY_CLEARING:')) {
    condition = eq(ledgerAccounts.gateway, key.endsWith('ESEWA') ? 'ESEWA' : 'KHALTI');
  } else {
    condition = eq(ledgerAccounts.account_type, key as 'SYSTEM_ESCROW' | 'PLATFORM_REVENUE');
  }
  const [account] = await db.select().from(ledgerAccounts).where(condition);
  return account?.balance_npr ?? null;
}
