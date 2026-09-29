import { randomInt } from 'node:crypto';

import { hash } from 'bcryptjs';

/** Cost factor for the handoff OTP hash; the raw code only ever lives on the customer's device. */
const BCRYPT_ROUNDS = 10;

/** SPEC journey step 10: a 4-digit code from a CSPRNG (never Math.random). */
export function generateDeliveryOtp(): string {
  return String(randomInt(0, 10_000)).padStart(4, '0');
}

/** SPEC data model: `delivery_otp` is stored as a bcrypt hash, raw only on the customer UI. */
export function hashDeliveryOtp(otp: string): Promise<string> {
  if (!/^\d{4}$/.test(otp)) {
    throw new Error('Delivery OTP must be exactly 4 digits');
  }
  return hash(otp, BCRYPT_ROUNDS);
}
