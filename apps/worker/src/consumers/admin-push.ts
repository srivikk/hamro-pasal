import { KAFKA_TOPICS } from '@hamro-pasal/shared-types';

import type { AdminPushService } from '../notifications/admin-push';
import { parseDomainEventMessage } from './order-state-fanout';
import type { KafkaConsumerDefinition } from './types';

/**
 * Kafka `notifications.broadcast` -> `notification.broadcast_requested` (step 7.5): pushes a
 * message the Super Admin sent. At most once per message (the service claims it).
 */
export function adminPushConsumer(deps: {
  readonly adminPush: Pick<AdminPushService, 'deliver'>;
}): KafkaConsumerDefinition {
  return {
    topic: KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
    handle: async ({ message }) => {
      const event = parseDomainEventMessage(message.value);
      if (event?.event_type !== 'notification.broadcast_requested') return;
      const outcome = await deps.adminPush.deliver(event.payload.message_id);
      if (outcome.status === 'PUSHED') {
        console.info(
          JSON.stringify({
            notification: 'admin_push.sent',
            message_id: event.payload.message_id,
            sent: outcome.sent,
            failed: outcome.failed,
          }),
        );
      }
    },
  };
}
