import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';

import { createDatabase, type Database } from '@hamro-pasal/db';
import type { ServerEnv, WalletTopUpMode } from '@hamro-pasal/shared-types';
import { smsGatewayFromEnv, type SmsGateway } from '@hamro-pasal/sms';
import { Redis } from 'ioredis';

import { AdminVendorService } from './admin/admin-vendor-service';
import { DeadLetterService } from './admin/dead-letter-service';
import type { ApiServices } from './app';
import { OtpAuthService } from './auth/otp-auth-service';
import { OtpStore, type OtpStoreOptions } from './auth/otp-store';
import { CatalogService } from './catalog/catalog-service';
import { CategoryService } from './catalog/category-service';
import { ProductService } from './catalog/product-service';
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
import { VendorTopUpService } from './wallet/vendor-top-up-service';
import { VendorWalletService } from './wallet/vendor-wallet-service';
import { WalletService } from './wallet/wallet-service';
import {
  DeliveryOtpAttempts,
  type DeliveryOtpAttemptOptions,
} from './orders/delivery-otp-attempts';
import { DeliveryHandoff } from './orders/delivery-handoff';
import { DriverOrderService } from './orders/driver-order-service';
import { OrderService } from './orders/order-service';
import { VendorOrderService } from './orders/vendor-order-service';
import { EsewaService, type EsewaConfig } from './payments/esewa/esewa-service';
import type { FetchLike } from './payments/gateway-http';
import { KhaltiClient, type KhaltiConfig } from './payments/khalti/khalti-client';
import { KhaltiService } from './payments/khalti/khalti-service';
import { PaymentConfirmationService } from './payments/payment-confirmation';
import { ReviewService } from './reviews/review-service';
import { LocalEvidenceStorage, type EvidenceStorage } from './uploads/evidence-storage';
import {
  LocalProductImageStorage,
  type ProductImageStorage,
} from './uploads/product-image-storage';

export interface ApiConfig {
  readonly accessTokenSecret: string;
  readonly refreshTokenSecret: string;
  readonly esewa: EsewaConfig;
  readonly khalti: KhaltiConfig;
  /** WALLET_TOP_UP_MODE: MOCK credits vendor top-ups without a payment (never in production). */
  readonly walletTopUpMode: WalletTopUpMode;
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
  /** Tests only: a shorter delivery-code lockout. Production uses the shared-types constant. */
  readonly deliveryOtpOptions?: DeliveryOtpAttemptOptions;
  /** Where dispute evidence images are stored (local disk until Cloudflare R2 is wired). */
  readonly evidence: EvidenceStorage;
  /** Where product photos are stored (the same local directory until R2 is wired). */
  readonly productImages: ProductImageStorage;
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
    walletTopUpMode: env.WALLET_TOP_UP_MODE,
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
  // The one WalletService: journals (suspend/restore for debt) and the admin overrides share it.
  const wallet = new WalletService();
  const ledger = new LedgerService(wallet);
  const settlement = new SettlementService(infra.db, ledger);
  const confirmation = new PaymentConfirmationService(infra.db, settlement, checkout);
  const khaltiClient = new KhaltiClient(config.khalti, infra.fetch);
  // One handoff (and one Redis counter per order) for the rider's and the vendor's deliveries.
  const handoff = new DeliveryHandoff(
    settlement,
    new DeliveryOtpAttempts(infra.redisPool, infra.deliveryOtpOptions),
  );
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
    vendorOrders: new VendorOrderService(infra.db, locks, handoff),
    vendorWallet: new VendorWalletService(infra.db),
    vendorTopUps: new VendorTopUpService(infra.db, ledger, config.walletTopUpMode),
    driverOrders: new DriverOrderService(infra.db, handoff),
    esewa: new EsewaService(infra.db, checkout, confirmation, config.esewa),
    khalti: new KhaltiService(infra.db, checkout, confirmation, khaltiClient),
    reviews: new ReviewService(infra.db),
    disputes: new DisputeService(infra.db),
    evidence: infra.evidence,
    adminDeadLetters: new DeadLetterService(infra.db),
    adminVendors: new AdminVendorService(infra.db, wallet),
    categories: new CategoryService(infra.db),
    products: new ProductService(infra.db, infra.productImages),
    productImages: infra.productImages,
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

/**
 * Where uploads go when UPLOADS_DIR is unset: `uploads/` at the API root (apps/api/uploads,
 * git-ignored). This file sits in src/ (tsx) or dist/ (node), one level below that root.
 */
export const DEFAULT_UPLOADS_DIR = resolve(__dirname, '..', 'uploads');

export function buildContainerFromEnv(env: ServerEnv): ApiContainer {
  const uploadsDir = env.UPLOADS_DIR ?? DEFAULT_UPLOADS_DIR;
  const uploadsBaseUrl =
    env.UPLOADS_PUBLIC_BASE_URL ?? `http://localhost:${String(env.API_PORT)}/uploads`;
  return buildContainer(apiConfigFromEnv(env), {
    db: createDatabase(env.DATABASE_URL),
    redisPool: new RedisConnectionPool(() => new Redis(env.REDIS_URL), 20),
    sms: smsGatewayFromEnv(env),
    evidence: new LocalEvidenceStorage(uploadsDir, uploadsBaseUrl),
    productImages: new LocalProductImageStorage(uploadsDir, uploadsBaseUrl),
  });
}
