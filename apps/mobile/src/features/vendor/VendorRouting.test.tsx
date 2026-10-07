import type { UserRole } from '@hamro-pasal/shared-types';
import { screen } from '@testing-library/react-native';
import type * as ReactModule from 'react';
import type * as ReactNativeModule from 'react-native';

import TabsLayout from '../../../app/(tabs)/_layout';
import VendorLayout from '../../../app/(vendor)/_layout';
import { useAuthStore } from '../../store/useAuthStore';
import { useOnboardingStore } from '../../store/useOnboardingStore';
import { useProfileStore } from '../../store/useProfileStore';
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
  useOnboardingStore.getState().resetOnboarding();
  // The first-launch language question has been answered (its own tests are below).
  useOnboardingStore.getState().markLanguageChosen();
  useProfileStore.getState().completeOnboarding();
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
    [
      'a guest who skipped the login',
      () => {
        useOnboardingStore.getState().skipAuthWall();
      },
    ],
  ])('stay for %s', (_label, arrange) => {
    arrange();

    renderWithProviders(<TabsLayout />);

    expect(screen.getByTestId('customer-tabs')).toBeOnTheScreen();
    expect(screen.queryByTestId('redirect')).not.toBeOnTheScreen();
  });
});

describe('boot flow: the welcome screen', () => {
  it('sends a visitor who is neither signed in nor a guest to /welcome', () => {
    renderWithProviders(<TabsLayout />);

    expect(screen.getByTestId('redirect')).toHaveTextContent('/welcome');
    expect(screen.queryByTestId('customer-tabs')).not.toBeOnTheScreen();
  });

  it('asks again after a sign-out when the login was never skipped', () => {
    signIn('CUSTOMER');
    const view = renderWithProviders(<TabsLayout />);
    expect(screen.getByTestId('customer-tabs')).toBeOnTheScreen();
    view.unmount();

    useAuthStore.getState().clearSession();
    renderWithProviders(<TabsLayout />);

    expect(screen.getByTestId('redirect')).toHaveTextContent('/welcome');
  });
});

describe('first launch and new-account onboarding', () => {
  it('asks for the language before anything else, once', () => {
    useOnboardingStore.setState({ languageChosen: false });
    const first = renderWithProviders(<TabsLayout />);
    expect(screen.getByTestId('redirect')).toHaveTextContent('/language');
    first.unmount();

    useOnboardingStore.getState().markLanguageChosen();
    renderWithProviders(<TabsLayout />);

    expect(screen.getByTestId('redirect')).toHaveTextContent('/welcome');
  });

  it('asks a signed-in customer too (an installation that predates the question)', () => {
    useOnboardingStore.setState({ languageChosen: false });
    signIn('CUSTOMER');

    renderWithProviders(<TabsLayout />);

    expect(screen.getByTestId('redirect')).toHaveTextContent('/language');
  });

  it('holds an account its sign-in just created on "Complete your profile"', () => {
    signIn('CUSTOMER');
    useProfileStore.getState().requireOnboarding('9f1c2a10-0000-4000-8000-000000000001');
    const pending = renderWithProviders(<TabsLayout />);
    expect(screen.getByTestId('redirect')).toHaveTextContent('/complete-profile');
    pending.unmount();

    useProfileStore.getState().completeOnboarding();
    renderWithProviders(<TabsLayout />);

    expect(screen.getByTestId('customer-tabs')).toBeOnTheScreen();
  });

  it('never holds another account, or a guest, for an onboarding that is not theirs', () => {
    useProfileStore.getState().requireOnboarding('another-user-id');
    signIn('CUSTOMER');
    const other = renderWithProviders(<TabsLayout />);
    expect(screen.getByTestId('customer-tabs')).toBeOnTheScreen();
    other.unmount();

    useAuthStore.getState().clearSession();
    useOnboardingStore.getState().skipAuthWall();
    renderWithProviders(<TabsLayout />);

    expect(screen.getByTestId('customer-tabs')).toBeOnTheScreen();
  });
});
