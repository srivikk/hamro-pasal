import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDatabase, type Database } from '@hamro-pasal/db';
import type { ServerEnv } from '@hamro-pasal/shared-types';
import { Redis } from 'ioredis';

import type { ApiServices } from './app';
import { OtpAuthService } from './auth/otp-auth-service';
import { OtpStore, type OtpStoreOptions } from './auth/otp-store';
import { CatalogService } from './catalog/catalog-service';
import { CheckoutService } from './checkout/checkout-service';
import { DisputeService } from './disputes/dispute-service';
import { RedisKeyedMutex } from './infra/redis-mutex';
import { RedisConnectionPool } from './infra/redis-pool';
import {
  InventoryLockService,
  type InventoryLockOptions,
} from './inventory/inventory-lock-service';
import { DrizzleStockReader } from './inventory/stock-reader';
import { LedgerService } from './ledger/ledger-service';
import { SettlementService } from './ledger/settlement-service';
import { OrderService } from './orders/order-service';
import { EsewaService, type EsewaConfig } from './payments/esewa/esewa-service';
import type { FetchLike } from './payments/gateway-http';
import { KhaltiClient, type KhaltiConfig } from './payments/khalti/khalti-client';
import { KhaltiService } from './payments/khalti/khalti-service';
import { PaymentConfirmationService } from './payments/payment-confirmation';
import { ReviewService } from './reviews/review-service';
import {
  AakashSmsGateway,
  MockSmsGateway,
  SparrowSmsGateway,
  type SmsGateway,
} from './sms/sms-gateway';
import { LocalEvidenceStorage, type EvidenceStorage } from './uploads/evidence-storage';

export interface ApiConfig {
  readonly accessTokenSecret: string;
  readonly refreshTokenSecret: string;
  readonly esewa: EsewaConfig;
  readonly khalti: KhaltiConfig;
}

export interface Infrastructure {
  readonly db: Database;
  readonly redisPool: RedisConnectionPool;
  readonly fetch?: FetchLike;
  /** Tests only: shorter lock TTLs. Production always uses the SPEC 600 s. */
  readonly lockOptions?: InventoryLockOptions;
  /** Delivers OTP codes (buildContainerFromEnv picks it from SMS_PROVIDER). */
  readonly sms: SmsGateway;
  /** Tests only: shorter OTP windows. Production uses the shared-types constants. */
  readonly otpOptions?: OtpStoreOptions;
  /** Where dispute evidence images are stored (local disk until Cloudflare R2 is wired). */
  readonly evidence: EvidenceStorage;
}

export interface ApiContainer extends ApiServices {
  readonly db: Database;
  readonly redisPool: RedisConnectionPool;
  readonly settlement: SettlementService;
  close(): Promise<void>;
}

export function apiConfigFromEnv(env: ServerEnv): ApiConfig {
  return {
    accessTokenSecret: env.JWT_ACCESS_SECRET,
    refreshTokenSecret: env.JWT_REFRESH_SECRET,
    esewa: {
      productCode: env.ESEWA_PRODUCT_CODE,
      secretKey: env.ESEWA_SECRET_KEY,
      paymentUrl: env.ESEWA_PAYMENT_URL,
      successUrl: env.ESEWA_SUCCESS_URL,
      failureUrl: env.ESEWA_FAILURE_URL,
    },
    khalti: {
      secretKey: env.KHALTI_SECRET_KEY,
      baseUrl: env.KHALTI_BASE_URL,
      returnUrl: env.KHALTI_RETURN_URL,
      websiteUrl: env.KHALTI_WEBSITE_URL,
    },
  };
}

/** Wires every service from explicit infrastructure (the composition root). */
export function buildContainer(config: ApiConfig, infra: Infrastructure): ApiContainer {
  const locks = new InventoryLockService(
    infra.redisPool,
    new DrizzleStockReader(infra.db),
    infra.lockOptions,
  );
  const checkout = new CheckoutService(infra.db, locks, new RedisKeyedMutex(infra.redisPool));
  const settlement = new SettlementService(infra.db, new LedgerService());
  const confirmation = new PaymentConfirmationService(infra.db, settlement, checkout);
  const khaltiClient = new KhaltiClient(config.khalti, infra.fetch);
  const otps = new OtpStore(infra.redisPool, otpPepper(config.accessTokenSecret), infra.otpOptions);

  return {
    accessTokenSecret: config.accessTokenSecret,
    db: infra.db,
    redisPool: infra.redisPool,
    settlement,
    auth: new OtpAuthService(infra.db, otps, infra.sms, {
      accessTokenSecret: config.accessTokenSecret,
      refreshTokenSecret: config.refreshTokenSecret,
    }),
    catalog: new CatalogService(infra.db),
    checkout,
    orders: new OrderService(infra.db, locks),
    esewa: new EsewaService(infra.db, checkout, confirmation, config.esewa),
    khalti: new KhaltiService(infra.db, checkout, confirmation, khaltiClient),
    reviews: new ReviewService(infra.db),
    disputes: new DisputeService(infra.db),
    evidence: infra.evidence,
    async close() {
      await infra.redisPool.close();
      await infra.db.$client.end();
    },
  };
}

/**
 * HMAC key for stored OTP digests, derived from the access secret with a fixed label (domain
 * separation), so no extra secret has to be provisioned and the JWT key itself is never reused.
 */
function otpPepper(accessTokenSecret: string): Buffer {
  return createHmac('sha256', accessTokenSecret).update('hamro-pasal:otp-digest:v1').digest();
}

/** The SMS adapter for SMS_PROVIDER (SPEC Nepal §4). */
export function smsGatewayFromEnv(env: ServerEnv): SmsGateway {
  switch (env.SMS_PROVIDER) {
    case 'SPARROW':
      return new SparrowSmsGateway({
        token: required(env.SPARROW_SMS_TOKEN, 'SPARROW_SMS_TOKEN'),
        from: required(env.SPARROW_SMS_FROM, 'SPARROW_SMS_FROM'),
        apiUrl: required(env.SPARROW_SMS_API_URL, 'SPARROW_SMS_API_URL'),
      });
    case 'AAKASH':
      return new AakashSmsGateway({
        authToken: required(env.AAKASH_SMS_AUTH_TOKEN, 'AAKASH_SMS_AUTH_TOKEN'),
        apiUrl: required(env.AAKASH_SMS_API_URL, 'AAKASH_SMS_API_URL'),
      });
    case 'MOCK':
      // Development only (parseServerEnv refuses it in production): the code appears in the log.
      return new MockSmsGateway((sms) => {
        console.info(`[sms:mock] to ${sms.to}: ${sms.text}`);
      });
    case 'FIREBASE':
      throw new Error(
        'SMS_PROVIDER=FIREBASE cannot deliver server-generated OTP codes; use SPARROW, AAKASH or MOCK',
      );
  }
}

function required(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

export function buildContainerFromEnv(env: ServerEnv): ApiContainer {
  return buildContainer(apiConfigFromEnv(env), {
    db: createDatabase(env.DATABASE_URL),
    redisPool: new RedisConnectionPool(() => new Redis(env.REDIS_URL), 20),
    sms: smsGatewayFromEnv(env),
    evidence: new LocalEvidenceStorage(
      env.UPLOADS_DIR ?? join(tmpdir(), 'uploads'),
      env.UPLOADS_PUBLIC_BASE_URL ?? `http://localhost:${String(env.API_PORT)}/uploads`,
    ),
  });
}
