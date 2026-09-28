import type { EachMessagePayload } from 'kafkajs';

export interface KafkaConsumerDefinition {
  readonly topic: string;
  readonly handle: (payload: EachMessagePayload) => Promise<void>;
}
