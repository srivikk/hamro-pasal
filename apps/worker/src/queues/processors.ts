import type { BillingCycleRenewalService } from '../billing/billing-cycle-renewal';
import type { ComplianceSweepService } from '../compliance/compliance-sweep';
import type { SettlementPayoutRunService } from '../finance/settlement-payout-run';
import type { MarketingStatusSweepService } from '../marketing/marketing-status-sweep';
import {
  ghostCustomerTimerJobSchema,
  midnightMaintenanceJobSchema,
  vendorAcceptanceTimeoutJobSchema,
  type GhostCustomerTimerJob,
  type MidnightTask,
  type VendorAcceptanceTimeoutJob,
} from '@hamro-pasal/shared-types';
import type { Job } from 'bullmq';

import type {
  OrderReconciliationService,
  ReconciliationDiscrepancy,
} from '../finance/order-reconciliation';
import type { VendorAcceptanceExpiryService } from '../sla/vendor-acceptance-expiry';
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
  /** Step 7.3: the 5-minute expiry (the job's kind is EXPIRE). */
  onVendorAcceptanceExpiry(job: VendorAcceptanceTimeoutJob): Promise<void>;
  onGhostCustomerTimerElapsed(job: GhostCustomerTimerJob): Promise<void>;
  runMidnightTask(task: MidnightTask): Promise<void>;
  /** Phase 28: the hourly upkeep of ad purchases. */
  runMarketingStatusSweep(): Promise<void>;
  /** Phase 29: the Tuesday 02:00 payout run. */
  runSettlementPayoutRun(): Promise<void>;
}

/** Payloads are validated at the boundary: a malformed job fails loudly (and is retained). */
export function createProcessors(handlers: TimerHandlers) {
  return {
    vendorAcceptance: async (job: Job): Promise<void> => {
      const data = vendorAcceptanceTimeoutJobSchema.parse(job.data);
      await (data.kind === 'EXPIRE'
        ? handlers.onVendorAcceptanceExpiry(data)
        : handlers.onVendorAcceptanceTimeout(data));
    },
    ghostCustomer: async (job: Job): Promise<void> => {
      await handlers.onGhostCustomerTimerElapsed(ghostCustomerTimerJobSchema.parse(job.data));
    },
    midnight: async (job: Job): Promise<void> => {
      const { task } = midnightMaintenanceJobSchema.parse(job.data);
      if (task === 'MARKETING_STATUS_SWEEP') return handlers.runMarketingStatusSweep();
      if (task === 'SETTLEMENT_PAYOUT_RUN') return handlers.runSettlementPayoutRun();
      return handlers.runMidnightTask(task);
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

/** A DELIVERED order the nightly reconciliation could not verify: one JSON line for the log shipper. */
export function auditReconciliationDiscrepancy(discrepancy: ReconciliationDiscrepancy): void {
  console.warn(
    JSON.stringify({
      audit: 'order.reconciliation_discrepancy',
      order_id: discrepancy.orderId,
      vendor_id: discrepancy.vendorId,
      reason: discrepancy.reason,
      expected_vendor_wallet_npr: discrepancy.expectedVendorWalletNpr,
      actual_vendor_wallet_npr: discrepancy.actualVendorWalletNpr,
      message: discrepancy.message,
    }),
  );
}

/**
 * One ORDER_RECONCILIATION run (the midnight job, or `reconcile:orders` by hand). Discrepancies are
 * audited and left for the next run; they do not fail the job, or BullMQ would retry them at once.
 */
export async function runOrderReconciliation(
  reconciliation: Pick<OrderReconciliationService, 'reconcileDeliveredOrders'>,
): Promise<void> {
  const run = await reconciliation.reconcileDeliveredOrders();
  run.discrepancies.forEach(auditReconciliationDiscrepancy);
  const posted = run.reconciled.filter((order) => order.settlementPosted).length;
  console.info(
    `[worker] order reconciliation: ${String(run.reconciled.length)} order(s) reconciled (${String(posted)} settlement(s) posted), ${String(run.discrepancies.length)} discrepancy(ies)`,
  );
}

/**
 * The handlers the worker runs. The 90 s vendor acceptance timeout is live (Phase 10): it writes
 * `vendor.escalation.required` for an order still PLACED. The midnight VENDOR_DEBT_RECONCILIATION
 * is live (Phase 12), and so is ORDER_RECONCILIATION (Phase 22). The ghost-customer timer and the subscription downgrade are placeholders.
 */
export function createTimerHandlers(deps: {
  readonly escalation: Pick<VendorEscalationService, 'escalateIfUnanswered'>;
  readonly debtReconciliation: Pick<VendorDebtReconciliationService, 'suspendIndebtedVendors'>;
  readonly orderReconciliation: Pick<OrderReconciliationService, 'reconcileDeliveredOrders'>;
  /** Phase 25. Optional so a worker built without them logs the task instead of failing it. */
  readonly complianceSweep?: Pick<ComplianceSweepService, 'suspendVendorsWithoutPan'>;
  readonly billingRenewal?: Pick<BillingCycleRenewalService, 'renewDueCycles'>;
  /** Phase 28. Optional like the two above. */
  readonly marketingSweep?: Pick<MarketingStatusSweepService, 'run'>;
  /** Phase 29. Optional like those above. */
  readonly settlementPayoutRun?: Pick<SettlementPayoutRunService, 'run'>;
  /** Step 7.3. Optional like those above. */
  readonly acceptanceExpiry?: Pick<VendorAcceptanceExpiryService, 'cancelIfUnanswered'>;
}): TimerHandlers {
  return {
    ...pendingImplementationHandlers,
    runSettlementPayoutRun: async () => {
      if (deps.settlementPayoutRun === undefined) {
        return pendingImplementationHandlers.runSettlementPayoutRun();
      }
      const summary = await deps.settlementPayoutRun.run();
      const total = summary.paid.reduce(
        (sum, payout) => sum + Math.round(payout.amountNpr * 100),
        0,
      );
      console.info(
        `[worker] settlement payout run (cut-off ${summary.cutoff.toISOString()}): ${String(summary.paid.length)} vendor(s) paid Rs. ${String(total / 100)}; skipped ${JSON.stringify(summary.skipped)}`,
      );
    },
    runMarketingStatusSweep: async () => {
      if (deps.marketingSweep === undefined) {
        return pendingImplementationHandlers.runMarketingStatusSweep();
      }
      const summary = await deps.marketingSweep.run();
      console.info(
        `[worker] marketing sweep: ${String(summary.ended)} ad(s) ended, ${String(summary.paused)} paused, Rs. ${String(summary.budgetReleasedNpr)} of budget released`,
      );
    },
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
        case 'ORDER_RECONCILIATION':
          return runOrderReconciliation(deps.orderReconciliation);
        case 'VENDOR_COMPLIANCE_SWEEP': {
          if (deps.complianceSweep === undefined) {
            return pendingImplementationHandlers.runMidnightTask(task);
          }
          const suspended = await deps.complianceSweep.suspendVendorsWithoutPan();
          console.info(
            `[worker] compliance sweep: ${String(suspended.length)} vendor(s) without a PAN suspended`,
          );
          return;
        }
        case 'BILLING_CYCLE_RENEWAL': {
          if (deps.billingRenewal === undefined) {
            return pendingImplementationHandlers.runMidnightTask(task);
          }
          const summary = await deps.billingRenewal.renewDueCycles();
          console.info(
            `[worker] billing cycles: ${String(summary.started)} started, ${String(summary.renewed)} renewed, ${String(summary.applied)} queued change(s) applied`,
          );
          return;
        }
        case 'SUBSCRIPTION_DOWNGRADE':
          return pendingImplementationHandlers.runMidnightTask(task);
      }
    },
    onVendorAcceptanceExpiry: async (job) => {
      if (deps.acceptanceExpiry === undefined) {
        return pendingImplementationHandlers.onVendorAcceptanceExpiry(job);
      }
      const outcome = await deps.acceptanceExpiry.cancelIfUnanswered(job);
      if (outcome.kind === 'CANCELLED') {
        console.warn(
          `[worker] order ${job.order_id} unanswered for 5 minutes: cancelled${outcome.paused ? ', shop auto-paused' : ''}`,
        );
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
  runSettlementPayoutRun: () => {
    console.warn('[worker] settlement payout run fired (not wired in this worker)');
    return Promise.resolve();
  },
  runMarketingStatusSweep: () => {
    console.warn('[worker] marketing status sweep fired (not wired in this worker)');
    return Promise.resolve();
  },
  onVendorAcceptanceTimeout: (job) => {
    console.warn('[worker] vendor acceptance timeout fired (escalation not implemented yet)', job);
    return Promise.resolve();
  },
  onVendorAcceptanceExpiry: (job) => {
    console.warn(
      '[worker] vendor acceptance expiry fired (auto-cancel not wired in this worker)',
      job,
    );
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
