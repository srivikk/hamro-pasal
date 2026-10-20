import { focusManager } from '@tanstack/react-query';
import { act, screen, waitFor } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import VendorDashboardScreen from '../../../app/(vendor)/dashboard';
import { VENDOR_ORDERS_PATH } from '../../api/vendor-orders';
import { useAuthStore } from '../../store/useAuthStore';
import { useVendorShopStore } from '../../store/useVendorShopStore';
import { vendorOrderList } from '../../test/api-fixtures';
import { resetMockAudio } from '../../test/fake-audio';
import { FakeSocket } from '../../test/fake-socket';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import {
  createTestQueryClient,
  renderHookWithProviders,
  renderWithProviders,
} from '../../test/render';
import { useVendorAvailability } from './useVendorAvailability';

let mockSocket = new FakeSocket();
jest.mock('socket.io-client', () => ({
  io: (url: string, options: { auth?: unknown }) => mockSocket.created(url, options),
}));

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  router: { push: jest.fn(), replace: jest.fn() },
}));

setupApiTestEnvironment();

const VENDOR_ID = '7b1f0c8e-0000-4000-8000-0000000000aa';

/** What GET /api/vendor/tax-identity answers: a PAN and its certificate on file, not verified. */
let verifiedAt: string | null = null;
let identityRequests = 0;

/**
 * A test client with the app's focus rule (query-client.ts): returning to the app refetches only
 * the queries that opt in, so these tests fail if the vendor's status queries stop opting in.
 */
function appQueryClient() {
  const client = createTestQueryClient();
  client.setDefaultOptions({
    ...client.getDefaultOptions(),
    queries: { ...client.getDefaultOptions().queries, refetchOnWindowFocus: false },
  });
  return client;
}
const renderDashboard = () =>
  renderWithProviders(<VendorDashboardScreen />, { queryClient: appQueryClient() });

/** Returning to the app, as `bindQueryFocusToAppState` reports it to React Query. */
function returnToForeground(): void {
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
}

beforeEach(() => {
  mockSocket = new FakeSocket();
  resetMockAudio();
  verifiedAt = null;
  identityRequests = 0;
  useAuthStore.getState().setLocale('en');
  useVendorShopStore.getState().setOnline(true);
  server.use(
    http.get(apiUrl(VENDOR_ORDERS_PATH), () => HttpResponse.json(vendorOrderList([]))),
    http.get(apiUrl('/api/vendor/tax-identity'), () => {
      identityRequests += 1;
      return HttpResponse.json({
        vendor_id: VENDOR_ID,
        tax_id: '302118845',
        is_vat_registered: false,
        legal_name: null,
        registered_address: null,
        status: verifiedAt === null ? 'SUSPENDED_COMPLIANCE' : 'LIVE',
        pan_verified_at: verifiedAt,
        has_pan_document: true,
      });
    }),
  );
});

afterEach(() => {
  focusManager.setFocused(undefined);
});

describe('Live Orders on an empty database', () => {
  it('shows "No orders yet" and nothing invented on the device', async () => {
    renderDashboard();

    expect(await screen.findByTestId('vendor-orders-empty')).toHaveTextContent(
      'No orders yet. New orders will ring here.',
    );
    expect(screen.queryByText('SAMPLE')).not.toBeOnTheScreen();
    expect(screen.queryByTestId(/^vendor-order-[0-9a-f]/)).not.toBeOnTheScreen();
  });

  it('waits for the server before drawing the board', () => {
    renderDashboard();
    expect(screen.getByTestId('vendor-orders-loading')).toBeOnTheScreen();
  });
});

describe('the pending-verification banner follows the server', () => {
  it('goes away when the app returns to the foreground after an admin verified the PAN', async () => {
    renderDashboard();
    expect(await screen.findByTestId('vendor-pan-banner')).toHaveTextContent(
      'Your shop is offline pending admin document verification.',
      { exact: false },
    );
    const before = identityRequests;

    // The Super Admin verifies the PAN while the vendor is in another app.
    verifiedAt = '2026-10-20T08:00:00.000Z';
    returnToForeground();

    await waitFor(() => {
      expect(screen.queryByTestId('vendor-pan-banner')).not.toBeOnTheScreen();
    });
    expect(identityRequests).toBe(before + 1);
  });

  it('asks again on every return, even though the answer was just fetched', async () => {
    renderDashboard();
    await screen.findByTestId('vendor-pan-banner');
    const before = identityRequests;

    returnToForeground();
    await waitFor(() => {
      expect(identityRequests).toBe(before + 1);
    });
    returnToForeground();
    await waitFor(() => {
      expect(identityRequests).toBe(before + 2);
    });
    expect(screen.getByTestId('vendor-pan-banner')).toBeOnTheScreen();
  });
});

describe("the shop's availability follows the server", () => {
  it('is read again when the app returns to the foreground', async () => {
    let open = false;
    server.use(
      http.get(apiUrl('/api/vendor/availability'), () =>
        HttpResponse.json({
          vendor_id: VENDOR_ID,
          mode: 'AUTO',
          override_until: null,
          has_hours: false,
          auto_paused_at: null,
          consecutive_missed_orders: 0,
          open_now: open,
          closed_reason: open ? null : 'OVERRIDE',
        }),
      ),
    );
    const hook = renderHookWithProviders(() => useVendorAvailability(), {
      queryClient: appQueryClient(),
    });
    await waitFor(() => {
      expect(hook.result.current.query.data?.open_now).toBe(false);
    });
    expect(useVendorShopStore.getState().online).toBe(false);

    open = true;
    returnToForeground();

    await waitFor(() => {
      expect(hook.result.current.query.data?.open_now).toBe(true);
    });
    expect(useVendorShopStore.getState().online).toBe(true);
  });
});
