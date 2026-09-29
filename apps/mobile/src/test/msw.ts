import { setupServer } from 'msw/node';

import { API_URL } from '../config/api';
import { useAuthStore } from '../store/useAuthStore';
import { useCartStore } from '../store/useCartStore';
import { useCheckoutStore } from '../store/useCheckoutStore';

/** Intercepts every fetch; an unexpected request fails the test instead of reaching the network. */
export const server = setupServer();

export const apiUrl = (path: string): string => `${API_URL}${path}`;

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
  });
  afterEach(() => {
    server.resetHandlers();
  });
  afterAll(() => {
    server.close();
  });
}
