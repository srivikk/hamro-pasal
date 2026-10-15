import type { UserRole } from '@hamro-pasal/shared-types';
import type { Request, RequestHandler } from 'express';

import { verifyAccessToken, type AccessTokenClaims } from '../auth/access-token';
import { HttpError } from './errors';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AccessTokenClaims;
  }
}

/** Requires `Authorization: Bearer <access token>` and, optionally, one of the given roles. */
export function requireAuth(secret: string, roles?: readonly UserRole[]): RequestHandler {
  return (req, _res, next) => {
    const header = req.get('authorization');
    const match = header === undefined ? null : /^Bearer ([A-Za-z0-9._-]+)$/.exec(header);
    if (match?.[1] === undefined) {
      next(new HttpError(401, 'UNAUTHENTICATED', 'Missing bearer token'));
      return;
    }
    let claims: AccessTokenClaims;
    try {
      claims = verifyAccessToken(match[1], secret);
    } catch {
      next(new HttpError(401, 'UNAUTHENTICATED', 'Invalid or expired token'));
      return;
    }
    if (roles !== undefined && !roles.includes(claims.role)) {
      next(new HttpError(403, 'FORBIDDEN', 'This action is not available for your role'));
      return;
    }
    req.auth = claims;
    next();
  };
}

/** The authenticated caller; only valid behind `requireAuth`. */
export function authOf(req: Request): AccessTokenClaims {
  if (req.auth === undefined) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Missing bearer token');
  }
  return req.auth;
}

/**
 * Reads a bearer token when one is sent, for public routes that add the caller's own details
 * (step 7.4: the menu's Notify Me flags). A missing or invalid token is simply a guest.
 */
export function optionalAuth(secret: string): RequestHandler {
  return (req, _res, next) => {
    const header = req.get('authorization');
    const match = header === undefined ? null : /^Bearer ([A-Za-z0-9._-]+)$/.exec(header);
    if (match?.[1] !== undefined) {
      try {
        req.auth = verifyAccessToken(match[1], secret);
      } catch {
        // A guest: an expired token must not make a public page fail.
      }
    }
    next();
  };
}
