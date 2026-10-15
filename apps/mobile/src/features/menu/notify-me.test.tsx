import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import VendorMenuScreen from '../../../app/(tabs)/(home)/vendor/[id]';
import { PRODUCTS_PATH, vendorProductsPath } from '../../api/catalog';
import { useAuthStore } from '../../store/useAuthStore';
import { useToastStore } from '../../store/useToastStore';
import { MUSTARD_OIL_ID, productList, THAMEL_VENDOR, vendorMenu } from '../../test/api-fixtures';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import { NO_VENDOR_EXTRAS } from '../promo/promo-model';
import { vendorExtras } from '../promo/mock-promotions';
import { alertPath } from './useNotifyMe';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => ({ id: '6f1c2a10-0000-4000-8000-000000000011' }),
  Stack: { Screen: () => null },
}));
jest.mock('../promo/mock-promotions', () => ({
  PROMO_MOCKS_ENABLED: true,
  homePromotions: jest.fn(),
  vendorExtras: jest.fn(),
}));

setupApiTestEnvironment();

const OIL_ALERT = apiUrl(alertPath({ kind: 'product', id: MUSTARD_OIL_ID }));
const SHOP_ALERT = apiUrl(alertPath({ kind: 'shop', id: THAMEL_VENDOR.id }));

/** Serves the menu and records the Authorization header it was asked with. */
function serveShop(menu = vendorMenu()) {
  const seen: (string | null)[] = [];
  server.use(
    http.get(apiUrl(vendorProductsPath(THAMEL_VENDOR.id)), ({ request }) => {
      seen.push(request.headers.get('authorization'));
      return HttpResponse.json(menu);
    }),
    http.get(apiUrl(PRODUCTS_PATH), () => HttpResponse.json(productList([]))),
  );
  return seen;
}

beforeEach(() => {
  useToastStore.setState({ toast: null });
  jest.mocked(vendorExtras).mockReturnValue(NO_VENDOR_EXTRAS);
});

describe('Notify Me on the shop page (step 7.4)', () => {
  it('asks with the token in memory, so the menu can say what the customer waits for', async () => {
    const seen = serveShop();
    renderWithProviders(<VendorMenuScreen />);

    await screen.findByTestId(`menu-notify-${MUSTARD_OIL_ID}`);
    expect(seen[0]).toMatch(/^Bearer /);
  });

  it('offers Notify Me on a sold-out product only, and turns it on and off', async () => {
    serveShop();
    const calls: string[] = [];
    server.use(
      http.put(OIL_ALERT, () => {
        calls.push('PUT');
        return HttpResponse.json({ alerted: true });
      }),
      http.delete(OIL_ALERT, () => {
        calls.push('DELETE');
        return HttpResponse.json({ alerted: false });
      }),
    );
    renderWithProviders(<VendorMenuScreen />);

    const button = await screen.findByTestId(`menu-notify-${MUSTARD_OIL_ID}`);
    expect(button).toHaveTextContent('Notify Me');
    // Products in stock have Add, not Notify Me.
    expect(screen.getAllByTestId(/^menu-notify-/)).toHaveLength(1);

    fireEvent.press(button);
    await waitFor(() => {
      expect(screen.getByTestId(`menu-notify-${MUSTARD_OIL_ID}`)).toHaveTextContent('Notifying');
    });
    expect(useToastStore.getState().toast?.message).toBe("We'll let you know.");

    fireEvent.press(screen.getByTestId(`menu-notify-${MUSTARD_OIL_ID}`));
    await waitFor(() => {
      expect(screen.getByTestId(`menu-notify-${MUSTARD_OIL_ID}`)).toHaveTextContent('Notify Me');
    });
    expect(calls).toEqual(['PUT', 'DELETE']);
  });

  it('shows a request the server already holds, and says when the limit is reached', async () => {
    const menu = vendorMenu();
    serveShop({
      ...menu,
      products: menu.products.map((p) =>
        p.id === MUSTARD_OIL_ID ? { ...p, is_alerted: true } : p,
      ),
    });
    renderWithProviders(<VendorMenuScreen />);
    expect(await screen.findByTestId(`menu-notify-${MUSTARD_OIL_ID}`)).toHaveTextContent(
      'Notifying',
    );

    server.use(
      http.delete(OIL_ALERT, () =>
        HttpResponse.json(
          { error: { code: 'ALERT_LIMIT_REACHED', message: 'limit' } },
          { status: 422 },
        ),
      ),
    );
    fireEvent.press(screen.getByTestId(`menu-notify-${MUSTARD_OIL_ID}`));
    await waitFor(() => {
      expect(useToastStore.getState().toast?.message).toBe(
        'You can wait for at most 50 products and shops. Remove one first.',
      );
    });
    expect(screen.getByTestId(`menu-notify-${MUSTARD_OIL_ID}`)).toHaveTextContent('Notifying');
  });

  it('asks a guest to sign in instead of calling the server', async () => {
    useAuthStore.setState({ accessToken: null, refreshToken: null });
    const seen = serveShop();
    renderWithProviders(<VendorMenuScreen />);

    fireEvent.press(await screen.findByTestId(`menu-notify-${MUSTARD_OIL_ID}`));

    expect(useToastStore.getState().toast?.message).toBe('Sign in to get notified.');
    expect(seen[0]).toBeNull();
  });

  it('lets the customer wait for a closed shop to open', async () => {
    serveShop({ ...vendorMenu(), open_now: false, closed_reason: 'HOURS' });
    server.use(http.put(SHOP_ALERT, () => HttpResponse.json({ alerted: true })));
    renderWithProviders(<VendorMenuScreen />);

    const button = await screen.findByTestId('menu-notify-shop');
    expect(button).toHaveTextContent('Notify me when it opens');
    fireEvent.press(button);

    await waitFor(() => {
      expect(screen.getByTestId('menu-notify-shop')).toHaveTextContent(
        "We'll tell you when it opens",
      );
    });
  });

  it('offers no shop request while the shop is open', async () => {
    serveShop();
    renderWithProviders(<VendorMenuScreen />);
    await screen.findByTestId(`menu-notify-${MUSTARD_OIL_ID}`);

    expect(screen.queryByTestId('menu-notify-shop')).toBeNull();
  });
});
