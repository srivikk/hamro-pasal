import { z } from 'zod';

import {
  DELIVERY_OTP_LENGTH,
  MAX_REVIEW_FEEDBACK_LENGTH,
  OTP_CODE_LENGTH,
} from '../domain/constants';
import { nepalPhoneSchema } from '../domain/entities';
import { paymentMethodSchema } from '../domain/enums';
import { nepalAddressInputSchema } from '../localization/address';
import { NEPAL_BOUNDING_BOX } from '../nepal/geo';

/*
 * HTTP request contracts for apps/api, shared with the mobile client so both sides validate
 * with the same rules.
 */

export const MAX_CART_LINES = 50;
export const MAX_LINE_QUANTITY = 99;

/** POST /api/cart/checkout. Locks the cart for 600 s and creates the order (SPEC §3, journey 6). */
export const checkoutRequestSchema = z.strictObject({
  /** Client-generated per checkout attempt; resubmitting it returns the same order. */
  idempotency_key: z.string().trim().min(8).max(100),
  vendor_id: z.uuid(),
  payment_method: paymentMethodSchema,
  items: z
    .array(
      z.strictObject({
        product_id: z.uuid(),
        quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
      }),
    )
    .min(1)
    .max(MAX_CART_LINES),
  /** Where to deliver (Nepal hierarchy + dropped pin), stored with the order. */
  delivery_address: nepalAddressInputSchema,
});
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;
export type CheckoutRequestInput = z.input<typeof checkoutRequestSchema>;

/** Query-string coordinate: parsed from text and limited to Nepal's bounding box (SPEC §1). */
const queryCoordinate = (field: string, min: number, max: number) =>
  z
    .string({ error: `${field} is required` })
    .trim()
    .min(1, `${field} is required`)
    .pipe(z.coerce.number({ error: `${field} must be a number` }))
    .pipe(z.number().min(min, `${field} is outside Nepal`).max(max, `${field} is outside Nepal`));

const customerLocationQueryShape = {
  lat: queryCoordinate('lat', NEPAL_BOUNDING_BOX.minLat, NEPAL_BOUNDING_BOX.maxLat),
  lng: queryCoordinate('lng', NEPAL_BOUNDING_BOX.minLng, NEPAL_BOUNDING_BOX.maxLng),
  /**
   * The customer's Palika (as in their address). CITY_WIDE vendors are serviceable only when it
   * matches theirs (SPEC §2). Without it no CITY_WIDE vendor can be shown as serviceable.
   */
  municipality_palika_string: z.string().trim().min(1).max(120).optional(),
};

/** GET /api/vendors?lat=&lng=[&municipality_palika_string=] (SPEC customer journey 3). */
export const vendorFeedQuerySchema = z.strictObject(customerLocationQueryShape);
export type VendorFeedQuery = z.output<typeof vendorFeedQuerySchema>;

/** GET /api/vendors/:id/products?lat=&lng=[&municipality_palika_string=] */
export const vendorMenuQuerySchema = z.strictObject(customerLocationQueryShape);
export type VendorMenuQuery = z.output<typeof vendorMenuQuerySchema>;

/** Route parameter `:id` of /api/vendors/:id/... and /api/orders/:id/... */
export const idParamSchema = z.strictObject({
  id: z.uuid(),
});

/** GET /api/cart/lock-status?order_id=... (SPEC edge case 1: resume or purge after reconnect). */
export const lockStatusQuerySchema = z.strictObject({
  order_id: z.uuid(),
});

/** POST /api/payments/{esewa,khalti}/initiate */
export const paymentInitiateRequestSchema = z.strictObject({
  order_id: z.uuid(),
});

/** POST /api/payments/esewa/webhook: the base64 `data` eSewa appends to the success redirect. */
export const esewaWebhookRequestSchema = z.strictObject({
  data: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[A-Za-z0-9+/=_-]+$/, 'data must be base64'),
});

/** POST /api/payments/khalti/lookup: the pidx from Khalti's return_url callback. */
export const khaltiLookupRequestSchema = z.strictObject({
  pidx: z.string().trim().min(1).max(100),
});

/** POST /api/auth/otp/send: the number must already be strict E.164 +977 (SPEC Nepal §4). */
export const otpSendRequestSchema = z.strictObject({
  phone: nepalPhoneSchema,
});
export type OtpSendRequest = z.infer<typeof otpSendRequestSchema>;

/** POST /api/auth/otp/verify */
export const otpVerifyRequestSchema = z.strictObject({
  phone: nepalPhoneSchema,
  code: z
    .string()
    .regex(
      new RegExp(`^[0-9]{${String(OTP_CODE_LENGTH)}}$`),
      `code must be ${String(OTP_CODE_LENGTH)} digits`,
    ),
});
export type OtpVerifyRequest = z.infer<typeof otpVerifyRequestSchema>;

/** POST /api/auth/token/refresh: the 7-day refresh token issued by /otp/verify. */
export const tokenRefreshRequestSchema = z.strictObject({
  refresh_token: z.string().min(1).max(4096),
});
export type TokenRefreshRequest = z.infer<typeof tokenRefreshRequestSchema>;

/**
 * POST /api/reviews (SPEC §6): the customer's rating of a delivered order's vendor. `feedback` is
 * optional; it is trimmed and a blank one is stored as null.
 */
export const reviewSubmitRequestSchema = z.strictObject({
  order_id: z.uuid(),
  rating: z.number().int().min(1).max(5),
  feedback: z
    .string()
    .trim()
    .max(MAX_REVIEW_FEEDBACK_LENGTH)
    .nullish()
    .transform((value) => (value === undefined || value === null || value === '' ? null : value)),
});
export type ReviewSubmitRequest = z.input<typeof reviewSubmitRequestSchema>;
export type ReviewSubmission = z.output<typeof reviewSubmitRequestSchema>;

/** Form fields of POST /api/uploads/dispute-evidence (multipart, next to the `file` part). */
export const disputeEvidenceUploadFieldsSchema = z.strictObject({
  order_id: z.uuid(),
});

/**
 * POST /api/vendors/orders/:id/reviews (SPEC §6): the vendor's 1-5 rating of the order's
 * customer, with the same optional feedback rules as the customer's review.
 */
export const vendorReviewSubmitRequestSchema = reviewSubmitRequestSchema.omit({ order_id: true });
export type VendorReviewSubmitRequest = z.input<typeof vendorReviewSubmitRequestSchema>;

/**
 * POST /api/deliveries/:id/complete (driver flow step 5) and /api/vendors/orders/:id/deliver
 * (vendor flow step 9, SELF_DELIVERY orders): the 4-digit code the customer shows
 * at the door, as ASCII digits (leading zeros kept, hence a string).
 */
export const deliveryOtpRequestSchema = z.strictObject({
  delivery_otp: z.string().length(DELIVERY_OTP_LENGTH).regex(/^\d+$/, 'Must be ASCII digits'),
});
export type DeliveryOtpRequest = z.input<typeof deliveryOtpRequestSchema>;

/** Phase 12: page sizes of GET /api/vendors/wallet/ledger. */
export const VENDOR_WALLET_LEDGER_DEFAULT_LIMIT = 20;
export const VENDOR_WALLET_LEDGER_MAX_LIMIT = 50;

/**
 * GET /api/vendors/wallet/ledger?limit=&cursor= (SPEC §5): the vendor's wallet postings, newest
 * first. `cursor` is the `next_cursor` of the previous page (the id of its last entry), so new
 * postings arriving meanwhile never shift or repeat entries.
 */
export const vendorWalletLedgerQuerySchema = z.strictObject({
  limit: z
    .string()
    .trim()
    .regex(/^\d{1,3}$/, 'limit must be a whole number')
    .transform(Number)
    .pipe(z.number().int().min(1).max(VENDOR_WALLET_LEDGER_MAX_LIMIT))
    .optional(),
  cursor: z.uuid().optional(),
});
export type VendorWalletLedgerQuery = z.output<typeof vendorWalletLedgerQuerySchema>;

/** Phase 12.5: the largest single wallet top-up, in NPR. */
export const MAX_WALLET_TOP_UP_NPR = 100_000;

/**
 * POST /api/vendors/wallet/top-up (SPEC §5: the vendor clears a negative wallet upfront). The key is
 * generated by the client per payment attempt: resending it returns the same top-up, never a
 * second credit.
 */
export const walletTopUpRequestSchema = z.strictObject({
  idempotency_key: z.string().trim().min(8).max(100),
  amount_npr: z
    .number()
    .positive()
    .max(MAX_WALLET_TOP_UP_NPR)
    .refine(
      (amount) => Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6,
      'amount_npr must be a whole number of paisa',
    ),
});
export type WalletTopUpRequest = z.infer<typeof walletTopUpRequestSchema>;
