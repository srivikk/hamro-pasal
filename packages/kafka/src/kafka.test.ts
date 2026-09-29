import { randomUUID } from 'node:crypto';

import type { DomainEvent } from '@hamro-pasal/shared-types';

import { buildKafkaConfig, type KafkaEnv } from './config';
import {
  DomainEventPublisher,
  IDEMPOTENT_PRODUCER_CONFIG,
  toKafkaMessage,
  toTopicMessages,
} from './producer';

const env: KafkaEnv = {
  KAFKA_BROKERS: ['localhost:9092'],
  KAFKA_CLIENT_ID: 'hamro-pasal',
  KAFKA_SSL: false,
  KAFKA_SASL_MECHANISM: undefined,
  KAFKA_SASL_USERNAME: undefined,
  KAFKA_SASL_PASSWORD: undefined,
};

function lockedEvent(aggregateId = randomUUID()): DomainEvent {
  return {
    event_id: randomUUID(),
    event_type: 'order.locked',
    event_version: 1,
    occurred_at: '2026-09-29T10:00:00.000Z',
    aggregate_id: aggregateId,
    payload: {
      reservation_id: aggregateId,
      vendor_id: randomUUID(),
      customer_id: randomUUID(),
      items: [{ product_id: randomUUID(), quantity: 1 }],
      locked_at: '2026-09-29T10:00:00.000Z',
      expires_at: '2026-09-29T10:10:00.000Z',
    },
  };
}

function ledgerEvent(): DomainEvent {
  return {
    event_id: randomUUID(),
    event_type: 'ledger.mutated',
    event_version: 1,
    occurred_at: '2026-09-29T10:00:00.000Z',
    aggregate_id: randomUUID(),
    payload: { transaction_id: randomUUID(), kind: 'ADJUSTMENT', order_id: null, entries: [] },
  };
}

describe('buildKafkaConfig', () => {
  it('maps env to the KafkaJS-compatible block without SASL by default', () => {
    const config = buildKafkaConfig(env);

    expect(config.kafkaJS).toMatchObject({
      clientId: 'hamro-pasal',
      brokers: ['localhost:9092'],
      ssl: false,
    });
    expect(config.kafkaJS).not.toHaveProperty('sasl');
  });

  it('includes SASL credentials when a mechanism is configured', () => {
    const config = buildKafkaConfig({
      ...env,
      KAFKA_SSL: true,
      KAFKA_SASL_MECHANISM: 'scram-sha-512',
      KAFKA_SASL_USERNAME: 'user',
      KAFKA_SASL_PASSWORD: 'pass',
    });

    expect(config.kafkaJS?.ssl).toBe(true);
    expect(config.kafkaJS?.sasl).toEqual({
      mechanism: 'scram-sha-512',
      username: 'user',
      password: 'pass',
    });
  });

  it('rejects a SASL mechanism without credentials', () => {
    expect(() => buildKafkaConfig({ ...env, KAFKA_SASL_MECHANISM: 'plain' })).toThrow(
      'KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD are required',
    );
  });
});

describe('domain event messages', () => {
  it('enables broker-side idempotence with acks=all', () => {
    expect(IDEMPOTENT_PRODUCER_CONFIG).toEqual({ 'enable.idempotence': true, acks: -1 });
  });

  it('keys messages by aggregate id and carries routing headers', () => {
    const event = lockedEvent();

    const message = toKafkaMessage(event);

    expect(message.key).toBe(event.aggregate_id);
    expect(JSON.parse(String(message.value))).toEqual(event);
    expect(message.headers).toEqual({
      event_id: event.event_id,
      event_type: 'order.locked',
      event_version: '1',
    });
  });

  it('groups events by topic while preserving per-topic order', () => {
    const first = lockedEvent();
    const ledger = ledgerEvent();
    const second = lockedEvent();

    const batches = toTopicMessages([first, ledger, second]);

    expect(batches.map((b) => b.topic)).toEqual(['order.lifecycle', 'ledger.mutations']);
    expect(batches[0]?.messages.map((m) => m.key)).toEqual([
      first.aggregate_id,
      second.aggregate_id,
    ]);
  });

  it('publishes through sendBatch and skips empty batches', async () => {
    const sendBatch = jest.fn().mockResolvedValue([]);
    const publisher = new DomainEventPublisher({ sendBatch });

    await publisher.publish([]);
    await publisher.publish([lockedEvent()]);

    expect(sendBatch).toHaveBeenCalledTimes(1);
  });
});
