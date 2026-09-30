import type { ServerEnv } from '@hamro-pasal/shared-types';

import {
  AakashSmsGateway,
  MockSmsGateway,
  SparrowSmsGateway,
  type FetchLike,
  type OutboundSms,
  type SmsGateway,
} from './sms-gateway';

/** The env keys the SMS adapters read (parseServerEnv has already checked they are complete). */
export type SmsEnv = Pick<
  ServerEnv,
  | 'SMS_PROVIDER'
  | 'SPARROW_SMS_TOKEN'
  | 'SPARROW_SMS_FROM'
  | 'SPARROW_SMS_API_URL'
  | 'AAKASH_SMS_AUTH_TOKEN'
  | 'AAKASH_SMS_API_URL'
>;

export interface SmsGatewayFromEnvOptions {
  /** Where SMS_PROVIDER=MOCK prints each message (default: console.info). */
  readonly mockLog?: (line: string) => void;
  /** HTTP client for Sparrow / Aakash (default: global fetch). */
  readonly fetch?: FetchLike;
}

/** The line SMS_PROVIDER=MOCK prints instead of sending: `[sms:mock] to +977…: <text>`. */
export function mockSmsLogLine(sms: OutboundSms): string {
  return `[sms:mock] to ${sms.to}: ${sms.text}`;
}

/**
 * The SMS adapter for SMS_PROVIDER (SPEC Nepal §4). MOCK makes no network call and logs the
 * message instead (parseServerEnv refuses it in production). FIREBASE fails: Firebase Auth sends
 * its own codes and cannot deliver server-written text.
 */
export function smsGatewayFromEnv(env: SmsEnv, options: SmsGatewayFromEnvOptions = {}): SmsGateway {
  switch (env.SMS_PROVIDER) {
    case 'SPARROW':
      return new SparrowSmsGateway(
        {
          token: required(env.SPARROW_SMS_TOKEN, 'SPARROW_SMS_TOKEN'),
          from: required(env.SPARROW_SMS_FROM, 'SPARROW_SMS_FROM'),
          apiUrl: required(env.SPARROW_SMS_API_URL, 'SPARROW_SMS_API_URL'),
        },
        options.fetch,
      );
    case 'AAKASH':
      return new AakashSmsGateway(
        {
          authToken: required(env.AAKASH_SMS_AUTH_TOKEN, 'AAKASH_SMS_AUTH_TOKEN'),
          apiUrl: required(env.AAKASH_SMS_API_URL, 'AAKASH_SMS_API_URL'),
        },
        options.fetch,
      );
    case 'MOCK': {
      const log =
        options.mockLog ??
        ((line: string) => {
          console.info(line);
        });
      return new MockSmsGateway((sms) => {
        log(mockSmsLogLine(sms));
      });
    }
    case 'FIREBASE':
      throw new Error(
        'SMS_PROVIDER=FIREBASE cannot deliver server-written SMS; use SPARROW, AAKASH or MOCK',
      );
  }
}

function required(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}
