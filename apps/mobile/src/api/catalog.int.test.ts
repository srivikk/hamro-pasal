import { act, waitFor } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import { useFeedQuery } from '../features/feed/useFeedQuery';
import {
  customerLocationFrom,
  THAMEL_FALLBACK_LOCATION,
  useCustomerLocation,
} from '../features/location/customer-location';
import { useVendorMenuQuery } from '../features/menu/useVendorMenuQuery';
import { useAddressStore } from '../store/useAddressStore';
import {
  errorBody,
  feedResponse,
  feedVendor,
  THAMEL_ADDRESS,
  THAMEL_VENDOR,
  vendorMenu,
} from '../test/api-fixtures';
import {
  apiUrl,
  capture,
  server,
  setupApiTestEnvironment,
  type CapturedRequest,
} from '../test/msw';
import { renderHookWithProviders } from '../test/render';
import {
  fetchFeed,
  fetchVendorMenu,
  VENDOR_NOT_FOUND,
  VENDORS_PATH,
  vendorProductsPath,
} from './catalog';
import { ApiError, CLIENT_ERROR_CODES } from './http';

setupApiTestEnvironment();

function endpoint(path: string, respond: () => Response) {
  const received: CapturedRequest[] = [];
  server.use(
    http.get(apiUrl(path), async ({ request }) => {
      received.push(await capture(request));
      return respond();
    }),
  );
  return received;
}

const queryOf = (request: CapturedRequest | undefined) =>
  Object.fromEntries(request?.url.searchParams ?? []);

describe('customer location', () => {
  it("uses the saved address's exact pin and Palika", () => {
    expect(customerLocationFrom({ ...THAMEL_ADDRESS, exact_lat: 27.7, exact_lng: 85.33 })).toEqual({
      lat: 27.7,
      lng: 85.33,
      municipalityPalika: 'Kathmandu Metropolitan City',
    });
  });

  it('falls back to Thamel when no address is saved', () => {
    expect(customerLocationFrom(null)).toEqual({
      lat: 27.7154,
      lng: 85.3123,
      municipalityPalika: 'Kathmandu Metropolitan City',
    });
  });

  it('follows the address store', () => {
    useAddressStore.getState().clearAddress();
    const { result } = renderHookWithProviders(() => useCustomerLocation());
    expect(result.current).toBe(THAMEL_FALLBACK_LOCATION);

    act(() => {
      useAddressStore.getState().setAddress({ ...THAMEL_ADDRESS, exact_lat: 27.71 });
    });

    expect(result.current.lat).toBe(27.71);
  });
});

describe('GET /api/vendors', () => {
  it('is public (no Bearer token), sends the location, and parses feedResponseSchema', async () => {
    const received = endpoint(VENDORS_PATH, () => HttpResponse.json(feedResponse()));

    const feed = await fetchFeed(customerLocationFrom(THAMEL_ADDRESS));

    expect(received).toHaveLength(1);
    expect(received[0]?.headers.get('authorization')).toBeNull();
    expect(received[0]?.url.pathname).toBe('/api/vendors');
    expect(queryOf(received[0])).toEqual({
      lat: '27.7154',
      lng: '85.3123',
      municipality_palika_string: 'Kathmandu Metropolitan City',
    });
    expect(feed).toEqual(feedResponse());
  });

  it('asks from the saved address, or Thamel without one (useFeedQuery)', async () => {
    const received = endpoint(VENDORS_PATH, () => HttpResponse.json(feedResponse()));
    useAddressStore.getState().setAddress({
      ...THAMEL_ADDRESS,
      district_string: 'Lalitpur',
      municipality_palika_string: 'Lalitpur Metropolitan City',
      exact_lat: 27.6795,
      exact_lng: 85.3188,
    });

    const { result } = renderHookWithProviders(() => useFeedQuery(useCustomerLocation()));
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    // Removing the saved address re-asks from Thamel.
    act(() => {
      useAddressStore.getState().clearAddress();
    });
    await waitFor(() => {
      expect(received).toHaveLength(2);
    });

    expect(received.map(queryOf)).toEqual([
      { lat: '27.6795', lng: '85.3188', municipality_palika_string: 'Lalitpur Metropolitan City' },
      { lat: '27.7154', lng: '85.3123', municipality_palika_string: 'Kathmandu Metropolitan City' },
    ]);
  });

  it('rejects a feed that leaks vendor fields outside the contract', async () => {
    endpoint(VENDORS_PATH, () =>
      HttpResponse.json({
        serviceable: [
          {
            vendor: { ...feedVendor(), wallet_balance_npr: -150 },
            distance_km: 0,
            serviceable: true,
          },
        ],
        explore_further: [],
      }),
    );

    await expect(fetchFeed(THAMEL_FALLBACK_LOCATION)).rejects.toMatchObject({
      code: CLIENT_ERROR_CODES.badResponse,
    });
  });

  it('shows a 4xx at once instead of retrying it', async () => {
    const received = endpoint(VENDORS_PATH, () =>
      HttpResponse.json(errorBody('VALIDATION_FAILED'), { status: 400 }),
    );

    const { result } = renderHookWithProviders(() => useFeedQuery(THAMEL_FALLBACK_LOCATION));
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(received).toHaveLength(1);
  });
});

describe('GET /api/vendors/:id/products', () => {
  it('requests the vendor path with the location and parses vendorMenuSchema', async () => {
    const received = endpoint(vendorProductsPath(THAMEL_VENDOR.id), () =>
      HttpResponse.json(vendorMenu()),
    );

    const menu = await fetchVendorMenu(THAMEL_VENDOR.id, THAMEL_FALLBACK_LOCATION);

    expect(received[0]?.url.pathname).toBe(`/api/vendors/${THAMEL_VENDOR.id}/products`);
    // Step 7.4: the token in memory goes along, for the menu's Notify Me flags.
    expect(received[0]?.headers.get('authorization')).toMatch(/^Bearer /);
    expect(queryOf(received[0])).toMatchObject({ lat: '27.7154', lng: '85.3123' });
    expect(menu.products.map((p) => p.in_stock)).toEqual([true, true, false]);
    expect(menu.products.map((p) => p.stock_quantity)).toEqual([20, 12, 0]);
  });

  it('rejects a menu whose products lack stock_quantity (the pre-Phase-19 contract)', async () => {
    const { products, ...rest } = vendorMenu();
    endpoint(vendorProductsPath(THAMEL_VENDOR.id), () =>
      HttpResponse.json({
        ...rest,
        products: products.map(({ stock_quantity: _dropped, ...product }) => product),
      }),
    );

    await expect(fetchVendorMenu(THAMEL_VENDOR.id, THAMEL_FALLBACK_LOCATION)).rejects.toMatchObject(
      { code: 'UNEXPECTED_RESPONSE' },
    );
  });

  it('surfaces 404 VENDOR_NOT_FOUND without retrying (useVendorMenuQuery)', async () => {
    const received = endpoint(vendorProductsPath(THAMEL_VENDOR.id), () =>
      HttpResponse.json(errorBody(VENDOR_NOT_FOUND), { status: 404 }),
    );

    const { result } = renderHookWithProviders(() =>
      useVendorMenuQuery(THAMEL_VENDOR.id, THAMEL_FALLBACK_LOCATION),
    );
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(received).toHaveLength(1);
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect(result.current.error).toMatchObject({ status: 404, code: VENDOR_NOT_FOUND });
  });
});
