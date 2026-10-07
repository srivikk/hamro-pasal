import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { http, HttpResponse } from 'msw';

import HomeScreen from '../../../app/(tabs)/(home)/index';
import ProfileScreen from '../../../app/(tabs)/profile';
import OrdersScreen, { recentOrders } from '../../../app/orders';
import { useAddressStore } from '../../store/useAddressStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useBrowseLocationStore } from '../../store/useBrowseLocationStore';
import { useOrderStore } from '../../store/useOrderStore';
import { useProfileStore } from '../../store/useProfileStore';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import type { describePlace } from '../location/describe-place';
import { nominatimPlaceName } from '../location/describe-place';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn() },
  Stack: { Screen: () => null },
  Redirect: () => null,
}));
const mockRouter = jest.mocked(router);

setupApiTestEnvironment();

const ORDER_A = '4a1c0000-0000-4000-8000-0000004fa5b6';
const ORDER_B = '4a1c0000-0000-4000-8000-0000001f8a11';

beforeEach(() => {
  jest.clearAllMocks();
  useOrderStore.setState({ orders: {} });
});

describe('Profile tab: account header and menu', () => {
  it('shows the name with the number and email, and the three menu rows', () => {
    useProfileStore.getState().setAccount('+9779800000001', null);
    renderWithProviders(<ProfileScreen />);

    expect(screen.getByText('Aarav Shrestha')).toBeOnTheScreen();
    expect(screen.getByText('+977 9800000001 · aarav@example.com')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Your Orders' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Address Book' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Log Out' })).toBeOnTheScreen();
  });

  it('shows the number as the title until the customer has a name', () => {
    useProfileStore.getState().clearProfile();
    useProfileStore.getState().setAccount('+9779800000001', null);
    renderWithProviders(<ProfileScreen />);

    expect(screen.getByText('+977 9800000001')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Complete your profile' })).toBeOnTheScreen();
  });

  it('never shows the number another account signed in with', () => {
    useProfileStore.getState().clearProfile();
    useProfileStore.getState().setAccount('+9779800000002', 'another-user-id');
    renderWithProviders(<ProfileScreen />);

    expect(screen.queryByText('+977 9800000002')).toBeNull();
    expect(screen.getByText('Your account')).toBeOnTheScreen();
  });

  it('opens Your Orders and the Address Book from their rows', () => {
    renderWithProviders(<ProfileScreen />);

    fireEvent.press(screen.getByTestId('menu-orders'));
    expect(mockRouter.push).toHaveBeenCalledWith('/orders');

    fireEvent.press(screen.getByTestId('menu-address-book'));
    expect(screen.getByText('Your addresses')).toBeOnTheScreen();
    expect(screen.getByTestId('address-icon-HOME')).toBeOnTheScreen();
  });

  it('logs out from the menu', () => {
    useAuthStore.getState().setSession({ accessToken: 'a.b.c', refreshToken: 'r.e.f' });
    renderWithProviders(<ProfileScreen />);

    fireEvent.press(screen.getByTestId('menu-log-out'));

    expect(useAuthStore.getState().refreshToken).toBeNull();
    expect(screen.getByText('Log in or sign up')).toBeOnTheScreen();
  });

  it('offers a guest the login only: no orders, addresses or log out', () => {
    useAuthStore.getState().clearSession();
    renderWithProviders(<ProfileScreen />);

    expect(screen.getByText('Log in or sign up')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeOnTheScreen();
    expect(screen.queryByTestId('menu-orders')).toBeNull();
    expect(screen.queryByTestId('menu-address-book')).toBeNull();
    expect(screen.queryByTestId('menu-log-out')).toBeNull();
  });
});

describe('Your Orders', () => {
  it('lists the tracked orders newest first and opens one', () => {
    useOrderStore
      .getState()
      .trackPlaced({ orderId: ORDER_A, paymentMethod: 'COD', totalNpr: 1250 }, 1_000);
    useOrderStore
      .getState()
      .trackPlaced({ orderId: ORDER_B, paymentMethod: 'ESEWA', totalNpr: 650 }, 2_000);
    useOrderStore.getState().setState(ORDER_A, 'DELIVERED');
    renderWithProviders(<OrdersScreen />);

    expect(recentOrders(useOrderStore.getState().orders).map((order) => order.orderId)).toEqual([
      ORDER_B,
      ORDER_A,
    ]);
    expect(screen.getByText('Order #1F8A11')).toBeOnTheScreen();
    expect(screen.getByText('Delivered')).toBeOnTheScreen();
    fireEvent.press(screen.getByTestId(`order-row-${ORDER_A}`));

    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/order/[id]',
      params: { id: ORDER_A },
    });
  });

  it('says so when there are none', () => {
    renderWithProviders(<OrdersScreen />);

    expect(screen.getByTestId('orders-empty')).toBeOnTheScreen();
  });
});

describe('Home: the selector opens by itself when the device location is off', () => {
  beforeEach(() => {
    server.use(
      http.get(apiUrl('/api/vendors'), () =>
        HttpResponse.json({ serviceable: [], explore_further: [] }),
      ),
    );
    useAddressStore.getState().clearAddress();
    useBrowseLocationStore.setState({ deviceChecked: false });
  });
  afterEach(() => {
    useBrowseLocationStore.setState({ deviceChecked: false });
  });

  it('waits for the boot check, then shows "Select delivery location" once', async () => {
    renderWithProviders(<HomeScreen />);
    expect(screen.queryByText('Select delivery location')).toBeNull();

    useBrowseLocationStore.getState().markDeviceChecked();

    expect(await screen.findByText('Select delivery location')).toBeOnTheScreen();
    expect(screen.getByTestId('location-off-banner')).toBeOnTheScreen();

    // Dismissed without choosing: it is not forced open again.
    fireEvent.press(screen.getByTestId('location-picker-close'));
    await waitFor(() => {
      expect(screen.queryByText('Select delivery location')).toBeNull();
    });
    expect(screen.getByTestId('select-location-prompt')).toBeOnTheScreen();
  });

  it('does not open when the boot check found the device position', () => {
    useBrowseLocationStore.getState().setDevice({ lat: 27.7154, lng: 85.3123, label: 'Thamel' });
    renderWithProviders(<HomeScreen />);

    useBrowseLocationStore.getState().markDeviceChecked();

    expect(screen.queryByText('Select delivery location')).toBeNull();
  });
});

describe('describePlace (device geocoder, then OpenStreetMap)', () => {
  const realDescribePlace = jest.requireActual<{ describePlace: typeof describePlace }>(
    '../location/describe-place',
  ).describePlace;
  const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';

  it('reads a street and area from a Nominatim answer', () => {
    expect(
      nominatimPlaceName({ address: { road: 'Thamel Marg', suburb: 'Thamel', city: 'Kathmandu' } }),
    ).toBe('Thamel Marg, Thamel');
    expect(nominatimPlaceName({ address: { village: 'Ghandruk', county: 'Kaski' } })).toBe(
      'Ghandruk, Kaski',
    );
    expect(nominatimPlaceName({ address: {} })).toBeNull();
    expect(nominatimPlaceName({ error: 'Unable to geocode' })).toBeNull();
    expect(nominatimPlaceName('nonsense')).toBeNull();
  });

  it('falls back to OpenStreetMap when the device geocoder gives nothing', async () => {
    const asked: string[] = [];
    server.use(
      http.get(NOMINATIM, ({ request }) => {
        asked.push(new URL(request.url).search);
        return HttpResponse.json({ address: { road: 'Lakeside Road', city: 'Pokhara' } });
      }),
    );

    const name = await realDescribePlace({ latitude: 28.2096, longitude: 83.9856 });

    expect(name).toBe('Lakeside Road, Pokhara');
    expect(asked).toEqual(['?format=jsonv2&addressdetails=1&zoom=17&lat=28.2096&lon=83.9856']);
  });

  it('answers null, never throwing, when neither can name the place', async () => {
    server.use(http.get(NOMINATIM, () => HttpResponse.error()));

    await expect(realDescribePlace({ latitude: 28.2096, longitude: 83.9856 })).resolves.toBeNull();
  });
});
