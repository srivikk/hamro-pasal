import { z } from 'zod';

import {
  fulfillmentModeSchema,
  ledgerAccountTypeSchema,
  ledgerTransactionKindSchema,
  paymentMethodSchema,
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
export const ledgerMutatedEventSchema = envelope('ledger.mutated', ledgerMutatedPayloadSchema);

export const domainEventSchema = z.discriminatedUnion('event_type', [
  orderLockedEventSchema,
  orderPlacedEventSchema,
  ledgerMutatedEventSchema,
]);

export type OrderLockedEvent = z.infer<typeof orderLockedEventSchema>;
export type OrderPlacedEvent = z.infer<typeof orderPlacedEventSchema>;
export type LedgerMutatedEvent = z.infer<typeof ledgerMutatedEventSchema>;
export type DomainEvent = z.infer<typeof domainEventSchema>;
export type DomainEventType = DomainEvent['event_type'];
export type DomainEventPayload<T extends DomainEventType> = Extract<
  DomainEvent,
  { event_type: T }
>['payload'];

export const DOMAIN_EVENT_TOPICS: Readonly<Record<DomainEventType, KafkaTopic>> = {
  'order.locked': KAFKA_TOPICS.ORDER_LIFECYCLE,
  'order.placed': KAFKA_TOPICS.ORDER_LIFECYCLE,
  'ledger.mutated': KAFKA_TOPICS.LEDGER_MUTATIONS,
};
