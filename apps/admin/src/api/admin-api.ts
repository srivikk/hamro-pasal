import {
  adminDeadLetterListResponseSchema,
  adminDeadLetterRetryResponseSchema,
  adminVendorListResponseSchema,
  adminVendorOverrideResponseSchema,
  otpSendResponseSchema,
  otpVerifyResponseSchema,
  type AdminDeadLetterListResponseBody,
  type AdminDeadLetterRetryResponseBody,
  type AdminVendorListResponseBody,
  type AdminVendorOverrideResponseBody,
  type DeadLetterStatus,
  type OtpSendResponseBody,
  type OtpVerifyResponseBody,
} from '@hamro-pasal/shared-types';
import { z } from 'zod';

import type { ApiClient } from './client';

/** The endpoints the dashboard calls (all under /api/admin, SUPER_ADMIN only, except sign-in). */
export interface AdminApi {
  sendOtp(phone: string): Promise<OtpSendResponseBody>;
  /** A Super Admin's refresh token arrives as an HttpOnly cookie, not in this body. */
  verifyOtp(phone: string, code: string): Promise<OtpVerifyResponseBody>;
  /** The silent refresh on page load (see ApiClient.restoreSession). */
  restoreSession(): Promise<boolean>;
  /** Clears the refresh cookie on the server; the caller then forgets the access token. */
  logout(): Promise<void>;
  listDeadLetters(query: {
    status?: DeadLetterStatus | undefined;
    cursor?: string | undefined;
  }): Promise<AdminDeadLetterListResponseBody>;
  retryDeadLetter(id: string): Promise<AdminDeadLetterRetryResponseBody>;
  listVendors(): Promise<AdminVendorListResponseBody>;
  overrideVendor(
    id: string,
    action: 'SUSPEND' | 'RESTORE',
  ): Promise<AdminVendorOverrideResponseBody>;
}

export function createAdminApi(client: ApiClient): AdminApi {
  return {
    sendOtp: (phone) =>
      client.publicRequest({
        method: 'POST',
        path: '/api/auth/otp/send',
        schema: otpSendResponseSchema,
        body: { phone },
      }),
    verifyOtp: (phone, code) =>
      client.publicRequest({
        method: 'POST',
        path: '/api/auth/otp/verify',
        schema: otpVerifyResponseSchema,
        body: { phone, code },
      }),
    restoreSession: () => client.restoreSession(),
    logout: async () => {
      // 204 No Content: the client reads an empty body as null.
      await client.publicRequest({ method: 'POST', path: '/api/auth/logout', schema: z.null() });
    },
    listDeadLetters: ({ status, cursor }) =>
      client.request({
        method: 'GET',
        path: '/api/admin/dlq',
        schema: adminDeadLetterListResponseSchema,
        query: { status, cursor },
      }),
    retryDeadLetter: (id) =>
      client.request({
        method: 'POST',
        path: `/api/admin/dlq/${encodeURIComponent(id)}/retry`,
        schema: adminDeadLetterRetryResponseSchema,
      }),
    listVendors: () =>
      client.request({
        method: 'GET',
        path: '/api/admin/vendors',
        schema: adminVendorListResponseSchema,
      }),
    overrideVendor: (id, action) =>
      client.request({
        method: 'POST',
        path: `/api/admin/vendors/${encodeURIComponent(id)}/${action === 'SUSPEND' ? 'suspend' : 'restore'}`,
        schema: adminVendorOverrideResponseSchema,
      }),
  };
}
