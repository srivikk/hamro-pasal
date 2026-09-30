/**
 * Nepal mobile numbers in E.164: +977 followed by a 10-digit number starting with 9.
 * Written in a regex subset shared by JavaScript and PostgreSQL, so the DB CHECK uses the same source.
 */
export const NEPAL_PHONE_PATTERN = '^\\+9779[0-9]{9}$';
export const NEPAL_PHONE_REGEX = new RegExp(NEPAL_PHONE_PATTERN);

/** Nepal has 7 provinces (SPEC address schema: province_id 1-7). */
export const NEPAL_PROVINCE_ID_MIN = 1;
export const NEPAL_PROVINCE_ID_MAX = 7;

/**
 * Absolute floor for a non-suspended vendor wallet (SPEC §5, edge case #2).
 * The Superadmin-configurable suspension limit may be stricter, never looser.
 */
export const VENDOR_WALLET_HARD_FLOOR_NPR = -2000;

/** SPEC §3: checkout locks SKU quantities in Redis for exactly 10 minutes. */
export const INVENTORY_LOCK_TTL_SECONDS = 600;

/** SPEC §6: customers whose average rating is below this lose COD everywhere. */
export const COD_MIN_CUSTOMER_RATING = 3.0;

/** WGS 84, the SRID of every stored geometry. */
export const GEO_SRID = 4326;

/**
 * SPEC §2: a RADIUS_BOUND vendor serves a customer at distance D when D <= radius_km x 1.1.
 * The extra 10% is the strict GPS-drift grace buffer.
 */
export const DELIVERY_RADIUS_GPS_DRIFT_MULTIPLIER = 1.1;

/**
 * Customer journey 8: an order can be canceled for 60 s after it is placed. The server measures
 * it on its own clock as NOW() - orders.placed_at.
 */
export const ORDER_CANCELLATION_WINDOW_SECONDS = 60;

/*
 * OTP login (SPEC customer/vendor journey step 1: "Auth via OTP (+977 only)").
 * The code lives in Redis for OTP_TTL_SECONDS; a new code can be requested after
 * OTP_RESEND_COOLDOWN_SECONDS; OTP_MAX_VERIFY_ATTEMPTS wrong guesses burn the code.
 */
export const OTP_CODE_LENGTH = 6;
export const OTP_TTL_SECONDS = 120;
export const OTP_RESEND_COOLDOWN_SECONDS = 60;
export const OTP_MAX_VERIFY_ATTEMPTS = 5;

/*
 * Delivery handoff (customer journey 10, driver flow step 5): the customer shows a 4-digit code
 * and the rider types it in. DELIVERY_OTP_MAX_ATTEMPTS wrong codes for one order lock it for
 * DELIVERY_OTP_LOCKOUT_SECONDS, so the 10 000 possible codes cannot be tried at the door.
 */
export const DELIVERY_OTP_LENGTH = 4;
export const DELIVERY_OTP_MAX_ATTEMPTS = 5;
export const DELIVERY_OTP_LOCKOUT_SECONDS = 15 * 60;

/** SPEC implicit requirement 3: 15-minute access tokens and 7-day refresh tokens. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

/*
 * SPEC §6 and customer journey 11: at delivery a 48-hour window opens for the double-blind review
 * and for starting a dispute chat. A review stays quarantined (is_published = false) until the
 * other side has reviewed too, or until this window has elapsed since orders.delivered_at.
 */
export const POST_DELIVERY_WINDOW_HOURS = 48;
export const POST_DELIVERY_WINDOW_SECONDS = POST_DELIVERY_WINDOW_HOURS * 60 * 60;

/** Longest optional feedback text accepted with a review. */
export const MAX_REVIEW_FEEDBACK_LENGTH = 500;

/** Largest dispute evidence image accepted by POST /api/uploads/dispute-evidence (5 MB). */
export const MAX_DISPUTE_EVIDENCE_BYTES = 5 * 1024 * 1024;

/** Image types accepted as dispute evidence (checked against the file's own bytes). */
export const DISPUTE_EVIDENCE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type DisputeEvidenceContentType = (typeof DISPUTE_EVIDENCE_CONTENT_TYPES)[number];
