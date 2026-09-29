import { createDatabase, type Database } from '@hamro-pasal/db';
import type { ServerEnv } from '@hamro-pasal/shared-types';
import { Redis } from 'ioredis';

import type { ApiServices } from './app';
import { CheckoutService } from './checkout/checkout-service';
import { RedisKeyedMutex } from './infra/redis-mutex';
import { RedisConnectionPool } from './infra/redis-pool';
import {
  InventoryLockService,
  type InventoryLockOptions,
} from './inventory/inventory-lock-service';
import { DrizzleStockReader } from './inventory/stock-reader';
import { LedgerService } from './ledger/ledger-service';
import { SettlementService } from './ledger/settlement-service';
import { EsewaService, type EsewaConfig } from './payments/esewa/esewa-service';
import type { FetchLike } from './payments/gateway-http';
import { KhaltiClient, type KhaltiConfig } from './payments/khalti/khalti-client';
import { KhaltiService } from './payments/khalti/khalti-service';
import { PaymentConfirmationService } from './payments/payment-confirmation';

export interface ApiConfig {
  readonly accessTokenSecret: string;
  readonly esewa: EsewaConfig;
  readonly khalti: KhaltiConfig;
}

export interface Infrastructure {
  readonly db: Database;
  readonly redisPool: RedisConnectionPool;
  readonly fetch?: FetchLike;
  /** Tests only: shorter lock TTLs. Production always uses the SPEC 600 s. */
  readonly lockOptions?: InventoryLockOptions;
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

  return {
    accessTokenSecret: config.accessTokenSecret,
    db: infra.db,
    redisPool: infra.redisPool,
    settlement,
    checkout,
    esewa: new EsewaService(infra.db, checkout, confirmation, config.esewa),
    khalti: new KhaltiService(infra.db, checkout, confirmation, khaltiClient),
    async close() {
      await infra.redisPool.close();
      await infra.db.$client.end();
    },
  };
}

export function buildContainerFromEnv(env: ServerEnv): ApiContainer {
  return buildContainer(apiConfigFromEnv(env), {
    db: createDatabase(env.DATABASE_URL),
    redisPool: new RedisConnectionPool(() => new Redis(env.REDIS_URL), 20),
  });
}
