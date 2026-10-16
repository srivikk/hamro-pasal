import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { ACCESS_TOKEN } from './access-token';

/**
 * Step 7.7: proof that a number passed its OTP in the Seller app but has no shop yet. Signed with
 * the refresh secret under its own audience, so it is never an access or a refresh token, and
 * short-lived: the signup form follows the sign-in.
 */
export const SELLER_SIGNUP_TOKEN = {
  algorithm: 'HS256',
  issuer: ACCESS_TOKEN.issuer,
  audience: 'hamro-pasal-seller-signup',
  ttlSeconds: 30 * 60,
} as const;

const claimsSchema = z.object({ sub: z.uuid(), typ: z.literal('seller-signup') });

export class InvalidSignupTokenError extends Error {
  constructor(reason: string) {
    super(`Invalid signup token: ${reason}`);
    this.name = 'InvalidSignupTokenError';
  }
}

export function signSellerSignupToken(userId: string, secret: string): string {
  return jwt.sign({ typ: 'seller-signup' }, secret, {
    algorithm: SELLER_SIGNUP_TOKEN.algorithm,
    subject: userId,
    issuer: SELLER_SIGNUP_TOKEN.issuer,
    audience: SELLER_SIGNUP_TOKEN.audience,
    expiresIn: SELLER_SIGNUP_TOKEN.ttlSeconds,
  });
}

/** The account the token was issued for. */
export function verifySellerSignupToken(token: string, secret: string): string {
  let payload: unknown;
  try {
    payload = jwt.verify(token, secret, {
      algorithms: [SELLER_SIGNUP_TOKEN.algorithm],
      issuer: SELLER_SIGNUP_TOKEN.issuer,
      audience: SELLER_SIGNUP_TOKEN.audience,
    });
  } catch (error: unknown) {
    throw new InvalidSignupTokenError(error instanceof Error ? error.message : 'unverifiable');
  }
  const claims = claimsSchema.safeParse(payload);
  if (!claims.success) throw new InvalidSignupTokenError('unexpected claims');
  return claims.data.sub;
}
