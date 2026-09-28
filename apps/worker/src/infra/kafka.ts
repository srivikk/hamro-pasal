import type { ServerEnv } from '@hamro-pasal/shared-types';
import { Kafka, type KafkaConfig, type SASLOptions } from 'kafkajs';

type KafkaEnv = Pick<
  ServerEnv,
  | 'KAFKA_BROKERS'
  | 'KAFKA_CLIENT_ID'
  | 'KAFKA_SSL'
  | 'KAFKA_SASL_MECHANISM'
  | 'KAFKA_SASL_USERNAME'
  | 'KAFKA_SASL_PASSWORD'
>;

export function buildKafkaConfig(env: KafkaEnv): KafkaConfig {
  const config: KafkaConfig = {
    clientId: env.KAFKA_CLIENT_ID,
    brokers: env.KAFKA_BROKERS,
    ssl: env.KAFKA_SSL,
  };

  if (env.KAFKA_SASL_MECHANISM !== undefined) {
    if (env.KAFKA_SASL_USERNAME === undefined || env.KAFKA_SASL_PASSWORD === undefined) {
      throw new Error('KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD are required for SASL');
    }
    const sasl: SASLOptions = {
      mechanism: env.KAFKA_SASL_MECHANISM,
      username: env.KAFKA_SASL_USERNAME,
      password: env.KAFKA_SASL_PASSWORD,
    };
    config.sasl = sasl;
  }

  return config;
}

export function createKafka(env: KafkaEnv): Kafka {
  return new Kafka(buildKafkaConfig(env));
}
