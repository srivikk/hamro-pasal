import type {
  FulfillmentMode,
  Order,
  OrderState,
  PaymentMethod,
  PaymentStatus,
} from '@hamro-pasal/shared-types';

import type { LockStatusView } from '../checkout/checkout-service';
import type { ConfirmedPayment } from '../payments/payment-confirmation';

/* Response bodies of the public HTTP API: the contract the mobile client codes against. */

export interface OrderView {
  id: string;
  vendor_id: string;
  state: OrderState;
  payment_method: PaymentMethod;
  payment_status: PaymentStatus;
  fulfillment: FulfillmentMode;
  subtotal_npr: number;
  delivery_fee_npr: number;
  total_npr: number;
  created_at: string;
}

export interface LockView {
  status: LockStatusView['status'];
  ttl_ms: number;
  expires_at: string | null;
}

export interface PaymentView {
  order_id: string;
  order_state: OrderState;
  payment_status: PaymentStatus;
  /** true when this confirmation repeated one that had already credited escrow. */
  duplicate: boolean;
}

export interface CheckoutResponseBody {
  order: OrderView;
  reservation: { id: string; expires_at: string | null };
  /** Raw 4-digit handoff OTP; shown to the customer, stored server-side only as a hash. */
  delivery_otp: string | null;
  replayed: boolean;
}

export interface LockStatusResponseBody {
  order: OrderView;
  lock: LockView;
}

export interface EsewaInitiateResponseBody {
  payment_url: string;
  method: 'POST';
  fields: Record<string, string>;
}

export interface KhaltiInitiateResponseBody {
  pidx: string;
  payment_url: string;
  expires_at: string | null;
}

export interface PaymentStatusResponseBody {
  /** Gateway status as reported (eSewa: COMPLETE/PENDING/...; Khalti: Completed/Pending/...). */
  status: string;
  payment: PaymentView | null;
}

/** Public order representation: never exposes the OTP hash, gateway refs or commission. */
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
