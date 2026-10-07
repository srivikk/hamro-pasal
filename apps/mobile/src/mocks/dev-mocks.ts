import { API_URL } from '../config/api';
import { useOrderStore } from '../store/useOrderStore';

const OPEN_ORDER_STATES: ReadonlySet<string> = new Set([
  'PENDING_PAYMENT',
  'PLACED',
  'PREPARING',
  'OUT_FOR_DELIVERY',
]);

/** Orders this phone tracks that are neither delivered, cancelled nor failed. */
export function openOrderCount(): number {
  return Object.values(useOrderStore.getState().orders).filter((order) =>
    OPEN_ORDER_STATES.has(order.state),
  ).length;
}

/**
 * DEVELOPMENT ONLY. With `EXPO_PUBLIC_MOCK_ACCOUNT_API=true` in apps/mobile/.env, a development
 * build answers the not-yet-built account endpoints itself (MSW's React Native server); every
 * other request still goes to the real API. Off by default, and never part of a preview or
 * production bundle: the whole branch is removed when `__DEV__` is false.
 */
export function startDevMocks(): void {
  if (__DEV__ && process.env.EXPO_PUBLIC_MOCK_ACCOUNT_API === 'true') {
    // Both imports are inside the development branch, so MSW and the handlers are left out of a
    // preview or production bundle altogether.
    void Promise.all([import('msw/native'), import('./account-handlers')])
      .then(([{ setupServer }, { accountMockHandlers }]) => {
        setupServer(
          ...accountMockHandlers({ baseUrl: API_URL, pendingOrderCount: openOrderCount }),
        ).listen({ onUnhandledRequest: 'bypass' });
        console.info('[mocks] account endpoints are answered on the device (MSW)');
      })
      .catch((error: unknown) => {
        console.warn(`[mocks] could not start MSW: ${String(error)}`);
      });
  }
}
