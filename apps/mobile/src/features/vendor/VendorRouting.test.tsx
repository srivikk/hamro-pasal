import type { UserRole } from '@hamro-pasal/shared-types';
import { screen } from '@testing-library/react-native';
import type * as ReactModule from 'react';
import type * as ReactNativeModule from 'react-native';

import TabsLayout from '../../../app/(tabs)/_layout';
import VendorLayout from '../../../app/(vendor)/_layout';
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
    Stack: () => createElement(View, { testID: 'vendor-stack' }),
    Tabs,
  };
});

function signIn(role: UserRole): void {
  useAuthStore.getState().setSession({ accessToken: accessTokenFor(role), refreshToken: 'r.jwt' });
}

beforeEach(() => {
  useAuthStore.getState().clearSession();
});

describe('vendor-only route group app/(vendor)', () => {
  it('opens for a signed-in vendor', () => {
    signIn('VENDOR');

    renderWithProviders(<VendorLayout />);

    expect(screen.getByTestId('vendor-stack')).toBeOnTheScreen();
  });

  it.each<UserRole>(['CUSTOMER', 'DRIVER', 'SUPER_ADMIN'])(
    'sends a %s to the customer app',
    (role) => {
      signIn(role);

      renderWithProviders(<VendorLayout />);

      expect(screen.getByTestId('redirect')).toHaveTextContent('/');
      expect(screen.queryByTestId('vendor-stack')).not.toBeOnTheScreen();
    },
  );

  it('sends a signed-out user (e.g. a vendor who just signed out) to the customer app', () => {
    renderWithProviders(<VendorLayout />);

    expect(screen.getByTestId('redirect')).toHaveTextContent('/');
  });
});

describe('customer tabs', () => {
  it('send a signed-in vendor to the order dashboard', () => {
    signIn('VENDOR');

    renderWithProviders(<TabsLayout />);

    expect(screen.getByTestId('redirect')).toHaveTextContent('/dashboard');
    expect(screen.queryByTestId('customer-tabs')).not.toBeOnTheScreen();
  });

  it('send a vendor there after a relaunch too (only the refresh token and role survive)', () => {
    signIn('VENDOR');
    useAuthStore.setState({ accessToken: null });

    renderWithProviders(<TabsLayout />);

    expect(screen.getByTestId('redirect')).toHaveTextContent('/dashboard');
  });

  it.each([
    [
      'a customer',
      () => {
        signIn('CUSTOMER');
      },
    ],
    ['a signed-out visitor', () => undefined],
  ])('stay for %s', (_label, arrange) => {
    arrange();

    renderWithProviders(<TabsLayout />);

    expect(screen.getByTestId('customer-tabs')).toBeOnTheScreen();
    expect(screen.queryByTestId('redirect')).not.toBeOnTheScreen();
  });
});
