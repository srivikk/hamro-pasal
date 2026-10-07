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

/** A Nepal mobile number without its +977 prefix is exactly this many digits. */
export const NEPAL_MOBILE_DIGITS = 10;

/**
 * What the sign-in number field keeps: ASCII digits only (Nepali-keyboard digits converted,
 * separators dropped), at most ten. A pasted or auto-filled +977 / 977 prefix is taken off first,
 * so the national number is what remains.
 */
export function sanitizePhoneInput(input: string): string {
  let digits = toAsciiDigits(input).replace(/[^0-9]/g, '');
  if (digits.length > NEPAL_MOBILE_DIGITS && digits.startsWith('977')) digits = digits.slice(3);
  return digits.slice(0, NEPAL_MOBILE_DIGITS);
}

/** Room for a pasted or auto-filled "+977 98XX-XXXXXX" while the field is not full yet. */
const PHONE_PASTE_ALLOWANCE = 20;

/**
 * The native length limit of the number field. A full field is capped at ten, so the keyboard
 * itself refuses an eleventh digit and it never appears, not even for one frame. A field that is
 * not full allows more, so a pasted or auto-filled number with its +977 prefix arrives whole for
 * `sanitizePhoneInput` to reduce.
 */
export function phoneInputMaxLength(draft: string): number {
  return draft.length >= NEPAL_MOBILE_DIGITS ? NEPAL_MOBILE_DIGITS : PHONE_PASTE_ALLOWANCE;
}

/**
 * The field's next value for what the keyboard reported, or null when nothing changes (a
 * keystroke the field refuses: an eleventh digit, a letter): the caller then sets no state.
 */
export function nextPhoneDraft(current: string, text: string): string | null {
  const next = sanitizePhoneInput(text);
  return next === current ? null : next;
}

/**
 * The sign-in field's value as strict E.164, or null. It must be exactly ten digits before
 * anything else is checked; the shared +977 rule (a mobile number starts with 9) then applies.
 */
export function toTenDigitNepalPhone(digits: string): string | null {
  return /^[0-9]{10}$/.test(digits) ? toNepalPhone(digits) : null;
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
