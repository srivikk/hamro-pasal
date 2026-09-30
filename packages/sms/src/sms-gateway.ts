import { isNepalPhone, normalizeNepalPhone } from '@hamro-pasal/shared-types';

/*
 * SMS / OTP gateway (SPEC: Nepal localizations §4): Sparrow SMS or Aakash SMS, every payload
 * addressed in strict +977 form. All adapters go through prepareOutboundSms, so no code path can
 * send to a non-Nepal or malformed number. Shared by the API (login codes) and the worker
 * (vendor notifications, Phase 13).
 */

/** The subset of `fetch` the HTTP adapters use (tests inject a recording fake). */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface SmsMessage {
  /** Any common Nepal format ("98XXXXXXXX", "+977-98..."); normalised before sending. */
  readonly to: string;
  readonly text: string;
}

export interface OutboundSms {
  /** Always matches NEPAL_PHONE_REGEX: +9779XXXXXXXXX. */
  readonly to: string;
  readonly text: string;
}

export interface SmsDelivery {
  readonly provider: SmsProviderName;
  readonly to: string;
}

export type SmsProviderName = 'SPARROW' | 'AAKASH' | 'MOCK';

export interface SmsGateway {
  readonly provider: SmsProviderName;
  send(message: SmsMessage): Promise<SmsDelivery>;
}

export class SmsDeliveryError extends Error {
  constructor(
    readonly provider: SmsProviderName,
    reason: string,
  ) {
    super(`${provider} SMS failed: ${reason}`);
    this.name = 'SmsDeliveryError';
  }
}

/** Longest text we send: 5 concatenated Unicode (Devanagari) SMS segments of 67 characters. */
export const MAX_SMS_LENGTH = 335;

/** The single choke point for outbound SMS: strict +977 recipient and a bounded, non-empty text. */
export function prepareOutboundSms(message: SmsMessage): OutboundSms {
  const to = normalizeNepalPhone(message.to);
  if (!isNepalPhone(to)) {
    // Defence in depth: normalisation already guarantees this.
    throw new Error('Recipient failed +977 validation');
  }
  const text = message.text.trim();
  if (text.length === 0 || text.length > MAX_SMS_LENGTH) {
    throw new RangeError(`SMS text must be 1-${String(MAX_SMS_LENGTH)} characters`);
  }
  return { to, text };
}

abstract class HttpSmsGateway implements SmsGateway {
  abstract readonly provider: SmsProviderName;

  constructor(
    protected readonly apiUrl: string,
    private readonly fetchImpl: FetchLike,
    private readonly timeoutMs = 10_000,
  ) {}

  protected abstract formFields(sms: OutboundSms): Record<string, string>;
  protected abstract assertAccepted(body: unknown): void;

  async send(message: SmsMessage): Promise<SmsDelivery> {
    const sms = prepareOutboundSms(message);
    let response: Response;
    try {
      response = await this.fetchImpl(this.apiUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams(this.formFields(sms)).toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error: unknown) {
      throw new SmsDeliveryError(this.provider, error instanceof Error ? error.message : 'network');
    }
    const text = await response.text();
    if (!response.ok) {
      throw new SmsDeliveryError(this.provider, `HTTP ${String(response.status)}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new SmsDeliveryError(this.provider, 'response is not JSON');
    }
    this.assertAccepted(body);
    return { provider: this.provider, to: sms.to };
  }
}

export interface SparrowConfig {
  readonly token: string;
  readonly from: string;
  readonly apiUrl: string;
}

/** Sparrow SMS v2: POST token, from, to, text. Success is `response_code` 200. */
export class SparrowSmsGateway extends HttpSmsGateway {
  readonly provider = 'SPARROW';

  constructor(
    private readonly config: SparrowConfig,
    fetchImpl: FetchLike = fetch,
  ) {
    super(config.apiUrl, fetchImpl);
  }

  protected formFields(sms: OutboundSms): Record<string, string> {
    return { token: this.config.token, from: this.config.from, to: sms.to, text: sms.text };
  }

  protected assertAccepted(body: unknown): void {
    const code = (body as { response_code?: unknown } | null)?.response_code;
    if (code !== 200) {
      throw new SmsDeliveryError(this.provider, `response_code ${String(code)}`);
    }
  }
}

export interface AakashConfig {
  readonly authToken: string;
  readonly apiUrl: string;
}

/** Aakash SMS v3: POST auth_token, to, text. Success is `error: false`. */
export class AakashSmsGateway extends HttpSmsGateway {
  readonly provider = 'AAKASH';

  constructor(
    private readonly config: AakashConfig,
    fetchImpl: FetchLike = fetch,
  ) {
    super(config.apiUrl, fetchImpl);
  }

  protected formFields(sms: OutboundSms): Record<string, string> {
    return { auth_token: this.config.authToken, to: sms.to, text: sms.text };
  }

  protected assertAccepted(body: unknown): void {
    if ((body as { error?: unknown } | null)?.error !== false) {
      throw new SmsDeliveryError(this.provider, 'provider reported an error');
    }
  }
}

/** In-memory gateway for development and tests. Applies the same +977 rules as the real ones. */
export class MockSmsGateway implements SmsGateway {
  readonly provider = 'MOCK';
  readonly sent: OutboundSms[] = [];

  /** `onSend` lets local development see the message (e.g. print the OTP to the log). */
  constructor(private readonly onSend?: (sms: OutboundSms) => void) {}

  // async, so validation failures surface as rejections exactly like the HTTP adapters.
  // eslint-disable-next-line @typescript-eslint/require-await
  async send(message: SmsMessage): Promise<SmsDelivery> {
    const sms = prepareOutboundSms(message);
    this.sent.push(sms);
    this.onSend?.(sms);
    return { provider: this.provider, to: sms.to };
  }
}
