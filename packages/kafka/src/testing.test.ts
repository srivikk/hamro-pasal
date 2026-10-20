import { DEFAULT_TEST_KAFKA_BROKERS, resolveTestKafkaBrokers, useTestKafkaBroker } from './testing';

describe('the integration-test Kafka broker', () => {
  it('defaults to kafka-test, apart from the dev broker', () => {
    expect(resolveTestKafkaBrokers({ KAFKA_BROKERS: '127.0.0.1:9092' })).toBe(
      DEFAULT_TEST_KAFKA_BROKERS,
    );
  });

  it('takes TEST_KAFKA_BROKERS', () => {
    expect(
      resolveTestKafkaBrokers({ KAFKA_BROKERS: '127.0.0.1:9092', TEST_KAFKA_BROKERS: 'ci:9092' }),
    ).toBe('ci:9092');
  });

  it.each([
    ['the same address', '127.0.0.1:9092'],
    ['localhost for 127.0.0.1', 'localhost:9092'],
    ['one broker of a list', '127.0.0.1:9094, 127.0.0.1:9092'],
  ])('refuses the dev broker (%s)', (_label, test) => {
    expect(() =>
      resolveTestKafkaBrokers({ KAFKA_BROKERS: '127.0.0.1:9092', TEST_KAFKA_BROKERS: test }),
    ).toThrow('Refusing to run integration tests on the dev Kafka broker (127.0.0.1:9092)');
  });

  it('refuses an empty list', () => {
    expect(() => resolveTestKafkaBrokers({ TEST_KAFKA_BROKERS: ' , ' })).toThrow(
      'TEST_KAFKA_BROKERS lists no broker',
    );
  });

  it('points KAFKA_BROKERS at the test broker for every client built afterwards', () => {
    const env: NodeJS.ProcessEnv = { KAFKA_BROKERS: '127.0.0.1:9092' };
    expect(useTestKafkaBroker(env)).toBe('127.0.0.1:9094');
    expect(env).toMatchObject({
      KAFKA_BROKERS: '127.0.0.1:9094',
      TEST_KAFKA_BROKERS: '127.0.0.1:9094',
    });
  });
});
