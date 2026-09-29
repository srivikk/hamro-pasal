import { randomUUID } from 'node:crypto';

import {
  DOMAIN_EVENT_TOPICS,
  domainEventSchema,
  type DomainEvent,
  type DomainEventPayload,
  type DomainEventType,
} from '@hamro-pasal/shared-types';

import type { Executor } from './client';
import { outboxEvents } from './schema';

export interface NewDomainEvent<T extends DomainEventType> {
  readonly type: T;
  readonly aggregateId: string;
  readonly payload: DomainEventPayload<T>;
  readonly occurredAt?: Date;
}

/**
 * Records a domain event in the transactional outbox. Call it with the same transaction as the
 * state change the event describes, so the event exists if and only if the change commits.
 * The envelope is validated against the shared Zod contract before it is stored.
 */
export async function enqueueDomainEvent<T extends DomainEventType>(
  executor: Executor,
  event: NewDomainEvent<T>,
): Promise<DomainEvent> {
  const occurredAt = event.occurredAt ?? new Date();
  const envelope = domainEventSchema.parse({
    event_id: randomUUID(),
    event_type: event.type,
    event_version: 1,
    occurred_at: occurredAt.toISOString(),
    aggregate_id: event.aggregateId,
    payload: event.payload,
  });

  await executor.insert(outboxEvents).values({
    id: envelope.event_id,
    event_type: envelope.event_type,
    topic: DOMAIN_EVENT_TOPICS[envelope.event_type],
    aggregate_id: envelope.aggregate_id,
    payload: envelope.payload,
    occurred_at: occurredAt,
  });
  return envelope;
}

/** Rebuilds (and re-validates) the envelope of a stored outbox row for publishing. */
export function outboxRowToDomainEvent(row: typeof outboxEvents.$inferSelect): DomainEvent {
  return domainEventSchema.parse({
    event_id: row.id,
    event_type: row.event_type,
    event_version: 1,
    occurred_at: row.occurred_at.toISOString(),
    aggregate_id: row.aggregate_id,
    payload: row.payload,
  });
}
