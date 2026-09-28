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
 * Vendor wallet movements. Debits are stored as negative amounts, credits as positive.
 * - ESCROW_RELEASE: vendor share credited after DELIVERED (SPEC §5).
 * - COD_COMMISSION: platform commission debited on COD self-delivery (SPEC §5).
 * - EMERGENCY_RIDER_FEE: platform delivery fee debited on Emergency Rider override (SPEC §2).
 * - TOP_UP: upfront eSewa payment to clear a negative balance (SPEC §5).
 * - ADJUSTMENT: Superadmin correction, either sign.
 */
export const walletLedgerEntryTypes = [
  'ESCROW_RELEASE',
  'COD_COMMISSION',
  'EMERGENCY_RIDER_FEE',
  'TOP_UP',
  'ADJUSTMENT',
] as const;
export const walletLedgerEntryTypeSchema = z.enum(walletLedgerEntryTypes);
export type WalletLedgerEntryType = z.infer<typeof walletLedgerEntryTypeSchema>;

/** Super Admin arbitration outcomes (SPEC Super Admin flow step 3). */
export const disputeStatuses = ['OPEN', 'REFUNDED_TO_CUSTOMER', 'RELEASED_TO_VENDOR'] as const;
export const disputeStatusSchema = z.enum(disputeStatuses);
export type DisputeStatus = z.infer<typeof disputeStatusSchema>;

/** Double-blind review sides (SPEC §6). */
export const reviewDirections = ['CUSTOMER_TO_VENDOR', 'VENDOR_TO_CUSTOMER'] as const;
export const reviewDirectionSchema = z.enum(reviewDirections);
export type ReviewDirection = z.infer<typeof reviewDirectionSchema>;
