import {
  MAX_DISPUTE_EVIDENCE_BYTES,
  MAX_PRODUCT_IMAGES,
  type ErrorBody,
} from '@hamro-pasal/shared-types';
import type { ErrorRequestHandler } from 'express';
import { MulterError } from 'multer';

import { PanDocumentNotFoundError, PanMissingError } from '../admin/admin-compliance-service';
import {
  SettlementChangeBlockedError,
  SettlementModelRequestDecidedError,
  SettlementModelRequestNotFoundError,
  SettlementModelRequestPendingError,
  SettlementModelUnavailableError,
  SettlementModelUnchangedError,
} from '../settlement/settlement-model-request-service';
import { InvalidAuditLogCursorError } from '../admin/audit-log-service';
import {
  DefaultPlanNotCommissionError,
  DefaultPlanRequiredError,
  PricingPlanNameTakenError,
  PricingPlanNotFoundError,
} from '../admin/pricing-plan-service';
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
import { InvoiceFontUnavailableError } from '../invoices/invoice-fonts';
import {
  DeliveryAlreadyAssignedError,
  DeliveryNotFoundError,
  DeliveryStateConflictError,
} from '../deliveries/delivery-service';
import { DisputeWindowClosedError } from '../disputes/dispute-service';
import {
  BankAccountMissingError,
  PanNotVerifiedError,
  SettlementModelNotEscrowError,
} from '../finance/admin-settlement-service';
import { AD_PURCHASE_MAX_START_AHEAD_DAYS } from '@hamro-pasal/shared-types';

import { AdProductNotFoundError } from '../marketing/ad-product-service';
import {
  AdBudgetInvalidError,
  AdExceedsPendingPayoutError,
  AdPurchaseKeyReusedError,
  AdPurchaseNotCancellableError,
  AdPurchaseNotFoundError,
  AdStartOutOfRangeError,
  LedgerRechargeRequiredError,
} from '../marketing/ad-purchase-service';
import {
  InvalidInvoiceCursorError,
  InvoiceNotFoundError,
} from '../invoices/vendor-invoice-service';
import {
  VendorOfferEndInPastError,
  VendorOfferLimitError,
  VendorOfferNotFoundError,
} from '../marketing/vendor-offer-service';
import {
  CampaignEndedError,
  CampaignNotFoundError,
  CampaignNotOptedInError,
  CampaignTermsChangedError,
} from '../marketing/campaign-service';
import {
  AdPurchaseMismatchError,
  PromotionImageInUseError,
  PromotionNotFoundError,
  PromotionTargetNotFoundError,
} from '../marketing/promotion-service';
import {
  BankAccountExistsError,
  BankAccountLimitError,
  BankAccountNotFoundError,
  PrimaryBankAccountRequiredError,
} from '../vendor/vendor-bank-account-service';
import {
  InvalidPayoutCursorError,
  PayoutAlreadyDecidedError,
  PayoutNotFoundError,
  PayoutNotProcessingError,
} from '../finance/admin-payout-service';
import { PayoutExceedsBalanceError, PayoutKeyReusedError } from '../finance/vendor-finance-service';
import {
  InsufficientStockError,
  InvalidCartError,
  ProductUnavailableError,
  ReservationContentionError,
  ReservationExpiredError,
} from '../inventory/errors';
import { MutexTimeoutError } from '../infra/redis-mutex';
import { toNpr } from '../ledger/money';
import { DeviceTokenOwnerNotFoundError } from '../notifications/device-token-service';
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
import {
  BillingCycleNotStartedError,
  LockInActiveError,
  PricingPlanNotOfferedError,
  SettingChangeClosedError,
  SettingChangeNotFoundError,
} from '../vendor/vendor-billing-service';
import {
  DeliveryModeDisabledError,
  TooManyServiceablePalikasError,
} from '../vendor/vendor-delivery-settings-service';
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
  if (error instanceof DeviceTokenOwnerNotFoundError) {
    // The same answer as a dead access token: the app's refresh then ends the session.
    return new HttpError(401, 'UNAUTHENTICATED', 'Invalid or expired token');
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
  if (error instanceof DeliveryNotFoundError) {
    return new HttpError(404, 'DELIVERY_NOT_FOUND', 'Delivery not found');
  }
  if (error instanceof DeliveryAlreadyAssignedError) {
    return new HttpError(409, 'DELIVERY_ALREADY_ASSIGNED', error.message);
  }
  if (error instanceof DeliveryStateConflictError) {
    return new HttpError(409, 'DELIVERY_STATE_CONFLICT', error.message, { state: error.state });
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
  if (error instanceof PayoutExceedsBalanceError) {
    return new HttpError(422, 'INSUFFICIENT_BALANCE', 'The payout exceeds the available balance', {
      requested_npr: error.requestedNpr,
      available_balance_npr: error.availableBalanceNpr,
    });
  }
  if (error instanceof PayoutKeyReusedError) {
    return new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', error.message);
  }
  if (error instanceof PayoutNotFoundError) {
    return new HttpError(404, 'PAYOUT_NOT_FOUND', 'Payout request not found');
  }
  if (error instanceof PayoutAlreadyDecidedError) {
    return new HttpError(409, 'PAYOUT_ALREADY_DECIDED', error.message, { status: error.status });
  }
  if (error instanceof PayoutNotProcessingError) {
    return new HttpError(409, 'PAYOUT_NOT_PROCESSING', error.message, {
      status: error.status,
      transfer_state: error.transferState,
    });
  }
  if (error instanceof InvalidPayoutCursorError) {
    return new HttpError(400, 'INVALID_CURSOR', error.message);
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
  if (error instanceof InvalidAuditLogCursorError) {
    return new HttpError(400, 'INVALID_CURSOR', error.message);
  }
  if (error instanceof PanNotVerifiedError) {
    return new HttpError(422, 'PAN_NOT_VERIFIED', error.message, { vendor_id: error.vendorId });
  }
  if (error instanceof BankAccountMissingError) {
    return new HttpError(422, 'BANK_ACCOUNT_MISSING', error.message, {
      vendor_id: error.vendorId,
    });
  }
  if (error instanceof SettlementModelNotEscrowError) {
    return new HttpError(422, 'SETTLEMENT_MODEL_NOT_ESCROW', error.message, {
      settlement_model: error.settlementModel,
    });
  }
  if (error instanceof BankAccountNotFoundError) {
    return new HttpError(404, 'BANK_ACCOUNT_NOT_FOUND', 'Bank account not found');
  }
  if (error instanceof BankAccountExistsError) {
    return new HttpError(409, 'BANK_ACCOUNT_EXISTS', error.message);
  }
  if (error instanceof BankAccountLimitError) {
    return new HttpError(422, 'BANK_ACCOUNT_LIMIT_REACHED', error.message, { max: error.max });
  }
  if (error instanceof PrimaryBankAccountRequiredError) {
    return new HttpError(409, 'PRIMARY_BANK_ACCOUNT_REQUIRED', error.message);
  }
  if (error instanceof InvoiceFontUnavailableError) {
    // The cause (a missing server file) is logged at startup; the client only needs "not now".
    return new HttpError(503, 'INVOICE_PRINT_UNAVAILABLE', 'Invoices cannot be printed right now');
  }
  if (error instanceof InvoiceNotFoundError) {
    return new HttpError(404, 'INVOICE_NOT_FOUND', 'Invoice not found');
  }
  if (error instanceof InvalidInvoiceCursorError) {
    return new HttpError(400, 'INVALID_CURSOR', 'The cursor is not valid');
  }
  if (error instanceof VendorOfferNotFoundError) {
    return new HttpError(404, 'OFFER_NOT_FOUND', 'Offer not found');
  }
  if (error instanceof VendorOfferLimitError) {
    return new HttpError(422, 'OFFER_LIMIT_REACHED', error.message, { max: error.max });
  }
  if (error instanceof VendorOfferEndInPastError) {
    return new HttpError(422, 'OFFER_END_IN_PAST', error.message);
  }
  if (error instanceof CampaignNotFoundError) {
    return new HttpError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
  }
  if (error instanceof CampaignTermsChangedError) {
    return new HttpError(409, 'CAMPAIGN_TERMS_CHANGED', error.message, {
      terms_version: error.currentTermsVersion,
    });
  }
  if (error instanceof CampaignNotOptedInError) {
    return new HttpError(409, 'CAMPAIGN_NOT_OPTED_IN', error.message);
  }
  if (error instanceof SettlementModelRequestNotFoundError) {
    return new HttpError(
      404,
      'SETTLEMENT_MODEL_REQUEST_NOT_FOUND',
      'Settlement model request not found',
    );
  }
  if (error instanceof SettlementModelUnavailableError) {
    return new HttpError(422, 'SETTLEMENT_MODEL_UNAVAILABLE', error.message, {
      settlement_model: error.model,
    });
  }
  if (error instanceof SettlementModelUnchangedError) {
    return new HttpError(422, 'SETTLEMENT_MODEL_UNCHANGED', error.message, {
      settlement_model: error.model,
    });
  }
  if (error instanceof SettlementModelRequestPendingError) {
    return new HttpError(409, 'SETTLEMENT_MODEL_REQUEST_PENDING', error.message, {
      request_id: error.requestId,
    });
  }
  if (error instanceof SettlementChangeBlockedError) {
    return new HttpError(409, 'SETTLEMENT_CHANGE_BLOCKED', error.message, {
      blockers: error.blockers,
    });
  }
  if (error instanceof SettlementModelRequestDecidedError) {
    return new HttpError(409, 'REQUEST_ALREADY_DECIDED', error.message, { status: error.status });
  }
  if (error instanceof CampaignEndedError) {
    return new HttpError(422, 'CAMPAIGN_ENDED', error.message);
  }
  if (error instanceof AdProductNotFoundError) {
    return new HttpError(404, 'AD_PRODUCT_NOT_FOUND', 'Ad product not found');
  }
  if (error instanceof PromotionNotFoundError) {
    return new HttpError(404, 'PROMOTION_NOT_FOUND', 'Promotion not found');
  }
  if (error instanceof PromotionTargetNotFoundError) {
    return new HttpError(422, 'PROMOTION_TARGET_NOT_FOUND', error.message, {
      target_type: error.targetType,
    });
  }
  if (error instanceof AdPurchaseMismatchError) {
    return new HttpError(422, 'AD_PURCHASE_MISMATCH', error.message, { reason: error.reason });
  }
  if (error instanceof AdPurchaseNotFoundError) {
    return new HttpError(404, 'AD_PURCHASE_NOT_FOUND', 'Ad purchase not found');
  }
  if (error instanceof AdPurchaseKeyReusedError) {
    return new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', error.message);
  }
  if (error instanceof AdBudgetInvalidError) {
    return new HttpError(422, 'AD_BUDGET_INVALID', error.message, {
      billing_model: error.billingModel,
      price_npr: error.priceNpr,
    });
  }
  if (error instanceof AdStartOutOfRangeError) {
    return new HttpError(422, 'AD_START_OUT_OF_RANGE', error.message, {
      max_days_ahead: AD_PURCHASE_MAX_START_AHEAD_DAYS,
    });
  }
  if (error instanceof AdExceedsPendingPayoutError) {
    return new HttpError(422, 'AD_EXCEEDS_PENDING_PAYOUT', error.message, {
      ad_price_npr: error.adPriceNpr,
      balance_npr: error.balanceNpr,
      pending_escrow_npr: error.pendingEscrowNpr,
      ad_fees_due_npr: error.adFeesDueNpr,
    });
  }
  if (error instanceof LedgerRechargeRequiredError) {
    return new HttpError(422, 'LEDGER_RECHARGE_REQUIRED', error.message, {
      recharge_required_npr: error.rechargeRequiredNpr,
    });
  }
  if (error instanceof AdPurchaseNotCancellableError) {
    return new HttpError(409, 'AD_PURCHASE_NOT_CANCELLABLE', error.message, {
      reason: error.reason,
    });
  }
  if (error instanceof PricingPlanNotFoundError) {
    return new HttpError(404, 'PRICING_PLAN_NOT_FOUND', 'Pricing plan not found');
  }
  if (error instanceof PricingPlanNameTakenError) {
    return new HttpError(409, 'PRICING_PLAN_NAME_TAKEN', error.message);
  }
  if (error instanceof DefaultPlanRequiredError) {
    return new HttpError(409, 'DEFAULT_PLAN_REQUIRED', error.message);
  }
  if (error instanceof DefaultPlanNotCommissionError) {
    return new HttpError(422, 'DEFAULT_PLAN_NOT_COMMISSION', error.message);
  }
  if (error instanceof PanMissingError) {
    return new HttpError(409, 'PAN_MISSING', 'The vendor has no PAN on file to verify');
  }
  if (error instanceof PanDocumentNotFoundError) {
    return new HttpError(404, 'PAN_DOCUMENT_NOT_FOUND', 'The vendor has uploaded no PAN document');
  }
  if (error instanceof PromotionImageInUseError) {
    return new HttpError(409, 'PROMOTION_IMAGE_IN_USE', error.message);
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
  if (error instanceof BillingCycleNotStartedError) {
    return new HttpError(409, 'BILLING_CYCLE_NOT_STARTED', error.message);
  }
  if (error instanceof PricingPlanNotOfferedError) {
    return new HttpError(422, 'PRICING_PLAN_NOT_OFFERED', error.message);
  }
  if (error instanceof LockInActiveError) {
    return new HttpError(409, 'LOCK_IN_ACTIVE', error.message, {
      lock_in_expiry: error.lockInExpiry.toISOString(),
    });
  }
  if (error instanceof SettingChangeNotFoundError) {
    return new HttpError(404, 'SETTING_CHANGE_NOT_FOUND', error.message);
  }
  if (error instanceof SettingChangeClosedError) {
    return new HttpError(409, 'SETTING_CHANGE_CLOSED', error.message, { status: error.status });
  }
  if (error instanceof DeliveryModeDisabledError) {
    return new HttpError(422, 'DELIVERY_MODE_DISABLED', error.message, {
      fulfillment_mode: error.fulfillmentMode,
    });
  }
  if (error instanceof TooManyServiceablePalikasError) {
    return new HttpError(400, 'VALIDATION_FAILED', 'Request validation failed', {
      issues: [{ path: 'serviceable_palikas', message: error.message }],
    });
  }
  if (error instanceof DisputeWindowClosedError) {
    return new HttpError(422, 'DISPUTE_WINDOW_CLOSED', error.message);
  }
  if (error instanceof MulterError) {
    // Every image upload (evidence, product photos, promotion art, PAN documents) is 5 MB.
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
