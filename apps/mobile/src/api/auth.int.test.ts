import { act, waitFor } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import { getSecureStorage } from '../storage/secure-mmkv';
import { AUTH_STORE_KEY, useAuthStore } from '../store/useAuthStore';
import {
  authTokensResponse,
  errorBody,
  ISSUED_ACCESS_TOKEN,
  ISSUED_REFRESH_TOKEN,
  otpSendResponse,
  TEST_PHONE,
} from '../test/api-fixtures';
import {
  apiUrl,
  capture,
  server,
  setupApiTestEnvironment,
  TEST_ACCESS_TOKEN,
  type CapturedRequest,
} from '../test/msw';
import { renderHookWithProviders } from '../test/render';
import {
  OTP_SEND_PATH,
  OTP_VERIFY_PATH,
  sendOtp,
  useSendOtp,
  useSignOut,
  useVerifyOtp,
  verifyOtp,
} from './auth';
import { CLIENT_ERROR_CODES } from './http';

setupApiTestEnvironment();

function endpoint(path: string, respond: () => Response) {
  const received: CapturedRequest[] = [];
  server.use(
    http.post(apiUrl(path), async ({ request }) => {
      received.push(await capture(request));
      return respond();
    }),
  );
  return received;
}

beforeEach(() => {
  useAuthStore.getState().clearSession();
});

describe('POST /api/auth/otp/send', () => {
  it('works signed out, sends the +977 number as JSON and parses otpSendResponseSchema', async () => {
    const received = endpoint(OTP_SEND_PATH, () => HttpResponse.json(otpSendResponse()));

    const body = await sendOtp(TEST_PHONE);

    expect(received).toHaveLength(1);
    expect(received[0]?.body).toEqual({ phone: TEST_PHONE });
    expect(received[0]?.headers.get('content-type')).toBe('application/json');
    expect(received[0]?.headers.get('authorization')).toBeNull();
    expect(body).toEqual({ phone: TEST_PHONE, expires_in_seconds: 120, resend_after_seconds: 60 });
  });

  it('never attaches an existing access token to the sign-in endpoints', async () => {
    useAuthStore.getState().setAccessToken(TEST_ACCESS_TOKEN);
    const received = endpoint(OTP_SEND_PATH, () => HttpResponse.json(otpSendResponse()));

    await sendOtp(TEST_PHONE);

    expect(received[0]?.headers.get('authorization')).toBeNull();
  });

  it('surfaces the resend cooldown with its retry time (useSendOtp)', async () => {
    endpoint(OTP_SEND_PATH, () =>
      HttpResponse.json(errorBody('OTP_RESEND_COOLDOWN', { retry_after_seconds: 42 }), {
        status: 429,
      }),
    );
    const { result } = renderHookWithProviders(() => useSendOtp());

    await act(async () => {
      await result.current.mutateAsync(TEST_PHONE).catch(() => undefined);
    });

    expect(result.current.error).toMatchObject({
      status: 429,
      code: 'OTP_RESEND_COOLDOWN',
      details: { retry_after_seconds: 42 },
    });
  });
});

describe('POST /api/auth/otp/verify', () => {
  it('parses authTokensResponseSchema and rejects a body that breaks it', async () => {
    endpoint(OTP_VERIFY_PATH, () => HttpResponse.json(authTokensResponse(true)));
    expect((await verifyOtp(TEST_PHONE, '042187')).is_new_user).toBe(true);

    endpoint(OTP_VERIFY_PATH, () =>
      HttpResponse.json({ ...authTokensResponse(), token_type: 'MAC' }),
    );
    await expect(verifyOtp(TEST_PHONE, '042187')).rejects.toMatchObject({
      code: CLIENT_ERROR_CODES.badResponse,
    });
  });

  it('keeps the access token in memory and persists only the refresh token, encrypted', async () => {
    const received = endpoint(OTP_VERIFY_PATH, () => HttpResponse.json(authTokensResponse()));
    const { result } = renderHookWithProviders(() => useVerifyOtp());

    await act(async () => {
      await result.current.mutateAsync({ phone: TEST_PHONE, code: '042187' });
    });

    expect(received[0]?.body).toEqual({ phone: TEST_PHONE, code: '042187' });
    expect(useAuthStore.getState()).toMatchObject({
      accessToken: ISSUED_ACCESS_TOKEN,
      refreshToken: ISSUED_REFRESH_TOKEN,
    });
    // The secure (AES-256) MMKV instance holds the refresh token and never the access token.
    const persisted = getSecureStorage().getString(AUTH_STORE_KEY) ?? '';
    expect(persisted).toContain(ISSUED_REFRESH_TOKEN);
    expect(persisted).not.toContain(ISSUED_ACCESS_TOKEN);
  });

  it('leaves the store signed out when the code is wrong', async () => {
    endpoint(OTP_VERIFY_PATH, () =>
      HttpResponse.json(errorBody('OTP_INVALID', { attempts_remaining: 4 }), { status: 401 }),
    );
    const { result } = renderHookWithProviders(() => useVerifyOtp());

    await act(async () => {
      await result.current
        .mutateAsync({ phone: TEST_PHONE, code: '000000' })
        .catch(() => undefined);
    });

    await waitFor(() => {
      expect(result.current.error?.code).toBe('OTP_INVALID');
    });
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });
  });
});

describe('useSignOut', () => {
  it('clears both tokens, including the persisted refresh token', () => {
    useAuthStore
      .getState()
      .setSession({ accessToken: ISSUED_ACCESS_TOKEN, refreshToken: ISSUED_REFRESH_TOKEN });
    const { result } = renderHookWithProviders(() => useSignOut());

    act(() => {
      result.current();
    });

    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });
    expect(getSecureStorage().getString(AUTH_STORE_KEY) ?? '').not.toContain(ISSUED_REFRESH_TOKEN);
  });
});
