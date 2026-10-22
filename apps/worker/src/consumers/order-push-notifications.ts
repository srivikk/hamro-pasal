import {
  KAFKA_TOPICS,
  type OrderStateChangedEvent,
  type ServerEnv,
} from '@hamro-pasal/shared-types';
import { mockSmsLogLine } from '@hamro-pasal/sms';

import type { OrderInbox } from '../notifications/order-inbox';
import {
  expoMessagePayload,
  expoMessages,
  orderPushes,
  orderPushFallbackSms,
  type OrderPush,
} from '../notifications/order-push';
import type {
  DeviceTokenRemover,
  PushRecipient,
  PushRecipientReader,
} from '../notifications/push-recipients';
import {
  EXPO_DEVICE_NOT_REGISTERED,
  type ExpoPushMessage,
  type PushGateway,
} from '../push/expo-push';
import { mockPushLogLine } from '../push/mock-push';
import { parseDomainEventMessage, type EventDeduplicator } from './order-state-fanout';
import type { KafkaConsumerDefinition } from './types';

/** Redis prefix of the per-event push claims (kept apart from the fan-out's and the SMS ones). */
export const ORDER_PUSH_DEDUPE_PREFIX = 'notifications:push:seen:';

/**
 * The SMS fallback log for SMS_PROVIDER: MOCK prints each line (default: console.info); every
 * real provider gets null, so an order push never costs an SMS.
 */
export function smsFallbackLogFromEnv(
  env: Pick<ServerEnv, 'SMS_PROVIDER'>,
  log: (line: string) => void = (line) => {
    console.info(line);
  },
): ((line: string) => void) | null {
  return env.SMS_PROVIDER === 'MOCK' ? log : null;
}

/** What became of one event's pushes (one JSON log line by default). */
export type OrderPushOutcome =
  | {
      readonly notification: 'push.sent';
      /** Messages Expo accepted. */
      readonly sent: number;
      /** Messages Expo refused (per-device errors). */
      readonly rejected: number;
      /** Tokens deleted because Expo reported DeviceNotRegistered. */
      readonly removed_tokens: number;
    }
  | { readonly notification: 'push.failed'; readonly error: string }
  /** 2026-10-21: the alert could not be kept in the notification centre; the push still went. */
  | {
      readonly notification: 'inbox.failed';
      readonly audience: OrderPush['audience'];
      readonly error: string;
    };

export interface OrderPushNotificationDeps {
  readonly recipients: PushRecipientReader;
  readonly tokens: DeviceTokenRemover;
  readonly push: PushGateway;
  readonly deduplicator: EventDeduplicator;
  /**
   * SMS_PROVIDER=MOCK: prints the SMS each push stands in for (`[sms:mock] to +977…: <text>`),
   * next to the push attempt. null for a real provider: order pushes never send a billed SMS.
   */
  readonly smsFallbackLog: ((line: string) => void) | null;
  /**
   * 2026-10-21: keeps every alert in the recipient's notification centre, before its push is
   * sent and whether or not a device is registered. Absent: nothing is kept (tests of the push).
   */
  readonly inbox?: OrderInbox | null;
  /**
   * MOCK_SERVICES: prints `[MOCK PUSH] -> Vendor/User <id>: <payload>` for every push, whether or
   * not the recipient has a device registered. Absent or null otherwise.
   */
  readonly mockPushLog?: ((line: string) => void) | null;
  readonly onOutcome?: (event: OrderStateChangedEvent, outcome: OrderPushOutcome) => void;
}

/**
 * Kafka `order.lifecycle` → Expo push (Phase 20). Every `order.state_changed` event is turned into
 * the pushes of `orderPushes` (new order → vendor; accepted, dispatched, delivered, failed →
 * customer; cancelled → both), sent to each recipient's registered devices in one request to
 * https://exp.host/--/api/v2/push/send.
 *
 * Best effort, at most once: the event is claimed in Redis before sending and the claim is kept,
 * and a failure (Expo down, Postgres down) is logged, never thrown. This topic also carries the
 * live order tracking and the 90 s vendor timer: a retried or blocked push must not delay them.
 * The vendor's safety net is the 90 s SMS / IVR escalation; the customer's is the tracking screen.
 */
export function orderPushNotificationConsumer(
  deps: OrderPushNotificationDeps,
): KafkaConsumerDefinition {
  const onOutcome =
    deps.onOutcome ??
    ((event: OrderStateChangedEvent, outcome: OrderPushOutcome) => {
      const line = JSON.stringify({
        ...outcome,
        event_type: event.event_type,
        event_id: event.event_id,
        aggregate_id: event.aggregate_id,
        to_state: event.payload.to_state,
      });
      if (outcome.notification !== 'push.sent') console.error(line);
      else console.info(line);
    });

  function recipientOf(
    event: OrderStateChangedEvent,
    push: OrderPush,
  ): Promise<PushRecipient | null> {
    return push.audience === 'VENDOR'
      ? deps.recipients.vendor(event.payload.vendor_id)
      : deps.recipients.customer(event.payload.customer_id);
  }

  async function deliver(event: OrderStateChangedEvent, pushes: readonly OrderPush[]) {
    const messages: ExpoPushMessage[] = [];
    for (const push of pushes) {
      const recipient = await recipientOf(event, push);
      if (recipient === null) continue;
      if (deps.inbox != null) {
        try {
          await deps.inbox.record(event, push, recipient.userId);
        } catch (error: unknown) {
          onOutcome(event, {
            notification: 'inbox.failed',
            audience: push.audience,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      deps.smsFallbackLog?.(
        mockSmsLogLine({ to: recipient.phone, text: orderPushFallbackSms(push) }),
      );
      deps.mockPushLog?.(
        mockPushLogLine(
          push.audience,
          push.audience === 'VENDOR' ? event.payload.vendor_id : event.payload.customer_id,
          expoMessagePayload(event, push),
        ),
      );
      messages.push(
        ...expoMessages(event, push, recipient.tokens, new Set(recipient.iosTokens ?? [])),
      );
    }
    // Nobody has a device registered: no request is made.
    if (messages.length === 0) return;

    const tickets = await deps.push.send(messages);
    const unregistered = tickets.flatMap((ticket) =>
      ticket.status === 'error' && ticket.error === EXPO_DEVICE_NOT_REGISTERED
        ? [ticket.token]
        : [],
    );
    await deps.tokens.remove(unregistered);
    const sent = tickets.filter((ticket) => ticket.status === 'ok').length;
    onOutcome(event, {
      notification: 'push.sent',
      sent,
      rejected: tickets.length - sent,
      removed_tokens: unregistered.length,
    });
  }

  return {
    topic: KAFKA_TOPICS.ORDER_LIFECYCLE,
    handle: async ({ message }) => {
      // An invalid envelope is reported by the fan-out consumer of the same topic.
      const event = parseDomainEventMessage(message.value);
      if (event?.event_type !== 'order.state_changed') return;
      const pushes = orderPushes(event);
      if (pushes.length === 0) return;
      try {
        if (!(await deps.deduplicator.claim(event.event_id))) return;
        await deliver(event, pushes);
      } catch (error: unknown) {
        onOutcome(event, {
          notification: 'push.failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
