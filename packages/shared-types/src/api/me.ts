import { z } from 'zod';

import {
  accountStatusSchema,
  languagePreferenceSchema,
  notificationAudienceSchema,
  notificationSourceSchema,
  userRoleSchema,
} from '../domain/enums';
import { nepalPhoneSchema } from '../domain/entities';

/*
 * Step 7.1 (SPEC core 11, STATE_HANDOFF §8Z.10): the signed-in account's own record and its
 * notification centre. Any role. The account is always the access token's subject.
 */

export const FULL_NAME_MIN_LENGTH = 2;
export const FULL_NAME_MAX_LENGTH = 80;
export const MAX_EMAIL_LENGTH = 254;

/** "Sita Gurung": inner spaces collapsed. The server stores the first word and the rest apart. */
export const fullNameSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/\s+/g, ' '))
  .pipe(z.string().min(FULL_NAME_MIN_LENGTH).max(FULL_NAME_MAX_LENGTH));

/** Lower-cased: two spellings of one address are one address. */
export const accountEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(MAX_EMAIL_LENGTH));

/** PATCH /api/me: every key optional, at least one; only the keys sent change. */
export const mePatchRequestSchema = z
  .strictObject({
    full_name: fullNameSchema.optional(),
    email: accountEmailSchema.nullable().optional(),
    language_preference: languagePreferenceSchema.optional(),
    whatsapp_opt_in: z.boolean().optional(),
    /** The server stamps the time, once; the device never sends a timestamp for a consent. */
    accept_terms: z.literal(true).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Send at least one field' });
export type MePatchRequest = z.infer<typeof mePatchRequestSchema>;

export const meUserSchema = z.strictObject({
  id: z.uuid(),
  phone: nepalPhoneSchema,
  role: userRoleSchema,
  full_name: z.string().nullable(),
  email: z.email().nullable(),
  /** "Has a name": the email is optional (decided 2026-10-06). */
  profile_complete: z.boolean(),
  language_preference: languagePreferenceSchema,
  terms_accepted_at: z.iso.datetime().nullable(),
  whatsapp_opt_in: z.boolean(),
  account_status: accountStatusSchema,
});
export type MeUser = z.infer<typeof meUserSchema>;

export const meResponseSchema = z.strictObject({ user: meUserSchema });
export type MeResponseBody = z.infer<typeof meResponseSchema>;

export const NOTIFICATION_TITLE_MAX_LENGTH = 60;
export const NOTIFICATION_BODY_MAX_LENGTH = 240;
export const NOTIFICATION_LIST_DEFAULT_LIMIT = 20;
export const NOTIFICATION_LIST_MAX_LIMIT = 50;

export const notificationListQuerySchema = z.strictObject({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(NOTIFICATION_LIST_MAX_LIMIT)
    .default(NOTIFICATION_LIST_DEFAULT_LIMIT),
  /** A message id from the previous page. */
  cursor: z.uuid().optional(),
});

export const notificationViewSchema = z.strictObject({
  id: z.uuid(),
  audience: notificationAudienceSchema,
  source: notificationSourceSchema,
  title: z.string().min(1).max(NOTIFICATION_TITLE_MAX_LENGTH),
  body: z.string().min(1).max(NOTIFICATION_BODY_MAX_LENGTH),
  data: z.record(z.string(), z.json()),
  created_at: z.iso.datetime(),
  read_at: z.iso.datetime().nullable(),
});
export type NotificationView = z.infer<typeof notificationViewSchema>;

export const notificationListResponseSchema = z.strictObject({
  notifications: z.array(notificationViewSchema),
  next_cursor: z.uuid().nullable(),
});
export type NotificationListResponseBody = z.infer<typeof notificationListResponseSchema>;

export const notificationUnreadCountResponseSchema = z.strictObject({
  unread: z.number().int().min(0),
});

export const notificationReadResponseSchema = z.strictObject({
  notification: notificationViewSchema,
});

export const notificationReadAllResponseSchema = z.strictObject({
  marked: z.number().int().min(0),
});
