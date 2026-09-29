import type { ErrorRequestHandler } from 'express';

import { OrderNotFoundError, OrderNotPlaceableError } from '../checkout/checkout-service';
import { CheckoutRejectedError } from '../checkout/pricing';
import {
  InsufficientStockError,
  InvalidCartError,
  ProductUnavailableError,
  ReservationContentionError,
  ReservationExpiredError,
} from '../inventory/errors';
import { MutexTimeoutError } from '../infra/redis-mutex';
import { toNpr } from '../ledger/money';
import { SettlementNotAllowedError } from '../ledger/settlement-service';
import { InvalidGatewayCallbackError } from '../payments/esewa/esewa-service';
import { PaymentGatewayError } from '../payments/gateway-http';
import {
  PaidAfterLockExpiredError,
  PaymentAmountMismatchError,
  PaymentNotFoundError,
} from '../payments/payment-confirmation';

/** An error that already knows its HTTP representation. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/** Maps domain errors to stable HTTP codes. Unknown errors become an opaque 500. */
export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof CheckoutRejectedError) {
    return new HttpError(error.httpStatus, error.code, error.message, error.details);
  }
  if (error instanceof InvalidCartError) return new HttpError(400, 'INVALID_CART', error.message);
  if (error instanceof InvalidGatewayCallbackError) {
    return new HttpError(400, 'INVALID_PAYMENT_CALLBACK', error.message);
  }
  if (error instanceof OrderNotFoundError) {
    return new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
  }
  if (error instanceof PaymentNotFoundError) {
    return new HttpError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
  }
  if (error instanceof ProductUnavailableError) {
    return new HttpError(422, 'PRODUCT_UNAVAILABLE', error.message, {
      product_ids: error.productIds,
    });
  }
  if (error instanceof InsufficientStockError) {
    return new HttpError(409, 'INSUFFICIENT_STOCK', 'Some items are out of stock', {
      shortfalls: error.shortfalls,
    });
  }
  if (error instanceof PaymentAmountMismatchError) {
    return new HttpError(409, 'PAYMENT_AMOUNT_MISMATCH', 'Paid amount does not match the order', {
      expected_npr: toNpr(error.expectedPaisa),
      paid_npr: toNpr(error.paidPaisa),
    });
  }
  if (error instanceof PaidAfterLockExpiredError) {
    return new HttpError(409, 'PAID_AFTER_SESSION_EXPIRED', error.message, {
      order_id: error.orderId,
      refund_required: true,
    });
  }
  if (error instanceof ReservationExpiredError) {
    return new HttpError(410, 'RESERVATION_EXPIRED', 'Checkout session expired');
  }
  if (error instanceof MutexTimeoutError) {
    return new HttpError(409, 'CHECKOUT_IN_PROGRESS', 'This checkout is still being processed');
  }
  if (error instanceof ReservationContentionError) {
    return new HttpError(503, 'CHECKOUT_BUSY', 'Checkout is busy, please retry');
  }
  if (error instanceof OrderNotPlaceableError || error instanceof SettlementNotAllowedError) {
    return new HttpError(409, 'ORDER_STATE_CONFLICT', error.message);
  }
  if (error instanceof PaymentGatewayError) {
    return new HttpError(502, 'PAYMENT_GATEWAY_ERROR', `${error.gateway} request failed`);
  }
  if (isBodyParserError(error)) {
    return new HttpError(error.status, 'MALFORMED_REQUEST', 'Request body could not be parsed');
  }
  return new HttpError(500, 'INTERNAL_SERVER_ERROR', 'Something went wrong');
}

/** express.json() errors (invalid JSON, too large) carry a 4xx `status` and `type`. */
function isBodyParserError(error: unknown): error is Error & { status: number } {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { status?: unknown; type?: unknown };
  return (
    typeof candidate.type === 'string' &&
    typeof candidate.status === 'number' &&
    candidate.status >= 400 &&
    candidate.status < 500
  );
}

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  const httpError = toHttpError(error);
  if (httpError.status >= 500) {
    console.error(error);
  }
  const body: ErrorBody = { error: { code: httpError.code, message: httpError.message } };
  if (httpError.details !== undefined) body.error.details = httpError.details;
  res.status(httpError.status).json(body);
};
