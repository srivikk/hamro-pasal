import { createDatabase } from '@hamro-pasal/db';
import { createIdempotentProducer, createKafka, DomainEventPublisher } from '@hamro-pasal/kafka';
import { Worker } from 'bullmq';

import { loadEnv } from './config/env';
import { consumers } from './consumers';
import { buildBullConnection } from './infra/redis';
import { Lifecycle } from './lifecycle';
import { OutboxRelay } from './outbox/outbox-relay';
import { allTimerQueues, createTimerQueues, registerMidnightJobs } from './queues/definitions';
import { createProcessors, pendingImplementationHandlers } from './queues/processors';

async function main(): Promise<void> {
  const env = loadEnv();
  const lifecycle = new Lifecycle();

  // PostgreSQL (outbox) -> Kafka (idempotent producer)
  const db = createDatabase(env.DATABASE_URL);
  lifecycle.register(() => db.$client.end());
  const kafka = createKafka(env);
  const producer = createIdempotentProducer(kafka);
  await producer.connect();
  lifecycle.register(() => producer.disconnect());
  const relay = new OutboxRelay(db, new DomainEventPublisher(producer));
  relay.start();
  lifecycle.register(() => relay.stop());

  // BullMQ timers and crons
  const connection = buildBullConnection(env.REDIS_URL);
  const queues = createTimerQueues(connection);
  await registerMidnightJobs(queues.midnight);
  const processors = createProcessors(pendingImplementationHandlers);
  const workers = [
    new Worker(queues.vendorAcceptance.name, processors.vendorAcceptance, { connection }),
    new Worker(queues.ghostCustomer.name, processors.ghostCustomer, { connection }),
    new Worker(queues.midnight.name, processors.midnight, { connection }),
  ];
  for (const worker of workers) {
    worker.on('failed', (job, error) => {
      console.error(`[worker] ${worker.name} job ${job?.id ?? '?'} failed`, error);
    });
    lifecycle.register(() => worker.close());
  }
  for (const queue of allTimerQueues(queues)) {
    lifecycle.register(() => queue.close());
  }

  // Kafka consumers
  if (consumers.length > 0) {
    const handlers = new Map(consumers.map((c) => [c.topic, c.handle]));
    const consumer = kafka.consumer({ kafkaJS: { groupId: env.KAFKA_CONSUMER_GROUP_ID } });
    await consumer.connect();
    lifecycle.register(() => consumer.disconnect());
    await consumer.subscribe({ topics: [...handlers.keys()] });
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
    `[worker] started: outbox relay, ${String(workers.length)} BullMQ workers, ${String(consumers.length)} Kafka consumer(s)`,
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
