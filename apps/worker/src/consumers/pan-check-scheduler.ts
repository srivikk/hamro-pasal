import { KAFKA_TOPICS } from '@hamro-pasal/shared-types';

import type { IrdCheckScheduler } from '../kyc/ird-queue';
import { parseDomainEventMessage } from './order-state-fanout';
import type { KafkaConsumerDefinition } from './types';

/**
 * Kafka `notifications.broadcast` -> `vendor.pan_check_requested` (2026-10-21): puts the IRD check
 * on the `ird-pan-verification` queue. The event travels the vendor onboarding flow's topic (the one
 * `vendor.signed_up` uses); it is written when the application becomes checkable, a PAN and its
 * document on file. Idempotent: the job id is the check and its request time.
 */
export function panCheckSchedulerConsumer(deps: {
  readonly scheduler: IrdCheckScheduler;
}): KafkaConsumerDefinition {
  return {
    topic: KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
    handle: async ({ message }) => {
      const event = parseDomainEventMessage(message.value);
      if (event?.event_type !== 'vendor.pan_check_requested') return;
      await deps.scheduler.schedule(event.payload.check_id, event.payload.requested_at);
    },
  };
}
