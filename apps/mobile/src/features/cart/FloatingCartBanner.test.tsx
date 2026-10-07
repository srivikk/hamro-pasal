import { act, fireEvent, screen } from '@testing-library/react-native';
import { router, Tabs } from 'expo-router';
import type * as ReactModule from 'react';
import type * as ReactNativeModule from 'react-native';

import HomeStackLayout from '../../../app/(tabs)/(home)/_layout';
import TabsLayout from '../../../app/(tabs)/_layout';
import { useAuthStore } from '../../store/useAuthStore';
import { useCartStore } from '../../store/useCartStore';
import { useOnboardingStore } from '../../store/useOnboardingStore';
import { NOODLES, RICE, THAMEL_VENDOR } from '../../test/api-fixtures';
import { renderWithProviders } from '../../test/render';
import { FloatingCartBanner } from './FloatingCartBanner';

jest.mock('expo-router', () => {
  const { createElement } = jest.requireActual<typeof ReactModule>('react');
  const { View } = jest.requireActual<typeof ReactNativeModule>('react-native');
  const Stack = Object.assign(() => createElement(View, { testID: 'home-stack' }), {
    Screen: () => null,
  });
  const Tabs = Object.assign(
    ({ children }: { children: ReactModule.ReactNode }) =>
      createElement(View, { testID: 'customer-tabs' }, children),
    { Screen: jest.fn(() => null) },
  );
  return { router: { push: jest.fn() }, Redirect: () => null, Stack, Tabs };
});

beforeEach(() => {
  jest.clearAllMocks();
  useCartStore.getState().clearCart();
});

describe('FloatingCartBanner', () => {
  it('renders nothing for an empty cart', () => {
    renderWithProviders(<FloatingCartBanner />);

    expect(screen.queryByTestId('cart-banner')).toBeNull();
  });

  it('shows the number of items and their price, and "View Cart"', () => {
    // 2 x noodles (600) + 1 x rice (1150): three units, Rs. 2350. No delivery fee in it.
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 2);
    useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 1);
    renderWithProviders(<FloatingCartBanner />);

    expect(screen.getByTestId('cart-banner-summary')).toHaveTextContent('3 items | Rs. 2350');
    expect(screen.getByText('View Cart')).toBeOnTheScreen();
  });

  it('opens the cart', () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 1);
    renderWithProviders(<FloatingCartBanner />);

    fireEvent.press(screen.getByTestId('cart-banner'));

    expect(jest.mocked(router.push)).toHaveBeenCalledWith('/cart');
  });

  it('appears with the first item, follows the cart, and goes with the last item', () => {
    renderWithProviders(<FloatingCartBanner />);

    act(() => {
      useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 1);
    });
    expect(screen.getByTestId('cart-banner-summary')).toHaveTextContent('1 item | Rs. 600');

    act(() => {
      useCartStore.getState().setQuantity(NOODLES.id, 3);
    });
    expect(screen.getByTestId('cart-banner-summary')).toHaveTextContent('3 items | Rs. 1800');

    act(() => {
      useCartStore.getState().setQuantity(NOODLES.id, 0);
    });
    expect(screen.queryByTestId('cart-banner')).toBeNull();
  });

  it('counts in Devanagari digits in Nepali', () => {
    useAuthStore.getState().setLocale('ne');
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 2);
    renderWithProviders(<FloatingCartBanner />, { locale: 'ne' });

    expect(screen.getByTestId('cart-banner-summary')).toHaveTextContent(/२.*\|.*१२००/);
    useAuthStore.getState().setLocale('en');
  });
});

describe('where the cart lives', () => {
  it('the Shops tab mounts the banner under its stack (the feed and a shop page)', () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 1);
    renderWithProviders(<HomeStackLayout />);

    expect(screen.getByTestId('home-stack')).toBeOnTheScreen();
    expect(screen.getByTestId('cart-banner')).toBeOnTheScreen();
  });

  it('the cart is not a tab: only Shops and Profile are', () => {
    useOnboardingStore.setState({ authWallSkipped: true, languageChosen: true });
    renderWithProviders(<TabsLayout />);

    const names = jest
      .mocked(Tabs.Screen)
      .mock.calls.map(([props]) => (props as { name: string }).name);
    expect([...new Set(names)]).toEqual(['(home)', 'profile']);
  });
});
