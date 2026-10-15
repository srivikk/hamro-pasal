import { KAFKA_TOPICS } from '@hamro-pasal/shared-types';

import type { NotifyMeService } from '../notifications/notify-me';
import { parseDomainEventMessage } from './order-state-fanout';
import type { KafkaConsumerDefinition } from './types';

export interface NotifyMeConsumerDeps {
  readonly notifyMe: Pick<NotifyMeService, 'productBackInStock' | 'shopOpened'>;
}

/**
 * Kafka `notifications.broadcast` → Notify Me (step 7.4, SPEC core 11):
 *   product.back_in_stock → everyone waiting for the product
 *   vendor.opened         → everyone waiting for the shop, if it takes orders now
 *
 * Idempotent without a claim: the requests are deleted in the transaction that writes their
 * notice, so a redelivered event finds nobody left to tell. An unparseable envelope is left to
 * the vendor-notifications consumer of the same topic, which dead-letters it.
 */
export function notifyMeConsumer(deps: NotifyMeConsumerDeps): KafkaConsumerDefinition {
  return {
    topic: KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
    handle: async ({ message }) => {
      const event = parseDomainEventMessage(message.value);
      if (event === null) return;
      if (event.event_type === 'product.back_in_stock') {
        const { notified } = await deps.notifyMe.productBackInStock(event.payload.product_id);
        log(event.event_type, event.event_id, notified);
      } else if (event.event_type === 'vendor.opened') {
        const { notified } = await deps.notifyMe.shopOpened(event.payload.vendor_id);
        log(event.event_type, event.event_id, notified);
      }
    },
  };
}

function log(eventType: string, eventId: string, notified: number): void {
  if (notified === 0) return;
  console.info(
    JSON.stringify({
      notification: 'notify_me.sent',
      event_type: eventType,
      event_id: eventId,
      notified,
    }),
  );
}
