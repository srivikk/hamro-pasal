import {
  otpSendRequestSchema,
  otpVerifyRequestSchema,
  tokenRefreshRequestSchema,
  type AuthTokensResponseBody,
  type CookieAuthTokensResponseBody,
  type OtpSendResponseBody,
  type SessionRefreshResponseBody,
  type TokenRefreshResponseBody,
} from '@hamro-pasal/shared-types';
import { Router } from 'express';

import type { OtpAuthService } from '../auth/otp-auth-service';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from '../auth/refresh-cookie';
import { InvalidRefreshTokenError } from '../auth/refresh-token';
import { parseInput } from '../http/validate';

/** Mounted at /api/auth. Public: these endpoints are how a client obtains a token. */
export function authRouter(auth: OtpAuthService): Router {
  const router = Router();

  /** SPEC journey step 1: text a 6-digit code to a +977 number (valid 2 min). */
  router.post('/otp/send', async (req, res) => {
    const { phone } = parseInput(otpSendRequestSchema, req.body);
    const sent = await auth.sendOtp(phone);
    const body: OtpSendResponseBody = {
      phone: sent.phone,
      expires_in_seconds: sent.expiresInSeconds,
      resend_after_seconds: sent.resendAfterSeconds,
    };
    res.json(body);
  });

  /**
   * Exchanges a valid code for a 15-min access token and a 7-day refresh token. A Super Admin signs
   * in from a browser (apps/admin), so their refresh token goes into the HttpOnly cookie and is
   * left out of the body; every other role (the mobile app) gets it in the body as before.
   */
  router.post('/otp/verify', async (req, res) => {
    const { phone, code, app } = parseInput(otpVerifyRequestSchema, req.body);
    const session = await auth.verifyOtp(phone, code, app);
    const shared: CookieAuthTokensResponseBody = {
      token_type: 'Bearer',
      access_token: session.accessToken,
      access_token_expires_in: session.accessTokenExpiresIn,
      refresh_token_expires_in: session.refreshTokenExpiresIn,
      user: session.user,
      is_new_user: session.isNewUser,
    };
    // Tokens must never be cached by a proxy or the client's HTTP cache.
    res.set('Cache-Control', 'no-store');
    if (session.user.role === 'SUPER_ADMIN') {
      setRefreshCookie(res, session.refreshToken);
      res.json(shared);
      return;
    }
    const body: AuthTokensResponseBody = { ...shared, refresh_token: session.refreshToken };
    res.json(body);
  });

  /** A fresh 15-min access token for a valid 7-day refresh token (SPEC implicit requirement 3). */
  router.post('/token/refresh', async (req, res) => {
    const { refresh_token: refreshToken } = parseInput(tokenRefreshRequestSchema, req.body);
    const refreshed = await auth.refreshAccessToken(refreshToken);
    const body: TokenRefreshResponseBody = {
      token_type: 'Bearer',
      access_token: refreshed.accessToken,
      access_token_expires_in: refreshed.accessTokenExpiresIn,
    };
    res.set('Cache-Control', 'no-store').json(body);
  });

  /**
   * The browser's refresh: the token is read from the HttpOnly cookie, never from the body. A
   * cookie that is refused is also cleared, so the browser stops presenting it.
   */
  router.post('/refresh', async (req, res) => {
    const refreshToken = readRefreshCookie(req);
    if (refreshToken === null) {
      throw new InvalidRefreshTokenError('no refresh cookie');
    }
    const refreshed = await auth.refreshCookieSession(refreshToken).catch((error: unknown) => {
      if (error instanceof InvalidRefreshTokenError) clearRefreshCookie(res);
      throw error;
    });
    const body: SessionRefreshResponseBody = {
      token_type: 'Bearer',
      access_token: refreshed.accessToken,
      access_token_expires_in: refreshed.accessTokenExpiresIn,
      user: refreshed.user,
    };
    res.set('Cache-Control', 'no-store').json(body);
  });

  /** Ends the browser session by clearing the refresh cookie. Safe to repeat. */
  router.post('/logout', (_req, res) => {
    clearRefreshCookie(res);
    res.set('Cache-Control', 'no-store').status(204).end();
  });

  return router;
}
