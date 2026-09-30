import {
  ghostCustomerTimerJobSchema,
  midnightMaintenanceJobSchema,
  vendorAcceptanceTimeoutJobSchema,
  type GhostCustomerTimerJob,
  type MidnightTask,
  type VendorAcceptanceTimeoutJob,
} from '@hamro-pasal/shared-types';
import type { Job } from 'bullmq';

import type { VendorEscalationService } from '../sla/vendor-escalation';

/**
 * What each timer does when it fires. The business actions (IVR/SMS escalation, ghost-customer
 * push/IVR, subscription downgrades) belong to later phases and are injected here, so the
 * queue plumbing is testable on its own.
 */
export interface TimerHandlers {
  onVendorAcceptanceTimeout(job: VendorAcceptanceTimeoutJob): Promise<void>;
  onGhostCustomerTimerElapsed(job: GhostCustomerTimerJob): Promise<void>;
  runMidnightTask(task: MidnightTask): Promise<void>;
}

/** Payloads are validated at the boundary: a malformed job fails loudly (and is retained). */
export function createProcessors(handlers: TimerHandlers) {
  return {
    vendorAcceptance: async (job: Job): Promise<void> => {
      await handlers.onVendorAcceptanceTimeout(vendorAcceptanceTimeoutJobSchema.parse(job.data));
    },
    ghostCustomer: async (job: Job): Promise<void> => {
      await handlers.onGhostCustomerTimerElapsed(ghostCustomerTimerJobSchema.parse(job.data));
    },
    midnight: async (job: Job): Promise<void> => {
      await handlers.runMidnightTask(midnightMaintenanceJobSchema.parse(job.data).task);
    },
  };
}

/**
 * The handlers the worker runs. The 90 s vendor acceptance timeout is live (Phase 10): it writes
 * `vendor.escalation.required` for an order still PLACED. The ghost-customer and midnight handlers
 * are still placeholders.
 */
export function createTimerHandlers(deps: {
  readonly escalation: Pick<VendorEscalationService, 'escalateIfUnanswered'>;
}): TimerHandlers {
  return {
    ...pendingImplementationHandlers,
    onVendorAcceptanceTimeout: async (job) => {
      const outcome = await deps.escalation.escalateIfUnanswered(job);
      if (outcome === 'ESCALATED') {
        console.warn(
          `[worker] order ${job.order_id} unanswered for 90 s: IVR/SMS escalation requested`,
        );
      }
    },
  };
}

/** Placeholder handlers until the escalation / downgrade phases land. They log and succeed. */
export const pendingImplementationHandlers: TimerHandlers = {
  onVendorAcceptanceTimeout: (job) => {
    console.warn('[worker] vendor acceptance timeout fired (escalation not implemented yet)', job);
    return Promise.resolve();
  },
  onGhostCustomerTimerElapsed: (job) => {
    console.warn('[worker] ghost customer timer elapsed (IVR/push not implemented yet)', job);
    return Promise.resolve();
  },
  runMidnightTask: (task) => {
    console.warn(`[worker] midnight task ${task} fired (not implemented yet)`);
    return Promise.resolve();
  },
};
