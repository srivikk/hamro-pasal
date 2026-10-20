import type { IvrGateway } from '@hamro-pasal/ivr';
import { KAFKA_TOPICS, type DomainEvent } from '@hamro-pasal/shared-types';
import type { SmsGateway } from '@hamro-pasal/sms';

import type { OrderStateReader } from '../notifications/order-state-reader';
import { vendorEscalationCall } from '../notifications/vendor-ivr';
import { vendorNotificationSms } from '../notifications/vendor-sms';
import { PoisonMessageError } from './dead-letter';
import { parseDomainEventMessage, type EventDeduplicator } from './order-state-fanout';
import type { KafkaConsumerDefinition } from './types';

/** Redis prefix of the per-event SMS claims (kept apart from the order fan-out's). */
export const VENDOR_SMS_DEDUPE_PREFIX = 'notifications:sms:seen:';
/** Redis prefix of the per-event IVR call claims. */
export const VENDOR_IVR_DEDUPE_PREFIX = 'notifications:ivr:seen:';

export type NotificationChannel = 'SMS' | 'IVR';

export interface NotificationSent {
  readonly channel: NotificationChannel;
  readonly provider: string;
}

export interface VendorNotificationDeps {
  /** The SMS_PROVIDER adapter (Sparrow / Aakash, or MOCK, which only logs). */
  readonly sms: SmsGateway;
  readonly smsDeduplicator: EventDeduplicator;
  /** The IVR_PROVIDER adapter (MOCK only logs); null when IVR_PROVIDER=DISABLED. */
  readonly ivr: IvrGateway | null;
  readonly ivrDeduplicator: EventDeduplicator;
  /** The stale-order guard reads the order's current state here. */
  readonly orders: OrderStateReader;
  /** Called after a provider accepted a message or call (default: one JSON log line). */
  readonly onSent?: (event: DomainEvent, sent: NotificationSent) => void;
}

/**
 * Kafka `notifications.broadcast` → vendor SMS (Phase 13) and IVR call (Phase 14):
 *   vendor.suspended_for_debt  → SMS "your shop is offline, pay Rs. N"
 *   vendor.restored            → SMS "your shop is back online" (or "still offline until your PAN is verified")
 *   vendor.escalation.required → SMS "order #CODE has waited over 90 seconds" + a voice call,
 *                                concurrently, only while the order is still PLACED
 *
 * Stale-order guard: an escalation is dropped silently if the order is no longer PLACED (or does
 * not exist) when the event is processed, so a backlog never texts or calls a vendor about an
 * order that was already accepted, rejected or canceled.
 *
 * Delivery is at-least-once, so each channel claims the event_id in Redis before sending and a
 * redelivery skips it. If a provider refuses (or times out), that channel's claim is released and
 * the handler throws; the other channel keeps its claim, so a retry repeats only what failed.
 * Retries and the dead-letter topic are `withDeadLetter`'s job (see buildConsumers). An
 * unparseable envelope throws PoisonMessageError and is dead-lettered without retries.
 */
export function vendorNotificationConsumer(deps: VendorNotificationDeps): KafkaConsumerDefinition {
  const onSent =
    deps.onSent ??
    ((event: DomainEvent, sent: NotificationSent) => {
      console.info(
        JSON.stringify({
          notification: sent.channel === 'SMS' ? 'sms.sent' : 'ivr.placed',
          event_type: event.event_type,
          event_id: event.event_id,
          aggregate_id: event.aggregate_id,
          provider: sent.provider,
        }),
      );
    });

  /** Sends on one channel unless an earlier delivery of this event already did. */
  async function deliverOnce(
    event: DomainEvent,
    channel: NotificationChannel,
    deduplicator: EventDeduplicator,
    send: () => Promise<{ readonly provider: string }>,
  ): Promise<void> {
    if (!(await deduplicator.claim(event.event_id))) return;
    let result: { readonly provider: string };
    try {
      result = await send();
    } catch (error: unknown) {
      await deduplicator.release(event.event_id).catch(() => undefined);
      throw error;
    }
    onSent(event, { channel, provider: result.provider });
  }

  return {
    topic: KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
    handle: async ({ message, partition }) => {
      const event = parseDomainEventMessage(message.value);
      if (event === null) {
        throw new PoisonMessageError(
          `invalid envelope at partition ${String(partition)} offset ${message.offset}`,
        );
      }
      const sms = vendorNotificationSms(event);
      if (sms === null) return;

      if (event.event_type === 'vendor.escalation.required') {
        const state = await deps.orders.currentState(event.payload.order_id);
        if (state !== 'PLACED') return;
      }

      const deliveries = [
        deliverOnce(event, 'SMS', deps.smsDeduplicator, () => deps.sms.send(sms)),
      ];
      const call = vendorEscalationCall(event);
      const ivr = deps.ivr;
      if (call !== null && ivr !== null) {
        deliveries.push(deliverOnce(event, 'IVR', deps.ivrDeduplicator, () => ivr.call(call)));
      }
      const failures = (await Promise.allSettled(deliveries)).flatMap((result): unknown[] =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length === 1) {
        throw failures[0] instanceof Error ? failures[0] : new Error(String(failures[0]));
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, 'SMS and IVR delivery both failed');
      }
    },
  };
}
