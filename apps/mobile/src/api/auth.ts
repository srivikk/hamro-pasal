import {
  authTokensResponseSchema,
  otpSendResponseSchema,
  type AuthTokensResponseBody,
  type OtpSendResponseBody,
} from '@hamro-pasal/shared-types';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useAuthStore } from '../store/useAuthStore';
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
} as const;

/** POST /api/auth/otp/send: texts a 6-digit code to a strict +977 number. No token needed. */
export function sendOtp(phone: string): Promise<OtpSendResponseBody> {
  return apiRequest({
    method: 'POST',
    path: OTP_SEND_PATH,
    body: { phone },
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
    mutationFn: sendOtp,
  });
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
    onSuccess: ({ access_token: accessToken, refresh_token: refreshToken }) => {
      useAuthStore.getState().setSession({ accessToken, refreshToken });
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
