import type { ORDER_ALARM_SOUND } from '@hamro-pasal/shared-types';
import { z } from 'zod';

/** Expo's push service (SPEC implicit requirement 1). One POST takes up to 100 messages. */
export const EXPO_PUSH_SEND_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_PUSH_BATCH_SIZE = 100;
/** A slow push service must not hold up the order.lifecycle partition for long. */
export const EXPO_PUSH_TIMEOUT_MS = 5_000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** One message of the Expo push API (the fields this worker uses). */
export interface ExpoPushMessage {
  /** An Expo push token. */
  readonly to: string;
  /** Absent on a data-only message: the app builds the notification from `data`. */
  readonly title?: string;
  readonly body?: string;
  /**
   * iOS only (Expo): 'default', or a sound file bundled with the app, named exactly with its
   * extension (ORDER_ALARM_SOUND). On Android the notification channel decides the sound.
   */
  readonly sound?: 'default' | typeof ORDER_ALARM_SOUND;
  readonly priority: 'default' | 'normal' | 'high';
  /** Android notification channel. */
  readonly channelId?: string;
  /** iOS: wakes the app in the background for a data-only message. */
  readonly _contentAvailable?: boolean;
  readonly data: Readonly<Record<string, unknown>>;
}

/** Expo's answer for one message, paired with the token it was sent to. */
export type PushTicket =
  | { readonly token: string; readonly status: 'ok'; readonly id: string }
  | {
      readonly token: string;
      readonly status: 'error';
      /** Expo's error code, e.g. DeviceNotRegistered; null when it gave none. */
      readonly error: string | null;
      readonly message: string;
    };

/** The token is no longer valid for this app (uninstalled, or its permission was revoked). */
export const EXPO_DEVICE_NOT_REGISTERED = 'DeviceNotRegistered';

export interface PushGateway {
  /** One ticket per message, in order. Throws PushDeliveryError when a request fails as a whole. */
  send(messages: readonly ExpoPushMessage[]): Promise<PushTicket[]>;
}

export class PushDeliveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Expo push request failed: ${message}`, options);
    this.name = 'PushDeliveryError';
  }
}

const ticketSchema = z.union([
  z.object({ status: z.literal('ok'), id: z.string() }),
  z.object({
    status: z.literal('error'),
    message: z.string().default('unknown error'),
    details: z.object({ error: z.string().optional() }).optional(),
  }),
]);
const responseSchema = z.object({ data: z.array(ticketSchema) });

export interface ExpoPushGatewayOptions {
  /** HTTP client (default: global fetch). */
  readonly fetch?: FetchLike;
  /** EXPO_ACCESS_TOKEN: required only when the Expo project enforces push security. */
  readonly accessToken?: string;
  readonly timeoutMs?: number;
}

/** Sends through https://exp.host/--/api/v2/push/send with plain fetch (no Expo server SDK). */
export class ExpoPushGateway implements PushGateway {
  private readonly fetch: FetchLike;
  private readonly accessToken: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: ExpoPushGatewayOptions = {}) {
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.accessToken = options.accessToken;
    this.timeoutMs = options.timeoutMs ?? EXPO_PUSH_TIMEOUT_MS;
  }

  async send(messages: readonly ExpoPushMessage[]): Promise<PushTicket[]> {
    const tickets: PushTicket[] = [];
    for (let start = 0; start < messages.length; start += EXPO_PUSH_BATCH_SIZE) {
      tickets.push(...(await this.sendBatch(messages.slice(start, start + EXPO_PUSH_BATCH_SIZE))));
    }
    return tickets;
  }

  private async sendBatch(batch: readonly ExpoPushMessage[]): Promise<PushTicket[]> {
    let response: Response;
    try {
      response = await this.fetch(EXPO_PUSH_SEND_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(this.accessToken === undefined
            ? {}
            : { Authorization: `Bearer ${this.accessToken}` }),
        },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error: unknown) {
      throw new PushDeliveryError(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
    }
    if (!response.ok) {
      throw new PushDeliveryError(`HTTP ${String(response.status)}`);
    }
    const parsed = responseSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success || parsed.data.data.length !== batch.length) {
      throw new PushDeliveryError('unexpected response body');
    }
    return parsed.data.data.map((ticket, index): PushTicket => {
      const token = batch[index]?.to ?? '';
      return ticket.status === 'ok'
        ? { token, status: 'ok', id: ticket.id }
        : {
            token,
            status: 'error',
            error: ticket.details?.error ?? null,
            message: ticket.message,
          };
    });
  }
}
