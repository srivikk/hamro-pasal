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
import type {
  DebtSuspension,
  VendorDebtReconciliationService,
} from '../wallet/vendor-debt-reconciliation';

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
 * SPEC infrastructure §5: every vendor auto-suspension gets a structured audit record (one JSON
 * line, picked up by the log shipper).
 */
export function auditDebtSuspension(suspension: DebtSuspension): void {
  console.warn(
    JSON.stringify({
      audit: 'vendor.suspended_for_debt',
      vendor_id: suspension.vendorId,
      previous_status: suspension.previousStatus,
      wallet_balance_npr: suspension.walletBalanceNpr,
      suspension_limit_npr: suspension.suspensionLimitNpr,
      suspended_at: suspension.suspendedAt.toISOString(),
    }),
  );
}

/**
 * The handlers the worker runs. The 90 s vendor acceptance timeout is live (Phase 10): it writes
 * `vendor.escalation.required` for an order still PLACED. The midnight VENDOR_DEBT_RECONCILIATION
 * is live (Phase 12). The ghost-customer timer and the subscription downgrade are placeholders.
 */
export function createTimerHandlers(deps: {
  readonly escalation: Pick<VendorEscalationService, 'escalateIfUnanswered'>;
  readonly debtReconciliation: Pick<VendorDebtReconciliationService, 'suspendIndebtedVendors'>;
}): TimerHandlers {
  return {
    ...pendingImplementationHandlers,
    runMidnightTask: async (task) => {
      switch (task) {
        case 'VENDOR_DEBT_RECONCILIATION': {
          const suspensions = await deps.debtReconciliation.suspendIndebtedVendors();
          suspensions.forEach(auditDebtSuspension);
          console.info(
            `[worker] debt reconciliation: ${String(suspensions.length)} vendor(s) suspended`,
          );
          return;
        }
        case 'SUBSCRIPTION_DOWNGRADE':
          return pendingImplementationHandlers.runMidnightTask(task);
      }
    },
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
