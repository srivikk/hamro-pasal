import {
  MAX_DISPUTE_EVIDENCE_BYTES,
  MAX_PRODUCT_IMAGES,
  type ErrorBody,
} from '@hamro-pasal/shared-types';
import type { ErrorRequestHandler } from 'express';
import { MulterError } from 'multer';

import {
  DeadLetterAlreadyReplayedError,
  DeadLetterNotFoundError,
  InvalidDeadLetterCursorError,
} from '../admin/dead-letter-service';
import {
  OtpAttemptsExceededError,
  OtpCooldownError,
  OtpExpiredError,
  OtpInvalidError,
} from '../auth/otp-auth-service';
import { InvalidRefreshTokenError } from '../auth/refresh-token';
import { VendorNotFoundError } from '../catalog/catalog-service';
import {
  CategoryCycleError,
  CategoryInUseError,
  CategoryNotFoundError,
  CategoryParentNotFoundError,
  CategorySlugTakenError,
  CategoryTooDeepError,
} from '../catalog/category-service';
import {
  CategoryUnavailableError,
  InvalidProductCursorError,
  ProductImageLimitError,
  ProductNameTakenError,
  ProductNotFoundError,
} from '../catalog/product-service';
import { OrderNotFoundError, OrderNotPlaceableError } from '../checkout/checkout-service';
import { CheckoutRejectedError } from '../checkout/pricing';
import { DisputeWindowClosedError } from '../disputes/dispute-service';
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
import { CancellationWindowExpiredError, OrderNotCancelableError } from '../orders/order-service';
import {
  DeliveryOtpLockedError,
  InvalidDeliveryOtpError,
  OrderNotDeliverableError,
} from '../orders/delivery-handoff';
import {
  CancellationWindowOpenError,
  OrderDecisionConflictError,
  VendorAccountNotFoundError,
  WrongFulfillmentModeError,
} from '../orders/vendor-order-service';
import {
  OrderNotReviewableError,
  ReviewAlreadySubmittedError,
  ReviewWindowClosedError,
} from '../reviews/review-service';
import { TopUpKeyReusedError, TopUpUnavailableError } from '../wallet/vendor-top-up-service';
import { InvalidLedgerCursorError } from '../wallet/vendor-wallet-service';
import {
  AdminVendorNotFoundError,
  RestoreStatusUnknownError,
  VendorStatusConflictError,
  WalletBelowSuspensionLimitError,
} from '../wallet/wallet-service';
import { SmsDeliveryError } from '@hamro-pasal/sms';
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
  if (error instanceof OtpCooldownError) {
    return new HttpError(429, 'OTP_RESEND_COOLDOWN', error.message, {
      retry_after_seconds: error.retryAfterSeconds,
    });
  }
  if (error instanceof OtpInvalidError) {
    return new HttpError(401, 'OTP_INVALID', error.message, {
      attempts_remaining: error.attemptsRemaining,
    });
  }
  if (error instanceof OtpAttemptsExceededError) {
    return new HttpError(429, 'OTP_ATTEMPTS_EXCEEDED', error.message);
  }
  if (error instanceof OtpExpiredError) {
    return new HttpError(410, 'OTP_EXPIRED', error.message);
  }
  if (error instanceof InvalidRefreshTokenError) {
    // Deliberately vague: forged, expired, wrong audience and deleted account all look the same.
    return new HttpError(401, 'REFRESH_TOKEN_INVALID', 'Refresh token is invalid or expired');
  }
  if (error instanceof SmsDeliveryError) {
    return new HttpError(502, 'SMS_DELIVERY_FAILED', 'The code could not be sent; try again');
  }
  if (error instanceof VendorNotFoundError || error instanceof VendorAccountNotFoundError) {
    return new HttpError(404, 'VENDOR_NOT_FOUND', 'Vendor not found');
  }
  if (error instanceof CancellationWindowExpiredError) {
    return new HttpError(422, 'CANCELLATION_WINDOW_EXPIRED', error.message);
  }
  if (error instanceof OrderNotCancelableError) {
    return new HttpError(409, 'ORDER_STATE_CONFLICT', error.message, { state: error.state });
  }
  if (error instanceof OrderDecisionConflictError) {
    return new HttpError(409, 'ORDER_STATE_CONFLICT', error.message, { state: error.state });
  }
  if (error instanceof CancellationWindowOpenError) {
    return new HttpError(422, 'CANCELLATION_WINDOW_OPEN', error.message, {
      retry_after_seconds: error.retryAfterSeconds,
    });
  }
  if (error instanceof WrongFulfillmentModeError) {
    return new HttpError(409, 'WRONG_FULFILLMENT_MODE', error.message, {
      fulfillment: error.fulfillment,
    });
  }
  if (error instanceof OrderNotDeliverableError) {
    return new HttpError(409, 'ORDER_STATE_CONFLICT', error.message, { state: error.state });
  }
  if (error instanceof InvalidDeliveryOtpError) {
    return new HttpError(401, 'INVALID_OTP', 'The delivery code is incorrect', {
      attempts_remaining: error.attemptsRemaining,
    });
  }
  if (error instanceof DeliveryOtpLockedError) {
    return new HttpError(429, 'DELIVERY_OTP_LOCKED', error.message, {
      retry_after_seconds: error.retryAfterSeconds,
    });
  }
  if (error instanceof OrderNotReviewableError) {
    return new HttpError(409, 'ORDER_STATE_CONFLICT', error.message, { state: error.state });
  }
  if (error instanceof ReviewAlreadySubmittedError) {
    return new HttpError(409, 'REVIEW_ALREADY_SUBMITTED', error.message, {
      review_id: error.reviewId,
    });
  }
  if (error instanceof ReviewWindowClosedError) {
    return new HttpError(422, 'REVIEW_WINDOW_CLOSED', error.message);
  }
  if (error instanceof TopUpUnavailableError) {
    return new HttpError(503, 'TOP_UP_UNAVAILABLE', error.message);
  }
  if (error instanceof TopUpKeyReusedError) {
    return new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', error.message);
  }
  if (error instanceof InvalidLedgerCursorError) {
    return new HttpError(400, 'INVALID_CURSOR', error.message);
  }
  if (error instanceof DeadLetterNotFoundError) {
    return new HttpError(404, 'DEAD_LETTER_NOT_FOUND', 'Dead letter not found');
  }
  if (error instanceof DeadLetterAlreadyReplayedError) {
    return new HttpError(409, 'DEAD_LETTER_ALREADY_REPLAYED', error.message);
  }
  if (error instanceof InvalidDeadLetterCursorError) {
    return new HttpError(400, 'INVALID_CURSOR', error.message);
  }
  if (error instanceof AdminVendorNotFoundError) {
    return new HttpError(404, 'VENDOR_NOT_FOUND', 'Vendor not found');
  }
  if (error instanceof VendorStatusConflictError) {
    return new HttpError(409, 'VENDOR_STATUS_CONFLICT', error.message, { status: error.status });
  }
  if (error instanceof WalletBelowSuspensionLimitError) {
    return new HttpError(409, 'WALLET_BELOW_SUSPENSION_LIMIT', error.message, {
      wallet_balance_npr: error.walletBalanceNpr,
      suspension_limit_npr: error.suspensionLimitNpr,
    });
  }
  if (error instanceof RestoreStatusUnknownError) {
    return new HttpError(409, 'RESTORE_STATUS_UNKNOWN', error.message);
  }
  if (error instanceof CategoryNotFoundError) {
    return new HttpError(404, 'CATEGORY_NOT_FOUND', 'Category not found');
  }
  if (error instanceof CategorySlugTakenError) {
    return new HttpError(409, 'CATEGORY_SLUG_TAKEN', error.message, { slug: error.slug });
  }
  if (error instanceof CategoryParentNotFoundError) {
    return new HttpError(422, 'CATEGORY_PARENT_NOT_FOUND', error.message);
  }
  if (error instanceof CategoryCycleError) {
    return new HttpError(409, 'CATEGORY_CYCLE', error.message);
  }
  if (error instanceof CategoryTooDeepError) {
    return new HttpError(422, 'CATEGORY_TOO_DEEP', error.message, { max_depth: error.maxDepth });
  }
  if (error instanceof CategoryInUseError) {
    return new HttpError(409, 'CATEGORY_IN_USE', error.message, {
      child_count: error.childCount,
      product_count: error.productCount,
    });
  }
  if (error instanceof CategoryUnavailableError) {
    return new HttpError(422, 'CATEGORY_UNAVAILABLE', 'This category is not available', {
      category_id: error.categoryId,
    });
  }
  if (error instanceof ProductNotFoundError) {
    return new HttpError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
  }
  if (error instanceof ProductNameTakenError) {
    return new HttpError(409, 'PRODUCT_NAME_TAKEN', error.message);
  }
  if (error instanceof ProductImageLimitError) {
    return new HttpError(422, 'PRODUCT_IMAGE_LIMIT', error.message, {
      max_images: error.maxImages,
      current_images: error.currentImages,
    });
  }
  if (error instanceof InvalidProductCursorError) {
    return new HttpError(400, 'INVALID_CURSOR', error.message);
  }
  if (error instanceof DisputeWindowClosedError) {
    return new HttpError(422, 'DISPUTE_WINDOW_CLOSED', error.message);
  }
  if (error instanceof MulterError) {
    // Dispute evidence and product photos share the 5 MB limit.
    if (error.code === 'LIMIT_FILE_SIZE') {
      return new HttpError(413, 'FILE_TOO_LARGE', 'Images may be at most 5 MB', {
        max_bytes: MAX_DISPUTE_EVIDENCE_BYTES,
      });
    }
    if (error.code === 'LIMIT_FILE_COUNT') {
      return new HttpError(422, 'PRODUCT_IMAGE_LIMIT', 'Too many images in one upload', {
        max_images: MAX_PRODUCT_IMAGES,
      });
    }
    return new HttpError(400, 'MALFORMED_REQUEST', `Upload rejected: ${error.code}`);
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
  const body: ErrorBody = {
    error: {
      code: httpError.code,
      message: httpError.message,
      ...(httpError.details === undefined ? {} : { details: httpError.details }),
    },
  };
  res.status(httpError.status).json(body);
};
