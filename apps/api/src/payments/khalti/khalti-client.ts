import { z } from 'zod';

import { postJson, type FetchLike } from '../gateway-http';

/*
 * Khalti ePay v2 web checkout (SPEC: Nepal localizations §2).
 *   initiate: POST {base}/epayment/initiate/  Authorization: Key <secret>, amount in paisa
 *   lookup:   POST {base}/epayment/lookup/    { pidx }
 * with base = https://a.khalti.com/api/v2 (KHALTI_BASE_URL).
 */

export interface KhaltiConfig {
  readonly secretKey: string;
  /** e.g. https://a.khalti.com/api/v2 */
  readonly baseUrl: string;
  readonly returnUrl: string;
  readonly websiteUrl: string;
  readonly timeoutMs?: number;
}

export interface KhaltiInitiateInput {
  /** NPR x 100. Khalti rejects fractional paisa. */
  readonly amountPaisa: number;
  readonly purchaseOrderId: string;
  readonly purchaseOrderName: string;
}

const initiateResponseSchema = z.object({
  pidx: z.string().min(1),
  payment_url: z.url(),
  expires_at: z.string().optional(),
  expires_in: z.number().optional(),
});
export type KhaltiInitiateResponse = z.infer<typeof initiateResponseSchema>;

/** Lookup statuses per Khalti docs. Only `Completed` releases escrow credit (SPEC). */
export const KHALTI_COMPLETED = 'Completed';

const lookupResponseSchema = z.object({
  pidx: z.string().min(1),
  /** Paisa. */
  total_amount: z.number().int().nonnegative(),
  status: z.string().min(1),
  transaction_id: z.string().nullable().optional(),
  fee: z.number().optional(),
  refunded: z.boolean().optional(),
});
export type KhaltiLookupResponse = z.infer<typeof lookupResponseSchema>;

export class KhaltiClient {
  private readonly timeoutMs: number;

  constructor(
    private readonly config: KhaltiConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  /**
   * `secretKey` (2026-10-21, Model C): the shop's own merchant secret, when the payment goes to
   * its account rather than the platform's.
   */
  initiate(input: KhaltiInitiateInput, secretKey?: string): Promise<KhaltiInitiateResponse> {
    if (!Number.isSafeInteger(input.amountPaisa) || input.amountPaisa <= 0) {
      throw new RangeError('Khalti amount must be a positive whole number of paisa');
    }
    return postJson({
      gateway: 'KHALTI',
      fetch: this.fetchImpl,
      url: this.endpoint('epayment/initiate/'),
      headers: this.authHeaders(secretKey),
      body: {
        return_url: this.config.returnUrl,
        website_url: this.config.websiteUrl,
        amount: input.amountPaisa,
        purchase_order_id: input.purchaseOrderId,
        purchase_order_name: input.purchaseOrderName,
      },
      responseSchema: initiateResponseSchema,
      timeoutMs: this.timeoutMs,
    });
  }

  lookup(pidx: string, secretKey?: string): Promise<KhaltiLookupResponse> {
    return postJson({
      gateway: 'KHALTI',
      fetch: this.fetchImpl,
      url: this.endpoint('epayment/lookup/'),
      headers: this.authHeaders(secretKey),
      body: { pidx },
      responseSchema: lookupResponseSchema,
      timeoutMs: this.timeoutMs,
    });
  }

  private endpoint(path: string): string {
    return `${this.config.baseUrl.replace(/\/+$/, '')}/${path}`;
  }

  private authHeaders(secretKey = this.config.secretKey): Record<string, string> {
    return { authorization: `Key ${secretKey}` };
  }
}
