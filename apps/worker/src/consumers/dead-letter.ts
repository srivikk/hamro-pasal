import type { KafkaJS } from '@hamro-pasal/kafka';

import type { KafkaConsumerDefinition } from './types';

/**
 * Thrown by a consumer for a message that can never be processed (an unparseable envelope).
 * `withDeadLetter` sends it to the dead-letter topic at once, without retrying.
 */
export class PoisonMessageError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'PoisonMessageError';
  }
}

/** Retries after the first failed attempt before a message is dead-lettered. */
export const DEAD_LETTER_MAX_RETRIES = 3;

/** Backoff before retry n (1-based): 1 s, 2 s, 4 s. The partition waits meanwhile (~7 s). */
export function defaultRetryDelayMs(retry: number): number {
  return 1_000 * 2 ** (retry - 1);
}

/** Headers added to a dead-lettered copy (the original headers are kept alongside). */
export const DEAD_LETTER_HEADERS = {
  sourceTopic: 'dlq_source_topic',
  sourcePartition: 'dlq_source_partition',
  sourceOffset: 'dlq_source_offset',
  consumer: 'dlq_consumer',
  attempts: 'dlq_attempts',
  errorName: 'dlq_error_name',
  errorMessage: 'dlq_error_message',
  failedAt: 'dlq_failed_at',
} as const;

/** Longest error message kept in a header. */
const MAX_ERROR_HEADER_LENGTH = 1_000;

/** Publishes a dead letter; resolves only once the broker acknowledged it. */
export interface DeadLetterPublisher {
  publish(record: KafkaJS.ProducerRecord): Promise<void>;
}

/** Sends through the worker's idempotent (acks=all) producer. */
export class KafkaDeadLetterPublisher implements DeadLetterPublisher {
  constructor(private readonly producer: Pick<KafkaJS.Producer, 'send'>) {}

  async publish(record: KafkaJS.ProducerRecord): Promise<void> {
    await this.producer.send(record);
  }
}

export interface DeadLetterRecord {
  readonly consumer: string;
  readonly sourceTopic: string;
  readonly partition: number;
  readonly offset: string;
  readonly attempts: number;
  readonly error: Error;
}

export interface DeadLetterOptions {
  /** Names the consumer in the `dlq_consumer` header and in logs. */
  readonly name: string;
  readonly deadLetterTopic: string;
  readonly publisher: DeadLetterPublisher;
  readonly maxRetries?: number;
  readonly retryDelayMs?: (retry: number) => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  /** Called after a message was dead-lettered (default: one JSON error line). */
  readonly onDeadLettered?: (record: DeadLetterRecord) => void;
}

/** The dead-letter copy of a message: key and value byte for byte, original + `dlq_*` headers. */
export function deadLetterRecord(
  deadLetterTopic: string,
  payload: KafkaJS.EachMessagePayload,
  details: { consumer: string; attempts: number; error: Error; failedAt: Date },
): KafkaJS.ProducerRecord {
  const { message } = payload;
  return {
    topic: deadLetterTopic,
    messages: [
      {
        key: message.key,
        value: message.value,
        headers: {
          ...message.headers,
          [DEAD_LETTER_HEADERS.sourceTopic]: payload.topic,
          [DEAD_LETTER_HEADERS.sourcePartition]: String(payload.partition),
          [DEAD_LETTER_HEADERS.sourceOffset]: message.offset,
          [DEAD_LETTER_HEADERS.consumer]: details.consumer,
          [DEAD_LETTER_HEADERS.attempts]: String(details.attempts),
          [DEAD_LETTER_HEADERS.errorName]: details.error.name,
          [DEAD_LETTER_HEADERS.errorMessage]: details.error.message.slice(
            0,
            MAX_ERROR_HEADER_LENGTH,
          ),
          [DEAD_LETTER_HEADERS.failedAt]: details.failedAt.toISOString(),
        },
      },
    ],
  };
}

/**
 * Keeps a failing message from blocking its partition (Phase 14). The wrapped handler is tried
 * once and then retried up to `maxRetries` times with backoff; a PoisonMessageError is not
 * retried. When the attempts run out, the message is copied to `deadLetterTopic` and the handler
 * returns normally, so its offset is committed and the partition moves on.
 *
 * If publishing the dead letter fails, the error propagates: the offset is not committed and
 * Kafka redelivers the message, so nothing is dropped without a copy in the DLQ.
 */
export function withDeadLetter(
  consumer: KafkaConsumerDefinition,
  options: DeadLetterOptions,
): KafkaConsumerDefinition {
  const maxRetries = options.maxRetries ?? DEAD_LETTER_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());
  const onDeadLettered =
    options.onDeadLettered ??
    ((record: DeadLetterRecord) => {
      console.error(
        JSON.stringify({
          notification: 'dead_lettered',
          consumer: record.consumer,
          source_topic: record.sourceTopic,
          partition: record.partition,
          offset: record.offset,
          attempts: record.attempts,
          error: record.error.message,
        }),
      );
    });

  return {
    topic: consumer.topic,
    handle: async (payload) => {
      for (let attempt = 1; ; attempt += 1) {
        let failure: Error;
        try {
          await consumer.handle(payload);
          return;
        } catch (error: unknown) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
        // Attempt n failed; the next one is retry n.
        if (!(failure instanceof PoisonMessageError) && attempt <= maxRetries) {
          await sleep(retryDelayMs(attempt));
          continue;
        }
        await options.publisher.publish(
          deadLetterRecord(options.deadLetterTopic, payload, {
            consumer: options.name,
            attempts: attempt,
            error: failure,
            failedAt: now(),
          }),
        );
        onDeadLettered({
          consumer: options.name,
          sourceTopic: payload.topic,
          partition: payload.partition,
          offset: payload.message.offset,
          attempts: attempt,
          error: failure,
        });
        return;
      }
    },
  };
}
