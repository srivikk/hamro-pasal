import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { http, HttpResponse } from 'msw';

import CartScreen from '../../../app/cart';
import FeedScreen from '../../../app/(tabs)/(home)/index';
import WelcomeScreen from '../../../app/welcome';
import { OTP_SEND_PATH } from '../../api/auth';
import { VENDORS_PATH, vendorProductsPath } from '../../api/catalog';
import { mmkvStateStorage } from '../../storage/mmkv-state-storage';
import { useAddressStore } from '../../store/useAddressStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useBrowseLocationStore } from '../../store/useBrowseLocationStore';
import { useCartStore } from '../../store/useCartStore';
import { createOnboardingStore, useOnboardingStore } from '../../store/useOnboardingStore';
import { useToastStore } from '../../store/useToastStore';
import {
  checkoutResponse,
  feedResponse,
  NOODLES,
  otpSendResponse,
  TEST_PHONE,
  THAMEL_VENDOR,
  vendorMenu,
} from '../../test/api-fixtures';
import { InMemoryMmkv } from '../../test/in-memory-mmkv';
import { apiUrl, capture, server, setupApiTestEnvironment } from '../../test/msw';
import { payWith } from '../../test/pay-with';
import { renderWithProviders } from '../../test/render';
import { placeName } from '../location/describe-place';

jest.mock('expo-router', () => ({
  useFocusEffect: jest.fn(),
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn() },
  Stack: { Screen: () => null },
  Redirect: () => null,
  useLocalSearchParams: () => ({}),
}));
const mockRouter = jest.mocked(router);

setupApiTestEnvironment();

beforeEach(() => {
  jest.clearAllMocks();
  useOnboardingStore.getState().resetOnboarding();
  useToastStore.setState({ toast: null });
});

describe('onboarding store', () => {
  it('remembers that the login was skipped across launches', () => {
    const engine = new InMemoryMmkv();
    const build = () => createOnboardingStore(mmkvStateStorage(engine));
    expect(build().getState().authWallSkipped).toBe(false);

    build().getState().skipAuthWall();

    expect(build().getState().authWallSkipped).toBe(true);
  });
});

describe('Welcome screen (auth wall)', () => {
  beforeEach(() => {
    useAuthStore.getState().clearSession();
  });

  it('shows the background, the number field and Continue, which sends the code', async () => {
    const sent: unknown[] = [];
    server.use(
      http.post(apiUrl(OTP_SEND_PATH), async ({ request }) => {
        sent.push((await capture(request)).body);
        return HttpResponse.json(otpSendResponse());
      }),
    );
    renderWithProviders(<WelcomeScreen />);

    expect(screen.getByTestId('auth-wall')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    fireEvent.changeText(screen.getByTestId('phone-input'), '9800000001');
    fireEvent.press(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledWith({
        pathname: '/verify-otp',
        params: { phone: TEST_PHONE, resendAfter: '60' },
      });
    });
    expect(sent).toEqual([{ phone: TEST_PHONE }]);
    expect(useOnboardingStore.getState().authWallSkipped).toBe(false);
  });

  it('refuses a number that is not a Nepal mobile, without a request', () => {
    renderWithProviders(<WelcomeScreen />);

    fireEvent.changeText(screen.getByTestId('phone-input'), '12345');
    fireEvent.press(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByTestId('login-error')).toBeOnTheScreen();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('"Skip login" opens Home as a guest and is remembered', () => {
    renderWithProviders(<WelcomeScreen />);

    fireEvent.press(screen.getByRole('button', { name: 'Skip login' }));

    expect(useOnboardingStore.getState().authWallSkipped).toBe(true);
    expect(useAuthStore.getState().refreshToken).toBeNull();
    expect(mockRouter.replace).toHaveBeenCalledWith('/');
  });
});

describe('Home header', () => {
  function serveFeed() {
    const queries: Record<string, string>[] = [];
    server.use(
      http.get(apiUrl(VENDORS_PATH), ({ request }) => {
        queries.push(Object.fromEntries(new URL(request.url).searchParams));
        return HttpResponse.json(feedResponse());
      }),
    );
    return queries;
  }

  it('shows the device location with its name and asks the feed around it', async () => {
    const queries = serveFeed();
    useBrowseLocationStore
      .getState()
      .setDevice({ lat: 27.6727, lng: 85.3249, label: 'Patan, Lalitpur' });
    renderWithProviders(<FeedScreen />);

    expect(screen.getByTestId('location-header-label')).toHaveTextContent('Patan, Lalitpur');
    await screen.findByText('Delivers to you');
    // The device position wins over the saved delivery address, and names no Palika.
    expect(queries).toEqual([{ lat: '27.6727', lng: '85.3249' }]);
  });

  it('says "Current location" until the place has a name', () => {
    serveFeed();
    useBrowseLocationStore.getState().setDevice({ lat: 27.6727, lng: 85.3249, label: null });
    renderWithProviders(<FeedScreen />);

    expect(screen.getByTestId('location-header-label')).toHaveTextContent('Current location');
  });

  it('asks to select a location when none is known, without requesting the feed', () => {
    const queries = serveFeed();
    useAddressStore.getState().clearAddress();
    renderWithProviders(<FeedScreen />);

    expect(screen.getByTestId('location-header-label')).toHaveTextContent('Select Location');
    expect(screen.getByTestId('select-location-prompt')).toBeOnTheScreen();
    expect(queries).toEqual([]);

    // Both the header and the prompt open the selector built for the manual override.
    fireEvent.press(
      within(screen.getByTestId('select-location-prompt')).getByRole('button', {
        name: 'Select Location',
      }),
    );
    expect(screen.getByTestId('place-search')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.press(screen.getByTestId('location-header'));
    expect(screen.getByTestId('place-search')).toBeOnTheScreen();
  });

  it('lists the shops once a location is selected', async () => {
    const queries = serveFeed();
    useAddressStore.getState().clearAddress();
    renderWithProviders(<FeedScreen />);

    useBrowseLocationStore
      .getState()
      .setOverride({ lat: 28.2096, lng: 83.9856, label: 'Lakeside', municipalityPalika: null });

    expect(await screen.findByText('Delivers to you')).toBeOnTheScreen();
    expect(queries).toEqual([{ lat: '28.2096', lng: '83.9856' }]);
    expect(screen.queryByTestId('select-location-prompt')).toBeNull();
  });

  it('opens the profile from the icon at the top right', () => {
    serveFeed();
    renderWithProviders(<FeedScreen />);

    fireEvent.press(screen.getByTestId('header-profile'));

    expect(mockRouter.push).toHaveBeenCalledWith('/profile');
  });

  it('has a search bar with a microphone that only announces voice search', () => {
    serveFeed();
    renderWithProviders(<FeedScreen />);

    expect(screen.getByTestId('product-search')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Voice search' }));

    expect(useToastStore.getState().toast?.message).toBe('Voice search is coming soon.');
  });
});

describe('placeName', () => {
  it('joins the most local names without repeating one', () => {
    const place = (parts: object) => parts as Parameters<typeof placeName>[0];

    expect(
      placeName(place({ district: 'Thamel', city: 'Kathmandu', subregion: 'Kathmandu' })),
    ).toBe('Thamel, Kathmandu');
    expect(placeName(place({ district: null, city: 'Pokhara', subregion: 'Kaski' }))).toBe(
      'Pokhara, Kaski',
    );
    expect(placeName(place({ district: null, city: null, subregion: null }))).toBeNull();
    expect(placeName(undefined)).toBeNull();
  });
});

describe('Cart: the shop must deliver to the delivery address (SPEC §2)', () => {
  beforeEach(() => {
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 2);
  });

  /** Serves the cart vendor's menu with the given serviceability and records what was asked. */
  function serveArea(respond: () => Response) {
    const queries: Record<string, string>[] = [];
    server.use(
      http.get(apiUrl(vendorProductsPath(THAMEL_VENDOR.id)), ({ request }) => {
        queries.push(Object.fromEntries(new URL(request.url).searchParams));
        return respond();
      }),
    );
    return queries;
  }
  function serveCheckout() {
    let calls = 0;
    server.use(
      http.post(apiUrl('/api/cart/checkout'), () => {
        calls += 1;
        return HttpResponse.json(checkoutResponse(), { status: 201 });
      }),
    );
    return () => calls;
  }

  it('blocks checkout with a modal when the shop does not deliver to the address', async () => {
    const queries = serveArea(() => HttpResponse.json(vendorMenu({ serviceable: false })));
    const checkouts = serveCheckout();
    // Browsing somewhere else must not matter: the delivery address is what is checked.
    useBrowseLocationStore
      .getState()
      .setOverride({ lat: 28.2096, lng: 83.9856, label: 'Lakeside', municipalityPalika: null });
    renderWithProviders(<CartScreen />);

    payWith('ESEWA');

    expect(await screen.findByTestId('delivery-area-modal')).toBeOnTheScreen();
    expect(
      screen.getByText(/^This shop does not deliver to your selected address\./),
    ).toBeOnTheScreen();
    expect(queries).toEqual([
      { lat: '27.7154', lng: '85.3123', municipality_palika_string: 'Kathmandu Metropolitan City' },
    ]);
    expect(checkouts()).toBe(0);

    fireEvent.press(screen.getByRole('button', { name: 'Change Address' }));

    expect(screen.queryByTestId('delivery-area-modal')).toBeNull();
    expect(screen.getByText('Your addresses')).toBeOnTheScreen();
  });

  it('checks out when the shop delivers there', async () => {
    serveArea(() => HttpResponse.json(vendorMenu({ serviceable: true })));
    const checkouts = serveCheckout();
    renderWithProviders(<CartScreen />);

    payWith('ESEWA');

    await waitFor(() => {
      expect(checkouts()).toBe(1);
    });
    expect(screen.queryByTestId('delivery-area-modal')).toBeNull();
  });

  it('checks again after the address changes', async () => {
    let serviceable = false;
    const queries = serveArea(() => HttpResponse.json(vendorMenu({ serviceable })));
    const checkouts = serveCheckout();
    renderWithProviders(<CartScreen />);

    payWith('ESEWA');
    await screen.findByTestId('delivery-area-modal');
    fireEvent.press(screen.getByRole('button', { name: 'Close' }));
    serviceable = true;
    payWith('ESEWA');

    await waitFor(() => {
      expect(checkouts()).toBe(1);
    });
    expect(queries).toHaveLength(2);
  });

  it('does not check out when the answer cannot be fetched', async () => {
    serveArea(() => HttpResponse.error());
    const checkouts = serveCheckout();
    renderWithProviders(<CartScreen />);

    payWith('ESEWA');

    expect(await screen.findByTestId('checkout-error')).toBeOnTheScreen();
    expect(checkouts()).toBe(0);
    expect(screen.queryByTestId('delivery-area-modal')).toBeNull();
  });

  it('leaves a shop that is gone to checkout itself', async () => {
    serveArea(() =>
      HttpResponse.json(
        { error: { code: 'VENDOR_NOT_FOUND', message: 'Vendor not found' } },
        { status: 404 },
      ),
    );
    const checkouts = serveCheckout();
    renderWithProviders(<CartScreen />);

    payWith('ESEWA');

    await waitFor(() => {
      expect(checkouts()).toBe(1);
    });
  });
});

describe('Home header: gradient block', () => {
  it('shows "Hamro Pasal in" over the location, with the profile button and the search bar inside', async () => {
    server.use(http.get(apiUrl(VENDORS_PATH), () => HttpResponse.json(feedResponse())));
    useBrowseLocationStore
      .getState()
      .setDevice({ lat: 27.6727, lng: 85.3249, label: 'Patan Dhoka, Lalitpur' });
    renderWithProviders(<FeedScreen />);
    await screen.findByText('Delivers to you');

    const header = within(screen.getByTestId('home-header'));
    expect(header.getByText('Hamro Pasal in')).toBeOnTheScreen();
    expect(header.getByTestId('location-header-label')).toHaveTextContent('Patan Dhoka, Lalitpur');
    expect(header.getByTestId('product-search')).toBeOnTheScreen();
    expect(header.getByTestId('voice-search')).toBeOnTheScreen();

    // Still wired: the location opens the selector, the icon opens the profile.
    fireEvent.press(header.getByTestId('header-profile'));
    expect(mockRouter.push).toHaveBeenCalledWith('/profile');
    fireEvent.press(header.getByTestId('location-header'));
    expect(screen.getByText('Select delivery location')).toBeOnTheScreen();
  });
});
