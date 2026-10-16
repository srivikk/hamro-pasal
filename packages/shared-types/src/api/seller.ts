import { z } from 'zod';

import {
  deliveryScopeSchema,
  vendorFulfillmentModeSchema,
  userRoleSchema,
  vendorStatusSchema,
} from '../domain/enums';
import { nepalPhoneSchema } from '../domain/entities';
import { authTokensResponseSchema } from './responses';

/*
 * Step 7.7 (SPEC core 11, verification 32): the Seller app and vendor onboarding. One account per
 * phone number may hold several roles (decided 2026-10-15); each app signs in with its own role.
 */

/** Which app a sign-in comes from. Absent: the account's primary role (the web dashboard). */
export const appVariants = ['CUSTOMER', 'SELLER'] as const;
export const appVariantSchema = z.enum(appVariants);
export type AppVariant = z.infer<typeof appVariantSchema>;

/**
 * `403 ROLE_NOT_GRANTED` from POST /api/auth/otp/verify with `app: SELLER` for a number that has no
 * shop yet: the code was right, so it carries a short-lived token that proves the number for
 * POST /api/seller/signup.
 */
export const roleNotGrantedDetailsSchema = z.strictObject({
  role: userRoleSchema,
  signup_token: z.string().min(1),
  signup_token_expires_in: z.number().int().positive(),
});
export type RoleNotGrantedDetails = z.infer<typeof roleNotGrantedDetailsSchema>;

/**
 * A new shop's delivery radius when its form leaves it out (RADIUS_BOUND). The vendor changes it,
 * with the fee and the minimum order (both 0 at first), in its delivery settings.
 */
export const NEW_SHOP_DEFAULT_RADIUS_KM = 3;
const radiusKm = z
  .number()
  .positive()
  .max(100)
  .multipleOf(0.01)
  .default(NEW_SHOP_DEFAULT_RADIUS_KM);

const businessName = z.string().trim().min(2).max(100);
const palika = z.string().trim().min(2).max(120);
const location = z.strictObject({
  lat: z.number().min(26.3).max(30.5),
  lng: z.number().min(80).max(88.3),
});

/**
 * POST /api/seller/signup: self-signup in the Seller app. The shop starts SANDBOXED (vendor flow
 * step 2) with the delivery defaults; documents follow through the upload routes.
 */
export const sellerSignupRequestSchema = z.strictObject({
  signup_token: z.string().min(1),
  business_name: businessName,
  municipality_palika_string: palika,
  location,
  fulfillment_mode: vendorFulfillmentModeSchema.default('SELF_DELIVERY'),
  delivery_scope: deliveryScopeSchema.default('RADIUS_BOUND'),
  radius_km: radiusKm,
});
export type SellerSignupRequest = z.infer<typeof sellerSignupRequestSchema>;

/** What a new or SANDBOXED shop still needs before an admin can approve it. */
export const sellerApplicationViewSchema = z.strictObject({
  vendor_id: z.uuid(),
  vendor_code: z.string(),
  business_name: z.string(),
  status: vendorStatusSchema,
  pan_document_uploaded: z.boolean(),
  citizenship_document_uploaded: z.boolean(),
  tax_id_saved: z.boolean(),
  /** Every document is in: the shop waits for a Super Admin's approval. */
  ready_for_review: z.boolean(),
  created_at: z.iso.datetime(),
});
export type SellerApplicationView = z.infer<typeof sellerApplicationViewSchema>;

export const sellerApplicationResponseSchema = z.strictObject({
  application: sellerApplicationViewSchema,
});
export type SellerApplicationResponseBody = z.infer<typeof sellerApplicationResponseSchema>;

/** POST /api/admin/vendors: the Super Admin creates a shop and its account (or adds the role). */
export const adminVendorCreateRequestSchema = z.strictObject({
  phone: nepalPhoneSchema,
  business_name: businessName,
  municipality_palika_string: palika,
  location,
  fulfillment_mode: vendorFulfillmentModeSchema.default('SELF_DELIVERY'),
  delivery_scope: deliveryScopeSchema.default('RADIUS_BOUND'),
  radius_km: radiusKm,
  /** APPROVED skips the review for a shop the admin vetted in person. Default SANDBOXED. */
  status: z.enum(['SANDBOXED', 'APPROVED']).default('SANDBOXED'),
});
export type AdminVendorCreateRequest = z.infer<typeof adminVendorCreateRequestSchema>;

export const adminVendorCreatedResponseSchema = z.strictObject({
  vendor_id: z.uuid(),
  vendor_code: z.string(),
  user_id: z.uuid(),
  status: vendorStatusSchema,
  /** The number had no account yet: it was created. */
  account_created: z.boolean(),
  /** The invitation SMS with the Seller app link was sent. */
  invite_sent: z.boolean(),
});
export type AdminVendorCreatedResponseBody = z.infer<typeof adminVendorCreatedResponseSchema>;

/** POST /api/admin/vendors/:id/approve: SANDBOXED -> APPROVED once its KYC documents are in. */
export const adminVendorApprovedResponseSchema = z.strictObject({
  vendor_id: z.uuid(),
  status: vendorStatusSchema,
});
export type AdminVendorApprovedResponseBody = z.infer<typeof adminVendorApprovedResponseSchema>;

/* Step 7.8: in-app video tutorials. */

/** A YouTube video id: 11 characters of letters, digits, `_` and `-`. */
export const youtubeVideoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/, 'A YouTube video id');

export const tutorialViewSchema = z.strictObject({
  id: z.uuid(),
  app: appVariantSchema,
  youtube_video_id: youtubeVideoIdSchema,
  title: z.string().min(1).max(80),
  display_order: z.number().int().min(0),
  is_active: z.boolean(),
});
export type TutorialView = z.infer<typeof tutorialViewSchema>;

/** GET /api/tutorials?app= (public: the active videos, in order). */
export const tutorialListQuerySchema = z.strictObject({ app: appVariantSchema });
export const tutorialListResponseSchema = z.strictObject({
  tutorials: z.array(tutorialViewSchema),
});
export type TutorialListResponseBody = z.infer<typeof tutorialListResponseSchema>;

/** POST and PUT /api/admin/tutorials[/:id]. */
export const tutorialWriteRequestSchema = z.strictObject({
  app: appVariantSchema,
  youtube_video_id: youtubeVideoIdSchema,
  title: z.string().trim().min(1).max(80),
  display_order: z.number().int().min(0).max(1000).default(0),
  is_active: z.boolean().default(true),
});
export type TutorialWriteRequest = z.infer<typeof tutorialWriteRequestSchema>;

export const tutorialResponseSchema = z.strictObject({ tutorial: tutorialViewSchema });
export type TutorialResponseBody = z.infer<typeof tutorialResponseSchema>;

/**
 * 201 from POST /api/seller/signup: a vendor session (as POST /api/auth/otp/verify answers one) and
 * the new shop's application.
 */
export const sellerSignupResponseSchema = authTokensResponseSchema.extend({
  application: sellerApplicationViewSchema,
});
export type SellerSignupResponseBody = z.infer<typeof sellerSignupResponseSchema>;
