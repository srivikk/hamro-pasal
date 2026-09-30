import { z } from 'zod';

import { nepalPhoneSchema } from '../domain/entities';
import {
  fulfillmentModeSchema,
  ledgerAccountTypeSchema,
  ledgerTransactionKindSchema,
  orderStateSchema,
  paymentMethodSchema,
  paymentStatusSchema,
} from '../domain/enums';

/** Kafka topics provisioned by infra/kafka/create-topics.sh. Keep the two lists in sync. */
export const KAFKA_TOPICS = {
  ORDER_LIFECYCLE: 'order.lifecycle',
  PAYMENT_RECONCILIATION: 'payment.reconciliation',
  LEDGER_MUTATIONS: 'ledger.mutations',
  NOTIFICATIONS_BROADCAST: 'notifications.broadcast',
} as const;
export type KafkaTopic = (typeof KAFKA_TOPICS)[keyof typeof KAFKA_TOPICS];

const lineItemSchema = z.strictObject({
  product_id: z.uuid(),
  quantity: z.number().int().positive(),
});

/** Inventory for a single-vendor cart was locked in Redis for 600 s (SPEC §3). */
export const orderLockedPayloadSchema = z.strictObject({
  reservation_id: z.uuid(),
  vendor_id: z.uuid(),
  customer_id: z.uuid(),
  items: z.array(lineItemSchema).min(1),
  locked_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
});

/** Payment/COD confirmed within the lock window. Stock permanently decremented (SPEC §3). */
export const orderPlacedPayloadSchema = z.strictObject({
  order_id: z.uuid(),
  reservation_id: z.uuid(),
  vendor_id: z.uuid(),
  customer_id: z.uuid(),
  payment_method: paymentMethodSchema,
  fulfillment_locked: fulfillmentModeSchema,
  subtotal: z.number(),
  delivery_fee: z.number(),
  items: z.array(lineItemSchema).min(1),
});

/**
 * ORDER_CANCELED_REFUND_DUE: a prepaid (PAID) order was canceled inside the 60 s window. Its
 * payment sits in SYSTEM_ESCROW and must be refunded through the gateway it came from.
 */
export const orderCanceledRefundDuePayloadSchema = z.strictObject({
  order_id: z.uuid(),
  vendor_id: z.uuid(),
  customer_id: z.uuid(),
  payment_method: z.enum(['ESEWA', 'KHALTI']),
  /** eSewa transaction_uuid or Khalti pidx of the captured payment. */
  payment_gateway_ref: z.string().min(1),
  /** subtotal + delivery fee: everything the customer paid. */
  refund_amount_npr: z.number().positive(),
  canceled_at: z.iso.datetime(),
});

/**
 * Any change of `orders.state`, written in the same transaction as the change. Every code path that
 * mutates the state emits it (creation, placement, cancellation of COD and prepaid orders, failure),
 * so the /orders Socket.io namespace can fan it out (customer journey 9).
 */
export const orderStateChangedPayloadSchema = z.strictObject({
  order_id: z.uuid(),
  customer_id: z.uuid(),
  vendor_id: z.uuid(),
  /** null when the order was just created. */
  from_state: orderStateSchema.nullable(),
  to_state: orderStateSchema,
  payment_status: paymentStatusSchema,
  refund_required: z.boolean(),
  placed_at: z.iso.datetime().nullable(),
  delivered_at: z.iso.datetime().nullable(),
  /** The order row's updated_at after the change (database clock). */
  changed_at: z.iso.datetime(),
});

/**
 * Vendor flow step 6 (infrastructure §1, §6): an order has sat in PLACED for 90 s without the
 * vendor accepting or rejecting it. The IVR/SMS escalation (Twilio Voice or a Nepal SIP trunk,
 * plus an SMS) consumes it and calls the vendor. Written at most once per order.
 */
export const vendorEscalationRequiredPayloadSchema = z.strictObject({
  order_id: z.uuid(),
  vendor_id: z.uuid(),
  /** The vendor's +977 business number: where the call and the SMS go. */
  vendor_phone: nepalPhoneSchema,
  placed_at: z.iso.datetime(),
  /** The acceptance threshold that was missed, in seconds. */
  sla_seconds: z.number().int().positive(),
  escalated_at: z.iso.datetime(),
});

/** A balanced journal transaction was posted. One posting per affected account line. */
export const ledgerMutatedPayloadSchema = z.strictObject({
  transaction_id: z.uuid(),
  kind: ledgerTransactionKindSchema,
  order_id: z.uuid().nullable(),
  entries: z
    .array(
      z.strictObject({
        account_id: z.uuid(),
        account_type: ledgerAccountTypeSchema,
        vendor_id: z.uuid().nullable(),
        driver_user_id: z.uuid().nullable(),
        gateway: paymentMethodSchema.nullable(),
        amount_npr: z.number(),
        balance_after_npr: z.number(),
      }),
    )
    .min(2),
});

function envelope<TType extends string, TPayload extends z.ZodType>(
  type: TType,
  payload: TPayload,
) {
  return z.strictObject({
    /** Unique per event; consumers de-duplicate on it (delivery is at-least-once). */
    event_id: z.uuid(),
    event_type: z.literal(type),
    event_version: z.literal(1),
    occurred_at: z.iso.datetime(),
    /** Kafka message key, so all events of one aggregate land in order on one partition. */
    aggregate_id: z.string().min(1),
    payload,
  });
}

export const orderLockedEventSchema = envelope('order.locked', orderLockedPayloadSchema);
export const orderPlacedEventSchema = envelope('order.placed', orderPlacedPayloadSchema);
export const orderCanceledRefundDueEventSchema = envelope(
  'order.canceled_refund_due',
  orderCanceledRefundDuePayloadSchema,
);
export const orderStateChangedEventSchema = envelope(
  'order.state_changed',
  orderStateChangedPayloadSchema,
);
export const ledgerMutatedEventSchema = envelope('ledger.mutated', ledgerMutatedPayloadSchema);
export const vendorEscalationRequiredEventSchema = envelope(
  'vendor.escalation.required',
  vendorEscalationRequiredPayloadSchema,
);

export const domainEventSchema = z.discriminatedUnion('event_type', [
  orderLockedEventSchema,
  orderPlacedEventSchema,
  orderCanceledRefundDueEventSchema,
  orderStateChangedEventSchema,
  ledgerMutatedEventSchema,
  vendorEscalationRequiredEventSchema,
]);

export type OrderLockedEvent = z.infer<typeof orderLockedEventSchema>;
export type OrderPlacedEvent = z.infer<typeof orderPlacedEventSchema>;
export type OrderStateChangedEvent = z.infer<typeof orderStateChangedEventSchema>;
export type OrderCanceledRefundDueEvent = z.infer<typeof orderCanceledRefundDueEventSchema>;
export type LedgerMutatedEvent = z.infer<typeof ledgerMutatedEventSchema>;
export type VendorEscalationRequiredEvent = z.infer<typeof vendorEscalationRequiredEventSchema>;
export type DomainEvent = z.infer<typeof domainEventSchema>;
export type DomainEventType = DomainEvent['event_type'];
export type DomainEventPayload<T extends DomainEventType> = Extract<
  DomainEvent,
  { event_type: T }
>['payload'];

export const DOMAIN_EVENT_TOPICS: Readonly<Record<DomainEventType, KafkaTopic>> = {
  'order.locked': KAFKA_TOPICS.ORDER_LIFECYCLE,
  'order.placed': KAFKA_TOPICS.ORDER_LIFECYCLE,
  'order.canceled_refund_due': KAFKA_TOPICS.PAYMENT_RECONCILIATION,
  'order.state_changed': KAFKA_TOPICS.ORDER_LIFECYCLE,
  'ledger.mutated': KAFKA_TOPICS.LEDGER_MUTATIONS,
  'vendor.escalation.required': KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
};
