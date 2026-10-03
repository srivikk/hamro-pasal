import { normalizeNepalPhone, type AuthUser } from '@hamro-pasal/shared-types';

import { ApiError } from '../../api/client';

/** The number typed after the fixed +977 prefix, as the API's strict +9779XXXXXXXXX, or null. */
export function toNepalPhone(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  try {
    return normalizeNepalPhone(trimmed);
  } catch {
    return null;
  }
}

export function isOtpCode(input: string): boolean {
  return /^\d{6}$/.test(input.trim());
}

/** Only Super Admins may use the dashboard; the API enforces it too (403 on every admin route). */
export function isSuperAdmin(user: AuthUser): boolean {
  return user.role === 'SUPER_ADMIN';
}

/** The two sides of this web app. */
export type Portal = 'ADMIN' | 'VENDOR';

/**
 * Which side an account opens (Phase 19): the dashboard for a Super Admin, the Vendor Portal for a
 * vendor, nothing for customers and riders. The API enforces the same split (403).
 */
export function portalOf(user: AuthUser): Portal | null {
  if (user.role === 'SUPER_ADMIN') return 'ADMIN';
  if (user.role === 'VENDOR') return 'VENDOR';
  return null;
}

/** What to show for a failed sign-in step. */
export function signInErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.';
  switch (error.code) {
    case 'OTP_INVALID':
      return 'That code is wrong. Check the SMS and try again.';
    case 'OTP_EXPIRED':
      return 'The code has expired. Request a new one.';
    case 'OTP_ATTEMPTS_EXCEEDED':
      return 'Too many wrong codes. Request a new one.';
    case 'OTP_RESEND_COOLDOWN':
      return 'A code was sent a moment ago. Wait a minute before asking again.';
    case 'SMS_DELIVERY_FAILED':
      return 'The SMS could not be sent. Try again.';
    case 'NETWORK_ERROR':
      return 'The API cannot be reached.';
    case 'VALIDATION_FAILED':
      return 'Enter a valid Nepal mobile number.';
    default:
      return 'Something went wrong. Try again.';
  }
}
