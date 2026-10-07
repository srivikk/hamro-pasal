import {
  authTokensResponseSchema,
  otpSendResponseSchema,
  type AuthTokensResponseBody,
  type OtpSendResponseBody,
} from '@hamro-pasal/shared-types';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { tokenSubject } from '../lib/access-token-role';
import { useAuthStore } from '../store/useAuthStore';
import { useProfileStore } from '../store/useProfileStore';
import { syncLanguagePreference } from './account';
import { apiRequest, type ApiError } from './http';

export const OTP_SEND_PATH = '/api/auth/otp/send';
export const OTP_VERIFY_PATH = '/api/auth/otp/verify';

/** Server error codes the sign-in screens branch on (STATE_HANDOFF §8). */
export const AUTH_ERROR_CODES = {
  resendCooldown: 'OTP_RESEND_COOLDOWN',
  invalid: 'OTP_INVALID',
  attemptsExceeded: 'OTP_ATTEMPTS_EXCEEDED',
  expired: 'OTP_EXPIRED',
  smsFailed: 'SMS_DELIVERY_FAILED',
  /** The proposed answer of a server that has no WhatsApp provider (STATE_HANDOFF §8W). */
  channelUnavailable: 'OTP_CHANNEL_UNAVAILABLE',
} as const;

/** How the code is delivered. SMS is the default and is never named in the request. */
export type OtpChannel = 'SMS' | 'WHATSAPP';

/**
 * POST /api/auth/otp/send: sends a 6-digit code to a strict +977 number. No token needed.
 * `channel: 'WHATSAPP'` asks the server to deliver it through its WhatsApp provider instead of
 * SMS (SPEC Nepal §4). The key is sent only for WhatsApp, so the SMS request is unchanged.
 */
export function sendOtp(phone: string, channel: OtpChannel = 'SMS'): Promise<OtpSendResponseBody> {
  return apiRequest({
    method: 'POST',
    path: OTP_SEND_PATH,
    body: channel === 'SMS' ? { phone } : { phone, channel },
    schema: otpSendResponseSchema,
    authenticated: false,
  });
}

/** POST /api/auth/otp/verify: exchanges the code for an access token and a refresh token. */
export function verifyOtp(phone: string, code: string): Promise<AuthTokensResponseBody> {
  return apiRequest({
    method: 'POST',
    path: OTP_VERIFY_PATH,
    body: { phone, code },
    schema: authTokensResponseSchema,
    authenticated: false,
  });
}

export function useSendOtp() {
  return useMutation<OtpSendResponseBody, ApiError, string>({
    mutationKey: ['auth', 'otp-send'],
    mutationFn: (phone) => sendOtp(phone),
  });
}

/** The same request with `channel: 'WHATSAPP'`. */
export function useSendOtpViaWhatsApp() {
  return useMutation<OtpSendResponseBody, ApiError, string>({
    mutationKey: ['auth', 'otp-send', 'whatsapp'],
    mutationFn: (phone) => sendOtp(phone, 'WHATSAPP'),
  });
}

/**
 * True when the server cannot send WhatsApp codes: it says so (OTP_CHANNEL_UNAVAILABLE), or it
 * predates the `channel` key and refuses the request body (400 VALIDATION_FAILED).
 */
export function isWhatsAppUnavailable(error: ApiError): boolean {
  return (
    error.code === AUTH_ERROR_CODES.channelUnavailable ||
    (error.status === 400 && error.code === 'VALIDATION_FAILED')
  );
}

/**
 * Verifies the code and starts the session (SPEC implicit requirement 3): the access token stays
 * in memory only; the refresh token is persisted by useAuthStore to the AES-256 encrypted MMKV.
 * Every cached query is then refetched, so screens that failed for lack of a session recover.
 */
export function useVerifyOtp() {
  const queryClient = useQueryClient();
  return useMutation<AuthTokensResponseBody, ApiError, { phone: string; code: string }>({
    mutationKey: ['auth', 'otp-verify'],
    mutationFn: ({ phone, code }) => verifyOtp(phone, code),
    onSuccess: (
      { access_token: accessToken, refresh_token: refreshToken, is_new_user: isNewUser },
      { phone },
    ) => {
      const userId = tokenSubject(accessToken);
      useAuthStore.getState().setSession({ accessToken, refreshToken });
      // Kept (encrypted) to show on the Profile tab; the session itself holds no phone.
      useProfileStore.getState().setAccount(phone, userId);
      // An account this sign-in created must complete its profile before using the app.
      if (isNewUser) useProfileStore.getState().requireOnboarding(userId);
      // The language chosen on this phone (first launch, or the toggle) follows the account.
      void syncLanguagePreference(useAuthStore.getState().locale);
      void queryClient.invalidateQueries();
    },
  });
}

/** Ends the session and drops every cached response, so the next user never sees this one's data. */
export function useSignOut(): () => void {
  const queryClient = useQueryClient();
  return () => {
    useAuthStore.getState().clearSession();
    queryClient.clear();
  };
}
