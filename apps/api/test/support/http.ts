import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { errorBodySchema, type ErrorBody, type WalletTopUpMode } from '@hamro-pasal/shared-types';
import type { Express } from 'express';
import type { z } from 'zod';

import { createApp } from '../../src/app';
import { signAccessToken } from '../../src/auth/access-token';
import { buildContainer, type ApiContainer } from '../../src/container';
import { esewaHmacBase64, esewaSignatureMessage } from '../../src/payments/esewa/signature';
import type { OtpStoreOptions } from '../../src/auth/otp-store';
import type { FetchLike } from '../../src/payments/gateway-http';
import { MockSmsGateway, type OutboundSms, type SmsGateway } from '@hamro-pasal/sms';
import { LocalEvidenceStorage } from '../../src/uploads/evidence-storage';
import { LocalProductImageStorage } from '../../src/uploads/product-image-storage';
import { testDatabase, testRedisPool } from './fixtures';

export const ACCESS_SECRET = 'integration-access-secret-0123456789abcdef';
export const REFRESH_SECRET = 'integration-refresh-secret-fedcba9876543210';
/** eSewa's public UAT merchant secret for product code EPAYTEST. */
export const ESEWA_UAT_SECRET = '8gBm/:&EnhH.1/q';
export const KHALTI_BASE = 'https://a.khalti.com/api/v2';

/**
 * Parses a supertest response body with its shared-types response schema. Every read is therefore
 * also a runtime check that the server honours the contract the mobile app relies on.
 */
export function bodyOf<TSchema extends z.ZodType>(
  schema: TSchema,
  res: { body: unknown },
): z.output<TSchema> {
  return schema.parse(res.body);
}

/** Parses the standard error envelope of a failed request (shared-types errorBodySchema). */
export function errorOf(res: { body: unknown }): ErrorBody['error'] {
  return errorBodySchema.parse(res.body).error;
}

/** The string body of a fetch call made by the code under test. */
export function requestBodyText(init: RequestInit): string {
  return typeof init.body === 'string' ? init.body : '';
}

/** Evidence uploads land in a per-run temporary directory, served under this base URL. */
export const TEST_UPLOADS_DIR = join(
  tmpdir(),
  `hamro-pasal-api-test-uploads-${String(process.pid)}`,
);
export const TEST_UPLOADS_BASE_URL = 'http://localhost:4000/uploads';

export interface TestApp {
  readonly app: Express;
  readonly container: ApiContainer;
  /** Every OTP SMS the app sent. */
  readonly sms: SmsGateway & { readonly sent: readonly OutboundSms[] };
}

export function buildTestApp(
  options: {
    khaltiFetch?: FetchLike;
    lockTtlMs?: number;
    sms?: SmsGateway & { readonly sent: readonly OutboundSms[] };
    otpOptions?: OtpStoreOptions;
    deliveryOtpLockoutMs?: number;
    /** A shorter staleness bound for rider positions. */
    riderLocationMaxAgeMs?: number;
    uploadsDir?: string;
    /** Defaults to MOCK so wallet tests can top up. */
    walletTopUpMode?: WalletTopUpMode;
    /** MOCK_SERVICES: serves POST /api/test/mock-payment. */
    mockServices?: boolean;
  } = {},
): TestApp {
  const sms = options.sms ?? new MockSmsGateway();
  const container = buildContainer(
    {
      accessTokenSecret: ACCESS_SECRET,
      refreshTokenSecret: REFRESH_SECRET,
      esewa: {
        productCode: 'EPAYTEST',
        secretKey: ESEWA_UAT_SECRET,
        paymentUrl: 'https://rc-epay.esewa.com.np/api/epay/main/v2/form',
        successUrl: 'https://app.hamropasal.test/payments/esewa/success',
        failureUrl: 'https://app.hamropasal.test/payments/esewa/failure',
      },
      khalti: {
        secretKey: 'test_khalti_secret',
        baseUrl: KHALTI_BASE,
        returnUrl: 'https://app.hamropasal.test/payments/khalti/return',
        websiteUrl: 'https://hamropasal.test',
      },
      walletTopUpMode: options.walletTopUpMode ?? 'MOCK',
      ...(options.mockServices === undefined ? {} : { mockServices: options.mockServices }),
    },
    {
      db: testDatabase(),
      redisPool: testRedisPool(10),
      ...(options.khaltiFetch === undefined ? {} : { fetch: options.khaltiFetch }),
      ...(options.lockTtlMs === undefined ? {} : { lockOptions: { ttlMs: options.lockTtlMs } }),
      ...(options.otpOptions === undefined ? {} : { otpOptions: options.otpOptions }),
      ...(options.deliveryOtpLockoutMs === undefined
        ? {}
        : { deliveryOtpOptions: { lockoutMs: options.deliveryOtpLockoutMs } }),
      ...(options.riderLocationMaxAgeMs === undefined
        ? {}
        : { riderLocationOptions: { maxAgeMs: options.riderLocationMaxAgeMs } }),
      sms,
      evidence: new LocalEvidenceStorage(
        options.uploadsDir ?? TEST_UPLOADS_DIR,
        TEST_UPLOADS_BASE_URL,
      ),
      productImages: new LocalProductImageStorage(
        options.uploadsDir ?? TEST_UPLOADS_DIR,
        TEST_UPLOADS_BASE_URL,
      ),
    },
  );
  return { app: createApp(container), container, sms };
}

export function bearer(
  userId: string,
  role: 'CUSTOMER' | 'VENDOR' | 'DRIVER' | 'SUPER_ADMIN' = 'CUSTOMER',
): string {
  return `Bearer ${signAccessToken({ userId, role }, ACCESS_SECRET)}`;
}

/**
 * Builds the base64 `data` eSewa appends to success_url, signed with the UAT secret exactly as
 * eSewa signs it. `total_amount` is emitted as a raw JSON number literal (e.g. 1050.0).
 */
export function esewaCallback(
  fields: {
    transaction_uuid: string;
    total_amount: string;
    status?: string;
    product_code?: string;
  },
  secret = ESEWA_UAT_SECRET,
): string {
  const values: Record<string, string> = {
    transaction_code: '000AWEO',
    status: fields.status ?? 'COMPLETE',
    total_amount: fields.total_amount,
    transaction_uuid: fields.transaction_uuid,
    product_code: fields.product_code ?? 'EPAYTEST',
    signed_field_names:
      'transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names',
  };
  const signature = esewaHmacBase64(
    esewaSignatureMessage(values, (values.signed_field_names ?? '').split(',')),
    secret,
  );
  const json =
    `{"transaction_code":"${values.transaction_code ?? ''}","status":"${values.status ?? ''}",` +
    `"total_amount":${fields.total_amount},"transaction_uuid":"${fields.transaction_uuid}",` +
    `"product_code":"${values.product_code ?? ''}","signed_field_names":"${values.signed_field_names ?? ''}",` +
    `"signature":"${signature}"}`;
  return Buffer.from(json, 'utf8').toString('base64');
}

interface FakeKhaltiPayment {
  amount: number;
  purchaseOrderId: string;
  status: string;
  paidAmount: number;
}

/** A stateful stand-in for Khalti's ePay v2 API, reachable only through the injected fetch. */
export class FakeKhalti {
  readonly payments = new Map<string, FakeKhaltiPayment>();
  readonly requests: { url: string; authorization: string | null; body: unknown }[] = [];

  readonly fetch: FetchLike = (url, init) => {
    const body: unknown = JSON.parse(requestBodyText(init));
    this.requests.push({
      url,
      authorization: new Headers(init.headers).get('authorization'),
      body,
    });
    const payload = body as Record<string, unknown>;

    if (url === `${KHALTI_BASE}/epayment/initiate/`) {
      const pidx = randomUUID().replaceAll('-', '');
      const amount = Number(payload.amount);
      this.payments.set(pidx, {
        amount,
        purchaseOrderId: String(payload.purchase_order_id),
        status: 'Initiated',
        paidAmount: amount,
      });
      return json({
        pidx,
        payment_url: `https://test-pay.khalti.com/?pidx=${pidx}`,
        expires_in: 1800,
      });
    }
    if (url === `${KHALTI_BASE}/epayment/lookup/`) {
      const pidx = String(payload.pidx);
      const payment = this.payments.get(pidx);
      if (payment === undefined) return json({ detail: 'Not found.' }, 404);
      return json({
        pidx,
        total_amount: payment.paidAmount,
        status: payment.status,
        transaction_id: payment.status === 'Completed' ? 'GFq9PFS7b2iYvL8Lir9oXe' : null,
        fee: 0,
        refunded: false,
      });
    }
    return json({ detail: 'unknown endpoint' }, 404);
  };

  /** Simulates the customer finishing (or abandoning) payment on Khalti's side. */
  settle(pidx: string, status: string, paidAmount?: number): void {
    const payment = this.payments.get(pidx);
    if (payment === undefined) throw new Error(`unknown pidx ${pidx}`);
    payment.status = status;
    payment.paidAmount = paidAmount ?? payment.amount;
  }
}

function json(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
}
