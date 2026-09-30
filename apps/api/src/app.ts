import express, { type Express } from 'express';

import type { OtpAuthService } from './auth/otp-auth-service';
import type { CatalogService } from './catalog/catalog-service';
import type { CheckoutService } from './checkout/checkout-service';
import type { DisputeService } from './disputes/dispute-service';
import { requireAuth } from './http/auth';
import { errorHandler, HttpError } from './http/errors';
import type { OrderService } from './orders/order-service';
import type { EsewaService } from './payments/esewa/esewa-service';
import type { KhaltiService } from './payments/khalti/khalti-service';
import type { ReviewService } from './reviews/review-service';
import { authRouter } from './routes/auth';
import { cartRouter } from './routes/cart';
import { ordersRouter } from './routes/orders';
import { paymentsRouter } from './routes/payments';
import { reviewsRouter } from './routes/reviews';
import { uploadsRouter } from './routes/uploads';
import { vendorOrdersRouter } from './routes/vendor-orders';
import { vendorsRouter } from './routes/vendors';
import { LocalEvidenceStorage, type EvidenceStorage } from './uploads/evidence-storage';

export interface ApiServices {
  readonly accessTokenSecret: string;
  readonly auth: OtpAuthService;
  readonly catalog: CatalogService;
  readonly checkout: CheckoutService;
  readonly orders: OrderService;
  readonly esewa: EsewaService;
  readonly khalti: KhaltiService;
  readonly reviews: ReviewService;
  readonly disputes: DisputeService;
  readonly evidence: EvidenceStorage;
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
    // Before the customer catalogue under /api/vendors, which would otherwise claim these paths.
    app.use(
      '/api/vendors/orders',
      requireAuth(services.accessTokenSecret, ['VENDOR']),
      vendorOrdersRouter(services.reviews),
    );
    app.use('/api/vendors', customerAuth, vendorsRouter(services.catalog));
    app.use('/api/cart', customerAuth, cartRouter(services.checkout));
    app.use('/api/orders', customerAuth, ordersRouter(services.orders));
    app.use(
      '/api/payments',
      paymentsRouter({ esewa: services.esewa, khalti: services.khalti, customerAuth }),
    );
    app.use('/api/reviews', customerAuth, reviewsRouter(services.reviews));
    app.use('/api/uploads', customerAuth, uploadsRouter(services.disputes, services.evidence));
    if (services.evidence instanceof LocalEvidenceStorage) {
      // Development stand-in for the R2/CDN origin: stored evidence is served as static files.
      app.use(
        services.evidence.mountPath,
        express.static(services.evidence.rootDir, {
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
