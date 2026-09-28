import { randomInt, randomUUID } from 'node:crypto';

import type {
  DeliveryScope,
  PaymentMethod,
  PricingModel,
  VendorStatus,
} from '@hamro-pasal/shared-types';
import { DatabaseError, Pool, type PoolClient } from 'pg';

import { resolveTestDatabaseUrl } from './test-database';

type Queryable = Pool | PoolClient;

export function createTestPool(): Pool {
  return new Pool({
    connectionString: process.env.TEST_DATABASE_URL ?? resolveTestDatabaseUrl(),
    max: 25,
  });
}

/** A syntactically valid bcrypt hash; the DB only checks that delivery_otp is not a raw code. */
export const BCRYPT_OTP_HASH = '$2b$10$abcdefghijklmnopqrstuuM3bJ0n9ZkZ2p9Y5o0t7m6c1QwV8e2yG';

/** Thamel, Kathmandu (lng, lat). */
export const THAMEL = { lng: 85.3123, lat: 27.7154 } as const;

export function uniqueNepalPhone(): string {
  return `+9779${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
}

export async function createUser(db: Queryable, role = 'CUSTOMER'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (phone, role, first_name) VALUES ($1, $2, 'Test') RETURNING id`,
    [uniqueNepalPhone(), role],
  );
  return firstRow(rows).id;
}

export interface VendorOptions {
  status?: VendorStatus;
  pricingModel?: PricingModel | null;
  commissionRate?: number;
  deliveryScope?: DeliveryScope;
  radiusKm?: number;
  lng?: number;
  lat?: number;
  walletBalanceNpr?: number;
}

export async function createVendor(db: Queryable, options: VendorOptions = {}): Promise<string> {
  const userId = await createUser(db, 'VENDOR');
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO vendors (user_id, business_name, phone, status, pricing_model, commission_rate,
                          delivery_scope, radius_km, city_string, min_order_value,
                          base_delivery_fee_npr, location, wallet_balance_npr)
     VALUES ($1, 'Test Pasal', $2, $3, $4, $5, $6, $7, 'Kathmandu', 500, 50,
             ST_SetSRID(ST_MakePoint($8, $9), 4326), $10)
     RETURNING id`,
    [
      userId,
      uniqueNepalPhone(),
      options.status ?? 'LIVE',
      options.pricingModel === undefined ? 'COMMISSION' : options.pricingModel,
      options.commissionRate ?? 0.1,
      options.deliveryScope ?? 'RADIUS_BOUND',
      options.radiusKm ?? 5,
      options.lng ?? THAMEL.lng,
      options.lat ?? THAMEL.lat,
      options.walletBalanceNpr ?? 0,
    ],
  );
  return firstRow(rows).id;
}

export interface OrderOptions {
  vendorId: string;
  customerId: string;
  idempotencyKey?: string;
  paymentMethod?: PaymentMethod;
  paymentGatewayRef?: string | null;
  subtotal?: number;
  commission?: number;
  deliveryOtp?: string;
}

export async function createOrder(db: Queryable, options: OrderOptions): Promise<string> {
  const { rows } = await db.query<{ id: string }>(orderInsertSql, orderInsertParams(options));
  return firstRow(rows).id;
}

export const orderInsertSql = `
  INSERT INTO orders (idempotency_key, customer_id, vendor_id, subtotal, delivery_fee,
                      platform_commission_amount, fulfillment_locked, payment_method,
                      payment_gateway_ref, delivery_otp)
  VALUES ($1, $2, $3, $4, 50, $5, 'SELF_DELIVERY', $6, $7, $8)
  RETURNING id`;

export function orderInsertParams(options: OrderOptions): unknown[] {
  return [
    options.idempotencyKey ?? randomUUID(),
    options.customerId,
    options.vendorId,
    options.subtotal ?? 1000,
    options.commission ?? 100,
    options.paymentMethod ?? 'COD',
    options.paymentGatewayRef ?? null,
    options.deliveryOtp ?? BCRYPT_OTP_HASH,
  ];
}

export interface VendorWallet {
  status: VendorStatus;
  wallet_balance_npr: string;
}

export async function getVendorWallet(db: Queryable, vendorId: string): Promise<VendorWallet> {
  const { rows } = await db.query<VendorWallet>(
    'SELECT status, wallet_balance_npr FROM vendors WHERE id = $1',
    [vendorId],
  );
  return firstRow(rows);
}

export function firstRow<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) {
    throw new Error('Expected at least one row');
  }
  return row;
}

/** Awaits a rejected query and returns its Postgres error, for asserting code and constraint. */
export async function pgError(promise: Promise<unknown>): Promise<DatabaseError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof DatabaseError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the query to fail');
}
