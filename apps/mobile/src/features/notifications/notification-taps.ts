import { orderPushDataSchema } from '@hamro-pasal/shared-types';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect } from 'react';

/** The part of a notification response this module reads. */
interface TappedNotification {
  readonly notification: { readonly request: { readonly content: { readonly data?: unknown } } };
}

/**
 * The order a tapped notification is about, when it is one of the worker's order pushes sent to
 * the customer (STATE_HANDOFF §8X). Vendor pushes open the app on the vendor dashboard anyway
 * (role routing), so they name no order here.
 */
export function trackedOrderOfTap(response: TappedNotification): string | null {
  const data = orderPushDataSchema.safeParse(response.notification.request.content.data);
  if (!data.success || data.data.audience !== 'CUSTOMER') return null;
  return data.data.order_id;
}

/**
 * Step 7.5: where a tapped admin message opens: its in-app link when the Super Admin gave one,
 * otherwise the notification centre, where the message is kept. Null for any other push.
 */
export function adminMessageRouteOfTap(response: TappedNotification): string | null {
  const data = response.notification.request.content.data;
  if (typeof data !== 'object' || data === null) return null;
  const fields = data as Record<string, unknown>;
  if (fields.type !== 'admin.message') return null;
  const link = fields.deep_link;
  return typeof link === 'string' && /^\/[A-Za-z0-9/_\-?=&.%]*$/.test(link)
    ? link
    : '/notifications';
}

function openTracking(response: TappedNotification): void {
  const orderId = trackedOrderOfTap(response);
  if (orderId !== null) {
    router.push({ pathname: '/track-order', params: { id: orderId } });
    return;
  }
  const route = adminMessageRouteOfTap(response);
  if (route !== null) router.push(route as never);
}

/**
 * Tapping an order notification opens that order's tracking, and an admin message its link or the
 * notification centre (step 7.5): while the app is running (the
 * listener) and when the tap is what started it (the last response, read once at mount).
 */
export function useOrderNotificationTaps(): void {
  useEffect(() => {
    // The tap that started the app, if any (read once).
    const launch = Notifications.getLastNotificationResponse();
    if (launch !== null) openTracking(launch);
    const subscription = Notifications.addNotificationResponseReceivedListener(openTracking);
    return () => {
      subscription.remove();
    };
  }, []);
}
