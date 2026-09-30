import {
  otpSendRequestSchema,
  otpVerifyRequestSchema,
  tokenRefreshRequestSchema,
  type AuthTokensResponseBody,
  type OtpSendResponseBody,
  type TokenRefreshResponseBody,
} from '@hamro-pasal/shared-types';
import { Router } from 'express';

import type { OtpAuthService } from '../auth/otp-auth-service';
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

  /** Exchanges a valid code for a 15-min access token and a 7-day refresh token. */
  router.post('/otp/verify', async (req, res) => {
    const { phone, code } = parseInput(otpVerifyRequestSchema, req.body);
    const session = await auth.verifyOtp(phone, code);
    const body: AuthTokensResponseBody = {
      token_type: 'Bearer',
      access_token: session.accessToken,
      access_token_expires_in: session.accessTokenExpiresIn,
      refresh_token: session.refreshToken,
      refresh_token_expires_in: session.refreshTokenExpiresIn,
      user: session.user,
      is_new_user: session.isNewUser,
    };
    // Tokens must never be cached by a proxy or the client's HTTP cache.
    res.set('Cache-Control', 'no-store').json(body);
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

  return router;
}
