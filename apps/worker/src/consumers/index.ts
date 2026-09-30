import type { IvrGateway } from '@hamro-pasal/ivr';
import type { KafkaJS } from '@hamro-pasal/kafka';
import { KAFKA_TOPICS } from '@hamro-pasal/shared-types';
import type { SmsGateway } from '@hamro-pasal/sms';
import type { Redis } from 'ioredis';

import type { OrderStateReader } from '../notifications/order-state-reader';
import { withDeadLetter, type DeadLetterPublisher } from './dead-letter';
import {
  orderStateFanoutConsumer,
  RedisEventDeduplicator,
  RedisOrderRoomBroadcaster,
} from './order-state-fanout';
import type { KafkaConsumerDefinition } from './types';
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
}

/** Register Kafka topic handlers here. Several may share a topic (see routeByTopic). */
export function buildConsumers(deps: ConsumerDeps): readonly KafkaConsumerDefinition[] {
  return [
    orderStateFanoutConsumer({
      broadcaster: new RedisOrderRoomBroadcaster(deps.redis),
      deduplicator: new RedisEventDeduplicator(deps.redis),
    }),
    vendorSlaSchedulerConsumer({ timers: deps.vendorAcceptanceTimers }),
    // 1 attempt + 3 retries, then notifications.dlq and the partition moves on (Phase 14).
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
      },
    ),
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
