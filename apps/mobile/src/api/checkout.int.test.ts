import { checkoutRequestSchema } from '@hamro-pasal/shared-types';
import { act, waitFor } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import { useAddressStore } from '../store/useAddressStore';
import { useAuthStore } from '../store/useAuthStore';
import { useCartStore } from '../store/useCartStore';
import { useCheckoutStore } from '../store/useCheckoutStore';
import { useDeliveryOtpStore } from '../store/useDeliveryOtpStore';
import {
  checkoutResponse,
  errorBody,
  NOODLES,
  ORDER_ID,
  RESERVATION_ID,
  RICE,
  THAMEL_ADDRESS,
  THAMEL_VENDOR,
} from '../test/api-fixtures';
import {
  apiUrl,
  capture,
  server,
  TEST_ACCESS_TOKEN,
  setupApiTestEnvironment,
  type CapturedRequest,
} from '../test/msw';
import { renderHookWithProviders } from '../test/render';
import { CLIENT_ERROR_CODES } from './http';
import { CHECKOUT_PATH, NO_DELIVERY_ADDRESS, useCheckout } from './mutations';

setupApiTestEnvironment();

/** Answers every checkout with `respond` and records what the server received. */
function checkoutEndpoint(respond: (call: number) => Response | Promise<Response>) {
  const received: CapturedRequest[] = [];
  server.use(
    http.post(apiUrl(CHECKOUT_PATH), async ({ request }) => {
      received.push(await capture(request));
      return respond(received.length);
    }),
  );
  return received;
}

function fillCart(): void {
  useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 2);
  useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 1);
}

async function checkoutWith(paymentMethod: 'ESEWA' | 'KHALTI' | 'COD') {
  const { result } = renderHookWithProviders(() => useCheckout());
  await act(async () => {
    await result.current.mutateAsync(paymentMethod).catch(() => undefined);
  });
  await waitFor(() => {
    expect(result.current.isSuccess || result.current.isError).toBe(true);
  });
  return result;
}

describe('useCheckout → POST /api/cart/checkout', () => {
  it('sends the Bearer token from useAuthStore and a JSON body', async () => {
    const received = checkoutEndpoint(() => HttpResponse.json(checkoutResponse(), { status: 201 }));
    fillCart();

    await checkoutWith('ESEWA');

    expect(received).toHaveLength(1);
    const [request] = received;
    expect(request?.method).toBe('POST');
    expect(request?.url.href).toBe('http://api.hamropasal.test/api/cart/checkout');
    expect(request?.headers.get('authorization')).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
    expect(request?.headers.get('content-type')).toBe('application/json');
    expect(request?.headers.get('accept')).toBe('application/json');
  });

  it('maps the cart to the shared-types checkout schema, with no client prices', async () => {
    const received = checkoutEndpoint(() => HttpResponse.json(checkoutResponse(), { status: 201 }));
    fillCart();

    await checkoutWith('KHALTI');

    const body = received[0]?.body;
    // Strict schema: unknown keys (prices, names, totals) would fail this parse.
    expect(checkoutRequestSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      idempotency_key: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ) as unknown,
      vendor_id: THAMEL_VENDOR.id,
      payment_method: 'KHALTI',
      items: [
        { product_id: NOODLES.id, quantity: 2 },
        { product_id: RICE.id, quantity: 1 },
      ],
      delivery_address: {
        province_id: THAMEL_ADDRESS.province_id,
        district_string: THAMEL_ADDRESS.district_string,
        municipality_palika_string: THAMEL_ADDRESS.municipality_palika_string,
        ward_number: THAMEL_ADDRESS.ward_number,
        tole_locality: THAMEL_ADDRESS.tole_locality,
        landmark: THAMEL_ADDRESS.landmark,
        exact_lat: THAMEL_ADDRESS.exact_lat,
        exact_lng: THAMEL_ADDRESS.exact_lng,
      },
    });
  });

  it('does not send anything without a saved delivery address', async () => {
    const received = checkoutEndpoint(() => HttpResponse.json(checkoutResponse(), { status: 201 }));
    fillCart();
    useAddressStore.getState().clearAddress();

    const result = await checkoutWith('COD');

    expect(received).toHaveLength(0);
    expect(result.current.error?.code).toBe(NO_DELIVERY_ADDRESS);
    expect(useCartStore.getState().lines).toHaveLength(2);
  });

  it('starts a new attempt when the delivery address changes', async () => {
    const received = checkoutEndpoint(() =>
      HttpResponse.json(errorBody('CHECKOUT_BUSY'), { status: 503 }),
    );
    fillCart();

    await checkoutWith('ESEWA');
    useAddressStore.getState().setAddress({ ...THAMEL_ADDRESS, ward_number: 16 });
    await checkoutWith('ESEWA');

    const bodies = received.map(
      (request) =>
        request.body as { idempotency_key: string; delivery_address: { ward_number: number } },
    );
    expect(bodies.map((b) => b.delivery_address.ward_number)).toEqual([26, 16]);
    expect(bodies[1]?.idempotency_key).not.toBe(bodies[0]?.idempotency_key);
  });

  it('reads the access token at call time, so a refreshed token is used immediately', async () => {
    const received = checkoutEndpoint(() => HttpResponse.json(checkoutResponse(), { status: 201 }));
    fillCart();
    useAuthStore.getState().setAccessToken('rotated.access.token');

    await checkoutWith('ESEWA');

    expect(received[0]?.headers.get('authorization')).toBe('Bearer rotated.access.token');
  });

  it('does not send anything without an access token', async () => {
    const received = checkoutEndpoint(() => HttpResponse.json(checkoutResponse(), { status: 201 }));
    fillCart();
    useAuthStore.getState().clearSession();

    const result = await checkoutWith('ESEWA');

    expect(received).toHaveLength(0);
    expect(result.current.error?.code).toBe(CLIENT_ERROR_CODES.notSignedIn);
  });

  it('saves the delivery OTP to encrypted storage, keeping only the newest on replay', async () => {
    checkoutEndpoint((call) =>
      HttpResponse.json(checkoutResponse({ otp: call === 1 ? '4821' : '0427' }), {
        status: call === 1 ? 201 : 200,
      }),
    );
    fillCart();

    await checkoutWith('ESEWA');
    expect(useDeliveryOtpStore.getState().otps[ORDER_ID]).toBe('4821');
    await checkoutWith('ESEWA');

    expect(useDeliveryOtpStore.getState().otps[ORDER_ID]).toBe('0427');
  });

  it('starts a checkout session for a prepaid order and keeps the cart until payment', async () => {
    checkoutEndpoint(() =>
      HttpResponse.json(checkoutResponse({ expiresAt: '2026-09-29T10:10:00.000Z' }), {
        status: 201,
      }),
    );
    fillCart();

    const result = await checkoutWith('ESEWA');

    expect(result.current.isSuccess).toBe(true);
    expect(useCheckoutStore.getState()).toMatchObject({
      session: {
        orderId: ORDER_ID,
        reservationId: RESERVATION_ID,
        expiresAt: '2026-09-29T10:10:00.000Z',
        orderState: 'PENDING_PAYMENT',
        paymentMethod: 'ESEWA',
        totalNpr: 2400,
      },
      attempt: null,
      deliveryOtp: '4821',
    });
    expect(useCartStore.getState().lines).toHaveLength(2);
  });

  it('empties the cart when a COD order is placed at once', async () => {
    checkoutEndpoint(() =>
      HttpResponse.json(
        checkoutResponse({
          order: { state: 'PLACED', payment_method: 'COD', payment_status: 'PENDING' },
        }),
        { status: 201 },
      ),
    );
    fillCart();

    await checkoutWith('COD');

    expect(useCartStore.getState()).toMatchObject({ vendor: null, lines: [] });
    expect(useCheckoutStore.getState().session?.orderState).toBe('PLACED');
  });

  it('reuses the idempotency key when the same cart is retried after a failure', async () => {
    const received = checkoutEndpoint((call) =>
      call === 1
        ? HttpResponse.json(errorBody('CHECKOUT_BUSY'), { status: 503 })
        : HttpResponse.json(checkoutResponse(), { status: 201 }),
    );
    fillCart();

    await checkoutWith('ESEWA');
    await checkoutWith('ESEWA');

    expect(received).toHaveLength(2);
    const [first, second] = received.map(
      (request) => (request.body as { idempotency_key: string }).idempotency_key,
    );
    expect(second).toBe(first);
  });

  it('reuses the key after a network failure too', async () => {
    let call = 0;
    const keys: string[] = [];
    server.use(
      http.post(apiUrl(CHECKOUT_PATH), async ({ request }) => {
        call += 1;
        keys.push(((await request.json()) as { idempotency_key: string }).idempotency_key);
        return call === 1
          ? HttpResponse.error()
          : HttpResponse.json(checkoutResponse(), { status: 201 });
      }),
    );
    fillCart();

    const failed = await checkoutWith('ESEWA');
    expect(failed.current.error?.code).toBe(CLIENT_ERROR_CODES.network);
    await checkoutWith('ESEWA');

    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it('uses a new key once the cart or payment method changes', async () => {
    const received = checkoutEndpoint(() =>
      HttpResponse.json(errorBody('CHECKOUT_BUSY'), { status: 503 }),
    );
    fillCart();

    await checkoutWith('ESEWA');
    useCartStore.getState().setQuantity(RICE.id, 2);
    await checkoutWith('ESEWA');
    await checkoutWith('KHALTI');

    const keys = received.map(
      (request) => (request.body as { idempotency_key: string }).idempotency_key,
    );
    expect(new Set(keys).size).toBe(3);
  });

  it('drops a key the server reports as reused, so the next attempt gets a fresh one', async () => {
    const received = checkoutEndpoint((call) =>
      call === 1
        ? HttpResponse.json(errorBody('IDEMPOTENCY_KEY_REUSED'), { status: 409 })
        : HttpResponse.json(checkoutResponse(), { status: 201 }),
    );
    fillCart();

    const first = await checkoutWith('ESEWA');
    expect(first.current.error?.code).toBe('IDEMPOTENCY_KEY_REUSED');
    await checkoutWith('ESEWA');

    const keys = received.map(
      (request) => (request.body as { idempotency_key: string }).idempotency_key,
    );
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('purges the cart and flags "Session Expired" on 410 RESERVATION_EXPIRED', async () => {
    checkoutEndpoint(() => HttpResponse.json(errorBody('RESERVATION_EXPIRED'), { status: 410 }));
    fillCart();

    const result = await checkoutWith('ESEWA');

    expect(result.current.error?.status).toBe(410);
    expect(useCartStore.getState().lines).toHaveLength(0);
    expect(useCheckoutStore.getState()).toMatchObject({ session: null, sessionExpired: true });
  });

  it('surfaces business errors with their code and details, leaving the cart intact', async () => {
    checkoutEndpoint(() =>
      HttpResponse.json(errorBody('INSUFFICIENT_STOCK', { shortfalls: [{ productId: RICE.id }] }), {
        status: 409,
      }),
    );
    fillCart();

    const result = await checkoutWith('COD');

    expect(result.current.error).toMatchObject({
      status: 409,
      code: 'INSUFFICIENT_STOCK',
      details: { shortfalls: [{ productId: RICE.id }] },
    });
    expect(useCartStore.getState().lines).toHaveLength(2);
    expect(useCheckoutStore.getState().session).toBeNull();
  });

  it('rejects a success body that breaks the response contract', async () => {
    checkoutEndpoint(() => HttpResponse.json({ order: { id: ORDER_ID } }, { status: 201 }));
    fillCart();

    const result = await checkoutWith('ESEWA');

    expect(result.current.error?.code).toBe(CLIENT_ERROR_CODES.badResponse);
    expect(useCheckoutStore.getState().session).toBeNull();
  });

  it('refuses to send a cart whose IDs are not uuids (checkout contract)', async () => {
    const received = checkoutEndpoint(() => HttpResponse.json(checkoutResponse(), { status: 201 }));
    useCartStore
      .getState()
      .addItem({ ...THAMEL_VENDOR, id: 'not-a-uuid' }, { id: 'p1', name: 'X', unitPriceNpr: 10 });

    const result = await checkoutWith('ESEWA');

    expect(received).toHaveLength(0);
    expect(result.current.error?.code).toBe('INVALID_CART');
  });
});
