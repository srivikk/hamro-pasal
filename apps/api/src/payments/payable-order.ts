import type { Order } from '@hamro-pasal/shared-types';

import type { LockStatusView } from '../checkout/checkout-service';
import { CheckoutRejectedError } from '../checkout/pricing';
import { ReservationExpiredError } from '../inventory/errors';
import type { Gateway } from './gateway-http';

/** A payment can be started only for a pending order of this gateway whose 600 s lock is live. */
export function assertPayable(order: Order, lock: LockStatusView, gateway: Gateway): void {
  if (order.payment_method !== gateway) {
    throw new CheckoutRejectedError(
      'WRONG_PAYMENT_METHOD',
      `Order is paid by ${order.payment_method}, not ${gateway}`,
      undefined,
      409,
    );
  }
  if (order.state !== 'PENDING_PAYMENT' || order.payment_status !== 'PENDING') {
    throw new CheckoutRejectedError(
      'ORDER_NOT_PAYABLE',
      `Order is ${order.state} / ${order.payment_status}`,
      undefined,
      409,
    );
  }
  if (lock.status !== 'ACTIVE') {
    throw new ReservationExpiredError(order.reservation_id ?? order.id);
  }
}

/** NPR amount string for gateway payloads: "1050", "1050.5" (no float noise, no grouping). */
export function formatNpr(paisa: number): string {
  if (!Number.isSafeInteger(paisa)) throw new RangeError('Amount must be whole paisa');
  return String(paisa / 100);
}
