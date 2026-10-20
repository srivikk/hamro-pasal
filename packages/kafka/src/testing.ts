/*
 * Integration-test helpers, exported as `@hamro-pasal/kafka/testing`. Not for production code.
 *
 * The integration suites publish to the real topics, poison pills included. On the dev broker a
 * running dev worker consumed them too: it dead-lettered the test messages into the dev database
 * (they showed in the Admin dashboard) and competed with the tests' own consumers, which made the
 * dead-letter tests flaky. The suites therefore use their own broker (`kafka-test` in
 * docker-compose.yml), the way they use their own database and Redis DB.
 */

/** `kafka-test` in docker-compose.yml (KAFKA_TEST_PORT). */
export const DEFAULT_TEST_KAFKA_BROKERS = '127.0.0.1:9094';

function brokerList(value: string): string[] {
  return value
    .split(',')
    .map((broker) => broker.trim().toLowerCase().replace('localhost:', '127.0.0.1:'))
    .filter((broker) => broker !== '');
}

/**
 * The test broker list: `TEST_KAFKA_BROKERS`, else the `kafka-test` default. Refuses a list that
 * shares a broker with the dev `KAFKA_BROKERS`, so a test run can never reach the dev worker.
 */
export function resolveTestKafkaBrokers(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.TEST_KAFKA_BROKERS?.trim();
  const brokers = explicit !== undefined && explicit !== '' ? explicit : DEFAULT_TEST_KAFKA_BROKERS;
  const dev = new Set(brokerList(env.KAFKA_BROKERS ?? ''));
  const shared = brokerList(brokers).filter((broker) => dev.has(broker));
  if (brokerList(brokers).length === 0) {
    throw new Error('TEST_KAFKA_BROKERS lists no broker');
  }
  if (shared.length > 0) {
    throw new Error(
      `Refusing to run integration tests on the dev Kafka broker (${shared.join(', ')}): ` +
        'set TEST_KAFKA_BROKERS to the kafka-test broker (pnpm infra:up starts it on 127.0.0.1:9094)',
    );
  }
  return brokers;
}

/**
 * Points this process (and the Jest sandboxes created after it) at the test broker. Call it in a
 * Jest globalSetup after the root .env is loaded; `process.loadEnvFile` never overwrites it later.
 */
export function useTestKafkaBroker(env: NodeJS.ProcessEnv = process.env): string {
  const brokers = resolveTestKafkaBrokers(env);
  env.TEST_KAFKA_BROKERS = brokers;
  env.KAFKA_BROKERS = brokers;
  return brokers;
}
