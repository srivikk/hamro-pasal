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
import type { DisputeService } from './disputes/dispute-service';
import type { AdminPayoutService } from './finance/admin-payout-service';
import type { AdminSettlementService } from './finance/admin-settlement-service';
import type { VendorFinanceService } from './finance/vendor-finance-service';
import { requireAuth } from './http/auth';
import { strictCors } from './http/cors';
import { errorHandler, HttpError } from './http/errors';
import { requestId } from './http/request-context';
import type { AdProductService } from './marketing/ad-product-service';
import type { AdPurchaseService } from './marketing/ad-purchase-service';
import type { VendorOfferService } from './marketing/vendor-offer-service';
import type { VendorInvoiceService } from './invoices/vendor-invoice-service';
import type { CampaignService } from './marketing/campaign-service';
import type { PromotionService } from './marketing/promotion-service';
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
import type { VendorDeliverySettingsService } from './vendor/vendor-delivery-settings-service';
import type { VendorTopUpService } from './wallet/vendor-top-up-service';
import type { VendorWalletService } from './wallet/vendor-wallet-service';
import { adminRouter } from './routes/admin';
import { authRouter } from './routes/auth';
import { cartRouter } from './routes/cart';
import { categoriesRouter, productsRouter, vendorProductsRouter } from './routes/catalog';
import { deliveriesRouter } from './routes/deliveries';
import { orderChatRouter } from './routes/order-chat';
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
import { vendorFinanceRouter } from './routes/vendor-finance';
import { vendorInvoicesRouter, vendorOffersRouter } from './routes/vendor-invoices-offers';
import { vendorOrdersRouter } from './routes/vendor-orders';
import { vendorSettingsRouter } from './routes/vendor-settings';
import { vendorWalletRouter } from './routes/vendor-wallet';
import { vendorsRouter } from './routes/vendors';
import { LocalEvidenceStorage, type EvidenceStorage } from './uploads/evidence-storage';
import {
  LocalProductImageStorage,
  type ProductImageStorage,
} from './uploads/product-image-storage';

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
  readonly evidence: EvidenceStorage;
  /** Phase 15: the Super Admin dashboard (apps/admin). */
  readonly adminDeadLetters: DeadLetterService;
  readonly adminVendors: AdminVendorService;
  /** Phase 17: the admin taxonomy, and products with their stock. */
  readonly categories: CategoryService;
  readonly products: ProductService;
  /** Phase 19: where product photos are stored (served statically when it is the local disk). */
  readonly productImages: ProductImageStorage;
  /** Phase 20: Expo push tokens of signed-in devices. */
  readonly deviceTokens: DeviceTokenService;
  /** Phase 22: vendor earnings and payout requests, and the Super Admin's decisions on them. */
  readonly vendorFinance: VendorFinanceService;
  readonly adminPayouts: AdminPayoutService;
  /** Phase 25: the shop's own tax identity (PAN) and delivery settings. */
  readonly vendorBilling: VendorBillingService;
  readonly vendorCompliance: VendorComplianceService;
  readonly vendorDeliverySettings: VendorDeliverySettingsService;
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
  /** Phase 26: where a shop is paid. */
  readonly vendorBankAccounts: VendorBankAccountService;
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
    // Phase 27. The shop's own request to change its settlement model.
    app.use(
      '/api/vendor/ledger',
      requireAuth(services.accessTokenSecret, ['VENDOR']),
      vendorLedgerRouter(services.settlementModelRequests),
    );
    // Phase 25. After the routers above: it only owns /tax-identity and /delivery-settings.
    app.use(
      '/api/vendor',
      requireAuth(services.accessTokenSecret, ['VENDOR']),
      vendorSettingsRouter({
        billing: services.vendorBilling,
        compliance: services.vendorCompliance,
        deliverySettings: services.vendorDeliverySettings,
      }),
    );
    // Before the customer catalogue under /api/vendors, which would otherwise claim these paths.
    app.use(
      '/api/vendors/orders',
      requireAuth(services.accessTokenSecret, ['VENDOR']),
      vendorOrdersRouter({ reviews: services.reviews, vendorOrders: services.vendorOrders }),
    );
    app.use(
      '/api/vendors/wallet',
      requireAuth(services.accessTokenSecret, ['VENDOR']),
      vendorWalletRouter(services.vendorWallet, services.vendorTopUps),
    );
    // Public reads (guest browsing): the feed and a LIVE shop's menu need no token.
    app.use('/api/vendors', vendorsRouter(services.catalog));
    app.use(
      '/api/deliveries',
      requireAuth(services.accessTokenSecret, ['DRIVER']),
      deliveriesRouter(services.deliveries),
    );
    app.use('/api/cart', customerAuth, cartRouter(services.checkout));
    // Before the customer-only orders router: vendors and admins read dispute transcripts too.
    app.use(
      '/api/orders',
      requireAuth(services.accessTokenSecret, ['CUSTOMER', 'VENDOR', 'SUPER_ADMIN']),
      orderChatRouter(services.disputes),
    );
    app.use('/api/orders', customerAuth, ordersRouter(services.orders));
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
    app.use('/api/uploads', customerAuth, uploadsRouter(services.disputes, services.evidence));
    // Development stand-in for the R2/CDN origin: dispute evidence and product photos are served
    // as static files. Both storages normally share one directory and path, mounted once.
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
