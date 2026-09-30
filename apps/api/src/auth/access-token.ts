import { ACCESS_TOKEN_TTL_SECONDS, userRoleSchema, type UserRole } from '@hamro-pasal/shared-types';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

/**
 * SPEC implicit requirement 3: short-lived (15 min) access tokens, issued by OTP login
 * (auth/otp-auth-service.ts). This module fixes the token contract both sides use.
 */
export const ACCESS_TOKEN = {
  algorithm: 'HS256',
  issuer: 'hamro-pasal-api',
  audience: 'hamro-pasal-app',
  ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
} as const;

export interface AccessTokenClaims {
  readonly userId: string;
  readonly role: UserRole;
}

const claimsSchema = z.object({
  sub: z.uuid(),
  role: userRoleSchema,
});

export class InvalidAccessTokenError extends Error {
  constructor(reason: string) {
    super(`Invalid access token: ${reason}`);
    this.name = 'InvalidAccessTokenError';
  }
}

export function signAccessToken(claims: AccessTokenClaims, secret: string): string {
  return jwt.sign({ role: claims.role }, secret, {
    algorithm: ACCESS_TOKEN.algorithm,
    subject: claims.userId,
    issuer: ACCESS_TOKEN.issuer,
    audience: ACCESS_TOKEN.audience,
    expiresIn: ACCESS_TOKEN.ttlSeconds,
  });
}

/**
 * Verifies signature, algorithm (HS256 only, so `alg: none` and algorithm-confusion attacks are
 * refused), issuer, audience and expiry, then validates the claims' shape.
 */
export function verifyAccessToken(token: string, secret: string): AccessTokenClaims {
  let payload: unknown;
  try {
    payload = jwt.verify(token, secret, {
      algorithms: [ACCESS_TOKEN.algorithm],
      issuer: ACCESS_TOKEN.issuer,
      audience: ACCESS_TOKEN.audience,
    });
  } catch (error: unknown) {
    throw new InvalidAccessTokenError(error instanceof Error ? error.message : 'unverifiable');
  }
  const claims = claimsSchema.safeParse(payload);
  if (!claims.success) {
    throw new InvalidAccessTokenError('unexpected claims');
  }
  return { userId: claims.data.sub, role: claims.data.role };
}
