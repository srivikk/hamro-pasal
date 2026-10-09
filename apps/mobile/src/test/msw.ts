import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { API_URL } from '../config/api';
import { accountMockHandlers } from '../mocks/account-handlers';
import { useAddressStore } from '../store/useAddressStore';
import { useBrowseLocationStore } from '../store/useBrowseLocationStore';
import { useProfileStore } from '../store/useProfileStore';
import { useAuthStore } from '../store/useAuthStore';
import { useCartStore } from '../store/useCartStore';
import { useCheckoutStore } from '../store/useCheckoutStore';
import { toNpr, toPaisa } from '../lib/money';
import { cartQuote, THAMEL_ADDRESS, vendorMenu } from './api-fixtures';

export const apiUrl = (path: string): string => `${API_URL}${path}`;

/**
 * Intercepts every fetch; an unexpected request fails the test instead of reaching the network.
 * Two standing answers, both overridden by `server.use`:
 * - an empty taxonomy: the Home screen always asks for the category pills (Phase 18), and most of
 *   its tests are about something else;
 * - a serviceable vendor menu: "Proceed to Checkout" first asks whether the shop delivers to the
 *   delivery address, and most checkout tests are about what happens after that;
 * - the cart's quote: a signed-in cart with an address always asks the server for its price.
 *   By default the answer is what the cart on the device adds up to, with no discount and every
 *   payment method, so a test about something else sees the totals it always did;
 * - the account endpoints (PATCH /api/me, deletion): signing in copies the language to the
 *   account, so every sign-in test would otherwise need its own handler. The same handlers a
 *   development build can run on the device (src/mocks).
 */
export const server = setupServer(
  http.get(apiUrl('/api/categories'), () => HttpResponse.json({ categories: [] })),
  // Home always asks for the admin's promotions; none by default.
  http.get(apiUrl('/api/home/promotions'), () => HttpResponse.json({ banners: [], offers: [] })),
  http.get(apiUrl('/api/vendors/:id/products'), () => HttpResponse.json(vendorMenu())),
  http.post(apiUrl('/api/cart/quote'), () => {
    const { vendor, lines } = useCartStore.getState();
    const subtotal = lines.reduce(
      (sum, line) => sum + toPaisa(line.unitPriceNpr) * line.quantity,
      0,
    );
    const fee = toPaisa(vendor?.deliveryFeeNpr ?? 0);
    return HttpResponse.json(
      cartQuote({
        subtotal_npr: toNpr(subtotal),
        delivery_fee_npr: toNpr(fee),
        total_npr: toNpr(subtotal + fee),
      }),
    );
  }),
  // The vendor's Shop settings always ask what tax identity is on file; nothing by default.
  http.get(apiUrl('/api/vendor/tax-identity'), () =>
    HttpResponse.json({
      vendor_id: '7b1f0c8e-0000-4000-8000-0000000000aa',
      tax_id: null,
      is_vat_registered: false,
      legal_name: null,
      registered_address: null,
      status: 'LIVE',
      pan_verified_at: null,
      has_pan_document: false,
    }),
  ),
  // The shop page reads its products' categories from the public list; none by default.
  http.get(apiUrl('/api/products'), () => HttpResponse.json({ products: [], next_cursor: null })),
  ...accountMockHandlers({ baseUrl: API_URL }),
);

export interface CapturedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

/** Reads what a handler received, so tests can assert on the exact wire format. */
export async function capture(request: Request): Promise<CapturedRequest> {
  const text = await request.clone().text();
  return {
    method: request.method,
    url: new URL(request.url),
    headers: request.headers,
    body: text === '' ? undefined : (JSON.parse(text) as unknown),
  };
}

export const TEST_ACCESS_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.test-access-token.signature';

/** Registers msw for the file and resets every global store between tests. */
export function setupApiTestEnvironment(): void {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'error' });
  });
  beforeEach(() => {
    useCartStore.getState().clearCart();
    useCheckoutStore.setState({
      session: null,
      attempt: null,
      deliveryOtp: null,
      sessionExpired: false,
    });
    useAuthStore.getState().setAccessToken(TEST_ACCESS_TOKEN);
    // Checkout requires a delivery address (Phase 5.6); API tests start with a valid one saved.
    useAddressStore.getState().clearAddress();
    useAddressStore.getState().setAddress(THAMEL_ADDRESS);
    // Checkout is offered only with a completed profile; the test token has no readable subject.
    useProfileStore
      .getState()
      .setProfile({ full_name: 'Aarav Shrestha', email: 'aarav@example.com' }, null);
    useBrowseLocationStore.getState().clearOverride();
    useBrowseLocationStore.setState({ device: null, deviceChecked: false, locationPrompt: 'idle' });
  });
  afterEach(() => {
    server.resetHandlers();
  });
  afterAll(() => {
    server.close();
  });
}
