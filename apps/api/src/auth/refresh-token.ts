import { randomUUID } from 'node:crypto';

import {
  REFRESH_TOKEN_TTL_SECONDS,
  userRoleSchema,
  type UserRole,
} from '@hamro-pasal/shared-types';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { ACCESS_TOKEN } from './access-token';

/**
 * SPEC implicit requirement 3: 7-day refresh tokens, signed with JWT_REFRESH_SECRET. A distinct
 * secret *and* audience mean a refresh token can never pass as an access token (or vice versa).
 * Each token has a unique `jti`, so a later refresh endpoint can rotate and revoke them.
 */
export const REFRESH_TOKEN = {
  algorithm: 'HS256',
  issuer: ACCESS_TOKEN.issuer,
  audience: 'hamro-pasal-refresh',
  ttlSeconds: REFRESH_TOKEN_TTL_SECONDS,
} as const;

export interface RefreshTokenClaims {
  readonly userId: string;
  readonly tokenId: string;
  /**
   * Step 7.7: the role the session was signed in with (one account, several roles). Absent from a
   * token issued before: the account's primary role applies.
   */
  readonly role: UserRole | null;
}

const claimsSchema = z.object({
  sub: z.uuid(),
  jti: z.uuid(),
  typ: z.literal('refresh'),
  rol: userRoleSchema.optional(),
});

export class InvalidRefreshTokenError extends Error {
  constructor(reason: string) {
    super(`Invalid refresh token: ${reason}`);
    this.name = 'InvalidRefreshTokenError';
  }
}

export function signRefreshToken(userId: string, secret: string, role?: UserRole): string {
  return jwt.sign(role === undefined ? { typ: 'refresh' } : { typ: 'refresh', rol: role }, secret, {
    algorithm: REFRESH_TOKEN.algorithm,
    subject: userId,
    issuer: REFRESH_TOKEN.issuer,
    audience: REFRESH_TOKEN.audience,
    expiresIn: REFRESH_TOKEN.ttlSeconds,
    jwtid: randomUUID(),
  });
}

export function verifyRefreshToken(token: string, secret: string): RefreshTokenClaims {
  let payload: unknown;
  try {
    payload = jwt.verify(token, secret, {
      algorithms: [REFRESH_TOKEN.algorithm],
      issuer: REFRESH_TOKEN.issuer,
      audience: REFRESH_TOKEN.audience,
    });
  } catch (error: unknown) {
    throw new InvalidRefreshTokenError(error instanceof Error ? error.message : 'unverifiable');
  }
  const claims = claimsSchema.safeParse(payload);
  if (!claims.success) {
    throw new InvalidRefreshTokenError('unexpected claims');
  }
  return { userId: claims.data.sub, tokenId: claims.data.jti, role: claims.data.rol ?? null };
}
