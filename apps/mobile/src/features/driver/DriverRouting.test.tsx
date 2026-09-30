import type { UserRole } from '@hamro-pasal/shared-types';
import { screen } from '@testing-library/react-native';
import type * as ReactModule from 'react';
import type * as ReactNativeModule from 'react-native';

import DriverLayout from '../../../app/(driver)/_layout';
import TabsLayout from '../../../app/(tabs)/_layout';
import { useAuthStore } from '../../store/useAuthStore';
import { accessTokenFor } from '../../test/access-tokens';
import { renderWithProviders } from '../../test/render';

// Stand-ins that show which navigator (or redirect) a layout rendered.
jest.mock('expo-router', () => {
  const { createElement } = jest.requireActual<typeof ReactModule>('react');
  const { Text, View } = jest.requireActual<typeof ReactNativeModule>('react-native');
  const Tabs = Object.assign(() => createElement(View, { testID: 'customer-tabs' }), {
    Screen: () => null,
  });
  return {
    Redirect: ({ href }: { href: string }) => createElement(Text, { testID: 'redirect' }, href),
    Stack: () => createElement(View, { testID: 'driver-stack' }),
    Tabs,
  };
});

function signIn(role: UserRole): void {
  useAuthStore.getState().setSession({ accessToken: accessTokenFor(role), refreshToken: 'r.jwt' });
}

beforeEach(() => {
  useAuthStore.getState().clearSession();
});

describe('driver-only route group app/(driver)', () => {
  it('opens for a signed-in driver', () => {
    signIn('DRIVER');

    renderWithProviders(<DriverLayout />);

    expect(screen.getByTestId('driver-stack')).toBeOnTheScreen();
  });

  it.each<UserRole>(['CUSTOMER', 'VENDOR', 'SUPER_ADMIN'])(
    'sends a %s to the customer app',
    (role) => {
      signIn(role);

      renderWithProviders(<DriverLayout />);

      expect(screen.getByTestId('redirect')).toHaveTextContent('/');
      expect(screen.queryByTestId('driver-stack')).not.toBeOnTheScreen();
    },
  );

  it('sends a signed-out user to the customer app', () => {
    renderWithProviders(<DriverLayout />);

    expect(screen.getByTestId('redirect')).toHaveTextContent('/');
  });
});

describe('customer tabs', () => {
  it('send a signed-in driver to the delivery dashboard', () => {
    signIn('DRIVER');

    renderWithProviders(<TabsLayout />);

    expect(screen.getByTestId('redirect')).toHaveTextContent('/driver/dashboard');
    expect(screen.queryByTestId('customer-tabs')).not.toBeOnTheScreen();
  });

  it('send a driver there after a relaunch too (only the refresh token and role survive)', () => {
    signIn('DRIVER');
    useAuthStore.setState({ accessToken: null });

    renderWithProviders(<TabsLayout />);

    expect(screen.getByTestId('redirect')).toHaveTextContent('/driver/dashboard');
  });
});
