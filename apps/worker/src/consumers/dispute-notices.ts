import { KAFKA_TOPICS } from '@hamro-pasal/shared-types';

import type { DisputeNoticeService } from '../notifications/dispute-notices';
import { parseDomainEventMessage } from './order-state-fanout';
import type { KafkaConsumerDefinition } from './types';

/**
 * Kafka `notifications.broadcast` -> the parties of an order conversation (step 7.3):
 *   dispute.escalated -> the other party
 *   dispute.resolved  -> both parties
 * Idempotent through the notification centre dedupe key (one message per event and person).
 */
export function disputeNoticeConsumer(deps: {
  readonly notices: Pick<DisputeNoticeService, 'escalated' | 'resolved'>;
}): KafkaConsumerDefinition {
  return {
    topic: KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
    handle: async ({ message }) => {
      const event = parseDomainEventMessage(message.value);
      if (event?.event_type === 'dispute.escalated') await deps.notices.escalated(event);
      else if (event?.event_type === 'dispute.resolved') await deps.notices.resolved(event);
    },
  };
}
