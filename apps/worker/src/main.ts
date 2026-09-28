import { Queue, Worker } from 'bullmq';

import { loadEnv } from './config/env';
import { consumers } from './consumers';
import { createKafka } from './infra/kafka';
import { buildBullConnection } from './infra/redis';
import { scheduledJobs } from './jobs';
import { Lifecycle } from './lifecycle';

async function main(): Promise<void> {
  const env = loadEnv();
  const lifecycle = new Lifecycle();
  const connection = buildBullConnection(env.REDIS_URL);

  for (const job of scheduledJobs) {
    const queue = new Queue(job.name, { connection });
    await queue.upsertJobScheduler(job.name, { pattern: job.cron, tz: job.timezone });
    const worker = new Worker(job.name, job.process, { connection });
    lifecycle.register(() => queue.close());
    lifecycle.register(() => worker.close());
  }

  if (consumers.length > 0) {
    const handlers = new Map(consumers.map((c) => [c.topic, c.handle]));
    const consumer = createKafka(env).consumer({ groupId: env.KAFKA_CONSUMER_GROUP_ID });
    await consumer.connect();
    lifecycle.register(() => consumer.disconnect());
    await consumer.subscribe({ topics: [...handlers.keys()], fromBeginning: false });
    await consumer.run({
      eachMessage: async (payload) => {
        const handle = handlers.get(payload.topic);
        if (handle === undefined) {
          throw new Error(`No handler registered for topic "${payload.topic}"`);
        }
        await handle(payload);
      },
    });
  }

  console.info(
    `[worker] started: ${String(scheduledJobs.length)} scheduled job(s), ${String(consumers.length)} Kafka consumer(s)`,
  );

  const shutdown = (signal: NodeJS.Signals): void => {
    console.info(`[worker] ${signal} received, shutting down`);
    lifecycle.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
