import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { ServerEnv } from '@hamro-pasal/shared-types';

export type KafkaEnv = Pick<
  ServerEnv,
  | 'KAFKA_BROKERS'
  | 'KAFKA_CLIENT_ID'
  | 'KAFKA_SSL'
  | 'KAFKA_SASL_MECHANISM'
  | 'KAFKA_SASL_USERNAME'
  | 'KAFKA_SASL_PASSWORD'
>;

/** Client config in the KafkaJS-compatible shape accepted by `new KafkaJS.Kafka(...)`. */
export function buildKafkaConfig(env: KafkaEnv): KafkaJS.CommonConstructorConfig {
  const kafkaJS: KafkaJS.KafkaConfig = {
    clientId: env.KAFKA_CLIENT_ID,
    brokers: env.KAFKA_BROKERS,
    ssl: env.KAFKA_SSL,
    logLevel: KafkaJS.logLevel.WARN,
  };

  if (env.KAFKA_SASL_MECHANISM !== undefined) {
    if (env.KAFKA_SASL_USERNAME === undefined || env.KAFKA_SASL_PASSWORD === undefined) {
      throw new Error('KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD are required for SASL');
    }
    kafkaJS.sasl = {
      mechanism: env.KAFKA_SASL_MECHANISM,
      username: env.KAFKA_SASL_USERNAME,
      password: env.KAFKA_SASL_PASSWORD,
    };
  }

  return { kafkaJS };
}

export function createKafka(env: KafkaEnv): KafkaJS.Kafka {
  return new KafkaJS.Kafka(buildKafkaConfig(env));
}
