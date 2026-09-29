import type { OrderState } from '@hamro-pasal/shared-types';

/**
 * SPEC customer flow step 9: discrete state nodes instead of live map polling.
 * Order Placed → Preparing → Out for Delivery → Arrived → Delivered.
 */
export const TRACKER_STEPS = [
  'PLACED',
  'PREPARING',
  'OUT_FOR_DELIVERY',
  'ARRIVED',
  'DELIVERED',
] as const;
export type TrackerStep = (typeof TRACKER_STEPS)[number];

export type StepStatus = 'completed' | 'active' | 'pending';

export interface TrackerNode {
  step: TrackerStep;
  status: StepStatus;
}

/**
 * How far along the order is, as an index into TRACKER_STEPS. There is no ARRIVED order state
 * (the rider's "Reached Location" is not recorded yet), so ARRIVED is reached together with
 * DELIVERED. Null for states the tracker does not show (checkout, cancelled, failed).
 */
function progressIndex(state: OrderState): number | null {
  switch (state) {
    case 'PLACED':
      return 0;
    case 'PREPARING':
      return 1;
    case 'OUT_FOR_DELIVERY':
      return 2;
    case 'DELIVERED':
    case 'DISPUTED':
      // Past the last step: every node is completed.
      return TRACKER_STEPS.length;
    case 'PENDING_PAYMENT':
    case 'CANCELED':
    case 'FAILED':
      return null;
  }
}

/** Nodes before the current one are completed, the current one is active, the rest pending. */
export function trackerNodes(state: OrderState): TrackerNode[] | null {
  const current = progressIndex(state);
  if (current === null) return null;
  return TRACKER_STEPS.map((step, index) => ({
    step,
    status: index < current ? 'completed' : index === current ? 'active' : 'pending',
  }));
}

/** Terminal states end tracking: no polling, no OTP, no cancellation. */
export function isTerminalOrderState(state: OrderState): boolean {
  return state === 'DELIVERED' || state === 'CANCELED' || state === 'FAILED';
}
