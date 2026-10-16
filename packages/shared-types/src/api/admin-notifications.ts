import { z } from 'zod';

import {
  ADMIN_NOTIFICATION_LIST_DEFAULT_LIMIT,
  MAX_ADMIN_NOTIFICATION_VENDORS,
} from '../domain/constants';
import { NOTIFICATION_BODY_MAX_LENGTH, NOTIFICATION_TITLE_MAX_LENGTH } from './me';
import { notificationAudienceSchema, vendorStatusSchema } from '../domain/enums';

/*
 * Step 7.5 (SPEC core 11, Super Admin flow 10): the Super Admin pushes a message to chosen vendors
 * or to all customers. Every message is kept in each recipient's notification centre, whether or
 * not the push reached a device.
 */

/** GET /api/admin/vendors/search?q=&limit= */
export const adminVendorSearchQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(60),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type AdminVendorSearchQuery = z.infer<typeof adminVendorSearchQuerySchema>;

/**
 * One search result. The Vendor Code is always shown next to the name, so two shops with similar
 * names are never mistaken for each other.
 */
export const adminVendorSearchResultSchema = z.strictObject({
  id: z.uuid(),
  vendor_code: z.string().regex(/^HPV-\d{5,}$/),
  business_name: z.string().min(1),
  municipality_palika_string: z.string(),
  status: vendorStatusSchema,
});
export type AdminVendorSearchResult = z.infer<typeof adminVendorSearchResultSchema>;

export const adminVendorSearchResponseSchema = z.strictObject({
  vendors: z.array(adminVendorSearchResultSchema),
});
export type AdminVendorSearchResponseBody = z.infer<typeof adminVendorSearchResponseSchema>;

const title = z.string().trim().min(1).max(NOTIFICATION_TITLE_MAX_LENGTH);
const body = z.string().trim().min(1).max(NOTIFICATION_BODY_MAX_LENGTH);
/** Where a tap on the message opens in the app: an app path such as `/orders`. */
const deepLink = z
  .string()
  .max(200)
  .regex(/^\/[A-Za-z0-9/_\-?=&.%]*$/, 'An app path starting with /');

/** POST /api/admin/notifications. */
export const adminNotificationRequestSchema = z.discriminatedUnion('audience', [
  z.strictObject({
    audience: z.literal('VENDORS'),
    /** 1 to 500 distinct shops. */
    vendor_ids: z
      .array(z.uuid())
      .min(1)
      .max(MAX_ADMIN_NOTIFICATION_VENDORS)
      .refine((ids) => new Set(ids).size === ids.length, 'Each vendor once'),
    title,
    body,
    deep_link: deepLink.optional(),
  }),
  z.strictObject({
    audience: z.literal('ALL_CUSTOMERS'),
    title,
    body,
    deep_link: deepLink.optional(),
  }),
]);
export type AdminNotificationRequest = z.infer<typeof adminNotificationRequestSchema>;

/** 202: stored and queued for the push. */
export const adminNotificationSentResponseSchema = z.strictObject({
  message_id: z.uuid(),
  recipient_count: z.number().int().min(0),
});
export type AdminNotificationSentResponseBody = z.infer<typeof adminNotificationSentResponseSchema>;

/** One message the Super Admin sent, with what the push did. */
export const adminNotificationViewSchema = z.strictObject({
  id: z.uuid(),
  audience: notificationAudienceSchema,
  title: z.string(),
  body: z.string(),
  deep_link: z.string().nullable(),
  recipient_count: z.number().int().min(0),
  /** Devices the push service accepted the message for, and refused; null until it ran. */
  push_sent: z.number().int().min(0).nullable(),
  push_failed: z.number().int().min(0).nullable(),
  push_completed_at: z.iso.datetime().nullable(),
  created_by_user_id: z.uuid(),
  created_at: z.iso.datetime(),
});
export type AdminNotificationView = z.infer<typeof adminNotificationViewSchema>;

/** GET /api/admin/notifications?cursor=&limit=, newest first. */
export const adminNotificationListQuerySchema = z.strictObject({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(ADMIN_NOTIFICATION_LIST_DEFAULT_LIMIT),
});
export type AdminNotificationListQuery = z.infer<typeof adminNotificationListQuerySchema>;

export const adminNotificationListResponseSchema = z.strictObject({
  notifications: z.array(adminNotificationViewSchema),
  next_cursor: z.uuid().nullable(),
});
export type AdminNotificationListResponseBody = z.infer<typeof adminNotificationListResponseSchema>;
