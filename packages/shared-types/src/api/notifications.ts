import { z } from 'zod';

import { orderStateSchema } from '../domain/enums';

/*
 * Phase 20: push notifications (SPEC implicit requirement 1, Expo Push Notifications).
 * The app registers its Expo push token at POST /api/notifications/device-token; the worker sends
 * order updates to https://exp.host/--/api/v2/push/send with the `data` contract below.
 */

/**
 * An Expo push token: `ExponentPushToken[…]` or `ExpoPushToken[…]` (the two prefixes Expo issues).
 * Also the body of the `device_tokens_token_check` constraint.
 */
export const EXPO_PUSH_TOKEN_PATTERN = '^Expo(nent)?PushToken\\[.+\\]$';
export const EXPO_PUSH_TOKEN_REGEX = new RegExp(EXPO_PUSH_TOKEN_PATTERN);
export const EXPO_PUSH_TOKEN_MAX_LENGTH = 255;

export const expoPushTokenSchema = z
  .string()
  .max(EXPO_PUSH_TOKEN_MAX_LENGTH)
  .regex(EXPO_PUSH_TOKEN_REGEX, 'Must be an Expo push token');

export const devicePlatforms = ['ANDROID', 'IOS'] as const;
export const devicePlatformSchema = z.enum(devicePlatforms);
export type DevicePlatform = z.infer<typeof devicePlatformSchema>;

/** POST /api/notifications/device-token (any signed-in role). */
export const deviceTokenRegisterRequestSchema = z.strictObject({
  token: expoPushTokenSchema,
  platform: devicePlatformSchema,
});
export type DeviceTokenRegisterRequest = z.infer<typeof deviceTokenRegisterRequestSchema>;

export const deviceTokenRegisterResponseSchema = z.strictObject({
  device_token: z.strictObject({
    token: expoPushTokenSchema,
    platform: devicePlatformSchema,
    updated_at: z.iso.datetime(),
  }),
});
export type DeviceTokenRegisterResponseBody = z.infer<typeof deviceTokenRegisterResponseSchema>;

/** The Android notification channel order pushes are posted to (created by the app). */
export const ORDER_PUSH_CHANNEL_ID = 'orders';

export const ORDER_PUSH_TYPE = 'order.state_changed';

export const pushAudiences = ['CUSTOMER', 'VENDOR'] as const;
export type PushAudience = (typeof pushAudiences)[number];

/**
 * The `data` object of every order push. Critical pushes (a new order for the vendor, a dispatch
 * for the customer) are data-only (SPEC implicit requirement 1): they have no title or body of
 * their own (`data_only: true`), so the app builds the visible notification from `title` and
 * `body` here.
 * `notification_id` is the domain event's id: the app shows each one at most once.
 */
export const orderPushDataSchema = z.object({
  type: z.literal(ORDER_PUSH_TYPE),
  notification_id: z.uuid(),
  order_id: z.uuid(),
  state: orderStateSchema,
  audience: z.enum(pushAudiences),
  /** true: the push has no title or body of its own, the app must post the notification. */
  data_only: z.boolean(),
  title: z.string().min(1),
  body: z.string().min(1),
});
export type OrderPushData = z.infer<typeof orderPushDataSchema>;

/**
 * 2026-10-21 (Task 4): the Android channel a new order rings on, for the shop. Separate from
 * `ORDER_PUSH_CHANNEL_ID` because a channel's sound and importance can never change once the
 * phone has created it. Maximum importance, alarm audio, the Seller app's own alarm sound.
 */
export const ORDER_ALARM_CHANNEL_ID = 'order-alarm';

/** The alarm sound bundled with the app (assets/sounds), by its file name as the OS looks it up. */
export const ORDER_ALARM_SOUND = 'vendor-alarm.wav';

/** Whether a push rings the alarm: a new order for the shop. Every other alert sounds once. */
export function orderPushRings(data: Pick<OrderPushData, 'audience' | 'state'>): boolean {
  return data.audience === 'VENDOR' && data.state === 'PLACED';
}
