import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';

import { createDatabase, type Database } from '@hamro-pasal/db';
import {
  mockServicesEnabled,
  type ServerEnv,
  type WalletTopUpMode,
} from '@hamro-pasal/shared-types';
import { smsGatewayFromEnv, type SmsGateway } from '@hamro-pasal/sms';
import { Redis } from 'ioredis';

import { AdminComplianceService } from './admin/admin-compliance-service';
import { AdminVendorService } from './admin/admin-vendor-service';
import { AuditLogService } from './admin/audit-log-service';
import { DeadLetterService } from './admin/dead-letter-service';
import { LogisticsSettingsService } from './admin/logistics-settings-service';
import { PricingPlanService } from './admin/pricing-plan-service';
import type { ApiServices } from './app';
import { OtpAuthService } from './auth/otp-auth-service';
import { OtpStore, type OtpStoreOptions } from './auth/otp-store';
import { CatalogService } from './catalog/catalog-service';
import { CategoryService } from './catalog/category-service';
import { ProductService } from './catalog/product-service';
import { CheckoutService } from './checkout/checkout-service';
import { DisputeService } from './disputes/dispute-service';
import { AdminPayoutService } from './finance/admin-payout-service';
import { AdminSettlementService } from './finance/admin-settlement-service';
import { VendorFinanceService } from './finance/vendor-finance-service';
import { VendorBankAccountService } from './vendor/vendor-bank-account-service';
import { VendorBillingService } from './vendor/vendor-billing-service';
import { VendorComplianceService } from './vendor/vendor-compliance-service';
import { VendorDeliverySettingsService } from './vendor/vendor-delivery-settings-service';
import { RedisKeyedMutex } from './infra/redis-mutex';
import { RedisConnectionPool } from './infra/redis-pool';
import {
  InventoryLockService,
  type InventoryLockOptions,
} from './inventory/inventory-lock-service';
import { DrizzleStockReader } from './inventory/stock-reader';
import { LedgerService } from './ledger/ledger-service';
import { SettlementService } from './ledger/settlement-service';
import { AdProductService } from './marketing/ad-product-service';
import { AdPurchaseService } from './marketing/ad-purchase-service';
import { VendorOfferService } from './marketing/vendor-offer-service';
import {
  DEFAULT_INVOICE_FONT_DIR,
  DEVANAGARI_REGULAR_FILE,
  loadInvoiceFonts,
  type InvoiceFonts,
} from './invoices/invoice-fonts';
import { VendorInvoiceService } from './invoices/vendor-invoice-service';
import { CampaignService } from './marketing/campaign-service';
import { SettlementModelRequestService } from './settlement/settlement-model-request-service';
import { PromotionService } from './marketing/promotion-service';
import { DeviceTokenService } from './notifications/device-token-service';
import { VendorTopUpService } from './wallet/vendor-top-up-service';
import { VendorWalletService } from './wallet/vendor-wallet-service';
import { WalletService } from './wallet/wallet-service';
import {
  DeliveryOtpAttempts,
  type DeliveryOtpAttemptOptions,
} from './orders/delivery-otp-attempts';
import { DeliveryHandoff } from './orders/delivery-handoff';
import { DeliveryService } from './deliveries/delivery-service';
import {
  RiderLocationStore,
  type RiderLocationStoreOptions,
} from './deliveries/rider-location-store';
import { OrderService } from './orders/order-service';
import { VendorOrderService } from './orders/vendor-order-service';
import { EsewaService, type EsewaConfig } from './payments/esewa/esewa-service';
import type { FetchLike } from './payments/gateway-http';
import { KhaltiClient, type KhaltiConfig } from './payments/khalti/khalti-client';
import { KhaltiService } from './payments/khalti/khalti-service';
import { MockPaymentService } from './payments/mock-payment-service';
import { PaymentConfirmationService } from './payments/payment-confirmation';
import { ReviewService } from './reviews/review-service';
import type { EvidenceStorage } from './uploads/evidence-storage';
import type { KycDocumentStorage } from './uploads/kyc-document-storage';
import type { ProductImageStorage } from './uploads/product-image-storage';
import type { PromotionImageStorage } from './uploads/promotion-image-storage';
import { fileStorageFromEnv } from './uploads/storage-from-env';

export interface ApiConfig {
  readonly accessTokenSecret: string;
  readonly refreshTokenSecret: string;
  readonly esewa: EsewaConfig;
  readonly khalti: KhaltiConfig;
  /** WALLET_TOP_UP_MODE: MOCK credits vendor top-ups without a payment (never in production). */
  readonly walletTopUpMode: WalletTopUpMode;
  /** MOCK_SERVICES: builds the mock payment service behind POST /api/test/mock-payment. */
  readonly mockServices?: boolean;
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
  /** Tests only: a shorter staleness bound for rider positions. */
  readonly riderLocationOptions?: RiderLocationStoreOptions;
  /** Where dispute evidence images are stored (the public bucket; local disk in development). */
  readonly evidence: EvidenceStorage;
  /** Where product photos are stored (the same bucket or directory). */
  readonly productImages: ProductImageStorage;
  /** Phase 34: Home promotion artwork (the same bucket or directory). */
  readonly promotionImages: PromotionImageStorage;
  /** Phase 34: vendors' KYC documents, in the private store that nothing serves. */
  readonly kycDocuments: KycDocumentStorage;
  /**
   * The invoice PDF's Devanagari font. Left out: read from apps/api/assets/fonts. Null: none
   * (invoices print Latin text only, and production refuses to print).
   */
  readonly invoiceFonts?: InvoiceFonts | null;
}

export interface ApiContainer extends ApiServices {
  readonly db: Database;
  readonly redisPool: RedisConnectionPool;
  readonly settlement: SettlementService;
  /** Phase 21: riders' last GPS positions (Redis geo set), fed and read by the /orders namespace. */
  readonly riderLocations: RiderLocationStore;
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
    mockServices: mockServicesEnabled(env),
  };
}

/** Wires every service from explicit infrastructure (the composition root). */
export function buildContainer(config: ApiConfig, infra: Infrastructure): ApiContainer {
  const invoiceFonts = infra.invoiceFonts === undefined ? loadInvoiceFonts() : infra.invoiceFonts;
  if (invoiceFonts === null) {
    console.warn(
      `[api] ${DEVANAGARI_REGULAR_FILE} is not in ${DEFAULT_INVOICE_FONT_DIR}: invoice PDFs print Latin text only, and are refused in production`,
    );
  }
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
    ledger,
  );
  const otps = new OtpStore(infra.redisPool, otpPepper(config.accessTokenSecret), infra.otpOptions);
  const esewa = new EsewaService(infra.db, checkout, confirmation, config.esewa);
  // Mock branches never exist in a production process, even if the config asks for them.
  const mockPayments =
    config.mockServices === true && process.env.NODE_ENV !== 'production'
      ? new MockPaymentService(infra.db, esewa, confirmation, config.esewa)
      : undefined;

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
    deliveries: new DeliveryService(infra.db, handoff),
    riderLocations: new RiderLocationStore(infra.redisPool, infra.riderLocationOptions),
    esewa,
    ...(mockPayments === undefined ? {} : { mockPayments }),
    khalti: new KhaltiService(infra.db, checkout, confirmation, khaltiClient),
    reviews: new ReviewService(infra.db),
    disputes: new DisputeService(infra.db),
    evidence: infra.evidence,
    adminDeadLetters: new DeadLetterService(infra.db),
    adminVendors: new AdminVendorService(infra.db, wallet),
    categories: new CategoryService(infra.db),
    products: new ProductService(infra.db, infra.productImages),
    productImages: infra.productImages,
    deviceTokens: new DeviceTokenService(infra.db),
    vendorFinance: new VendorFinanceService(infra.db, ledger),
    adminPayouts: new AdminPayoutService(infra.db, ledger),
    vendorBilling: new VendorBillingService(infra.db),
    vendorCompliance: new VendorComplianceService(infra.db, infra.kycDocuments),
    vendorDeliverySettings: new VendorDeliverySettingsService(infra.db),
    adminAuditLogs: new AuditLogService(infra.db),
    adminLogistics: new LogisticsSettingsService(infra.db),
    adminCompliance: new AdminComplianceService(infra.db, infra.kycDocuments),
    adminSettlements: new AdminSettlementService(infra.db, ledger),
    adminPricingPlans: new PricingPlanService(infra.db),
    campaigns: new CampaignService(infra.db),
    settlementModelRequests: new SettlementModelRequestService(infra.db),
    adProducts: new AdProductService(infra.db),
    adPurchases: new AdPurchaseService(infra.db, ledger),
    promotions: new PromotionService(infra.db, infra.promotionImages),
    promotionImages: infra.promotionImages,
    vendorBankAccounts: new VendorBankAccountService(infra.db),
    vendorInvoices: new VendorInvoiceService(
      infra.db,
      invoiceFonts,
      process.env.NODE_ENV === 'production',
    ),
    vendorOffers: new VendorOfferService(infra.db),
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
 * Where public uploads go under STORAGE_DRIVER=LOCAL when UPLOADS_DIR is unset: `uploads/` at
 * the API root (apps/api/uploads, git-ignored). This file sits in src/ (tsx) or dist/ (node), one
 * level below that root.
 */
export const DEFAULT_UPLOADS_DIR = resolve(__dirname, '..', 'uploads');
/** The same for private documents (KYC): beside the served directory, never inside it. */
export const DEFAULT_PRIVATE_UPLOADS_DIR = resolve(__dirname, '..', 'uploads-private');

export function buildContainerFromEnv(env: ServerEnv): ApiContainer {
  return buildContainer(apiConfigFromEnv(env), {
    db: createDatabase(env.DATABASE_URL),
    redisPool: new RedisConnectionPool(() => new Redis(env.REDIS_URL), 20),
    sms: smsGatewayFromEnv(env),
    ...fileStorageFromEnv(env, {
      publicDir: DEFAULT_UPLOADS_DIR,
      privateDir: DEFAULT_PRIVATE_UPLOADS_DIR,
    }),
  });
}
