import type { KafkaJS } from '@hamro-pasal/kafka';
import type { Redis } from 'ioredis';

import {
  orderStateFanoutConsumer,
  RedisEventDeduplicator,
  RedisOrderRoomBroadcaster,
} from './order-state-fanout';
import type { KafkaConsumerDefinition } from './types';
import {
  vendorSlaSchedulerConsumer,
  type VendorAcceptanceTimerScheduler,
} from './vendor-sla-scheduler';

export interface ConsumerDeps {
  /** Publishes Socket.io broadcasts and holds fan-out de-duplication keys. */
  readonly redis: Redis;
  /** Schedules the 90 s vendor acceptance timers (BullMQ). */
  readonly vendorAcceptanceTimers: VendorAcceptanceTimerScheduler;
}

/** Register Kafka topic handlers here. Several may share a topic (see routeByTopic). */
export function buildConsumers(deps: ConsumerDeps): readonly KafkaConsumerDefinition[] {
  return [
    orderStateFanoutConsumer({
      broadcaster: new RedisOrderRoomBroadcaster(deps.redis),
      deduplicator: new RedisEventDeduplicator(deps.redis),
    }),
    vendorSlaSchedulerConsumer({ timers: deps.vendorAcceptanceTimers }),
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
