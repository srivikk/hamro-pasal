import type { KafkaJS } from '@hamro-pasal/kafka';

import {
  DEAD_LETTER_MAX_RETRIES,
  defaultRetryDelayMs,
  headerText,
  ownHeaders,
  PoisonMessageError,
  withDeadLetter,
  type DeadLetterEntry,
  type DeadLetterPublisher,
  type DeadLetterRecord,
  type DeadLetterStore,
} from './dead-letter';
import type { KafkaConsumerDefinition } from './types';

const FAILED_AT = new Date('2026-09-30T10:00:00.000Z');

function payload(headers: KafkaJS.IHeaders = {}): KafkaJS.EachMessagePayload {
  return {
    topic: 'notifications.broadcast',
    partition: 1,
    message: {
      key: Buffer.from('order-1'),
      value: Buffer.from('{"event_id":"e1"}'),
      offset: '42',
      timestamp: String(Date.now()),
      attributes: 0,
      headers: { event_id: 'e1', event_type: 'vendor.escalation.required', ...headers },
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

/** Records the order in which the row and the Kafka copy were written. */
const writes: string[] = [];

function setup(
  consumer: KafkaConsumerDefinition,
  publisher?: DeadLetterPublisher,
  store?: DeadLetterStore,
) {
  writes.length = 0;
  const published: KafkaJS.ProducerRecord[] = [];
  const stored: DeadLetterEntry[] = [];
  const delays: number[] = [];
  const deadLettered: DeadLetterRecord[] = [];
  const wrapped = withDeadLetter(consumer, {
    name: 'vendor-notifications',
    deadLetterTopic: 'notifications.dlq',
    publisher: publisher ?? {
      publish: (record) => {
        writes.push('kafka');
        published.push(record);
        return Promise.resolve();
      },
    },
    store: store ?? {
      save: (entry) => {
        writes.push('row');
        stored.push(entry);
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
  return { wrapped, published, stored, delays, deadLettered };
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

  it('stores the dead letter (Phase 15) before publishing the Kafka copy', async () => {
    const source = failing(Infinity);
    const { wrapped, stored } = setup(source.consumer);

    await wrapped.handle(payload());

    expect(writes).toEqual(['row', 'kafka']);
    expect(stored).toEqual([
      {
        consumer: 'vendor-notifications',
        deadLetterTopic: 'notifications.dlq',
        sourceTopic: 'notifications.broadcast',
        partition: 1,
        offset: '42',
        key: Buffer.from('order-1'),
        value: Buffer.from('{"event_id":"e1"}'),
        headers: { event_id: 'e1', event_type: 'vendor.escalation.required' },
        eventId: 'e1',
        eventType: 'vendor.escalation.required',
        replayOfId: null,
        attempts: 4,
        errorName: 'Error',
        errorMessage: 'Sparrow HTTP 503',
        failedAt: FAILED_AT,
      },
    ]);
  });

  it('propagates a failed row insert without publishing, so Kafka redelivers', async () => {
    const source = failing(Infinity);
    const { wrapped, published, deadLettered } = setup(source.consumer, undefined, {
      save: () => Promise.reject(new Error('database down')),
    });

    await expect(wrapped.handle(payload())).rejects.toThrow('database down');
    expect(published).toEqual([]);
    expect(deadLettered).toEqual([]);
  });

  it('links a failed retry to the dead letter it replayed and keeps dlq_* headers out of the row', async () => {
    const source = failing(Infinity);
    const replayOf = 'b1f6f6c2-4a8e-4f0e-9a51-3c1d2e3f4a5b';
    const { wrapped, stored, published } = setup(source.consumer);

    await wrapped.handle(payload({ dlq_replay_of: Buffer.from(replayOf), trace: 't-1' }));

    expect(stored[0]?.replayOfId).toBe(replayOf);
    expect(stored[0]?.headers).toEqual({
      event_id: 'e1',
      event_type: 'vendor.escalation.required',
      trace: 't-1',
    });
    // The Kafka copy still carries the link, next to the fresh dlq_* headers.
    expect(published[0]?.messages[0]?.headers?.dlq_replay_of).toEqual(Buffer.from(replayOf));
  });

  it('ignores a dlq_replay_of header that is not a uuid', async () => {
    const source = failing(Infinity);
    const { wrapped, stored } = setup(source.consumer);

    await wrapped.handle(payload({ dlq_replay_of: 'not-a-uuid' }));

    expect(stored[0]?.replayOfId).toBeNull();
  });

  it('keeps the row error message up to 2000 characters', async () => {
    const source = failing(Infinity, () => new PoisonMessageError('x'.repeat(5_000)));
    const { wrapped, stored } = setup(source.consumer);

    await wrapped.handle(payload());

    expect(stored[0]?.errorMessage).toHaveLength(2_000);
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

  it('decodes headers as strings, the last value of a repeated header winning', () => {
    expect(headerText(Buffer.from('a'))).toBe('a');
    expect(headerText(['a', Buffer.from('b')])).toBe('b');
    expect(headerText([])).toBeUndefined();
    expect(headerText(undefined)).toBeUndefined();
    expect(ownHeaders({ event_id: Buffer.from('e'), dlq_attempts: '4', gone: undefined })).toEqual({
      event_id: 'e',
    });
    expect(ownHeaders(undefined)).toEqual({});
  });

  it('backs off exponentially by default', () => {
    expect([1, 2, 3].map(defaultRetryDelayMs)).toEqual([1_000, 2_000, 4_000]);
  });
});
