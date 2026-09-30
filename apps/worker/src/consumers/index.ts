import type { Redis } from 'ioredis';

import {
  orderStateFanoutConsumer,
  RedisEventDeduplicator,
  RedisOrderRoomBroadcaster,
} from './order-state-fanout';
import type { KafkaConsumerDefinition } from './types';

export interface ConsumerDeps {
  /** Publishes Socket.io broadcasts and holds fan-out de-duplication keys. */
  readonly redis: Redis;
}

/** Register Kafka topic handlers here (at most one per topic). */
export function buildConsumers(deps: ConsumerDeps): readonly KafkaConsumerDefinition[] {
  return [
    orderStateFanoutConsumer({
      broadcaster: new RedisOrderRoomBroadcaster(deps.redis),
      deduplicator: new RedisEventDeduplicator(deps.redis),
    }),
  ];
}
