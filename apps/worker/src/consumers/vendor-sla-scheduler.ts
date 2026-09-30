import { KAFKA_TOPICS, type VendorAcceptanceTimeoutJob } from '@hamro-pasal/shared-types';
import type { Queue } from 'bullmq';

import { scheduleVendorAcceptanceTimeout, vendorAcceptanceDelayMs } from '../queues/definitions';
import { parseDomainEventMessage } from './order-state-fanout';
import type { KafkaConsumerDefinition } from './types';

/** Schedules the 90 s acceptance timer of one order (a BullMQ delayed job keyed by order id). */
export interface VendorAcceptanceTimerScheduler {
  schedule(job: VendorAcceptanceTimeoutJob, placedAt: Date): Promise<void>;
}

/** The BullMQ implementation: the job fires at placed_at + 90 s (at once if that has passed). */
export class BullVendorAcceptanceTimers implements VendorAcceptanceTimerScheduler {
  constructor(
    private readonly queue: Queue<VendorAcceptanceTimeoutJob>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  schedule(job: VendorAcceptanceTimeoutJob, placedAt: Date): Promise<void> {
    return scheduleVendorAcceptanceTimeout(
      this.queue,
      job,
      vendorAcceptanceDelayMs(placedAt, this.now()),
    );
  }
}

export interface VendorSlaSchedulerDeps {
  readonly timers: VendorAcceptanceTimerScheduler;
  readonly onInvalidMessage?: (reason: string) => void;
}

/**
 * Kafka `order.lifecycle` → BullMQ `vendor-acceptance-timeout` (vendor flow step 6, SPEC
 * infrastructure §1): every order that becomes PLACED gets its 90 s timer. Driven by the outbox
 * event rather than by the API after its commit, so a crash between the commit and the scheduling
 * cannot lose the timer: Kafka redelivers until the job exists. Scheduling is idempotent (the job
 * id is the order id), so a redelivered event schedules nothing new.
 */
export function vendorSlaSchedulerConsumer(deps: VendorSlaSchedulerDeps): KafkaConsumerDefinition {
  const onInvalid =
    deps.onInvalidMessage ??
    ((reason: string) => {
      console.error(`[worker] vendor-sla-scheduler skipped a message: ${reason}`);
    });

  return {
    topic: KAFKA_TOPICS.ORDER_LIFECYCLE,
    handle: async ({ message, partition }) => {
      const event = parseDomainEventMessage(message.value);
      if (event === null) {
        onInvalid(`invalid envelope at partition ${String(partition)} offset ${message.offset}`);
        return;
      }
      if (event.event_type !== 'order.state_changed') return;
      const { payload } = event;
      if (payload.to_state !== 'PLACED' || payload.from_state === 'PLACED') return;
      if (payload.placed_at === null) {
        onInvalid(`order ${payload.order_id} became PLACED without placed_at`);
        return;
      }
      await deps.timers.schedule(
        { order_id: payload.order_id, vendor_id: payload.vendor_id },
        new Date(payload.placed_at),
      );
    },
  };
}
