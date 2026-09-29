import type { z } from 'zod';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type Gateway = 'ESEWA' | 'KHALTI';

/** A payment gateway call failed (network, timeout, non-2xx, or an unexpected response). */
export class PaymentGatewayError extends Error {
  constructor(
    readonly gateway: Gateway,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(`${gateway}: ${message}`);
    this.name = 'PaymentGatewayError';
  }
}

export interface PostJsonOptions<TSchema extends z.ZodType> {
  readonly gateway: Gateway;
  readonly fetch: FetchLike;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly responseSchema: TSchema;
  readonly timeoutMs: number;
}

/** POSTs JSON with a hard timeout and validates the JSON response against a schema. */
export async function postJson<TSchema extends z.ZodType>(
  options: PostJsonOptions<TSchema>,
): Promise<z.output<TSchema>> {
  let response: Response;
  try {
    response = await options.fetch(options.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...options.headers,
      },
      body: JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error: unknown) {
    throw new PaymentGatewayError(
      options.gateway,
      `request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const text = await response.text();
  if (!response.ok) {
    throw new PaymentGatewayError(
      options.gateway,
      `HTTP ${String(response.status)}: ${text.slice(0, 300)}`,
      response.status,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PaymentGatewayError(options.gateway, 'response is not JSON', response.status);
  }
  const parsed = options.responseSchema.safeParse(json);
  if (!parsed.success) {
    throw new PaymentGatewayError(options.gateway, 'unexpected response shape', response.status);
  }
  return parsed.data;
}
