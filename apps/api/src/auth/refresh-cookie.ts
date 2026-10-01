import type { CookieOptions, Request, Response } from 'express';

import { REFRESH_TOKEN } from './refresh-token';

/**
 * SPEC implicit requirement 3: "HTTP-only, secure Refresh Tokens (7 days)". A browser (the Super
 * Admin dashboard) has no encrypted storage, so its refresh token lives in a cookie that scripts
 * cannot read:
 *   HttpOnly        - invisible to JavaScript (an XSS cannot copy it)
 *   Secure          - HTTPS only (browsers also accept it on http://localhost for development)
 *   SameSite=Strict - never attached to a request another site started (no CSRF on refresh/logout)
 *   Path=/api/auth  - sent to the auth endpoints only, not with every API call
 */
export const REFRESH_COOKIE = {
  name: 'hamro_pasal_refresh',
  path: '/api/auth',
  maxAgeSeconds: REFRESH_TOKEN.ttlSeconds,
} as const;

/** Clearing needs the same attributes as setting, or the browser keeps the cookie. */
const attributes: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  path: REFRESH_COOKIE.path,
};

export function setRefreshCookie(res: Response, refreshToken: string): void {
  res.cookie(REFRESH_COOKIE.name, refreshToken, {
    ...attributes,
    maxAge: REFRESH_COOKIE.maxAgeSeconds * 1000,
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE.name, attributes);
}

/**
 * The refresh cookie's value, or null. A JWT needs no decoding (base64url and dots only). With
 * several cookies of this name the first wins: browsers list the most specific path first.
 */
export function readRefreshCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (header === undefined) return null;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() !== REFRESH_COOKIE.name) continue;
    const value = pair.slice(separator + 1).trim();
    return value === '' ? null : value;
  }
  return null;
}
