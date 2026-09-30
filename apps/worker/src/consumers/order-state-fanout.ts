import {
  domainEventSchema,
  KAFKA_TOPICS,
  ORDER_SOCKET_EVENTS,
  ORDERS_NAMESPACE,
  orderStateUpdateFromEvent,
  orderStateUpdateRooms,
  SOCKET_IO_REDIS_KEY,
  type DomainEvent,
  type OrderStateUpdate,
} from '@hamro-pasal/shared-types';
import { Emitter } from '@socket.io/redis-emitter';
import type { Redis } from 'ioredis';

import type { KafkaConsumerDefinition } from './types';

/** Events the worker may emit into the `/orders` namespace. */
interface OrdersEmitEvents {
  'order:state_update': (update: OrderStateUpdate) => void;
}

/**
 * Delivers one order update to every socket in the given rooms (the order's own room and its
 * vendor's room), on any API instance. A socket in several of them receives it once.
 */
export interface OrderRoomBroadcaster {
  broadcast(update: OrderStateUpdate, rooms: readonly string[]): Promise<void>;
}

/** The one Redis command the broadcaster needs (an ioredis client satisfies it). */
export interface RedisPublisher {
  publish(channel: string, message: string | Buffer): Promise<unknown>;
}

/**
 * Publishes into the API's Socket.io rooms through Redis (`@socket.io/redis-emitter`). The API's
 * `@socket.io/redis-adapter` subscribes to the same channels (same `key`) and forwards each
 * message to the sockets in `order:{id}` / `vendor:{id}` it holds locally.
 *
 * The emitter fires `publish` without waiting for it; the wrapper below keeps those promises so a
 * Redis failure fails the Kafka message (and it is retried) instead of being lost silently.
 */
export class RedisOrderRoomBroadcaster implements OrderRoomBroadcaster {
  constructor(
    private readonly redis: RedisPublisher,
    private readonly key: string = SOCKET_IO_REDIS_KEY,
  ) {}

  async broadcast(update: OrderStateUpdate, rooms: readonly string[]): Promise<void> {
    const pending: Promise<unknown>[] = [];
    const client = {
      publish: (channel: string, message: string | Buffer): void => {
        pending.push(this.redis.publish(channel, message));
      },
    };
    new Emitter<OrdersEmitEvents>(client, { key: this.key })
      .of(ORDERS_NAMESPACE)
      .to([...rooms])
      .emit(ORDER_SOCKET_EVENTS.stateUpdate, update);
    await Promise.all(pending);
  }
}

/** Remembers which events were already fanned out (Kafka delivery is at-least-once). */
export interface EventDeduplicator {
  /** true the first time an event id is claimed, false for a redelivery. */
  claim(eventId: string): Promise<boolean>;
  /** Forgets a claim whose processing failed, so the retry is not skipped. */
  release(eventId: string): Promise<void>;
}

/** One day: far longer than any redelivery window (offsets are committed within seconds). */
export const FANOUT_DEDUPE_TTL_SECONDS = 86_400;

export class RedisEventDeduplicator implements EventDeduplicator {
  constructor(
    private readonly redis: Pick<Redis, 'set' | 'del'>,
    private readonly prefix = 'fanout:orders:seen:',
    private readonly ttlSeconds = FANOUT_DEDUPE_TTL_SECONDS,
  ) {}

  async claim(eventId: string): Promise<boolean> {
    const result = await this.redis.set(
      `${this.prefix}${eventId}`,
      '1',
      'EX',
      this.ttlSeconds,
      'NX',
    );
    return result === 'OK';
  }

  async release(eventId: string): Promise<void> {
    await this.redis.del(`${this.prefix}${eventId}`);
  }
}

export interface OrderStateFanoutDeps {
  readonly broadcaster: OrderRoomBroadcaster;
  readonly deduplicator: EventDeduplicator;
  readonly onInvalidMessage?: (reason: string) => void;
}

/** Parses a Kafka message body into a domain event; null for anything else. */
export function parseDomainEventMessage(value: Buffer | null): DomainEvent | null {
  if (value === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(value.toString('utf8'));
  } catch {
    return null;
  }
  const parsed = domainEventSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * Kafka `order.lifecycle` → Socket.io `/orders`: every `order.state_changed` event is broadcast as
 * `order:state_update` to the `order:{order_id}` room and, once the order was placed, to the
 * `vendor:{vendor_id}` room (the vendor dashboard, Phase 10). Other lifecycle events are ignored,
 * and a redelivered event (same event_id) is broadcast only once.
 */
export function orderStateFanoutConsumer(deps: OrderStateFanoutDeps): KafkaConsumerDefinition {
  const onInvalid =
    deps.onInvalidMessage ??
    ((reason: string) => {
      console.error(`[worker] order-state-fanout skipped a message: ${reason}`);
    });

  return {
    topic: KAFKA_TOPICS.ORDER_LIFECYCLE,
    handle: async ({ message, partition }) => {
      const event = parseDomainEventMessage(message.value);
      if (event === null) {
        // A poison message would block the partition forever if it were retried.
        onInvalid(`invalid envelope at partition ${String(partition)} offset ${message.offset}`);
        return;
      }
      if (event.event_type !== 'order.state_changed') return;
      if (!(await deps.deduplicator.claim(event.event_id))) return;
      try {
        await deps.broadcaster.broadcast(
          orderStateUpdateFromEvent(event),
          orderStateUpdateRooms(event),
        );
      } catch (error: unknown) {
        await deps.deduplicator.release(event.event_id).catch(() => undefined);
        throw error;
      }
    },
  };
}
