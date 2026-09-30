import {
  NEPAL_PHONE_REGEX,
  normalizeNepalPhone,
  OTP_CODE_LENGTH,
  toAsciiDigits,
} from '@hamro-pasal/shared-types';

/** Shown in front of the number field; customers type only the 10-digit national number. */
export const NEPAL_DIALING_PREFIX = '+977';

/**
 * The typed number as strict E.164 (+9779XXXXXXXXX), or null if it is not a Nepal mobile number.
 * Accepts Devanagari digits and the usual separators, and a pasted +977 / 977 prefix; the result
 * must pass the shared NEPAL_PHONE_REGEX (the same rule the API and the database enforce).
 */
export function toNepalPhone(input: string): string | null {
  const ascii = toAsciiDigits(input).trim();
  if (ascii === '') return null;
  try {
    const e164 = normalizeNepalPhone(ascii);
    return NEPAL_PHONE_REGEX.test(e164) ? e164 : null;
  } catch {
    return null;
  }
}

/** What the code field keeps: ASCII digits only (Nepali-keyboard digits converted), at most 6. */
export function sanitizeOtpInput(input: string): string {
  return toAsciiDigits(input)
    .replace(/[^0-9]/g, '')
    .slice(0, OTP_CODE_LENGTH);
}

export function isCompleteOtp(code: string): boolean {
  return code.length === OTP_CODE_LENGTH && /^[0-9]+$/.test(code);
}

/** "+9779800000001" -> "+977 9800000001", for display. */
export function formatNepalPhone(e164: string): string {
  return `${NEPAL_DIALING_PREFIX} ${e164.slice(NEPAL_DIALING_PREFIX.length)}`;
}

/**
 * After signing in, return to the screen that sent the customer to the login (the login screen
 * replaced itself with the code screen, so one step back is that screen), or to the Feed when the
 * login was the first screen.
 */
export interface SignInNavigator {
  canGoBack: () => boolean;
  back: () => void;
  replace: (href: '/') => void;
}

export function leaveSignIn(router: SignInNavigator): void {
  if (router.canGoBack()) {
    router.back();
  } else {
    router.replace('/');
  }
}
