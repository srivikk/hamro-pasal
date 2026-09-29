import type { LockView, Order, OrderView, PaymentView } from '@hamro-pasal/shared-types';

import type { LockStatusView } from '../checkout/checkout-service';
import type { ConfirmedPayment } from '../payments/payment-confirmation';

/*
 * Mappers from domain objects to the public response contracts. The contracts themselves (types
 * and Zod schemas) live in @hamro-pasal/shared-types (src/api/responses.ts), shared with mobile.
 */

/** Never exposes the OTP hash, gateway refs or commission. */
export function orderView(order: Order): OrderView {
  return {
    id: order.id,
    vendor_id: order.vendor_id,
    state: order.state,
    payment_method: order.payment_method,
    payment_status: order.payment_status,
    fulfillment: order.fulfillment_locked,
    subtotal_npr: order.subtotal,
    delivery_fee_npr: order.delivery_fee,
    total_npr: Math.round((order.subtotal + order.delivery_fee) * 100) / 100,
    created_at: order.created_at.toISOString(),
  };
}

export function lockView(lock: LockStatusView): LockView {
  return lock.status === 'ACTIVE'
    ? { status: lock.status, ttl_ms: lock.ttlMs, expires_at: lock.expiresAt.toISOString() }
    : { status: lock.status, ttl_ms: 0, expires_at: null };
}

export function paymentView(payment: ConfirmedPayment | null): PaymentView | null {
  return payment === null
    ? null
    : {
        order_id: payment.orderId,
        order_state: payment.orderState,
        payment_status: payment.paymentStatus,
        duplicate: !payment.newlyCaptured,
      };
}
