import type { KafkaJS } from '@hamro-pasal/kafka';

export interface KafkaConsumerDefinition {
  readonly topic: string;
  readonly handle: (payload: KafkaJS.EachMessagePayload) => Promise<void>;
}
