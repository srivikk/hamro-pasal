import {
  mockServicesEnabled,
  ORDER_PUSH_CHANNEL_ID,
  type ServerEnv,
} from '@hamro-pasal/shared-types';
import type { SmsGateway } from '@hamro-pasal/sms';

import {
  EXPO_DEVICE_NOT_REGISTERED,
  type ExpoPushMessage,
  type PushGateway,
} from '../push/expo-push';
import {
  LoggerNotificationAdapter,
  type NotificationAdapter,
  type VendorNotice,
} from './notification-adapter';
import type { DeviceTokenRemover, PushRecipientReader } from './push-recipients';

/** `data.type` of a vendor notice push. The app's order task ignores it; the OS draws the banner. */
export const VENDOR_NOTICE_PUSH_TYPE = 'vendor.notice';

/** What became of one notice's push (one JSON log line by default). */
export type NoticePushOutcome =
  | {
      readonly notification: 'notice.push_sent';
      /** Messages Expo accepted. */
      readonly sent: number;
      /** Messages Expo refused (per-device errors). */
      readonly rejected: number;
      /** Tokens deleted because Expo reported DeviceNotRegistered. */
      readonly removed_tokens: number;
    }
  /** The shop's account has no device registered (always so right after a deactivation). */
  | { readonly notification: 'notice.push_skipped'; readonly reason: 'NO_DEVICE' }
  /** Expo timed out or refused the request, or the tokens could not be read. Not retried. */
  | { readonly notification: 'notice.push_failed'; readonly error: string };

export interface ProductionNotificationDeps {
  /** The SMS_PROVIDER adapter (Sparrow / Aakash): the one the login code and debt notices use. */
  readonly sms: SmsGateway;
  /** The Expo push service. */
  readonly push: PushGateway;
  /** Device tokens of the shop's account (vendors.user_id), and their removal when Expo says so. */
  readonly recipients: Pick<PushRecipientReader, 'vendor'> & DeviceTokenRemover;
  readonly onPushOutcome?: (notice: VendorNotice, outcome: NoticePushOutcome) => void;
}

/** The Expo messages of one notice: a visible push to every device of the shop's account. */
export function noticePushMessages(
  notice: VendorNotice,
  tokens: readonly string[],
): ExpoPushMessage[] {
  return tokens.map((to) => ({
    to,
    title: notice.push.title,
    body: notice.push.body,
    sound: 'default',
    priority: 'high',
    channelId: ORDER_PUSH_CHANNEL_ID,
    data: {
      type: VENDOR_NOTICE_PUSH_TYPE,
      notification_id: `${notice.eventId}:${notice.vendorId}`,
      event_type: notice.eventType,
    },
  }));
}

/**
 * Vendor notices over the real providers (Phase 38).
 *
 * **The SMS is the delivery.** It goes first, through `@hamro-pasal/sms`; if the provider refuses
 * it or does not answer inside its timeout, `send` rejects. The consumer then gives the shop's
 * claim back, the message is retried with backoff and finally dead-lettered, where an admin can
 * replay it. A timeout may hide an SMS that was in fact sent, so a retry can text a shop twice:
 * at-least-once, never silently lost.
 *
 * **The push is best effort**, sent only after the SMS was accepted (so a retried SMS never
 * repeats a push). Nothing it does can reject `send`: a slow or failing Expo, an unreadable token
 * table and per-device refusals are reported through `onPushOutcome` and left at that. A token
 * Expo reports as DeviceNotRegistered is deleted.
 */
export class ProductionNotificationAdapter implements NotificationAdapter {
  readonly name: string;
  private readonly onPushOutcome: (notice: VendorNotice, outcome: NoticePushOutcome) => void;

  constructor(private readonly deps: ProductionNotificationDeps) {
    this.name = deps.sms.provider;
    this.onPushOutcome =
      deps.onPushOutcome ??
      ((notice, outcome) => {
        const line = JSON.stringify({
          ...outcome,
          event_type: notice.eventType,
          event_id: notice.eventId,
          vendor_id: notice.vendorId,
        });
        if (outcome.notification === 'notice.push_failed') console.error(line);
        else console.info(line);
      });
  }

  async send(notice: VendorNotice): Promise<void> {
    await this.deps.sms.send({ to: notice.phone, text: notice.sms });
    let outcome: NoticePushOutcome;
    try {
      outcome = await this.pushTo(notice);
    } catch (error: unknown) {
      outcome = {
        notification: 'notice.push_failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      this.onPushOutcome(notice, outcome);
    } catch {
      // Reporting a push must not undo an SMS that was delivered.
    }
  }

  private async pushTo(notice: VendorNotice): Promise<NoticePushOutcome> {
    const recipient = await this.deps.recipients.vendor(notice.vendorId);
    const messages = noticePushMessages(notice, recipient?.tokens ?? []);
    if (messages.length === 0) return { notification: 'notice.push_skipped', reason: 'NO_DEVICE' };

    const tickets = await this.deps.push.send(messages);
    const unregistered = tickets.flatMap((ticket) =>
      ticket.status === 'error' && ticket.error === EXPO_DEVICE_NOT_REGISTERED
        ? [ticket.token]
        : [],
    );
    // The push itself went out: a failed clean-up is not a failed push.
    await this.deps.recipients.remove(unregistered).catch(() => undefined);
    const sent = tickets.filter((ticket) => ticket.status === 'ok').length;
    return {
      notification: 'notice.push_sent',
      sent,
      rejected: tickets.length - sent,
      removed_tokens: unregistered.length,
    };
  }
}

/**
 * The real providers; with MOCK_SERVICES on (never in production) the logger, which writes
 * `[notify:sms]` / `[notify:push]` lines and makes no request.
 */
export function notificationAdapterFromEnv(
  env: Pick<ServerEnv, 'MOCK_SERVICES' | 'NODE_ENV'>,
  deps: ProductionNotificationDeps,
): NotificationAdapter {
  return mockServicesEnabled(env)
    ? new LoggerNotificationAdapter()
    : new ProductionNotificationAdapter(deps);
}
