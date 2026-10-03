import { z } from 'zod';

/*
 * Domain enums. The `as const` tuples are the single source of truth: packages/db builds its
 * Postgres enum types from these same arrays, so the DB and the API contract cannot drift.
 * SPEC.md declares these as numeric TS enums. They are string-valued here so stored rows stay
 * readable and reordering members can never silently remap existing data.
 */

export const userRoles = ['CUSTOMER', 'VENDOR', 'DRIVER', 'SUPER_ADMIN'] as const;
export const userRoleSchema = z.enum(userRoles);
export type UserRole = z.infer<typeof userRoleSchema>;

export const vendorStatuses = ['SANDBOXED', 'APPROVED', 'LIVE', 'SUSPENDED'] as const;
export const vendorStatusSchema = z.enum(vendorStatuses);
export type VendorStatus = z.infer<typeof vendorStatusSchema>;

export const pricingModels = ['SUBSCRIPTION', 'COMMISSION'] as const;
export const pricingModelSchema = z.enum(pricingModels);
export type PricingModel = z.infer<typeof pricingModelSchema>;

export const deliveryScopes = ['RADIUS_BOUND', 'CITY_WIDE', 'NATION_WIDE'] as const;
export const deliveryScopeSchema = z.enum(deliveryScopes);
export type DeliveryScope = z.infer<typeof deliveryScopeSchema>;

export const fulfillmentModes = ['SELF_DELIVERY', 'PLATFORM_FLEET', 'EMERGENCY_FLEET'] as const;
export const fulfillmentModeSchema = z.enum(fulfillmentModes);
export type FulfillmentMode = z.infer<typeof fulfillmentModeSchema>;

/** A vendor's standing choice (SPEC §2). EMERGENCY_FLEET only ever applies to a single order. */
export const vendorFulfillmentModes = ['SELF_DELIVERY', 'PLATFORM_FLEET'] as const;
export const vendorFulfillmentModeSchema = z.enum(vendorFulfillmentModes);
export type VendorFulfillmentMode = z.infer<typeof vendorFulfillmentModeSchema>;

export const orderStates = [
  'PENDING_PAYMENT',
  'PLACED',
  'PREPARING',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELED',
  'FAILED',
  'DISPUTED',
] as const;
export const orderStateSchema = z.enum(orderStates);
export type OrderState = z.infer<typeof orderStateSchema>;

export const paymentMethods = ['ESEWA', 'KHALTI', 'COD'] as const;
export const paymentMethodSchema = z.enum(paymentMethods);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

export const paymentStatuses = ['PENDING', 'PAID', 'FAILED'] as const;
export const paymentStatusSchema = z.enum(paymentStatuses);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

/**
 * Double-entry ledger accounts (SPEC §5).
 * - SYSTEM_ESCROW: every upfront payment lands here; released only after DELIVERED. Never negative.
 * - PLATFORM_REVENUE: platform commission.
 * - GATEWAY_CLEARING: one per gateway (eSewa, Khalti). Money received but not yet paid out by the
 *   gateway to the platform bank account. It goes negative on capture, as the gateway owes us.
 * - VENDOR_WALLET: one per vendor. Mirrored into vendors.wallet_balance_npr.
 * - DRIVER_WALLET: one per platform-fleet driver. Goes negative while holding COD cash (SPEC float).
 */
export const ledgerAccountTypes = [
  'SYSTEM_ESCROW',
  'PLATFORM_REVENUE',
  'GATEWAY_CLEARING',
  'VENDOR_WALLET',
  'DRIVER_WALLET',
] as const;
export const ledgerAccountTypeSchema = z.enum(ledgerAccountTypes);
export type LedgerAccountType = z.infer<typeof ledgerAccountTypeSchema>;

/**
 * Journal transaction kinds.
 * - PAYMENT_CAPTURE: gateway payment confirmed. GATEWAY_CLEARING to SYSTEM_ESCROW.
 * - ORDER_SETTLEMENT: after DELIVERED. Escrow (or COD cash) split to vendor, driver, platform.
 * - VENDOR_TOP_UP: vendor pays upfront via a gateway to clear a negative wallet (SPEC §5).
 * - ADJUSTMENT: Super Admin correction between accounts.
 */
export const ledgerTransactionKinds = [
  'PAYMENT_CAPTURE',
  'ORDER_SETTLEMENT',
  'VENDOR_TOP_UP',
  'ADJUSTMENT',
] as const;
export const ledgerTransactionKindSchema = z.enum(ledgerTransactionKinds);
export type LedgerTransactionKind = z.infer<typeof ledgerTransactionKindSchema>;

/** Super Admin arbitration outcomes (SPEC Super Admin flow step 3). */
export const disputeStatuses = ['OPEN', 'REFUNDED_TO_CUSTOMER', 'RELEASED_TO_VENDOR'] as const;
export const disputeStatusSchema = z.enum(disputeStatuses);
export type DisputeStatus = z.infer<typeof disputeStatusSchema>;

/** Double-blind review sides (SPEC §6). */
export const reviewDirections = ['CUSTOMER_TO_VENDOR', 'VENDOR_TO_CUSTOMER'] as const;
export const reviewDirectionSchema = z.enum(reviewDirections);
export type ReviewDirection = z.infer<typeof reviewDirectionSchema>;

/**
 * Phase 15: lifecycle of a stored dead letter (`dead_letter_events`).
 * - PENDING: dead-lettered by the worker, waiting for an operator.
 * - RETRY_REQUESTED: a Super Admin asked for a retry; the worker's replayer republishes it.
 * - REPLAYED: republished to its source topic. A replay that fails again becomes a new row.
 */
export const deadLetterStatuses = ['PENDING', 'RETRY_REQUESTED', 'REPLAYED'] as const;
export const deadLetterStatusSchema = z.enum(deadLetterStatuses);
export type DeadLetterStatus = z.infer<typeof deadLetterStatusSchema>;

/**
 * A platform-fleet delivery (delivery partner flow). OFFERED: dispatched by the shop, no rider yet.
 * ASSIGNED: a rider accepted it. PICKED_UP: the rider has the parcel. DELIVERED: handed over with
 * the customer's code. FAILED: the ghost-customer timer ran out (nothing sets it yet).
 */
export const deliveryStates = ['OFFERED', 'ASSIGNED', 'PICKED_UP', 'DELIVERED', 'FAILED'] as const;
export const deliveryStateSchema = z.enum(deliveryStates);
export type DeliveryState = z.infer<typeof deliveryStateSchema>;
