import { prepareTestDatabase } from '@hamro-pasal/db/testing';
import { useTestKafkaBroker } from '@hamro-pasal/kafka/testing';
import { Redis } from 'ioredis';

/** Runs before Jest creates the per-file sandboxes, so the env set here reaches every test. */
export default async function globalSetup(): Promise<void> {
  process.env.TEST_DATABASE_URL = await prepareTestDatabase('worker_test');
  // After the root .env is loaded (by prepareTestDatabase): the kafka-test broker, so the dev
  // worker never consumes the suites' messages (poison pills included) and never competes with
  // their consumers.
  useTestKafkaBroker();

  const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  redisUrl.pathname = '/14';
  process.env.TEST_REDIS_URL = redisUrl.toString();

  const redis = new Redis(process.env.TEST_REDIS_URL);
  await redis.flushdb();
  await redis.quit();
}
