import { z } from 'zod';

import { discountKindSchema, type DiscountKind } from '../domain/enums';

/*
 * A vendor's own offers (Phase 32, SPEC core 7 "Vendor Offers"), served under /api/vendor/offers
 * to the shop's own account. The vendor funds an offer entirely, so no body names a vendor (the
 * shop is the caller's) and nobody else can create one.
 *
 * A rule is never edited: the shop ends it and makes a new one, so an order always points at the
 * exact rule it was priced with. Not applied to any price yet: checkout reads offers in a later
 * phase.
 */

/** The most offers a shop may have running or scheduled at once. */
export const MAX_LIVE_VENDOR_OFFERS = 10;
export const MAX_VENDOR_OFFER_AMOUNT_NPR = 1_000_000;

/**
 * An offer's standing, derived on every read (nothing stored goes stale):
 * CANCELLED the shop ended it; ENDED its `ends_at` has passed; ACTIVE otherwise (an offer whose
 * `starts_at` lies ahead is ACTIVE and not yet running).
 */
export const vendorOfferStatuses = ['ACTIVE', 'ENDED', 'CANCELLED'] as const;
export const vendorOfferStatusSchema = z.enum(vendorOfferStatuses);
export type VendorOfferStatus = z.infer<typeof vendorOfferStatusSchema>;

export function vendorOfferStatusOf(
  offer: { readonly ended_at: Date | null; readonly ends_at: Date | null },
  now: Date,
): VendorOfferStatus {
  if (offer.ended_at !== null) return 'CANCELLED';
  if (offer.ends_at !== null && offer.ends_at.getTime() <= now.getTime()) return 'ENDED';
  return 'ACTIVE';
}

const rupees = (amount: number) => (Number.isInteger(amount) ? String(amount) : amount.toFixed(2));

/** The offer as customers read it: "Flat Rs. 100 OFF", "10% OFF", "20% OFF up to Rs. 100". */
export function vendorOfferLabel(offer: {
  readonly kind: DiscountKind;
  readonly value: number;
  readonly max_discount_npr: number | null;
}): string {
  if (offer.kind === 'FLAT') return `Flat Rs. ${rupees(offer.value)} OFF`;
  const cap = offer.max_discount_npr === null ? '' : ` up to Rs. ${rupees(offer.max_discount_npr)}`;
  return `${String(offer.value)}% OFF${cap}`;
}

const offerAmount = z.number().multipleOf(0.01).max(MAX_VENDOR_OFFER_AMOUNT_NPR);

/**
 * The body of POST /api/vendor/offers. Strict: no vendor, label, status or start date (an offer
 * starts when it is created).
 */
export const vendorOfferCreateRequestSchema = z
  .strictObject({
    kind: discountKindSchema,
    /** NPR for FLAT; percent for PERCENTAGE. */
    value: offerAmount.positive(),
    /** The cart subtotal the offer applies from. A flat offer needs one of at least its value. */
    min_cart_npr: offerAmount.min(0).default(0),
    /** The most one order is discounted; PERCENTAGE only. */
    max_discount_npr: offerAmount.positive().nullable().default(null),
    /** Null: until the shop ends it. */
    ends_at: z.iso.datetime().nullable().default(null),
  })
  .refine((offer) => offer.kind !== 'PERCENTAGE' || offer.value <= 100, {
    path: ['value'],
    message: 'A percentage is at most 100',
  })
  .refine((offer) => offer.kind === 'PERCENTAGE' || offer.max_discount_npr === null, {
    path: ['max_discount_npr'],
    message: 'Only a percentage discount has a cap',
  })
  // A flat discount never exceeds the goods it is taken from.
  .refine((offer) => offer.kind !== 'FLAT' || offer.min_cart_npr >= offer.value, {
    path: ['min_cart_npr'],
    message: 'A flat discount needs a minimum order of at least its amount',
  });
export type VendorOfferCreateRequest = z.output<typeof vendorOfferCreateRequestSchema>;

/** An offer as the shop that made it sees it. */
export const vendorOfferViewSchema = z.strictObject({
  id: z.uuid(),
  kind: discountKindSchema,
  value: z.number().positive(),
  max_discount_npr: z.number().positive().nullable(),
  min_cart_npr: z.number().min(0),
  /** Rendered by the server from the rule. */
  label: z.string().min(1),
  starts_at: z.iso.datetime(),
  ends_at: z.iso.datetime().nullable(),
  status: vendorOfferStatusSchema,
  created_at: z.iso.datetime(),
  /** When the shop ended it; null unless CANCELLED. */
  ended_at: z.iso.datetime().nullable(),
});
export type VendorOfferView = z.infer<typeof vendorOfferViewSchema>;

/** GET /api/vendor/offers: every offer of the shop, newest first (at most 100). */
export const vendorOfferListResponseSchema = z.strictObject({
  offers: z.array(vendorOfferViewSchema),
});
export type VendorOfferListResponseBody = z.infer<typeof vendorOfferListResponseSchema>;

/** POST /api/vendor/offers (201) and POST /api/vendor/offers/:id/end (200, also on repeat). */
export const vendorOfferResponseSchema = z.strictObject({ offer: vendorOfferViewSchema });
export type VendorOfferResponseBody = z.infer<typeof vendorOfferResponseSchema>;
