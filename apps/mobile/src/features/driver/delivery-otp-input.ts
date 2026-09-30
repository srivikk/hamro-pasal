import { DELIVERY_OTP_LENGTH, toAsciiDigits } from '@hamro-pasal/shared-types';

/**
 * What the delivery-code field keeps: ASCII digits only (a Nepali keyboard's ०–९ converted, pasted
 * spaces and dashes dropped), at most 4.
 */
export function sanitizeDeliveryOtpInput(input: string): string {
  return toAsciiDigits(input)
    .replace(/[^0-9]/g, '')
    .slice(0, DELIVERY_OTP_LENGTH);
}

export function isCompleteDeliveryOtp(code: string): boolean {
  return code.length === DELIVERY_OTP_LENGTH && /^[0-9]+$/.test(code);
}

/** Whole minutes (at least 1) for "try again in N minutes". */
export function lockoutMinutes(retryAfterSeconds: number): number {
  return Math.max(1, Math.ceil(retryAfterSeconds / 60));
}
