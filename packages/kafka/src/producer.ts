import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { DOMAIN_EVENT_TOPICS, type DomainEvent, type KafkaTopic } from '@hamro-pasal/shared-types';

/**
 * librdkafka producer settings for domain events:
 * - enable.idempotence: the broker de-duplicates producer retries, so a retried send is written
 *   exactly once per partition and in order (implies acks=all and bounded in-flight requests).
 * - acks=all is stated explicitly so the durability guarantee is visible, not implied.
 */
export const IDEMPOTENT_PRODUCER_CONFIG = {
  'enable.idempotence': true,
  acks: -1,
} as const satisfies KafkaJS.ProducerConstructorConfig;

export function createIdempotentProducer(kafka: KafkaJS.Kafka): KafkaJS.Producer {
  return kafka.producer({ ...IDEMPOTENT_PRODUCER_CONFIG });
}

/**
 * Serialises a domain event as a Kafka message. Keyed by aggregate id, so every event of one
 * order/transaction lands on the same partition in order. Headers let consumers route without
 * parsing the body.
 */
export function toKafkaMessage(event: DomainEvent): KafkaJS.Message {
  return {
    key: event.aggregate_id,
    value: JSON.stringify(event),
    headers: {
      event_id: event.event_id,
      event_type: event.event_type,
      event_version: String(event.event_version),
    },
  };
}

/** Groups events by their topic, preserving order within each topic. */
export function toTopicMessages(events: readonly DomainEvent[]): KafkaJS.TopicMessages[] {
  const byTopic = new Map<KafkaTopic, KafkaJS.Message[]>();
  for (const event of events) {
    const topic = DOMAIN_EVENT_TOPICS[event.event_type];
    const messages = byTopic.get(topic) ?? [];
    messages.push(toKafkaMessage(event));
    byTopic.set(topic, messages);
  }
  return [...byTopic].map(([topic, messages]) => ({ topic, messages }));
}

/** Publishes typed domain events through an idempotent producer. Resolves once all are acked. */
export class DomainEventPublisher {
  constructor(private readonly producer: Pick<KafkaJS.Producer, 'sendBatch'>) {}

  async publish(events: readonly DomainEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.producer.sendBatch({ topicMessages: toTopicMessages(events) });
  }
}
