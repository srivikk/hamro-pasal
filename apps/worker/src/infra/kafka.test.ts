import { buildKafkaConfig } from './kafka';

const base = {
  KAFKA_BROKERS: ['localhost:9092'],
  KAFKA_CLIENT_ID: 'hamro-pasal',
  KAFKA_SSL: false,
  KAFKA_SASL_MECHANISM: undefined,
  KAFKA_SASL_USERNAME: undefined,
  KAFKA_SASL_PASSWORD: undefined,
};

describe('buildKafkaConfig', () => {
  it('omits SASL when no mechanism is configured', () => {
    const config = buildKafkaConfig(base);

    expect(config).toEqual({ clientId: 'hamro-pasal', brokers: ['localhost:9092'], ssl: false });
    expect(config).not.toHaveProperty('sasl');
  });

  it('includes SASL credentials when a mechanism is configured', () => {
    const config = buildKafkaConfig({
      ...base,
      KAFKA_SSL: true,
      KAFKA_SASL_MECHANISM: 'scram-sha-512',
      KAFKA_SASL_USERNAME: 'user',
      KAFKA_SASL_PASSWORD: 'pass',
    });

    expect(config.ssl).toBe(true);
    expect(config.sasl).toEqual({ mechanism: 'scram-sha-512', username: 'user', password: 'pass' });
  });

  it('rejects a SASL mechanism without credentials', () => {
    expect(() => buildKafkaConfig({ ...base, KAFKA_SASL_MECHANISM: 'plain' })).toThrow(
      'KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD are required',
    );
  });
});
