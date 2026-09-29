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

/** WGS 84, the SRID of every stored geometry. */
export const GEO_SRID = 4326;
