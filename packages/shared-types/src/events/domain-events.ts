import { z } from 'zod';

import { nepalPhoneSchema } from '../domain/entities';
import {
  adBillingModelSchema,
  fulfillmentModeSchema,
  ledgerAccountTypeSchema,
  ledgerTransactionKindSchema,
  orderStateSchema,
  paymentMethodSchema,
  paymentStatusSchema,
  vendorStatusSchema,
} from '../domain/enums';

/** Kafka topics provisioned by infra/kafka/create-topics.sh. Keep the two lists in sync. */
export const KAFKA_TOPICS = {
  ORDER_LIFECYCLE: 'order.lifecycle',
  PAYMENT_RECONCILIATION: 'payment.reconciliation',
  LEDGER_MUTATIONS: 'ledger.mutations',
  NOTIFICATIONS_BROADCAST: 'notifications.broadcast',
  /**
   * Dead letters of `notifications.broadcast` (Phase 14): messages the worker could not process
   * after its retries, copied byte for byte with `dlq_*` headers. No domain event is routed here.
   */
  NOTIFICATIONS_DLQ: 'notifications.dlq',
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

/**
 * SPEC §5: the vendor's wallet went below the suspension limit and the vendor was switched to
 * SUSPENDED, either by the posting that took it there (API, Phase 12.5) or by the nightly
 * reconciliation after the limit was tightened (worker, Phase 12). The shop stays offline until
 * the negative balance is cleared with an upfront eSewa payment (then `vendor.restored`). Written
 * once per suspension: only a transition into SUSPENDED writes it.
 */
export const vendorSuspendedForDebtPayloadSchema = z.strictObject({
  vendor_id: z.uuid(),
  /** The vendor's +977 business number, for the SMS telling them why the shop went offline. */
  vendor_phone: nepalPhoneSchema,
  /** The status before suspension: what an admin restores once the dues are paid. */
  previous_status: vendorStatusSchema.exclude(['SUSPENDED']),
  wallet_balance_npr: z.number().negative(),
  /** platform_settings.vendor_wallet_suspension_limit_npr at the time of the suspension. */
  suspension_limit_npr: z.number().max(0),
  suspended_at: z.iso.datetime(),
});

/**
 * SPEC §5 (Phase 12.5): a vendor suspended for wallet debt cleared the negative balance (a top-up or
 * a payout brought it back to zero or above) and is back in the status it had before.
 */
export const vendorRestoredPayloadSchema = z.strictObject({
  vendor_id: z.uuid(),
  vendor_phone: nepalPhoneSchema,
  restored_status: vendorStatusSchema.exclude(['SUSPENDED']),
  wallet_balance_npr: z.number().nonnegative(),
  /** The journal that cleared the debt. */
  transaction_id: z.uuid(),
  restored_at: z.iso.datetime(),
});

/**
 * Phase 15: a Super Admin suspended or restored a vendor by hand (SPEC infrastructure §5: vendor
 * suspension events need an audit record). Written in the transaction of the status change. An
 * admin suspension is never lifted by paying dues; only an admin RESTORE ends it.
 */
export const vendorStatusOverriddenPayloadSchema = z.strictObject({
  vendor_id: z.uuid(),
  action: z.enum(['SUSPEND', 'RESTORE']),
  from_status: vendorStatusSchema,
  to_status: vendorStatusSchema,
  wallet_balance_npr: z.number(),
  admin_user_id: z.uuid(),
  overridden_at: z.iso.datetime(),
});

/**
 * SPEC core 10 (Phase 35): the nightly compliance sweep found the shop LIVE without a PAN and took
 * it offline. It returns the moment its PAN is saved. Written once per suspension, in the sweep's
 * own transaction for that vendor.
 */
export const vendorSuspendedForCompliancePayloadSchema = z.strictObject({
  vendor_id: z.uuid(),
  /** The vendor's +977 business number, for the message telling them to add their PAN. */
  vendor_phone: nepalPhoneSchema,
  /** What saving the PAN restores. The sweep only suspends LIVE shops. */
  previous_status: z.literal('LIVE'),
  suspended_at: z.iso.datetime(),
});

/**
 * SPEC core 10 (Phase 36): saving the PAN lifted the shop's compliance suspension. `status` is
 * where that left it: LIVE again, or still SUSPENDED when a debt or admin suspension lies on top
 * (a PAN never lifts those). Written in the transaction that saved the PAN.
 */
export const vendorComplianceRestoredPayloadSchema = z.strictObject({
  vendor_id: z.uuid(),
  vendor_phone: nepalPhoneSchema,
  status: vendorStatusSchema.exclude(['SUSPENDED_COMPLIANCE', 'DEACTIVATED']),
  /** Invoices issued by the same save for orders delivered while the shop had no PAN. */
  waiting_invoices_issued: z.number().int().min(0),
  restored_at: z.iso.datetime(),
});

/**
 * SPEC vendor flow 23 (Phase 38): the vendor closed its shop. Written once, last in the
 * transaction that set DEACTIVATED (a repeated request writes none). The account's devices were
 * signed out in that transaction, so the notice reaches the shop by SMS.
 */
export const vendorDeactivatedPayloadSchema = z.strictObject({
  vendor_id: z.uuid(),
  vendor_phone: nepalPhoneSchema,
  /** What the platform still holds for the shop and will pay out; a shop in debt is never closed. */
  wallet_balance_npr: z.number().min(0),
  cancelled_ad_count: z.number().int().min(0),
  /** Unstarted flat fees and unused held budgets returned to the wallet with the closure. */
  returned_npr: z.number().min(0),
  deactivated_at: z.iso.datetime(),
});

/**
 * SPEC vendor flow 23 (Phase 38): a Super Admin reopened a closed shop. `status` is where that
 * left it: LIVE, or SUSPENDED_COMPLIANCE when it has no PAN (saving one then brings it back).
 */
export const vendorReactivatedPayloadSchema = z.strictObject({
  vendor_id: z.uuid(),
  vendor_phone: nepalPhoneSchema,
  status: vendorStatusSchema.extract(['LIVE', 'SUSPENDED_COMPLIANCE']),
  reactivated_by_user_id: z.uuid(),
  reactivated_at: z.iso.datetime(),
});

/**
 * Step 7.3 (SPEC core 11): the shop missed or rejected too many orders in a row and was paused.
 * Written once per pause, in the transaction of the order that crossed the threshold.
 */
export const vendorAutoPausedPayloadSchema = z.strictObject({
  vendor_id: z.uuid(),
  vendor_phone: nepalPhoneSchema,
  missed_orders: z.number().int().positive(),
  paused_at: z.iso.datetime(),
});

/**
 * Step 7.4 (SPEC core 11, Notify Me): a product became orderable again (active with stock), written
 * in the transaction of the change. The customers waiting for it are told once, even if it sells
 * out again before the notice goes (SPEC edge case 22).
 */
export const productBackInStockPayloadSchema = z.strictObject({
  product_id: z.uuid(),
  vendor_id: z.uuid(),
});

/**
 * Step 7.4: the vendor lifted an Auto-Pause or switched the shop on and it is open now. Opening
 * by the clock writes nothing; the Notify Me sweep finds those shops instead.
 */
export const vendorOpenedPayloadSchema = z.strictObject({
  vendor_id: z.uuid(),
  opened_at: z.iso.datetime(),
});

/**
 * Step 7.3 (SPEC core 6): a party asked Hamro Pasal to decide. The other party is told; the
 * order's held amount is frozen until the resolution.
 */
export const disputeEscalatedPayloadSchema = z.strictObject({
  dispute_id: z.uuid(),
  order_id: z.uuid(),
  vendor_id: z.uuid(),
  customer_id: z.uuid(),
  escalated_by: z.enum(['CUSTOMER', 'VENDOR']),
  escalated_at: z.iso.datetime(),
});

/** Step 7.3: the Super Admin resolved an escalated order. Both parties are told. */
export const disputeResolvedPayloadSchema = z.strictObject({
  dispute_id: z.uuid(),
  order_id: z.uuid(),
  vendor_id: z.uuid(),
  customer_id: z.uuid(),
  outcome: z.enum(['RELEASE', 'REFUND', 'PARTIAL_REFUND']),
  refund_npr: z.number().nonnegative(),
  resolved_at: z.iso.datetime(),
});

/**
 * Step 7.5 (SPEC core 11): the Super Admin sent a message; the worker pushes it to the
 * recipients' devices and records what the push service answered on the message.
 */
export const notificationBroadcastRequestedPayloadSchema = z.strictObject({
  message_id: z.uuid(),
  audience: z.enum(['VENDOR', 'ALL_CUSTOMERS']),
});

/**
 * Step 7.6 (SPEC core 11): a data export too large to download at once was queued; the worker
 * puts it on its DATA_EXPORT queue, builds it and emails it.
 */
export const exportRequestedPayloadSchema = z.strictObject({
  job_id: z.uuid(),
});

/** SPEC core 8 (Phase 35): an ad's paid period is over. Written once, when it becomes ENDED. */
export const marketingAdEndedPayloadSchema = z.strictObject({
  ad_purchase_id: z.uuid(),
  vendor_id: z.uuid(),
  vendor_phone: nepalPhoneSchema,
  billing_model: adBillingModelSchema,
  /** The end of the period the shop bought. */
  ends_at: z.iso.datetime(),
  /** Unused held budget returned to the shop's ledger with the end; 0 when none was held. */
  returned_npr: z.number().min(0),
  ended_at: z.iso.datetime(),
});

/**
 * SPEC edge case 8 (Phase 35): a per-order ad was paused because its budget cannot cover one more
 * fee. Written once, by whichever path paused it (the hourly sweep, or the delivery that used the
 * budget up).
 */
export const marketingAdPausedPayloadSchema = z.strictObject({
  ad_purchase_id: z.uuid(),
  vendor_id: z.uuid(),
  vendor_phone: nepalPhoneSchema,
  reason: z.literal('BUDGET_EXHAUSTED'),
  budget_npr: z.number().min(0),
  amount_paid_npr: z.number().min(0),
  /** The paid period still runs to here; adding budget is not possible yet. */
  ends_at: z.iso.datetime(),
  paused_at: z.iso.datetime(),
});

/** At most this many shops are named in one `marketing.campaign_terms_changed` event. */
export const MAX_CAMPAIGN_EVENT_VENDORS = 5000;

/**
 * SPEC core 7 (Phase 35): an admin changed a campaign's terms. The version went up and every live
 * opt-in was voided in the same transaction; the shops named here are no longer in the campaign
 * until each opts in to the new terms.
 */
export const marketingCampaignTermsChangedPayloadSchema = z.strictObject({
  campaign_id: z.uuid(),
  campaign_name: z.string().min(1),
  previous_terms_version: z.number().int().positive(),
  terms_version: z.number().int().positive(),
  /** The shops whose opt-in this change voided (the first MAX_CAMPAIGN_EVENT_VENDORS of them). */
  voided_vendor_ids: z.array(z.uuid()).max(MAX_CAMPAIGN_EVENT_VENDORS),
  /** How many opt-ins were voided in all. */
  voided_opt_in_count: z.number().int().min(0),
  changed_by_user_id: z.uuid(),
  changed_at: z.iso.datetime(),
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
        /** Step 7.3: owner of a VENDOR_DISPUTE_HOLD account. Absent from older events. */
        hold_vendor_id: z.uuid().nullable().default(null),
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

export const vendorSuspendedForDebtEventSchema = envelope(
  'vendor.suspended_for_debt',
  vendorSuspendedForDebtPayloadSchema,
);

export const vendorRestoredEventSchema = envelope('vendor.restored', vendorRestoredPayloadSchema);

export const vendorStatusOverriddenEventSchema = envelope(
  'vendor.status_overridden',
  vendorStatusOverriddenPayloadSchema,
);

export const vendorSuspendedForComplianceEventSchema = envelope(
  'vendor.suspended_for_compliance',
  vendorSuspendedForCompliancePayloadSchema,
);
export const vendorComplianceRestoredEventSchema = envelope(
  'vendor.compliance_restored',
  vendorComplianceRestoredPayloadSchema,
);
export const vendorDeactivatedEventSchema = envelope(
  'vendor.deactivated',
  vendorDeactivatedPayloadSchema,
);
export const vendorReactivatedEventSchema = envelope(
  'vendor.reactivated',
  vendorReactivatedPayloadSchema,
);
export const vendorAutoPausedEventSchema = envelope(
  'vendor.auto_paused',
  vendorAutoPausedPayloadSchema,
);
export const productBackInStockEventSchema = envelope(
  'product.back_in_stock',
  productBackInStockPayloadSchema,
);
export const vendorOpenedEventSchema = envelope('vendor.opened', vendorOpenedPayloadSchema);
export const disputeEscalatedEventSchema = envelope(
  'dispute.escalated',
  disputeEscalatedPayloadSchema,
);
export const disputeResolvedEventSchema = envelope(
  'dispute.resolved',
  disputeResolvedPayloadSchema,
);
export const notificationBroadcastRequestedEventSchema = envelope(
  'notification.broadcast_requested',
  notificationBroadcastRequestedPayloadSchema,
);
export const exportRequestedEventSchema = envelope(
  'export.requested',
  exportRequestedPayloadSchema,
);
export const marketingAdEndedEventSchema = envelope(
  'marketing.ad_ended',
  marketingAdEndedPayloadSchema,
);
export const marketingAdPausedEventSchema = envelope(
  'marketing.ad_paused',
  marketingAdPausedPayloadSchema,
);
export const marketingCampaignTermsChangedEventSchema = envelope(
  'marketing.campaign_terms_changed',
  marketingCampaignTermsChangedPayloadSchema,
);

export const domainEventSchema = z.discriminatedUnion('event_type', [
  orderLockedEventSchema,
  orderPlacedEventSchema,
  orderCanceledRefundDueEventSchema,
  orderStateChangedEventSchema,
  ledgerMutatedEventSchema,
  vendorEscalationRequiredEventSchema,
  vendorSuspendedForDebtEventSchema,
  vendorRestoredEventSchema,
  vendorStatusOverriddenEventSchema,
  vendorSuspendedForComplianceEventSchema,
  vendorComplianceRestoredEventSchema,
  vendorDeactivatedEventSchema,
  vendorReactivatedEventSchema,
  vendorAutoPausedEventSchema,
  productBackInStockEventSchema,
  vendorOpenedEventSchema,
  disputeEscalatedEventSchema,
  disputeResolvedEventSchema,
  notificationBroadcastRequestedEventSchema,
  exportRequestedEventSchema,
  marketingAdEndedEventSchema,
  marketingAdPausedEventSchema,
  marketingCampaignTermsChangedEventSchema,
]);

export type OrderLockedEvent = z.infer<typeof orderLockedEventSchema>;
export type OrderPlacedEvent = z.infer<typeof orderPlacedEventSchema>;
export type OrderStateChangedEvent = z.infer<typeof orderStateChangedEventSchema>;
export type OrderCanceledRefundDueEvent = z.infer<typeof orderCanceledRefundDueEventSchema>;
export type LedgerMutatedEvent = z.infer<typeof ledgerMutatedEventSchema>;
export type VendorEscalationRequiredEvent = z.infer<typeof vendorEscalationRequiredEventSchema>;
export type VendorSuspendedForDebtEvent = z.infer<typeof vendorSuspendedForDebtEventSchema>;
export type VendorRestoredEvent = z.infer<typeof vendorRestoredEventSchema>;
export type VendorStatusOverriddenEvent = z.infer<typeof vendorStatusOverriddenEventSchema>;
export type VendorSuspendedForComplianceEvent = z.infer<
  typeof vendorSuspendedForComplianceEventSchema
>;
export type VendorComplianceRestoredEvent = z.infer<typeof vendorComplianceRestoredEventSchema>;
export type VendorDeactivatedEvent = z.infer<typeof vendorDeactivatedEventSchema>;
export type VendorReactivatedEvent = z.infer<typeof vendorReactivatedEventSchema>;
export type VendorAutoPausedEvent = z.infer<typeof vendorAutoPausedEventSchema>;
export type ProductBackInStockEvent = z.infer<typeof productBackInStockEventSchema>;
export type VendorOpenedEvent = z.infer<typeof vendorOpenedEventSchema>;
export type DisputeEscalatedEvent = z.infer<typeof disputeEscalatedEventSchema>;
export type DisputeResolvedEvent = z.infer<typeof disputeResolvedEventSchema>;
export type NotificationBroadcastRequestedEvent = z.infer<
  typeof notificationBroadcastRequestedEventSchema
>;
export type ExportRequestedEvent = z.infer<typeof exportRequestedEventSchema>;
export type MarketingAdEndedEvent = z.infer<typeof marketingAdEndedEventSchema>;
export type MarketingAdPausedEvent = z.infer<typeof marketingAdPausedEventSchema>;
export type MarketingCampaignTermsChangedEvent = z.infer<
  typeof marketingCampaignTermsChangedEventSchema
>;
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
  'vendor.suspended_for_debt': KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
  'vendor.restored': KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
  'vendor.status_overridden': KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
  'vendor.suspended_for_compliance': KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
  'vendor.compliance_restored': KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
  'vendor.deactivated': KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
  'vendor.reactivated': KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
  'vendor.auto_paused': KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
  'product.back_in_stock': KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
  'vendor.opened': KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
  'dispute.escalated': KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
  'dispute.resolved': KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
  'notification.broadcast_requested': KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
  'export.requested': KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
  'marketing.ad_ended': KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
  'marketing.ad_paused': KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
  'marketing.campaign_terms_changed': KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
};
