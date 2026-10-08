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

/**
 * SUSPENDED is for wallet debt or a Super Admin's decision. SUSPENDED_COMPLIANCE (Phase 25) is
 * separate: a LIVE vendor without a PAN, lifted only by the transaction that saves the PAN.
 */
export const vendorStatuses = [
  'SANDBOXED',
  'APPROVED',
  'LIVE',
  'SUSPENDED',
  'SUSPENDED_COMPLIANCE',
] as const;
export const vendorStatusSchema = z.enum(vendorStatuses);
export type VendorStatus = z.infer<typeof vendorStatusSchema>;

export const pricingModels = ['SUBSCRIPTION', 'COMMISSION', 'FREE'] as const;
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
 * - PAYOUT_CLEARING: one account (Phase 22). Money vendors asked to withdraw: credited when a payout
 *   is requested, debited back when it is rejected. An approved payout stays here as paid out.
 * - AD_REVENUE: one account (Phase 28). What vendors paid for their own ad purchases (SPEC core 8,
 *   Layer 2): kept apart from PLATFORM_REVENUE, which is commission.
 * - AD_BUDGET_CLEARING: one account (Phase 28). Per-order ad budgets held at purchase for a shop
 *   that pays from its ledger (Models A and C); what is unused goes back when the ad ends.
 */
export const ledgerAccountTypes = [
  'SYSTEM_ESCROW',
  'PLATFORM_REVENUE',
  'GATEWAY_CLEARING',
  'VENDOR_WALLET',
  'DRIVER_WALLET',
  'PAYOUT_CLEARING',
  'AD_REVENUE',
  'AD_BUDGET_CLEARING',
  /** The platform's share of campaign discounts: its marketing cost (SPEC core 9). */
  'PROMO_EXPENSE',
] as const;
export const ledgerAccountTypeSchema = z.enum(ledgerAccountTypes);
export type LedgerAccountType = z.infer<typeof ledgerAccountTypeSchema>;

/**
 * Journal transaction kinds.
 * - PAYMENT_CAPTURE: gateway payment confirmed. GATEWAY_CLEARING to SYSTEM_ESCROW.
 * - ORDER_SETTLEMENT: after DELIVERED. Escrow (or COD cash) split to vendor, driver, platform.
 * - VENDOR_TOP_UP: vendor pays upfront via a gateway to clear a negative wallet (SPEC §5).
 * - ADJUSTMENT: Super Admin correction between accounts.
 * - VENDOR_PAYOUT: a vendor requested a bank withdrawal. VENDOR_WALLET to PAYOUT_CLEARING (Phase 22).
 * - VENDOR_PAYOUT_REVERSAL: the request was rejected. PAYOUT_CLEARING back to VENDOR_WALLET.
 * - AD_PURCHASE: a vendor's own ad purchase was charged (Phase 28). VENDOR_WALLET to AD_REVENUE (a
 *   flat fee, in one or several collections) or to AD_BUDGET_CLEARING (a per-order budget held).
 * - AD_BUDGET_RELEASE: the unused part of a held budget. AD_BUDGET_CLEARING back to VENDOR_WALLET.
 * - AD_REFUND: a flat-rate ad cancelled before it started. AD_REVENUE back to VENDOR_WALLET.
 */
export const ledgerTransactionKinds = [
  'PAYMENT_CAPTURE',
  'ORDER_SETTLEMENT',
  'VENDOR_TOP_UP',
  'ADJUSTMENT',
  'VENDOR_PAYOUT',
  'VENDOR_PAYOUT_REVERSAL',
  'AD_PURCHASE',
  'AD_BUDGET_RELEASE',
  'AD_REFUND',
] as const;
export const ledgerTransactionKindSchema = z.enum(ledgerTransactionKinds);
export type LedgerTransactionKind = z.infer<typeof ledgerTransactionKindSchema>;

/**
 * What one posting is (SPEC core 4 "Dual-Layer Billing", STATE_HANDOFF §8Z.5): every statement
 * shows commission (Layer 1) and ad charges (Layer 2) as separate lines, never one figure.
 * ADJUSTMENT is the column's default: a posting written without a line type, which is every
 * posting from before migration 0027 and, until each journal names its lines, every non-ad one.
 * The four AD_* lines always name the vendor's own purchase (a database CHECK).
 */
export const ledgerLineTypes = [
  'ORDER_PROCEEDS',
  'DELIVERY_FEE',
  'PLATFORM_COMMISSION',
  'SUBSCRIPTION_FEE',
  'AD_FLAT_FEE',
  'AD_ORDER_PREMIUM',
  'AD_BUDGET_HOLD',
  'AD_BUDGET_RELEASE',
  'DISCOUNT_VENDOR_OFFER',
  'DISCOUNT_CAMPAIGN_VENDOR_SHARE',
  'DISCOUNT_CAMPAIGN_PLATFORM_SHARE',
  'REFUND',
  'RECHARGE',
  'PAYOUT',
  'ADJUSTMENT',
] as const;
export const ledgerLineTypeSchema = z.enum(ledgerLineTypes);
export type LedgerLineType = z.infer<typeof ledgerLineTypeSchema>;

/** The lines that exist only through a vendor's own ad purchase (SPEC edge case 6). */
export const adLedgerLineTypes = [
  'AD_FLAT_FEE',
  'AD_ORDER_PREMIUM',
  'AD_BUDGET_HOLD',
  'AD_BUDGET_RELEASE',
] as const satisfies readonly LedgerLineType[];

/**
 * Payout request state machine (Phase 22): PENDING (amount held out of the wallet) → APPROVED (bank
 * transfer recorded) or REJECTED (amount posted back). Both outcomes are final.
 */
export const payoutStatuses = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export const payoutStatusSchema = z.enum(payoutStatuses);
export type PayoutStatus = z.infer<typeof payoutStatusSchema>;

/**
 * Where the bank transfer of a payout made by the scheduled run stands (Phase 29). Null on a
 * payout whose transfer an admin had already made when it was recorded.
 *   PROCESSING_BANK_TRANSFER  the amount left the wallet; the transfer is still to be made
 *   COMPLETED                 an admin made the transfer and recorded its reference
 *   FAILED                    the transfer failed; the amount was posted back to the wallet
 */
export const payoutTransferStates = ['PROCESSING_BANK_TRANSFER', 'COMPLETED', 'FAILED'] as const;
export const payoutTransferStateSchema = z.enum(payoutTransferStates);
export type PayoutTransferState = z.infer<typeof payoutTransferStateSchema>;

/** The documents of the fiscal invoicing engine (SPEC core 10). Only INVOICE is issued today. */
export const fiscalDocumentTypes = ['INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE'] as const;
export const fiscalDocumentTypeSchema = z.enum(fiscalDocumentTypes);
export type FiscalDocumentType = z.infer<typeof fiscalDocumentTypeSchema>;

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

/** A discount rule (SPEC core 7): an amount off, or a share off with an optional cap. */
export const discountKinds = ['FLAT', 'PERCENTAGE'] as const;
export const discountKindSchema = z.enum(discountKinds);
export type DiscountKind = z.infer<typeof discountKindSchema>;

/**
 * A shop's consent to a platform campaign (SPEC core 7). ACTIVE: the campaign applies to the shop.
 * OPTED_OUT: the vendor's own account withdrew it. VOIDED: the campaign's terms changed, so the
 * consent no longer covers them. Both ends are final: joining again is a new row.
 */
export const campaignOptInStatuses = ['ACTIVE', 'OPTED_OUT', 'VOIDED'] as const;
export const campaignOptInStatusSchema = z.enum(campaignOptInStatuses);
export type CampaignOptInStatus = z.infer<typeof campaignOptInStatusSchema>;

/** Where a sponsored placement shows (SPEC core 8). FEED_LISTING is "Sponsored Search". */
export const adSlots = ['CAROUSEL', 'FEED_LISTING'] as const;
export const adSlotSchema = z.enum(adSlots);
export type AdSlot = z.infer<typeof adSlotSchema>;

/** FLAT_RATE: one price for the booked period. PER_ORDER_PREMIUM: a fixed fee per delivered order. */
export const adBillingModels = ['FLAT_RATE', 'PER_ORDER_PREMIUM'] as const;
export const adBillingModelSchema = z.enum(adBillingModels);
export type AdBillingModel = z.infer<typeof adBillingModelSchema>;

/**
 * How a vendor's money is settled (SPEC core 5). Model A COD_CREDIT, Model B PLATFORM_ESCROW (the
 * default, and the only one that runs today), Model C DIRECT_PREPAID (Phase 3, not selectable).
 */
export const settlementModels = ['COD_CREDIT', 'PLATFORM_ESCROW', 'DIRECT_PREPAID'] as const;
export const settlementModelSchema = z.enum(settlementModels);
export type SettlementModel = z.infer<typeof settlementModelSchema>;

/**
 * Payment routing (SPEC core 9): the methods a shop's settlement model allows. Model A is cash
 * only; Model B takes all three. Model C is Phase 3: it needs the vendor's own gateway
 * credentials and the Fixed Reserve check, neither of which exists, so it allows nothing.
 * A shop's `accepted_payment_methods` can only narrow this list.
 */
export const SETTLEMENT_MODEL_PAYMENT_METHODS: Readonly<
  Record<SettlementModel, readonly PaymentMethod[]>
> = {
  COD_CREDIT: ['COD'],
  PLATFORM_ESCROW: ['ESEWA', 'KHALTI', 'COD'],
  DIRECT_PREPAID: [],
};

/** Where a Home promotion shows: the banner carousel, or a Featured Offers tile. */
export const promotionPlacements = ['CAROUSEL', 'FEATURED'] as const;
export const promotionPlacementSchema = z.enum(promotionPlacements);
export type PromotionPlacement = z.infer<typeof promotionPlacementSchema>;

/** What a tapped promotion opens: a shop, a category, or the shops carrying an offer label. */
export const promotionTargetTypes = ['SHOP', 'CATEGORY', 'DISCOUNT_TAG'] as const;
export const promotionTargetTypeSchema = z.enum(promotionTargetTypes);
export type PromotionTargetType = z.infer<typeof promotionTargetTypeSchema>;

/** A vendor's request to change its settlement model (Phase 27, SPEC core 5). */
export const settlementModelRequestStatuses = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export const settlementModelRequestStatusSchema = z.enum(settlementModelRequestStatuses);
export type SettlementModelRequestStatus = z.infer<typeof settlementModelRequestStatusSchema>;

/**
 * A vendor's ad purchase (Phase 27, SPEC core 8). ACTIVE: running. PAUSED: a per-order ad whose
 * budget is used up. ENDED: its period is over. CANCELLED: the vendor withdrew it.
 */
export const adPurchaseStatuses = ['ACTIVE', 'PAUSED', 'ENDED', 'CANCELLED'] as const;
export const adPurchaseStatusSchema = z.enum(adPurchaseStatuses);
export type AdPurchaseStatus = z.infer<typeof adPurchaseStatusSchema>;
