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
  // Phase 36: the vendor closed its shop (POST /api/vendor/account/deactivate). Final for the
  // vendor: the row stays for the ledger, the account can no longer sign in.
  'DEACTIVATED',
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

/**
 * How a customer pays an order. WALLET (2026-10-21, SPEC core 12) is the customer's own stored
 * value on the platform: it routes exactly like a gateway payment (into escrow for a Model B shop,
 * straight to the shop's prepaid balance for a Model C one). A shop accepts it wherever it accepts
 * eSewa or Khalti; it is never stored in `vendors.accepted_payment_methods`.
 */
export const paymentMethods = ['ESEWA', 'KHALTI', 'COD', 'WALLET'] as const;
export const paymentMethodSchema = z.enum(paymentMethods);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

/** The external gateways: they have a clearing account and (Model C) a vendor merchant account. */
export const gatewayPaymentMethods = ['ESEWA', 'KHALTI'] as const;
export const gatewayPaymentMethodSchema = z.enum(gatewayPaymentMethods);
export type GatewayPaymentMethod = z.infer<typeof gatewayPaymentMethodSchema>;

/** What a shop itself may accept (its `accepted_payment_methods`): never WALLET, which follows. */
export const shopPaymentMethods = ['ESEWA', 'KHALTI', 'COD'] as const;
export const shopPaymentMethodSchema = z.enum(shopPaymentMethods);
export type ShopPaymentMethod = z.infer<typeof shopPaymentMethodSchema>;

export function isGatewayPaymentMethod(method: PaymentMethod): method is GatewayPaymentMethod {
  return method === 'ESEWA' || method === 'KHALTI';
}

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
  /**
   * Step 7.3 (SPEC core 6): one per vendor (owner `hold_vendor_id`). A delivered prepaid order's
   * earnings wait here for its 7-day conversation window; never negative, never paid out.
   */
  'VENDOR_DISPUTE_HOLD',
  /**
   * Step 7.3: one account. Refunds a resolution decided, owed to customers and paid by hand from
   * the eSewa / Khalti merchant dashboards (decided 2026-10-15).
   */
  'REFUND_CLEARING',
  /**
   * 2026-10-21 (SPEC core 12): a customer's stored value, one per customer (owner
   * `customer_user_id`), opened by the first recharge. Never negative.
   */
  'CUSTOMER_WALLET',
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
  /** Step 7.3: day 8 with no escalation, or a resolution: VENDOR_DISPUTE_HOLD to VENDOR_WALLET. */
  'DISPUTE_HOLD_RELEASE',
  /** Step 7.3: a resolution's refund: hold (and / or wallet) to REFUND_CLEARING. */
  'DISPUTE_REFUND',
  /** 2026-10-21: a customer recharged its wallet through a gateway. GATEWAY_CLEARING to CUSTOMER_WALLET. */
  'CUSTOMER_WALLET_RECHARGE',
  /**
   * 2026-10-21: an order paid from the customer's wallet. CUSTOMER_WALLET to SYSTEM_ESCROW (Model B)
   * or straight to the shop's VENDOR_WALLET (Model C: the platform holds none of it).
   */
  'WALLET_PAYMENT',
  /** 2026-10-21, Model C: the platform's commission debited from the prepaid balance at PLACED. */
  'ORDER_FEE_DEBIT',
  /**
   * 2026-10-21: a cancelled order's money going back: escrow or a Model C shop's balance to the
   * customer's wallet (a wallet order) or to REFUND_CLEARING (a gateway order), and a Model C fee
   * back to the shop.
   */
  'ORDER_REFUND',
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
  /** Step 7.3: the settlement's credit to the dispute hold, its release, and a refund. */
  'DISPUTE_HOLD',
  'DISPUTE_RELEASE',
  'DISPUTE_REFUND',
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
/**
 * Step 7.3 (SPEC core 6): an order's conversation. OPEN while the parties chat; ESCALATED once a
 * party asked Hamro Pasal to decide; CLOSED when the 7-day window ended without an escalation (its
 * hold was released); the other three are the Super Admin's resolution.
 */
export const disputeStatuses = [
  'OPEN',
  'ESCALATED',
  'CLOSED',
  'RELEASED_TO_VENDOR',
  'REFUNDED_TO_CUSTOMER',
  'PARTIALLY_REFUNDED',
] as const;
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
 * default, and the only one that runs today), Model C DIRECT_PREPAID (activated 2026-10-21).
 */
export const settlementModels = ['COD_CREDIT', 'PLATFORM_ESCROW', 'DIRECT_PREPAID'] as const;
export const settlementModelSchema = z.enum(settlementModels);
export type SettlementModel = z.infer<typeof settlementModelSchema>;

/**
 * Payment routing (SPEC core 9): the methods a shop's settlement model allows. Model A is cash
 * only; Model B takes every method. Model C (activated 2026-10-21) takes every method too, but a
 * gateway only through the shop's own verified merchant account, and nothing at all while its
 * prepaid balance after the order's fee would fall below the Fixed Reserve (checked at checkout).
 * A shop's `accepted_payment_methods` can only narrow this list (WALLET follows eSewa / Khalti).
 */
export const SETTLEMENT_MODEL_PAYMENT_METHODS: Readonly<
  Record<SettlementModel, readonly PaymentMethod[]>
> = {
  COD_CREDIT: ['COD'],
  PLATFORM_ESCROW: ['ESEWA', 'KHALTI', 'COD', 'WALLET'],
  DIRECT_PREPAID: ['ESEWA', 'KHALTI', 'COD', 'WALLET'],
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

/** Step 7.1 (2026-10-15): the language server-written texts use for an account (§8Z.10). */
export const languagePreferences = ['en', 'ne'] as const;
export const languagePreferenceSchema = z.enum(languagePreferences);
export type LanguagePreference = z.infer<typeof languagePreferenceSchema>;

/** An account's own standing, apart from any role (a deleted or blocked person). */
export const accountStatuses = ['ACTIVE', 'DELETED_REQUESTED', 'SUSPENDED'] as const;
export const accountStatusSchema = z.enum(accountStatuses);
export type AccountStatus = z.infer<typeof accountStatusSchema>;

/** Who an in-app notification centre message is for (SPEC core 11). */
export const notificationAudiences = ['VENDOR', 'CUSTOMER', 'ALL_CUSTOMERS'] as const;
export const notificationAudienceSchema = z.enum(notificationAudiences);
export type NotificationAudience = z.infer<typeof notificationAudienceSchema>;

export const notificationSources = ['ADMIN', 'SYSTEM'] as const;
export const notificationSourceSchema = z.enum(notificationSources);
export type NotificationSource = z.infer<typeof notificationSourceSchema>;

/** Step 7.3: the vendor's switch over its opening hours (SPEC core 11). */
export const availabilityOverrides = ['NONE', 'OPEN', 'CLOSED'] as const;
export const availabilityOverrideSchema = z.enum(availabilityOverrides);
export type AvailabilityOverride = z.infer<typeof availabilityOverrideSchema>;

/** Why an orderable-looking shop takes no order right now. */
export const shopClosedReasons = ['HOURS', 'OVERRIDE', 'AUTO_PAUSED'] as const;
export const shopClosedReasonSchema = z.enum(shopClosedReasons);
export type ShopClosedReason = z.infer<typeof shopClosedReasonSchema>;
