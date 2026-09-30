import type { KafkaJS } from '@hamro-pasal/kafka';

import {
  DEAD_LETTER_MAX_RETRIES,
  defaultRetryDelayMs,
  PoisonMessageError,
  withDeadLetter,
  type DeadLetterPublisher,
  type DeadLetterRecord,
} from './dead-letter';
import type { KafkaConsumerDefinition } from './types';

const FAILED_AT = new Date('2026-09-30T10:00:00.000Z');

function payload(): KafkaJS.EachMessagePayload {
  return {
    topic: 'notifications.broadcast',
    partition: 1,
    message: {
      key: Buffer.from('order-1'),
      value: Buffer.from('{"event_id":"e1"}'),
      offset: '42',
      timestamp: String(Date.now()),
      attributes: 0,
      headers: { event_id: 'e1', event_type: 'vendor.escalation.required' },
    },
    heartbeat: () => Promise.resolve(),
    pause: () => () => undefined,
  };
}

/** A consumer that throws `failures` times (the given error), then succeeds. */
function failing(failures: number, error: () => Error = () => new Error('Sparrow HTTP 503')) {
  let calls = 0;
  const consumer: KafkaConsumerDefinition = {
    topic: 'notifications.broadcast',
    handle: () => {
      calls += 1;
      return calls <= failures ? Promise.reject(error()) : Promise.resolve();
    },
  };
  return { consumer, calls: () => calls };
}

function setup(consumer: KafkaConsumerDefinition, publisher?: DeadLetterPublisher) {
  const published: KafkaJS.ProducerRecord[] = [];
  const delays: number[] = [];
  const deadLettered: DeadLetterRecord[] = [];
  const wrapped = withDeadLetter(consumer, {
    name: 'vendor-notifications',
    deadLetterTopic: 'notifications.dlq',
    publisher: publisher ?? {
      publish: (record) => {
        published.push(record);
        return Promise.resolve();
      },
    },
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
    now: () => FAILED_AT,
    onDeadLettered: (record) => deadLettered.push(record),
  });
  return { wrapped, published, delays, deadLettered };
}

describe('withDeadLetter', () => {
  it('keeps the topic and passes a success straight through', async () => {
    const source = failing(0);
    const { wrapped, published, delays } = setup(source.consumer);

    await wrapped.handle(payload());

    expect(wrapped.topic).toBe('notifications.broadcast');
    expect(source.calls()).toBe(1);
    expect(published).toEqual([]);
    expect(delays).toEqual([]);
  });

  it('retries 3 times with 1 s / 2 s / 4 s backoff and does not dead-letter a late success', async () => {
    const source = failing(3);
    const { wrapped, published, delays } = setup(source.consumer);

    await wrapped.handle(payload());

    expect(source.calls()).toBe(4);
    expect(delays).toEqual([1_000, 2_000, 4_000]);
    expect(published).toEqual([]);
  });

  it('dead-letters after the 3rd retry fails and returns normally (offset committed)', async () => {
    const source = failing(Infinity);
    const { wrapped, published, deadLettered } = setup(source.consumer);

    await expect(wrapped.handle(payload())).resolves.toBeUndefined();

    expect(DEAD_LETTER_MAX_RETRIES).toBe(3);
    expect(source.calls()).toBe(4);
    expect(published).toEqual([
      {
        topic: 'notifications.dlq',
        messages: [
          {
            key: Buffer.from('order-1'),
            value: Buffer.from('{"event_id":"e1"}'),
            headers: {
              event_id: 'e1',
              event_type: 'vendor.escalation.required',
              dlq_source_topic: 'notifications.broadcast',
              dlq_source_partition: '1',
              dlq_source_offset: '42',
              dlq_consumer: 'vendor-notifications',
              dlq_attempts: '4',
              dlq_error_name: 'Error',
              dlq_error_message: 'Sparrow HTTP 503',
              dlq_failed_at: '2026-09-30T10:00:00.000Z',
            },
          },
        ],
      },
    ]);
    expect(deadLettered).toMatchObject([
      { consumer: 'vendor-notifications', partition: 1, offset: '42', attempts: 4 },
    ]);
  });

  it('dead-letters a poison message at once, without retries', async () => {
    const source = failing(Infinity, () => new PoisonMessageError('invalid envelope'));
    const { wrapped, published, delays } = setup(source.consumer);

    await wrapped.handle(payload());

    expect(source.calls()).toBe(1);
    expect(delays).toEqual([]);
    expect(published[0]?.messages[0]?.headers).toMatchObject({
      dlq_attempts: '1',
      dlq_error_name: 'PoisonMessageError',
      dlq_error_message: 'invalid envelope',
    });
  });

  it('propagates a failed dead-letter publish, so Kafka redelivers instead of dropping', async () => {
    const source = failing(Infinity);
    const { wrapped, deadLettered } = setup(source.consumer, {
      publish: () => Promise.reject(new Error('broker down')),
    });

    await expect(wrapped.handle(payload())).rejects.toThrow('broker down');
    expect(deadLettered).toEqual([]);
  });

  it('truncates a long error message in the header', async () => {
    const source = failing(Infinity, () => new PoisonMessageError('x'.repeat(5_000)));
    const { wrapped, published } = setup(source.consumer);

    await wrapped.handle(payload());

    const header = published[0]?.messages[0]?.headers?.dlq_error_message;
    expect(typeof header === 'string' ? header.length : 0).toBe(1_000);
  });

  it('backs off exponentially by default', () => {
    expect([1, 2, 3].map(defaultRetryDelayMs)).toEqual([1_000, 2_000, 4_000]);
  });
});
