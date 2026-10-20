import { randomInt, randomUUID } from 'node:crypto';

import {
  categories,
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
  DeliveryScope,
  FulfillmentMode,
  GeoPoint,
  Order,
  PaymentMethod,
  PricingModel,
  UserRole,
  VendorFulfillmentMode,
  VendorStatus,
} from '@hamro-pasal/shared-types';
import { eq, sql } from 'drizzle-orm';
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
  status?: VendorStatus;
  businessName?: string;
  deliveryScope?: DeliveryScope;
  radiusKm?: number;
  palika?: string;
  location?: GeoPoint;
  /**
   * A PAN a Super Admin has verified. Since 2026-10-20 (SPEC core 10) every path back to LIVE (a
   * debt or admin restore, a reopening) needs one, or lands in SUSPENDED_COMPLIANCE.
   */
  verifiedPan?: boolean;
}

export async function createVendor(db: Database, options: VendorFixture = {}): Promise<string> {
  const userId = await createUser(db, 'VENDOR');
  const pricingModel = options.pricingModel ?? 'COMMISSION';
  return one(
    await db
      .insert(vendors)
      .values({
        user_id: userId,
        business_name: options.businessName ?? 'Test Pasal',
        phone: '+9779800000000',
        status: options.status ?? 'LIVE',
        pricing_model: pricingModel,
        commission_rate: options.commissionRate ?? (pricingModel === 'SUBSCRIPTION' ? 0 : 0.1),
        delivery_scope: options.deliveryScope ?? 'RADIUS_BOUND',
        fulfillment_mode: options.fulfillmentMode ?? 'SELF_DELIVERY',
        radius_km: options.radiusKm ?? 5,
        municipality_palika_string: options.palika ?? 'Kathmandu Metropolitan City',
        min_order_value: options.minOrderValue ?? 0,
        base_delivery_fee_npr: options.baseDeliveryFee ?? 50,
        location: options.location ?? { x: 85.3123, y: 27.7154 },
        ...(options.verifiedPan === true
          ? { tax_id: '302118845', ...(await verifiedPanColumns(db)) }
          : {}),
      })
      .returning({ id: vendors.id }),
  ).id;
}

/**
 * The columns of a PAN a Super Admin has verified. Since 2026-10-20 (SPEC core 10) a shop trades and
 * invoices only on a verified PAN; spread these next to `tax_id`.
 */
export async function verifiedPanColumns(
  db: Database,
): Promise<{ pan_verified_at: Date; pan_verified_by_user_id: string }> {
  return {
    pan_verified_at: new Date(),
    pan_verified_by_user_id: await createUser(db, 'SUPER_ADMIN'),
  };
}

/** The user who runs a vendor (the subject of that vendor's access tokens). */
export async function vendorUserIdOf(db: Database, vendorId: string): Promise<string> {
  return one(
    await db.select({ userId: vendors.user_id }).from(vendors).where(eq(vendors.id, vendorId)),
  ).userId;
}

/**
 * The point exactly `distanceM` metres (geodesic, WGS 84 spheroid) from `origin` along
 * `azimuthDeg`, computed by PostGIS ST_Project, the same geometry model ST_DWithin uses.
 */
export async function pointAtDistance(
  db: Database,
  origin: GeoPoint,
  distanceM: number,
  azimuthDeg = 90,
): Promise<GeoPoint> {
  const { rows } = await db.execute<{ x: number; y: number }>(sql`
    SELECT ST_X(p::geometry) AS x, ST_Y(p::geometry) AS y
    FROM ST_Project(
      ST_SetSRID(ST_MakePoint(${origin.x}::float8, ${origin.y}::float8), 4326)::geography,
      ${distanceM}::float8,
      radians(${azimuthDeg}::float8)
    ) AS p`);
  return one(rows);
}

/** Moves an order's placement `seconds` into the past (the cancellation window's anchor). */
export async function backdatePlacement(db: Database, orderId: string, seconds: number) {
  await db
    .update(orders)
    .set({ placed_at: sql`now() - make_interval(secs => ${seconds}::float8)` })
    .where(eq(orders.id, orderId));
}

/** Moves an order's checkout (creation) time `seconds` into the past. */
export async function backdateCheckout(db: Database, orderId: string, seconds: number) {
  await db
    .update(orders)
    .set({ created_at: sql`now() - make_interval(secs => ${seconds}::float8)` })
    .where(eq(orders.id, orderId));
}

export async function createProduct(
  db: Database,
  vendorId: string,
  stock: number,
  priceNpr = 100,
  extra: Partial<Omit<typeof products.$inferInsert, 'vendor_id'>> = {},
): Promise<string> {
  return one(
    await db
      .insert(products)
      .values({
        vendor_id: vendorId,
        name: `Product ${randomUUID()}`,
        price_npr: priceNpr,
        stock_quantity: stock,
        ...extra,
      })
      .returning({ id: products.id }),
  ).id;
}

export interface CategoryFixture {
  name?: string;
  parentId?: string | null;
  isActive?: boolean;
  displayOrder?: number;
}

/** A taxonomy category with a slug no other test uses. */
export async function createCategory(db: Database, options: CategoryFixture = {}): Promise<string> {
  return one(
    await db
      .insert(categories)
      .values({
        name: options.name ?? 'Test Category',
        slug: `test-${randomUUID()}`,
        parent_id: options.parentId ?? null,
        is_active: options.isActive ?? true,
        display_order: options.displayOrder ?? 0,
      })
      .returning({ id: categories.id }),
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
    .set({
      state: 'DELIVERED',
      placed_at: sql`coalesce(${orders.placed_at}, now())`,
      delivered_at: new Date(),
      driver_user_id: driverUserId,
    })
    .where(eq(orders.id, orderId));
}

export async function outboxFor(db: Database, aggregateId: string) {
  return db.select().from(outboxEvents).where(eq(outboxEvents.aggregate_id, aggregateId));
}

export type BalanceKey =
  'SYSTEM_ESCROW' | 'PLATFORM_REVENUE' | 'GATEWAY_CLEARING:ESEWA' | 'GATEWAY_CLEARING:KHALTI';

/**
 * Current balance of a system account, of the vendor/driver wallet owned by `ownerId`, or (step
 * 7.3) of a vendor's dispute hold, where a delivered prepaid order's earnings wait for 7 days.
 */
export async function balanceOf(
  db: Database,
  key: BalanceKey | { vendorId: string } | { driverUserId: string } | { holdVendorId: string },
) {
  let condition;
  if (typeof key === 'object') {
    condition =
      'vendorId' in key
        ? eq(ledgerAccounts.vendor_id, key.vendorId)
        : 'holdVendorId' in key
          ? eq(ledgerAccounts.hold_vendor_id, key.holdVendorId)
          : eq(ledgerAccounts.driver_user_id, key.driverUserId);
  } else if (key.startsWith('GATEWAY_CLEARING:')) {
    condition = eq(ledgerAccounts.gateway, key.endsWith('ESEWA') ? 'ESEWA' : 'KHALTI');
  } else {
    condition = eq(ledgerAccounts.account_type, key as 'SYSTEM_ESCROW' | 'PLATFORM_REVENUE');
  }
  const [account] = await db.select().from(ledgerAccounts).where(condition);
  return account?.balance_npr ?? null;
}

/** A valid Nepal delivery address (Thamel, Kathmandu), required by every checkout. */
export const DELIVERY_ADDRESS = {
  province_id: 3,
  district_string: 'Kathmandu',
  municipality_palika_string: 'Kathmandu Metropolitan City',
  ward_number: 26,
  tole_locality: 'Thamel',
  landmark: 'Near Kathmandu Guest House',
  exact_lat: 27.7149,
  exact_lng: 85.3106,
} as const;
