import { KAFKA_TOPICS, type DomainEvent } from '@hamro-pasal/shared-types';
import type { SmsDelivery, SmsGateway } from '@hamro-pasal/sms';

import { vendorNotificationSms } from '../notifications/vendor-sms';
import { parseDomainEventMessage, type EventDeduplicator } from './order-state-fanout';
import type { KafkaConsumerDefinition } from './types';

/** Redis prefix of the per-event claims (kept apart from the order fan-out's). */
export const VENDOR_SMS_DEDUPE_PREFIX = 'notifications:sms:seen:';

export interface VendorNotificationDeps {
  /** The SMS_PROVIDER adapter (Sparrow / Aakash, or MOCK, which only logs). */
  readonly sms: SmsGateway;
  readonly deduplicator: EventDeduplicator;
  readonly onInvalidMessage?: (reason: string) => void;
  /** Called after the provider accepted a message (default: one JSON log line, no phone/text). */
  readonly onSent?: (event: DomainEvent, delivery: SmsDelivery) => void;
}

/**
 * Kafka `notifications.broadcast` → vendor SMS (Phase 13):
 *   vendor.suspended_for_debt  → "your shop is offline, pay Rs. N"
 *   vendor.restored            → "your shop is back online"
 *   vendor.escalation.required → "order #CODE has waited over 90 seconds"
 *
 * Delivery is at-least-once, so each event_id is claimed in Redis before sending and a
 * redelivery is skipped. If the provider refuses (or times out), the claim is released and the
 * handler throws, so Kafka redelivers and the SMS is retried. A crash between the claim and the
 * provider's answer loses that one SMS rather than sending it twice.
 */
export function vendorNotificationConsumer(deps: VendorNotificationDeps): KafkaConsumerDefinition {
  const onInvalid =
    deps.onInvalidMessage ??
    ((reason: string) => {
      console.error(`[worker] vendor-notifications skipped a message: ${reason}`);
    });
  const onSent =
    deps.onSent ??
    ((event: DomainEvent, delivery: SmsDelivery) => {
      console.info(
        JSON.stringify({
          notification: 'sms.sent',
          event_type: event.event_type,
          event_id: event.event_id,
          aggregate_id: event.aggregate_id,
          provider: delivery.provider,
        }),
      );
    });

  return {
    topic: KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
    handle: async ({ message, partition }) => {
      const event = parseDomainEventMessage(message.value);
      if (event === null) {
        // A poison message would block the partition forever if it were retried.
        onInvalid(`invalid envelope at partition ${String(partition)} offset ${message.offset}`);
        return;
      }
      const sms = vendorNotificationSms(event);
      if (sms === null) return;
      if (!(await deps.deduplicator.claim(event.event_id))) return;
      let delivery: SmsDelivery;
      try {
        delivery = await deps.sms.send(sms);
      } catch (error: unknown) {
        await deps.deduplicator.release(event.event_id).catch(() => undefined);
        throw error;
      }
      onSent(event, delivery);
    },
  };
}
