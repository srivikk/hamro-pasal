import { prepareTestDatabase } from '@hamro-pasal/db/testing';
import { useTestKafkaBroker } from '@hamro-pasal/kafka/testing';
import { Redis } from 'ioredis';

/** Runs before Jest creates the per-file sandboxes, so the env set here reaches every test. */
export default async function globalSetup(): Promise<void> {
  process.env.TEST_DATABASE_URL = await prepareTestDatabase('api_test');
  // The kafka-test broker (the e2e test runs worker scripts), never the dev one.
  useTestKafkaBroker();

  const redisUrl = new URL(
    process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://localhost:6379',
  );
  redisUrl.pathname = '/15';
  process.env.TEST_REDIS_URL = redisUrl.toString();

  const redis = new Redis(process.env.TEST_REDIS_URL);
  await redis.flushdb();
  await redis.quit();
}
