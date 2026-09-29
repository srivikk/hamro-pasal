import { randomUUID } from 'node:crypto';
import { parseKafkaEnv, type DomainEvent } from '@hamro-pasal/shared-types';

import { createKafka, type KafkaEnv } from '../src/config';
import { createIdempotentProducer, DomainEventPublisher } from '../src/producer';

/** Round-trips a typed event through the local broker (pnpm infra:up) with the idempotent producer. */
describe('DomainEventPublisher against Kafka', () => {
  const env: KafkaEnv = parseKafkaEnv(process.env);

  it('publishes an event that a consumer group reads back intact', async () => {
    const kafka = createKafka(env);
    const producer = createIdempotentProducer(kafka);
    const consumer = kafka.consumer({
      kafkaJS: { groupId: `publisher-int-${randomUUID()}`, fromBeginning: false },
    });
    const event: DomainEvent = {
      event_id: randomUUID(),
      event_type: 'order.placed',
      event_version: 1,
      occurred_at: new Date().toISOString(),
      aggregate_id: randomUUID(),
      payload: {
        order_id: randomUUID(),
        reservation_id: randomUUID(),
        vendor_id: randomUUID(),
        customer_id: randomUUID(),
        payment_method: 'COD',
        fulfillment_locked: 'SELF_DELIVERY',
        subtotal: 1000,
        delivery_fee: 50,
        items: [{ product_id: randomUUID(), quantity: 2 }],
      },
    };

    await Promise.all([producer.connect(), consumer.connect()]);
    try {
      await consumer.subscribe({ topics: ['order.lifecycle'] });
      const received = new Promise<{ key: string; body: unknown; eventType: string }>((resolve) => {
        void consumer.run({
          eachMessage: ({ message }) => {
            const body: unknown = JSON.parse(message.value?.toString() ?? 'null');
            if (message.key?.toString() === event.aggregate_id) {
              resolve({
                key: message.key.toString(),
                body,
                eventType: message.headers?.event_type?.toString() ?? '',
              });
            }
            return Promise.resolve();
          },
        });
      });
      // Wait for partition assignment before producing, since the group starts at latest offsets.
      await waitFor(() => consumer.assignment().length > 0, 30_000);

      await new DomainEventPublisher(producer).publish([event]);

      const message = await received;
      expect(message).toEqual({ key: event.aggregate_id, body: event, eventType: 'order.placed' });
    } finally {
      await Promise.all([producer.disconnect(), consumer.disconnect()]);
    }
  }, 60_000);
});

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
