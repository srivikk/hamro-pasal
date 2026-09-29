import express, { type Express } from 'express';

import type { CatalogService } from './catalog/catalog-service';
import type { CheckoutService } from './checkout/checkout-service';
import { requireAuth } from './http/auth';
import { errorHandler, HttpError } from './http/errors';
import type { OrderService } from './orders/order-service';
import type { EsewaService } from './payments/esewa/esewa-service';
import type { KhaltiService } from './payments/khalti/khalti-service';
import { cartRouter } from './routes/cart';
import { ordersRouter } from './routes/orders';
import { paymentsRouter } from './routes/payments';
import { vendorsRouter } from './routes/vendors';

export interface ApiServices {
  readonly accessTokenSecret: string;
  readonly catalog: CatalogService;
  readonly checkout: CheckoutService;
  readonly orders: OrderService;
  readonly esewa: EsewaService;
  readonly khalti: KhaltiService;
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
    app.use('/api/vendors', customerAuth, vendorsRouter(services.catalog));
    app.use('/api/cart', customerAuth, cartRouter(services.checkout));
    app.use('/api/orders', customerAuth, ordersRouter(services.orders));
    app.use(
      '/api/payments',
      paymentsRouter({ esewa: services.esewa, khalti: services.khalti, customerAuth }),
    );
  }

  app.use((_req, _res, next) => {
    next(new HttpError(404, 'NOT_FOUND', 'Route not found'));
  });
  app.use(errorHandler);

  return app;
}
