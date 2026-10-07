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

function openTracking(response: TappedNotification): void {
  const orderId = trackedOrderOfTap(response);
  if (orderId !== null) router.push({ pathname: '/track-order', params: { id: orderId } });
}

/**
 * Tapping an order notification opens that order's tracking: while the app is running (the
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
