import { z } from 'zod';

/*
 * 2026-10-21 (Task 5, decided by the user: "guarded reveal"): the Super Admin's Authentication
 * Logs, a failsafe for SMS delays. Every login-code send and check is logged (never the code). A
 * live code can be revealed, one at a time, with a written reason, and only where the server runs
 * with OTP_ADMIN_REVEAL=true (off by default). Each reveal is in the audit trail.
 */

export const authEventKinds = [
  /** A code was generated and handed to the SMS gateway. */
  'OTP_SENT',
  /** The SMS gateway refused it; the code was discarded. */
  'OTP_SEND_FAILED',
  /** A resend inside the cooldown; nothing was sent. */
  'OTP_COOLDOWN',
  'OTP_VERIFIED',
  'OTP_WRONG',
  /** The last allowed attempt failed; the code was burned. */
  'OTP_LOCKED',
  /** A check found no code: never sent, expired or already used. */
  'OTP_EXPIRED',
] as const;
export const authEventKindSchema = z.enum(authEventKinds);
export type AuthEventKind = z.infer<typeof authEventKindSchema>;

export const AUTH_LOG_DEFAULT_LIMIT = 50;

const phoneSchema = z.string().regex(/^\+977\d{10}$/, 'A +977 number of 10 digits');

/** GET /api/admin/auth-logs?phone=&cursor=&limit=, newest first. */
export const adminAuthLogListQuerySchema = z.strictObject({
  phone: phoneSchema.optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(AUTH_LOG_DEFAULT_LIMIT),
});
export type AdminAuthLogListQuery = z.infer<typeof adminAuthLogListQuerySchema>;

export const authLogEntrySchema = z.strictObject({
  id: z.uuid(),
  phone: phoneSchema,
  /** The account of that number, when one exists. */
  user_id: z.uuid().nullable(),
  kind: authEventKindSchema,
  /** The gateway's error, or the attempts left; never the code. */
  detail: z.string().nullable(),
  created_at: z.iso.datetime(),
  /** The newest send of a number whose code is still live and revealable. */
  revealable: z.boolean(),
});
export type AuthLogEntry = z.infer<typeof authLogEntrySchema>;

export const adminAuthLogListResponseSchema = z.strictObject({
  entries: z.array(authLogEntrySchema),
  next_cursor: z.uuid().nullable(),
  /** Whether this server keeps codes revealable (OTP_ADMIN_REVEAL). */
  reveal_enabled: z.boolean(),
});
export type AdminAuthLogListResponseBody = z.infer<typeof adminAuthLogListResponseSchema>;

export const OTP_REVEAL_REASON_MIN_LENGTH = 10;
export const OTP_REVEAL_REASON_MAX_LENGTH = 300;

/** POST /api/admin/auth-logs/reveal. */
export const adminOtpRevealRequestSchema = z.strictObject({
  phone: phoneSchema,
  reason: z.string().trim().min(OTP_REVEAL_REASON_MIN_LENGTH).max(OTP_REVEAL_REASON_MAX_LENGTH),
});
export type AdminOtpRevealRequest = z.infer<typeof adminOtpRevealRequestSchema>;

export const adminOtpRevealResponseSchema = z.strictObject({
  phone: phoneSchema,
  code: z.string().regex(/^\d{6}$/),
  expires_in_seconds: z.number().int().min(0),
  attempts_used: z.number().int().min(0),
});
export type AdminOtpRevealResponseBody = z.infer<typeof adminOtpRevealResponseSchema>;

/** "+9779801234567" -> "+97798•••••567": how a number is written to the audit trail. */
export function maskPhone(phone: string): string {
  return phone.length <= 9 ? phone : `${phone.slice(0, 6)}•••••${phone.slice(-3)}`;
}
