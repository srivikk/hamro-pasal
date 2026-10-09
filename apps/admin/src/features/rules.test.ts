import type { AdminVendorView, AuthUser, DeadLetterView } from '@hamro-pasal/shared-types';

import { createAdminApi } from '../api/admin-api';
import { ApiError, createApiClient, type FetchLike } from '../api/client';
import { createSessionStore } from '../auth/session-store';
import { formatDateTime, formatNpr } from '../lib/format';
import { isOtpCode, isSuperAdmin, signInErrorMessage, toNepalPhone } from './auth/login-rules';
import {
  hasQueuedRetry,
  messageBody,
  retryButton,
  retryErrorMessage,
  sourceLabel,
} from './dlq/dead-letter-rules';
import { matchesSearch, overrideErrorMessage, vendorAction } from './vendors/vendor-rules';

const letter: DeadLetterView = {
  id: '0b3f0a52-7c1f-4a5e-9f2e-2f7a3c9d1e11',
  status: 'PENDING',
  consumer: 'vendor-notifications',
  source_topic: 'notifications.broadcast',
  source_partition: 1,
  source_offset: '42',
  dead_letter_topic: 'notifications.dlq',
  message_key: 'order-1',
  event_id: 'e1',
  event_type: 'vendor.restored',
  payload: { event_type: 'vendor.restored' },
  raw_value: '{"event_type":"vendor.restored"}',
  headers: {},
  attempts: 4,
  error_name: 'SmsDeliveryError',
  error_message: 'SPARROW SMS failed: HTTP 503',
  failed_at: '2026-10-01T06:00:00.000Z',
  retry_requested_at: null,
  retry_requested_by: null,
  replayed_at: null,
  replay_attempts: 0,
  last_replay_error: null,
  replay_of_id: null,
};

const vendor: AdminVendorView = {
  id: '7f0c6a3e-2b1d-4c5e-8f9a-0b1c2d3e4f50',
  business_name: 'Thamel Kirana Pasal',
  phone: '+9779800000011',
  status: 'LIVE',
  suspension: 'NONE',
  restore_status: null,
  wallet_balance_npr: -100,
  pricing_model: 'COMMISSION',
  fulfillment_mode: 'SELF_DELIVERY',
  municipality_palika_string: 'Kathmandu Metropolitan City',
  created_at: '2026-10-01T06:00:00.000Z',
};

describe('format', () => {
  it('formats NPR with lakh grouping and paisa only when present', () => {
    expect(formatNpr(2500)).toBe('Rs. 2,500');
    expect(formatNpr(-150000.5)).toBe('Rs. -1,50,000.50');
    expect(formatNpr(0)).toBe('Rs. 0');
  });

  it('shows times in Nepal Time (UTC+05:45)', () => {
    expect(formatDateTime('2026-10-01T06:00:00.000Z')).toBe('2026-10-01 11:45:00');
    expect(formatDateTime('2026-12-31T18:20:05.000Z')).toBe('2027-01-01 00:05:05');
  });
});

describe('sign-in rules', () => {
  it('normalises a Nepal mobile number and refuses anything else', () => {
    expect(toNepalPhone('9800000099')).toBe('+9779800000099');
    expect(toNepalPhone(' +977 9800000099 ')).toBe('+9779800000099');
    expect(toNepalPhone('12345')).toBeNull();
    expect(toNepalPhone('')).toBeNull();
  });

  it('accepts 6-digit codes only', () => {
    expect(isOtpCode('012345')).toBe(true);
    expect(isOtpCode('12345')).toBe(false);
    expect(isOtpCode('12a456')).toBe(false);
  });

  it('lets Super Admins in only', () => {
    const user = (role: AuthUser['role']): AuthUser => ({ id: vendor.id, role, first_name: null });
    expect(isSuperAdmin(user('SUPER_ADMIN'))).toBe(true);
    expect(isSuperAdmin(user('VENDOR'))).toBe(false);
    expect(isSuperAdmin(user('CUSTOMER'))).toBe(false);
  });

  it('explains each sign-in failure', () => {
    expect(signInErrorMessage(new ApiError(401, 'OTP_INVALID', 'x'))).toMatch(/wrong/);
    expect(signInErrorMessage(new ApiError(410, 'OTP_EXPIRED', 'x'))).toMatch(/expired/);
    expect(signInErrorMessage(new ApiError(429, 'OTP_RESEND_COOLDOWN', 'x'))).toMatch(/minute/);
    expect(signInErrorMessage(new Error('boom'))).toMatch(/Try again/);
  });
});

describe('dead letter rules', () => {
  it('offers Retry for a pending letter only', () => {
    expect(retryButton(letter)).toEqual({ label: 'Retry', enabled: true });
    expect(
      retryButton({ ...letter, status: 'RETRY_REQUESTED', retry_requested_at: letter.failed_at }),
    ).toEqual({ label: 'Queued', enabled: false });
    expect(retryButton({ ...letter, status: 'REPLAYED' })).toEqual({
      label: 'Replayed',
      enabled: false,
    });
  });

  it('lets a retry the worker keeps failing on be pushed again', () => {
    expect(retryButton({ ...letter, status: 'RETRY_REQUESTED', replay_attempts: 3 })).toEqual({
      label: 'Retry again',
      enabled: true,
    });
  });

  it('polls only while a retry is queued', () => {
    expect(hasQueuedRetry([letter])).toBe(false);
    expect(hasQueuedRetry([letter, { ...letter, status: 'RETRY_REQUESTED' }])).toBe(true);
    expect(hasQueuedRetry([])).toBe(false);
  });

  it('shows the source and the message body (pretty JSON, else raw text)', () => {
    expect(sourceLabel(letter)).toBe('notifications.broadcast · partition 1 · offset 42');
    expect(messageBody(letter)).toBe('{\n  "event_type": "vendor.restored"\n}');
    expect(messageBody({ ...letter, payload: null, raw_value: '{"broken":' })).toBe('{"broken":');
    expect(messageBody({ ...letter, payload: null, raw_value: null })).toBe('(empty message)');
  });

  it('explains a refused retry', () => {
    expect(retryErrorMessage(new ApiError(409, 'DEAD_LETTER_ALREADY_REPLAYED', 'x'))).toMatch(
      /already replayed/,
    );
    expect(retryErrorMessage(new ApiError(500, 'INTERNAL_SERVER_ERROR', 'x'))).toMatch(
      /could not be requested/,
    );
  });
});

describe('vendor rules', () => {
  it('offers Suspend for any vendor that is not suspended', () => {
    expect(vendorAction(vendor, -2000)).toEqual({ action: 'SUSPEND', enabled: true, note: null });
    expect(vendorAction({ ...vendor, status: 'SANDBOXED' }, -2000).action).toBe('SUSPEND');
    // Phase 37: a shop its vendor closed is offered Reactivate, never Suspend or Restore.
    expect(vendorAction({ ...vendor, status: 'DEACTIVATED' }, -2000)).toMatchObject({
      action: 'REACTIVATE',
      enabled: true,
    });
  });

  it('offers Restore with the status it returns to', () => {
    const suspended: AdminVendorView = {
      ...vendor,
      status: 'SUSPENDED',
      suspension: 'ADMIN',
      restore_status: 'APPROVED',
    };
    expect(vendorAction(suspended, -2000)).toEqual({
      action: 'RESTORE',
      enabled: true,
      note: 'Restores to APPROVED.',
    });
  });

  it('disables Restore below the limit, the server rule, including exactly at it', () => {
    const debt: AdminVendorView = {
      ...vendor,
      status: 'SUSPENDED',
      suspension: 'DEBT',
      restore_status: 'LIVE',
      wallet_balance_npr: -2500,
    };
    expect(vendorAction(debt, -2000)).toMatchObject({ action: 'RESTORE', enabled: false });
    expect(vendorAction(debt, -2000).note).toContain('Rs. -2,500');
    expect(vendorAction({ ...debt, wallet_balance_npr: -2000 }, -2000).enabled).toBe(true);
  });

  it('disables Restore when no earlier status was recorded', () => {
    expect(
      vendorAction({ ...vendor, status: 'SUSPENDED', suspension: 'UNSPECIFIED' }, -2000),
    ).toMatchObject({ action: 'RESTORE', enabled: false });
  });

  it('explains a refused override', () => {
    expect(overrideErrorMessage(new ApiError(409, 'WALLET_BELOW_SUSPENSION_LIMIT', 'x'))).toMatch(
      /pay dues/,
    );
    expect(overrideErrorMessage(new ApiError(409, 'VENDOR_STATUS_CONFLICT', 'x'))).toMatch(
      /changed/,
    );
  });

  it('searches by name, phone and Palika', () => {
    expect(matchesSearch(vendor, 'thamel')).toBe(true);
    expect(matchesSearch(vendor, '980000001')).toBe(true);
    expect(matchesSearch(vendor, 'kathmandu metro')).toBe(true);
    expect(matchesSearch(vendor, 'pokhara')).toBe(false);
    expect(matchesSearch(vendor, '  ')).toBe(true);
  });
});

describe('createAdminApi', () => {
  it('calls the admin endpoints with the right method and path', async () => {
    const calls: string[] = [];
    const fetch: FetchLike = (url, init) => {
      calls.push(`${init.method ?? ''} ${url}`);
      const body = url.includes('/dlq/')
        ? {
            dead_letter: {
              ...letter,
              status: 'RETRY_REQUESTED',
              retry_requested_at: letter.failed_at,
            },
          }
        : url.includes('/dlq')
          ? { dead_letters: [letter], next_cursor: null }
          : url.endsWith('/vendors')
            ? { vendors: [vendor], suspension_limit_npr: -2000 }
            : { vendor, previous_status: 'SUSPENDED' };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    };
    const session = createSessionStore();
    session.getState().setSession({
      phone: '+9779800000099',
      user: { id: vendor.id, role: 'SUPER_ADMIN', first_name: null },
      accessToken: 'a',
    });
    const api = createAdminApi(createApiClient({ baseUrl: '', fetch, session }));

    await api.listDeadLetters({ status: 'PENDING', cursor: letter.id });
    await api.retryDeadLetter(letter.id);
    await api.listVendors();
    await api.overrideVendor(vendor.id, 'SUSPEND');
    await api.overrideVendor(vendor.id, 'RESTORE');

    expect(calls).toEqual([
      `GET /api/admin/dlq?status=PENDING&cursor=${letter.id}`,
      `POST /api/admin/dlq/${letter.id}/retry`,
      'GET /api/admin/vendors',
      `POST /api/admin/vendors/${vendor.id}/suspend`,
      `POST /api/admin/vendors/${vendor.id}/restore`,
    ]);
  });

  it('signs in, restores and signs out through the cookie endpoints', async () => {
    const calls: { call: string; body: string | undefined; credentials: string | undefined }[] = [];
    const user = { id: vendor.id, role: 'SUPER_ADMIN', first_name: null };
    const tokens = { token_type: 'Bearer', access_token: 'a', access_token_expires_in: 900 };
    const fetch: FetchLike = (url, init) => {
      calls.push({
        call: `${init.method ?? ''} ${url}`,
        body: typeof init.body === 'string' ? init.body : undefined,
        credentials: init.credentials,
      });
      if (url.endsWith('/logout')) return Promise.resolve(new Response(null, { status: 204 }));
      const body = url.endsWith('/refresh')
        ? { ...tokens, user: { ...user, phone: '+9779800000099' } }
        : { ...tokens, refresh_token_expires_in: 604_800, user, is_new_user: false };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    };
    const session = createSessionStore();
    const api = createAdminApi(createApiClient({ baseUrl: '', fetch, session }));

    // A Super Admin's sign-in body carries no refresh token: it is in the HttpOnly cookie.
    const verified = await api.verifyOtp('+9779800000099', '123456');
    expect(verified).not.toHaveProperty('refresh_token');
    expect(verified.user).toEqual(user);

    await expect(api.restoreSession()).resolves.toBe(true);
    expect(session.getState().session).toMatchObject({ phone: '+9779800000099', accessToken: 'a' });

    await expect(api.logout()).resolves.toBeUndefined();

    expect(calls).toEqual([
      {
        call: 'POST /api/auth/otp/verify',
        body: '{"phone":"+9779800000099","code":"123456"}',
        credentials: 'same-origin',
      },
      { call: 'POST /api/auth/refresh', body: undefined, credentials: 'same-origin' },
      { call: 'POST /api/auth/logout', body: undefined, credentials: 'same-origin' },
    ]);
  });

  it('still reads the sign-in of another role (refresh token in the body), to refuse it', async () => {
    const fetch: FetchLike = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            token_type: 'Bearer',
            access_token: 'a',
            access_token_expires_in: 900,
            refresh_token: 'r',
            refresh_token_expires_in: 604_800,
            user: { id: vendor.id, role: 'VENDOR', first_name: null },
            is_new_user: false,
          }),
          { status: 200 },
        ),
      );
    const api = createAdminApi(
      createApiClient({ baseUrl: '', fetch, session: createSessionStore() }),
    );

    const verified = await api.verifyOtp('+9779800000011', '123456');

    expect(isSuperAdmin(verified.user)).toBe(false);
  });

  it('reports a failed sign-out, so the caller keeps the session', async () => {
    const fetch: FetchLike = () => Promise.reject(new TypeError('Failed to fetch'));
    const api = createAdminApi(
      createApiClient({ baseUrl: '', fetch, session: createSessionStore() }),
    );

    await expect(api.logout()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
});

describe('session store', () => {
  it('keeps the session in memory, renews the access token and forgets everything on clear', () => {
    const session = createSessionStore();
    session.getState().setAccessToken('ignored');
    expect(session.getState().session).toBeNull();

    session.getState().setSession({
      phone: '+9779800000099',
      user: { id: vendor.id, role: 'SUPER_ADMIN', first_name: null },
      accessToken: 'a1',
    });
    session.getState().setAccessToken('a2');
    expect(session.getState().session).toEqual({
      phone: '+9779800000099',
      user: { id: vendor.id, role: 'SUPER_ADMIN', first_name: null },
      accessToken: 'a2',
    });

    session.getState().clear();
    expect(session.getState().session).toBeNull();
  });
});
