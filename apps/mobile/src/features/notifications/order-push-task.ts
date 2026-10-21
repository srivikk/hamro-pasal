import {
  ORDER_ALARM_CHANNEL_ID,
  ORDER_ALARM_SOUND,
  ORDER_PUSH_CHANNEL_ID,
  orderPushDataSchema,
  orderPushRings,
  type OrderPushData,
} from '@hamro-pasal/shared-types';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

/*
 * SPEC implicit requirement 1: critical order pushes (a new order for the vendor, a dispatch for
 * the customer) arrive data-only, so a budget Android device wakes the app silently instead of
 * relying on the system to draw them. This task receives every remote notification (foreground,
 * background or terminated) and posts the visible notification for the data-only ones itself.
 */

export const ORDER_PUSH_TASK = 'hamro-pasal.order-push';

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The order push inside a task payload, or null when it holds none. The platforms deliver the
 * `data` the worker sent in different places: Android as a JSON string (`data.dataString`, or
 * `data.body` in the raw FCM message), iOS as an object (`data.body`), or directly as `data`.
 */
export function orderPushFromTaskPayload(payload: unknown): OrderPushData | null {
  if (typeof payload !== 'object' || payload === null) return null;
  // A tap on a notification (Android runs the task for those too) is not an incoming push.
  if ('actionIdentifier' in payload) return null;
  const data: unknown = Reflect.get(payload, 'data');
  if (typeof data !== 'object' || data === null) return null;
  for (const candidate of [Reflect.get(data, 'dataString'), Reflect.get(data, 'body'), data]) {
    const parsed = orderPushDataSchema.safeParse(parseJson(candidate));
    if (parsed.success) return parsed.data;
  }
  return null;
}

/**
 * How the notification sounds (2026-10-21): a new order for the shop rings with the bundled alarm
 * at the highest priority; every other alert plays the default sound once.
 */
export function alertOf(
  data: Pick<OrderPushData, 'audience' | 'state'>,
): Pick<Notifications.NotificationContentInput, 'sound' | 'priority'> {
  return orderPushRings(data)
    ? { sound: ORDER_ALARM_SOUND, priority: Notifications.AndroidNotificationPriority.MAX }
    : { sound: 'default', priority: Notifications.AndroidNotificationPriority.HIGH };
}

/**
 * Posts the visible notification of a data-only push. The identifier is the event's id, so a
 * push delivered twice replaces its own notification instead of stacking a second one. The copy
 * is marked `data_only: false`: it is a finished notification, never to be posted again.
 */
export async function presentOrderPush(data: OrderPushData): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    identifier: data.notification_id,
    content: {
      title: data.title,
      body: data.body,
      ...alertOf(data),
      data: { ...data, data_only: false },
    },
    trigger:
      Platform.OS === 'android'
        ? { channelId: orderPushRings(data) ? ORDER_ALARM_CHANNEL_ID : ORDER_PUSH_CHANNEL_ID }
        : null,
  });
}

/** The task body: posts a data-only order push, ignores everything else. */
export async function handleOrderPushTask(
  payload: unknown,
): Promise<Notifications.BackgroundNotificationTaskResult> {
  const data = orderPushFromTaskPayload(payload);
  if (!data?.data_only) {
    return Notifications.BackgroundNotificationTaskResult.NoData;
  }
  try {
    await presentOrderPush(data);
    return Notifications.BackgroundNotificationTaskResult.NewData;
  } catch {
    return Notifications.BackgroundNotificationTaskResult.Failed;
  }
}

/**
 * Defines and registers the task. Must run at module scope of the app entry (index.ts): a
 * terminated app is started headless for a data-only push and only the entry module is evaluated.
 */
export function registerOrderPushTask(): void {
  if (Platform.OS === 'web') return;
  if (!TaskManager.isTaskDefined(ORDER_PUSH_TASK)) {
    TaskManager.defineTask<Notifications.NotificationTaskPayload>(ORDER_PUSH_TASK, ({ data }) =>
      handleOrderPushTask(data),
    );
  }
  // Rejects where background tasks are unsupported (Expo Go): pushes with a title still show.
  Notifications.registerTaskAsync(ORDER_PUSH_TASK).catch(() => undefined);
}
