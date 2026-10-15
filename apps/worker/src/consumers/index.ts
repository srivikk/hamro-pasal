import type { IvrGateway } from '@hamro-pasal/ivr';
import type { KafkaJS } from '@hamro-pasal/kafka';
import { KAFKA_TOPICS } from '@hamro-pasal/shared-types';
import type { SmsGateway } from '@hamro-pasal/sms';
import type { Redis } from 'ioredis';

import type { NotificationAdapter } from '../notifications/notification-adapter';
import type { DisputeNoticeService } from '../notifications/dispute-notices';
import type { NotifyMeService } from '../notifications/notify-me';
import type { OrderStateReader } from '../notifications/order-state-reader';
import type { DeviceTokenRemover, PushRecipientReader } from '../notifications/push-recipients';
import type { VendorContactReader } from '../notifications/vendor-notices';
import type { PushGateway } from '../push/expo-push';
import { withDeadLetter, type DeadLetterPublisher, type DeadLetterStore } from './dead-letter';
import {
  ORDER_PUSH_DEDUPE_PREFIX,
  orderPushNotificationConsumer,
} from './order-push-notifications';
import { disputeNoticeConsumer } from './dispute-notices';
import { notifyMeConsumer } from './notify-me';
import {
  orderStateFanoutConsumer,
  RedisEventDeduplicator,
  RedisOrderRoomBroadcaster,
} from './order-state-fanout';
import type { KafkaConsumerDefinition } from './types';
import { VENDOR_NOTICE_DEDUPE_PREFIX, vendorNoticeConsumer } from './vendor-notices';
import {
  VENDOR_IVR_DEDUPE_PREFIX,
  VENDOR_SMS_DEDUPE_PREFIX,
  vendorNotificationConsumer,
} from './vendor-notifications';
import {
  vendorSlaSchedulerConsumer,
  type VendorAcceptanceTimerScheduler,
} from './vendor-sla-scheduler';

export interface ConsumerDeps {
  /** Publishes Socket.io broadcasts and holds fan-out / SMS de-duplication keys. */
  readonly redis: Redis;
  /** Schedules the 90 s vendor acceptance timers (BullMQ). */
  readonly vendorAcceptanceTimers: VendorAcceptanceTimerScheduler;
  /** Sends vendor notification SMS (SMS_PROVIDER). */
  readonly sms: SmsGateway;
  /** Places the escalation's voice call (IVR_PROVIDER); null when DISABLED. */
  readonly ivr: IvrGateway | null;
  /** Current order state, for the escalation's stale-order guard. */
  readonly orders: OrderStateReader;
  /** Writes `notifications.dlq` (the worker's idempotent producer). */
  readonly deadLetters: DeadLetterPublisher;
  /** Keeps every dead letter in dead_letter_events for the admin DLQ monitor (Phase 15). */
  readonly deadLetterStore: DeadLetterStore;
  /** Sends order pushes to the Expo push service (Phase 20). */
  readonly push: PushGateway;
  /** Device tokens and phone numbers of an order's customer and vendor. */
  readonly pushRecipients: PushRecipientReader & DeviceTokenRemover;
  /** Set when SMS_PROVIDER=MOCK: logs the SMS each order push stands in for. null otherwise. */
  readonly pushSmsFallbackLog: ((line: string) => void) | null;
  /** Set when MOCK_SERVICES is on: logs "[MOCK PUSH] -> …" for each order push. */
  readonly pushMockLog?: ((line: string) => void) | null;
  /** Where compliance, account, ad and campaign notices leave the worker (SMS + push). */
  readonly notifications: NotificationAdapter;
  /** Phone numbers of the shops a campaign change names by id. */
  readonly vendorContacts: VendorContactReader;
  /** Step 7.4: tells customers waiting for a product or a shop. Absent: not consumed here. */
  readonly notifyMe?: Pick<NotifyMeService, 'productBackInStock' | 'shopOpened'>;
  /** Step 7.3: tells the parties of an escalated or resolved order. Absent: not consumed here. */
  readonly disputeNotices?: Pick<DisputeNoticeService, 'escalated' | 'resolved'>;
}

/** Register Kafka topic handlers here. Several may share a topic (see routeByTopic). */
export function buildConsumers(deps: ConsumerDeps): readonly KafkaConsumerDefinition[] {
  return [
    orderStateFanoutConsumer({
      broadcaster: new RedisOrderRoomBroadcaster(deps.redis),
      deduplicator: new RedisEventDeduplicator(deps.redis),
    }),
    vendorSlaSchedulerConsumer({ timers: deps.vendorAcceptanceTimers }),
    // Last on order.lifecycle and never throwing: a push can not hold back the two above.
    orderPushNotificationConsumer({
      recipients: deps.pushRecipients,
      tokens: deps.pushRecipients,
      push: deps.push,
      deduplicator: new RedisEventDeduplicator(deps.redis, ORDER_PUSH_DEDUPE_PREFIX),
      smsFallbackLog: deps.pushSmsFallbackLog,
      mockPushLog: deps.pushMockLog ?? null,
    }),
    // 1 attempt + 3 retries, then a dead_letter_events row + notifications.dlq, and the partition
    // moves on (Phases 14 and 15).
    withDeadLetter(
      vendorNotificationConsumer({
        sms: deps.sms,
        smsDeduplicator: new RedisEventDeduplicator(deps.redis, VENDOR_SMS_DEDUPE_PREFIX),
        ivr: deps.ivr,
        ivrDeduplicator: new RedisEventDeduplicator(deps.redis, VENDOR_IVR_DEDUPE_PREFIX),
        orders: deps.orders,
      }),
      {
        name: 'vendor-notifications',
        deadLetterTopic: KAFKA_TOPICS.NOTIFICATIONS_DLQ,
        publisher: deps.deadLetters,
        store: deps.deadLetterStore,
      },
    ),
    // Phase 36. After the consumer above on the same topic, with its own retries and dead
    // letters: a notice that cannot be delivered never holds back a debt or escalation SMS.
    withDeadLetter(
      vendorNoticeConsumer({
        notifications: deps.notifications,
        contacts: deps.vendorContacts,
        deduplicator: new RedisEventDeduplicator(deps.redis, VENDOR_NOTICE_DEDUPE_PREFIX),
      }),
      {
        name: 'vendor-notices',
        deadLetterTopic: KAFKA_TOPICS.NOTIFICATIONS_DLQ,
        publisher: deps.deadLetters,
        store: deps.deadLetterStore,
      },
    ),
    // Step 7.4. Last on the topic, with its own retries and dead letters.
    ...(deps.notifyMe === undefined
      ? []
      : [
          withDeadLetter(notifyMeConsumer({ notifyMe: deps.notifyMe }), {
            name: 'notify-me',
            deadLetterTopic: KAFKA_TOPICS.NOTIFICATIONS_DLQ,
            publisher: deps.deadLetters,
            store: deps.deadLetterStore,
          }),
        ]),
    // Step 7.3. Its own retries and dead letters too.
    ...(deps.disputeNotices === undefined
      ? []
      : [
          withDeadLetter(disputeNoticeConsumer({ notices: deps.disputeNotices }), {
            name: 'dispute-notices',
            deadLetterTopic: KAFKA_TOPICS.NOTIFICATIONS_DLQ,
            publisher: deps.deadLetters,
            store: deps.deadLetterStore,
          }),
        ]),
  ];
}

export type KafkaMessageHandler = (payload: KafkaJS.EachMessagePayload) => Promise<void>;

/**
 * One handler per subscribed topic, running that topic's consumers in registration order. If
 * one throws, the message fails and Kafka redelivers it to all of them, so each consumer must be
 * idempotent (the fan-out dedupes on event_id; timers are keyed by order id).
 */
export function routeByTopic(
  consumers: readonly KafkaConsumerDefinition[],
): Map<string, KafkaMessageHandler> {
  const byTopic = new Map<string, KafkaConsumerDefinition['handle'][]>();
  for (const consumer of consumers) {
    byTopic.set(consumer.topic, [...(byTopic.get(consumer.topic) ?? []), consumer.handle]);
  }
  return new Map(
    [...byTopic].map(([topic, handlers]) => [
      topic,
      async (payload: KafkaJS.EachMessagePayload) => {
        for (const handle of handlers) await handle(payload);
      },
    ]),
  );
}
