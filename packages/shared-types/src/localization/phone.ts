import { NEPAL_PHONE_REGEX } from '../domain/constants';

export class InvalidNepalPhoneError extends Error {
  constructor(readonly input: string) {
    super('Not a valid Nepal mobile number (expected +977 followed by 10 digits starting with 9)');
    this.name = 'InvalidNepalPhoneError';
  }
}

/**
 * Normalises user-entered Nepal mobile numbers to strict E.164 `+9779XXXXXXXXX`.
 * Accepts the national form (98XXXXXXXX), 977/00977 prefixes, and spaces, dashes, dots or
 * brackets as separators. Anything else, including other country codes, is rejected: the
 * platform is +977 only (SPEC §1, SMS/OTP §4).
 */
export function normalizeNepalPhone(input: string): string {
  const compact = input.trim().replace(/[\s\-().]/g, '');
  let national: string;
  if (compact.startsWith('+977')) {
    national = compact.slice(4);
  } else if (compact.startsWith('00977')) {
    national = compact.slice(5);
  } else if (compact.startsWith('977') && compact.length === 13) {
    national = compact.slice(3);
  } else {
    national = compact;
  }
  const e164 = `+977${national}`;
  if (!NEPAL_PHONE_REGEX.test(e164)) {
    throw new InvalidNepalPhoneError(input);
  }
  return e164;
}

export function isNepalPhone(value: string): boolean {
  return NEPAL_PHONE_REGEX.test(value);
}
