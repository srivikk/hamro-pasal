import express, { type Express } from 'express';

import type { AdminComplianceService } from './admin/admin-compliance-service';
import type { AdminVendorService } from './admin/admin-vendor-service';
import type { AuditLogService } from './admin/audit-log-service';
import type { DeadLetterService } from './admin/dead-letter-service';
import type { LogisticsSettingsService } from './admin/logistics-settings-service';
import type { PricingPlanService } from './admin/pricing-plan-service';
import type { OtpAuthService } from './auth/otp-auth-service';
import type { CatalogService } from './catalog/catalog-service';
import type { CategoryService } from './catalog/category-service';
import type { ProductService } from './catalog/product-service';
import type { CheckoutService } from './checkout/checkout-service';
import type { AdminDisputeService } from './disputes/admin-dispute-service';
import type { ExportService } from './exports/export-service';
import type { TutorialService } from './tutorials/tutorial-service';
import type { SellerOnboardingService } from './vendor/seller-onboarding-service';
import type { AdminNotificationService } from './notifications/admin-notification-service';
import type { DisputeService } from './disputes/dispute-service';
import type { AdminPayoutService } from './finance/admin-payout-service';
import type { AdminSettlementService } from './finance/admin-settlement-service';
import type { VendorFinanceService } from './finance/vendor-finance-service';
import { optionalAuth, requireAuth } from './http/auth';
import { strictCors } from './http/cors';
import { errorHandler, HttpError } from './http/errors';
import { requestId } from './http/request-context';
import type { AdProductService } from './marketing/ad-product-service';
import type { AdPurchaseService } from './marketing/ad-purchase-service';
import type { VendorOfferService } from './marketing/vendor-offer-service';
import type { VendorAnalyticsService } from './analytics/vendor-analytics-service';
import type { VendorInvoiceService } from './invoices/vendor-invoice-service';
import type { CampaignService } from './marketing/campaign-service';
import type { PromotionService } from './marketing/promotion-service';
import type { MeService } from './account/me-service';
import type { AlertService } from './account/alert-service';
import type { NotificationCentreService } from './account/notification-centre-service';
import type { DeviceTokenService } from './notifications/device-token-service';
import type { DeliveryService } from './deliveries/delivery-service';
import type { OrderService } from './orders/order-service';
import type { VendorOrderService } from './orders/vendor-order-service';
import type { EsewaService } from './payments/esewa/esewa-service';
import type { KhaltiService } from './payments/khalti/khalti-service';
import type { MockPaymentService } from './payments/mock-payment-service';
import type { ReviewService } from './reviews/review-service';
import type { VendorBankAccountService } from './vendor/vendor-bank-account-service';
import type { VendorBillingService } from './vendor/vendor-billing-service';
import type { VendorComplianceService } from './vendor/vendor-compliance-service';
import type { VendorDeactivationService } from './vendor/vendor-deactivation-service';
import type { VendorDeliverySettingsService } from './vendor/vendor-delivery-settings-service';
import type { VendorTopUpService } from './wallet/vendor-top-up-service';
import type { VendorWalletService } from './wallet/vendor-wallet-service';
import { adminRouter } from './routes/admin';
import { authRouter } from './routes/auth';
import { cartRouter } from './routes/cart';
import { categoriesRouter, productsRouter, vendorProductsRouter } from './routes/catalog';
import { deliveriesRouter } from './routes/deliveries';
import { orderChatRouter } from './routes/order-chat';
import { alertsRouter } from './routes/alerts';
import { adminPushRouter } from './routes/admin-push';
import { exportsRouter } from './routes/exports';
import {
  adminOnboardingRouter,
  sellerRouter,
  tutorialsRouter,
  vendorKycRouter,
} from './routes/seller';
import { adminDisputesRouter, escalationRouter } from './routes/disputes';
import { meRouter } from './routes/me';
import { notificationsRouter } from './routes/notifications';
import { testRouter } from './routes/mock-services';
import { ordersRouter } from './routes/orders';
import { paymentsRouter } from './routes/payments';
import { reviewsRouter } from './routes/reviews';
import { uploadsRouter } from './routes/uploads';
import { vendorLedgerRouter } from './routes/settlement-model-requests';
import { vendorBankAccountsRouter, vendorCampaignsRouter } from './routes/vendor-account';
import { homeRouter } from './routes/home';
import { vendorAdsRouter } from './routes/vendor-ads';
import type { SettlementModelRequestService } from './settlement/settlement-model-request-service';
import { vendorAnalyticsRouter } from './routes/vendor-analytics';
import { vendorDeactivationRouter } from './routes/vendor-deactivation';
import { vendorFinanceRouter } from './routes/vendor-finance';
import { vendorInvoicesRouter, vendorOffersRouter } from './routes/vendor-invoices-offers';
import { vendorOrdersRouter } from './routes/vendor-orders';
import { vendorSettingsRouter } from './routes/vendor-settings';
import type { VendorAvailabilityService } from './vendor/vendor-availability-service';
import { vendorWalletRouter } from './routes/vendor-wallet';
import {
  adminPaymentsRouter,
  walletRechargeRouter,
  vendorPaymentsRouter,
} from './routes/wallet-and-payments';
import type { CustomerWalletService } from './wallet/customer-wallet-service';
import type { VendorGatewayAccountService } from './payments/gateway-accounts';
import { vendorsRouter } from './routes/vendors';
import { LocalEvidenceStorage, type EvidenceStorage } from './uploads/evidence-storage';
import {
  LocalProductImageStorage,
  type ProductImageStorage,
} from './uploads/product-image-storage';
import type { PromotionImageStorage } from './uploads/promotion-image-storage';

export interface ApiServices {
  readonly accessTokenSecret: string;
  readonly auth: OtpAuthService;
  readonly catalog: CatalogService;
  readonly checkout: CheckoutService;
  readonly orders: OrderService;
  readonly vendorOrders: VendorOrderService;
  readonly vendorWallet: VendorWalletService;
  readonly vendorTopUps: VendorTopUpService;
  /** Phase 21: the platform rider's deliveries (accept, pickup, complete with the code). */
  readonly deliveries: DeliveryService;
  readonly esewa: EsewaService;
  readonly khalti: KhaltiService;
  readonly reviews: ReviewService;
  readonly disputes: DisputeService;
  /** Step 7.3: escalated conversations and their resolution. */
  readonly adminDisputes: AdminDisputeService;
  /** Step 7.5: the Super Admin push and its vendor search. */
  readonly adminNotifications: AdminNotificationService;
  /** Step 7.6: data exports (downloaded at once, or queued and emailed). */
  readonly exports: ExportService;
  /** Step 7.7: Seller app signup, admin onboarding and approval. */
  readonly sellerOnboarding: SellerOnboardingService;
  /** Step 7.8: the in-app tutorial videos. */
  readonly tutorials: TutorialService;
  readonly evidence: EvidenceStorage;
  /** Phase 15: the Super Admin dashboard (apps/admin). */
  readonly adminDeadLetters: DeadLetterService;
  readonly adminVendors: AdminVendorService;
  /** Phase 17: the admin taxonomy, and products with their stock. */
  readonly categories: CategoryService;
  readonly products: ProductService;
  /** Phase 19: where product photos are stored (served statically when it is the local disk). */
  readonly productImages: ProductImageStorage;
  /** Phase 34: where Home promotion artwork is stored (the admin's image upload). */
  readonly promotionImages: PromotionImageStorage;
  /** Phase 20: Expo push tokens of signed-in devices. */
  readonly deviceTokens: DeviceTokenService;
  /** Step 7.1: the signed-in account and its notification centre. */
  readonly me: MeService;
  readonly notificationCentre: NotificationCentreService;
  /** Step 7.4: Notify Me requests. */
  readonly alerts: AlertService;
  /** Phase 22: vendor earnings and payout requests, and the Super Admin's decisions on them. */
  readonly vendorFinance: VendorFinanceService;
  readonly adminPayouts: AdminPayoutService;
  /** Phase 25: the shop's own tax identity (PAN) and delivery settings. */
  readonly vendorBilling: VendorBillingService;
  readonly vendorCompliance: VendorComplianceService;
  readonly vendorDeliverySettings: VendorDeliverySettingsService;
  readonly vendorAvailability: VendorAvailabilityService;
  /** Phase 26: the audit trail's read side, the logistics settings and PAN verification. */
  readonly adminAuditLogs: AuditLogService;
  readonly adminLogistics: LogisticsSettingsService;
  readonly adminCompliance: AdminComplianceService;
  /** Phase 26: admin-initiated settlement payouts (behind the PAN gate) and the pricing plans. */
  readonly adminSettlements: AdminSettlementService;
  readonly adminPricingPlans: PricingPlanService;
  /** Phase 26: campaigns (admin CRUD and the vendor's own opt-in), ad products, promotions. */
  readonly campaigns: CampaignService;
  /** Phase 27: a vendor's request to change its settlement model, and the admin's decision. */
  readonly settlementModelRequests: SettlementModelRequestService;
  readonly adProducts: AdProductService;
  readonly promotions: PromotionService;
  /** Phase 28: the Ad Marketplace as a shop uses it (its own purchases). */
  readonly adPurchases: AdPurchaseService;
  /** Phase 32: the shop's fiscal invoices (list, server-rendered PDF) and its own offers. */
  readonly vendorInvoices: VendorInvoiceService;
  readonly vendorOffers: VendorOfferService;
  readonly vendorAnalytics: VendorAnalyticsService;
  readonly vendorDeactivation: VendorDeactivationService;
  /** Phase 26: where a shop is paid. */
  readonly vendorBankAccounts: VendorBankAccountService;
  /** 2026-10-21: the customer's stored-value wallet, and a Model C shop's own merchant accounts. */
  readonly customerWallet: CustomerWalletService;
  readonly gatewayAccounts: VendorGatewayAccountService;
  /** Local end-to-end runs: present only with MOCK_SERVICES outside production. */
  readonly mockPayments?: MockPaymentService;
}

export interface AppOptions {
  /** Browser origins other than the API's own that may call it (`CORS_ALLOWED_ORIGINS`). */
  readonly corsAllowedOrigins?: readonly string[];
}

/** Builds the HTTP app. Without services only /health is served (used by liveness checks/tests). */
export function createApp(services?: ApiServices, options: AppOptions = {}): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(requestId);
  // Before the body parser: a refused preflight never has its body read.
  app.use(strictCors(options.corsAllowedOrigins ?? []));
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  if (services !== undefined) {
    const customerAuth = requireAuth(services.accessTokenSecret, ['CUSTOMER']);
    app.use('/api/auth', authRouter(services.auth));
    // Step 7.3. Before the admin router, which would otherwise answer 404 for these paths.
    app.use(
      '/api/admin/disputes',
      requireAuth(services.accessTokenSecret, ['SUPER_ADMIN']),
      adminDisputesRouter(services.adminDisputes),
    );
    // 2026-10-21. Before the admin router: a plan assignment, a merchant account's check.
    app.use(
      '/api/admin',
      requireAuth(services.accessTokenSecret, ['SUPER_ADMIN']),
      adminPaymentsRouter(services.vendorBilling, services.gatewayAccounts),
    );
    // Step 7.7 / 7.8. Before the admin router: onboarding, approval and the tutorials.
    app.use(
      '/api/admin',
      requireAuth(services.accessTokenSecret, ['SUPER_ADMIN']),
      adminOnboardingRouter(services.sellerOnboarding, services.tutorials),
    );
    app.use(
      '/api/seller',
      sellerRouter(services.sellerOnboarding, requireAuth(services.accessTokenSecret, ['VENDOR'])),
    );
    app.use(
      '/api/vendor/kyc',
      requireAuth(services.accessTokenSecret, ['VENDOR']),
      vendorKycRouter(services.sellerOnboarding),
    );
    app.use('/api/tutorials', tutorialsRouter(services.tutorials));
    // Step 7.6. Before the admin router too.
    app.use(
      '/api/admin/exports',
      requireAuth(services.accessTokenSecret, ['SUPER_ADMIN']),
      exportsRouter(services.exports, 'SUPER_ADMIN'),
    );
    app.use(
      '/api/vendor/exports',
      requireAuth(services.accessTokenSecret, ['VENDOR']),
      exportsRouter(services.exports, 'VENDOR'),
    );
    // Step 7.5. Also before the admin router: the vendor search and the push.
    app.use(
      '/api/admin',
      requireAuth(services.accessTokenSecret, ['SUPER_ADMIN']),
      adminPushRouter(services.adminNotifications),
    );
    app.use(
      '/api/admin',
      requireAuth(services.accessTokenSecret, ['SUPER_ADMIN']),
      adminRouter({
        deadLetters: services.adminDeadLetters,
        vendors: services.adminVendors,
        categories: services.categories,
        products: services.products,
        payouts: services.adminPayouts,
        auditLogs: services.adminAuditLogs,
        logistics: services.adminLogistics,
        compliance: services.adminCompliance,
        settlements: services.adminSettlements,
        pricingPlans: services.adminPricingPlans,
        marketing: {
          campaigns: services.campaigns,
          adProducts: services.adProducts,
          promotions: services.promotions,
          promotionImages: services.promotionImages,
        },
        settlementModelRequests: services.settlementModelRequests,
      }),
    );
    // Phase 17. Public reads: the active taxonomy and the active products of LIVE vendors.
    app.use('/api/categories', categoriesRouter(services.categories));
    // Phase 28. Public: the Home banners and Featured Offers running now.
    app.use('/api/home', homeRouter(services.promotions));
    app.use('/api/products', productsRouter(services.products));
    app.use(
      '/api/vendor/products',
      requireAuth(services.accessTokenSecret, ['VENDOR']),
      vendorProductsRouter(services.products),
    );
    app.use(
      '/api/vendor/finance',
      requireAuth(services.accessTokenSecret, ['VENDOR']),
      vendorFinanceRouter(services.vendorFinance),
    );
    // Phase 26. The shop's bank accounts and its own campaign opt-in.
    app.use(
      '/api/vendor/bank-accounts',
      requireAuth(services.accessTokenSecret, ['VENDOR']),
      vendorBankAccountsRouter(services.vendorBankAccounts),
    );
    app.use(
      '/api/vendor/campaigns',
      requireAuth(services.accessTokenSecret, ['VENDOR']),
      vendorCampaignsRouter(services.campaigns),
    );
    // Phase 28. The Ad Marketplace: what is on sale and the shop's own purchases.
    app.use(
      '/api/vendor/ads',
      requireAuth(services.accessTokenSecret, ['VENDOR']),
      vendorAdsRouter(services.adPurchases),
    );
    // Phase 32. The shop's invoices (the PDF is the server's) and its own offers.
    app.use(
      '/api/vendor/invoices',
      requireAuth(services.accessTokenSecret, ['VENDOR']),
      vendorInvoicesRouter(services.vendorInvoices),
    );
    app.use(
      '/api/vendor/offers',
      requireAuth(services.accessTokenSecret, ['VENDOR']),
      vendorOffersRouter(services.vendorOffers),
    );
    // Phase 35. How the shop is doing: today, the top item, the ad return, seven days of sales.
    app.use(
      '/api/vendor/analytics',
      requireAuth(services.accessTokenSecret, ['VENDOR']),
      vendorAnalyticsRouter(services.vendorAnalytics),
    );
    // Phase 36. Closing the shop (soft delete).
    app.use(
      '/api/vendor/account',
      requireAuth(services.accessTokenSecret, ['VENDOR']),
      vendorDeactivationRouter(services.vendorDeactivation),
    );
    // Phase 27. The shop's own request to change its settlement model.
    app.use(
      '/api/vendor/ledger',
      requireAuth(services.accessTokenSecret, ['VENDOR']),
      vendorLedgerRouter(services.settlementModelRequests),
    );
    // 2026-10-21. The shop's billing view and its own merchant accounts (Model C).
    app.use(
      '/api/vendor',
      requireAuth(services.accessTokenSecret, ['VENDOR']),
      vendorPaymentsRouter(services.vendorBilling, services.gatewayAccounts),
    );
    // Phase 25. After the routers above: it only owns /tax-identity and /delivery-settings.
    app.use(
      '/api/vendor',
      requireAuth(services.accessTokenSecret, ['VENDOR']),
      vendorSettingsRouter({
        billing: services.vendorBilling,
        compliance: services.vendorCompliance,
        deliverySettings: services.vendorDeliverySettings,
        availability: services.vendorAvailability,
      }),
    );
    // Before the customer catalogue under /api/vendors, which would otherwise claim these paths.
    app.use(
      '/api/vendors/orders',
      requireAuth(services.accessTokenSecret, ['VENDOR']),
      vendorOrdersRouter({ reviews: services.reviews, vendorOrders: services.vendorOrders }),
      // Step 7.3: the vendor escalates its order's conversation.
      escalationRouter(services.disputes),
    );
    app.use(
      '/api/vendors/wallet',
      requireAuth(services.accessTokenSecret, ['VENDOR']),
      vendorWalletRouter(services.vendorWallet, services.vendorTopUps),
      // 2026-10-21: a real eSewa recharge of the shop's ledger (prepaid balance or dues).
      walletRechargeRouter(services.customerWallet, 'VENDOR'),
    );
    // Public reads (guest browsing): the feed and a LIVE shop's menu need no token. A signed-in
    // customer's menu also carries its Notify Me flags (step 7.4).
    app.use(
      '/api/vendors',
      optionalAuth(services.accessTokenSecret),
      vendorsRouter(services.catalog, services.alerts),
    );
    app.use(
      '/api/deliveries',
      requireAuth(services.accessTokenSecret, ['DRIVER']),
      deliveriesRouter(services.deliveries),
    );
    app.use('/api/cart', customerAuth, cartRouter(services.checkout));
    // 2026-10-21 (SPEC core 12): the customer's own stored-value wallet.
    app.use('/api/wallet', customerAuth, walletRechargeRouter(services.customerWallet, 'CUSTOMER'));
    // Before the customer-only orders router: vendors and admins read dispute transcripts too.
    app.use(
      '/api/orders',
      requireAuth(services.accessTokenSecret, ['CUSTOMER', 'VENDOR', 'SUPER_ADMIN']),
      orderChatRouter(services.disputes),
    );
    app.use(
      '/api/orders',
      customerAuth,
      ordersRouter(services.orders),
      // Step 7.3: the customer escalates its order's conversation.
      escalationRouter(services.disputes),
    );
    app.use(
      '/api/payments',
      paymentsRouter({ esewa: services.esewa, khalti: services.khalti, customerAuth }),
    );
    // Test-only routes. Never registered in production, whatever the container holds: there the
    // path falls through to the 404 below.
    if (process.env.NODE_ENV !== 'production' && services.mockPayments !== undefined) {
      app.use('/api/test', testRouter(services.mockPayments));
    }
    app.use('/api/reviews', customerAuth, reviewsRouter(services.reviews));
    // Phase 20. Every role registers its device: customers, vendors and riders all get pushes.
    app.use(
      '/api/notifications',
      requireAuth(services.accessTokenSecret),
      notificationsRouter(services.deviceTokens),
    );
    // Step 7.4. Before /api/me: Notify Me is the customer's own.
    app.use('/api/me/alerts', customerAuth, alertsRouter(services.alerts));
    // Step 7.1. Any role: the account's own record and its notification centre.
    app.use(
      '/api/me',
      requireAuth(services.accessTokenSecret),
      meRouter(services.me, services.notificationCentre),
    );
    app.use('/api/uploads', customerAuth, uploadsRouter(services.disputes, services.evidence));
    // STORAGE_DRIVER=LOCAL only (development, tests): the API stands in for the bucket's public
    // origin and serves the public uploads directory as static files. Evidence, product photos
    // and promotion artwork share that one directory and path, mounted once. With S3 nothing is
    // mounted: files are read from the CDN. Private documents (KYC) are never under this root.
    const mounted = new Set<string>();
    for (const storage of [services.evidence, services.productImages]) {
      if (!(
        storage instanceof LocalEvidenceStorage || storage instanceof LocalProductImageStorage
      )) {
        continue;
      }
      const mount = `${storage.mountPath}\n${storage.rootDir}`;
      if (mounted.has(mount)) continue;
      mounted.add(mount);
      app.use(
        storage.mountPath,
        express.static(storage.rootDir, {
          index: false,
          dotfiles: 'deny',
          setHeaders: (res) => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
          },
        }),
      );
    }
  }

  app.use((_req, _res, next) => {
    next(new HttpError(404, 'NOT_FOUND', 'Route not found'));
  });
  app.use(errorHandler);

  return app;
}
