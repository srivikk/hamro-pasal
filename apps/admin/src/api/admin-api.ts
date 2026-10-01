import {
  adminDeadLetterListResponseSchema,
  adminDeadLetterRetryResponseSchema,
  adminVendorListResponseSchema,
  adminVendorOverrideResponseSchema,
  authTokensResponseSchema,
  otpSendResponseSchema,
  type AdminDeadLetterListResponseBody,
  type AdminDeadLetterRetryResponseBody,
  type AdminVendorListResponseBody,
  type AdminVendorOverrideResponseBody,
  type AuthTokensResponseBody,
  type DeadLetterStatus,
  type OtpSendResponseBody,
} from '@hamro-pasal/shared-types';

import type { ApiClient } from './client';

/** The endpoints the dashboard calls (all under /api/admin, SUPER_ADMIN only, except sign-in). */
export interface AdminApi {
  sendOtp(phone: string): Promise<OtpSendResponseBody>;
  verifyOtp(phone: string, code: string): Promise<AuthTokensResponseBody>;
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
        schema: authTokensResponseSchema,
        body: { phone, code },
      }),
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
