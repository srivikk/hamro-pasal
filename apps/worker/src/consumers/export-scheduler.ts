import { KAFKA_TOPICS } from '@hamro-pasal/shared-types';

import { parseDomainEventMessage } from './order-state-fanout';
import type { KafkaConsumerDefinition } from './types';

export interface DataExportScheduler {
  schedule(jobId: string): Promise<void>;
}

/**
 * Kafka `notifications.broadcast` -> `export.requested` (step 7.6): puts the queued export on the
 * DATA_EXPORT queue. Idempotent: the BullMQ job id is the export's own.
 */
export function exportSchedulerConsumer(deps: {
  readonly scheduler: DataExportScheduler;
}): KafkaConsumerDefinition {
  return {
    topic: KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
    handle: async ({ message }) => {
      const event = parseDomainEventMessage(message.value);
      if (event?.event_type !== 'export.requested') return;
      await deps.scheduler.schedule(event.payload.job_id);
    },
  };
}
