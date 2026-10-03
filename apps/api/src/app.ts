import express, { type Express } from 'express';

import type { AdminVendorService } from './admin/admin-vendor-service';
import type { DeadLetterService } from './admin/dead-letter-service';
import type { OtpAuthService } from './auth/otp-auth-service';
import type { CatalogService } from './catalog/catalog-service';
import type { CategoryService } from './catalog/category-service';
import type { ProductService } from './catalog/product-service';
import type { CheckoutService } from './checkout/checkout-service';
import type { DisputeService } from './disputes/dispute-service';
import { requireAuth } from './http/auth';
import { errorHandler, HttpError } from './http/errors';
import type { DeviceTokenService } from './notifications/device-token-service';
import type { DriverOrderService } from './orders/driver-order-service';
import type { OrderService } from './orders/order-service';
import type { VendorOrderService } from './orders/vendor-order-service';
import type { EsewaService } from './payments/esewa/esewa-service';
import type { KhaltiService } from './payments/khalti/khalti-service';
import type { ReviewService } from './reviews/review-service';
import type { VendorTopUpService } from './wallet/vendor-top-up-service';
import type { VendorWalletService } from './wallet/vendor-wallet-service';
import { adminRouter } from './routes/admin';
import { authRouter } from './routes/auth';
import { cartRouter } from './routes/cart';
import { categoriesRouter, productsRouter, vendorProductsRouter } from './routes/catalog';
import { driverOrdersRouter } from './routes/driver-orders';
import { orderChatRouter } from './routes/order-chat';
import { notificationsRouter } from './routes/notifications';
import { ordersRouter } from './routes/orders';
import { paymentsRouter } from './routes/payments';
import { reviewsRouter } from './routes/reviews';
import { uploadsRouter } from './routes/uploads';
import { vendorOrdersRouter } from './routes/vendor-orders';
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
  readonly driverOrders: DriverOrderService;
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
}

/** Builds the HTTP app. Without services only /health is served (used by liveness checks/tests). */
export function createApp(services?: ApiServices): Express {
  const app = express();

  app.disable('x-powered-by');
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
      }),
    );
    // Phase 17. Public reads: the active taxonomy and the active products of LIVE vendors.
    app.use('/api/categories', categoriesRouter(services.categories));
    app.use('/api/products', productsRouter(services.products));
    app.use(
      '/api/vendor/products',
      requireAuth(services.accessTokenSecret, ['VENDOR']),
      vendorProductsRouter(services.products),
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
    app.use('/api/vendors', customerAuth, vendorsRouter(services.catalog));
    app.use(
      '/api/driver/orders',
      requireAuth(services.accessTokenSecret, ['DRIVER']),
      driverOrdersRouter(services.driverOrders),
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
