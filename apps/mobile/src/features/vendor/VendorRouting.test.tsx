import type { UserRole } from '@hamro-pasal/shared-types';
import { fireEvent, screen, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import type * as ReactModule from 'react';
import type * as ReactNativeModule from 'react-native';

import TabsLayout from '../../../app/(tabs)/_layout';
import VendorLayout from '../../../app/(vendor)/_layout';
import VendorMarketingScreen from '../../../app/(vendor)/marketing';
import { setAppVariantForTests } from '../../lib/app-variant';
import { useAuthStore } from '../../store/useAuthStore';
import { useOnboardingStore } from '../../store/useOnboardingStore';
import { useProfileStore } from '../../store/useProfileStore';
import { accessTokenFor } from '../../test/access-tokens';
import { renderWithProviders } from '../../test/render';

interface HeaderOptions {
  headerLeft?: () => ReactModule.ReactNode;
  headerRight?: () => ReactModule.ReactNode;
}

interface TabScreenProps {
  name: string;
  options?: HeaderOptions & { href?: string | null };
}

// Stand-ins that show which navigator (or redirect) a layout rendered: each declared tab is a
// `tab-<name>` element saying whether it has a tab-bar button, followed by its header buttons.
// The header every tab shares (settings gear, Online switch) is rendered once, in `shared-header`.
jest.mock('expo-router', () => {
  const { createElement, Fragment } = jest.requireActual<typeof ReactModule>('react');
  const { Text, View } = jest.requireActual<typeof ReactNativeModule>('react-native');
  const Tabs = Object.assign(
    ({
      children,
      screenOptions,
    }: {
      children?: ReactModule.ReactNode;
      screenOptions?: HeaderOptions;
    }) =>
      createElement(
        View,
        { testID: 'tabs' },
        createElement(
          View,
          { testID: 'shared-header' },
          screenOptions?.headerLeft?.(),
          screenOptions?.headerRight?.(),
        ),
        children,
      ),
    {
      Screen: ({ name, options }: TabScreenProps) =>
        createElement(
          Fragment,
          null,
          createElement(
            Text,
            { testID: `tab-${name}` },
            options?.href === null ? 'hidden' : 'shown',
          ),
          options?.headerLeft?.(),
          options?.headerRight?.(),
        ),
    },
  );
  return {
    Redirect: ({ href }: { href: string }) => createElement(Text, { testID: 'redirect' }, href),
    router: { push: jest.fn(), navigate: jest.fn(), back: jest.fn() },
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
  // Step 7.7: the vendor screens are the Seller app's.
  beforeEach(() => {
    setAppVariantForTests('SELLER');
  });
  afterEach(() => {
    setAppVariantForTests('CUSTOMER');
  });

  it('is not mounted by the customer app, even for a vendor session', () => {
    setAppVariantForTests('CUSTOMER');
    signIn('VENDOR');

    renderWithProviders(<VendorLayout />);

    expect(screen.getByTestId('redirect')).toHaveTextContent('/');
  });

  it('opens for a signed-in vendor', () => {
    signIn('VENDOR');

    renderWithProviders(<VendorLayout />);

    expect(screen.getByTestId('tab-dashboard')).toBeOnTheScreen();
  });

  it('has four tabs, Live Orders first, and keeps the other routes out of the tab bar', () => {
    signIn('VENDOR');

    renderWithProviders(<VendorLayout />);

    const tabs = screen.getAllByTestId(/^tab-/);
    expect(tabs.map((tab) => String(tab.props.testID))).toEqual([
      'tab-dashboard',
      'tab-catalogue',
      'tab-wallet',
      'tab-marketing',
      'tab-invoices',
      'tab-product',
      'tab-offer',
      'tab-analytics',
      'tab-order-chat',
      'tab-payments',
      'tab-settings',
    ]);
    expect(screen.getByTestId('tab-invoices')).toHaveTextContent('hidden');
    for (const name of ['product', 'offer', 'analytics', 'order-chat', 'payments']) {
      expect(screen.getByTestId(`tab-${name}`)).toHaveTextContent('hidden');
    }
    expect(screen.getByTestId('tab-settings')).toHaveTextContent('hidden');
    for (const name of ['dashboard', 'catalogue', 'wallet', 'marketing']) {
      expect(screen.getByTestId(`tab-${name}`)).toHaveTextContent('shown');
    }
  });

  it('opens Invoices from the Ledger header and returns to the Ledger from there', () => {
    signIn('VENDOR');
    renderWithProviders(<VendorLayout />);

    fireEvent.press(screen.getByTestId('vendor-invoices-link'));
    expect(router.push).toHaveBeenCalledWith('/invoices');

    fireEvent.press(screen.getByTestId('vendor-invoices-back'));
    expect(router.navigate).toHaveBeenCalledWith('/wallet');
  });

  it('puts the settings gear and the Online switch in the header every tab shares', () => {
    signIn('VENDOR');
    renderWithProviders(<VendorLayout />);
    const shared = within(screen.getByTestId('shared-header'));

    expect(shared.getByTestId('vendor-online-toggle')).toBeOnTheScreen();
    fireEvent.press(shared.getByTestId('vendor-settings-link'));
    expect(router.push).toHaveBeenCalledWith('/settings');

    // The Ledger replaces the right side with its own buttons: the switch must still be there.
    expect(screen.getAllByTestId('vendor-online-toggle')).toHaveLength(2);

    fireEvent.press(screen.getByTestId('vendor-settings-back'));
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('opens the product form from the Catalogue and returns there', () => {
    signIn('VENDOR');
    renderWithProviders(<VendorLayout />);

    fireEvent.press(screen.getByTestId('vendor-product-back'));

    expect(router.navigate).toHaveBeenCalledWith('/catalogue');
  });

  it('opens Analytics from the Ledger header, and returns from it and from the offer form', () => {
    signIn('VENDOR');
    renderWithProviders(<VendorLayout />);

    fireEvent.press(screen.getByTestId('vendor-analytics-link'));
    expect(router.push).toHaveBeenCalledWith('/analytics');

    fireEvent.press(screen.getByTestId('vendor-analytics-back'));
    expect(router.navigate).toHaveBeenLastCalledWith('/wallet');

    fireEvent.press(screen.getByTestId('vendor-offer-back'));
    expect(router.navigate).toHaveBeenLastCalledWith('/marketing');
  });

  it('opens Marketing on My Offers', () => {
    renderWithProviders(<VendorMarketingScreen />);

    expect(screen.getByTestId('marketing-section-OFFERS')).toBeSelected();
    // The offers themselves come from the API (VendorMarketing.test.tsx).
    expect(screen.getByTestId('offers-loading')).toBeOnTheScreen();
  });
});

describe('customer tabs', () => {
  it('sign a vendor session out of the customer app, which asks for a customer sign-in (step 7.7)', () => {
    signIn('VENDOR');

    renderWithProviders(<TabsLayout />);

    expect(screen.queryByTestId('tab-(home)')).not.toBeOnTheScreen();
    expect(useAuthStore.getState().refreshToken).toBeNull();
  });

  it('in the Seller app, send a vendor to the order dashboard, even after a relaunch', () => {
    setAppVariantForTests('SELLER');
    try {
      signIn('VENDOR');
      useAuthStore.setState({ accessToken: null });
      renderWithProviders(<TabsLayout />);
      expect(screen.getByTestId('redirect')).toHaveTextContent('/dashboard');
    } finally {
      setAppVariantForTests('CUSTOMER');
    }
  });

  it('in the Seller app, open on the seller sign-in when signed out', () => {
    setAppVariantForTests('SELLER');
    try {
      renderWithProviders(<TabsLayout />);
      expect(screen.getByTestId('redirect')).toHaveTextContent('/login');
    } finally {
      setAppVariantForTests('CUSTOMER');
    }
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

    expect(screen.getByTestId('tab-(home)')).toBeOnTheScreen();
    expect(screen.queryByTestId('redirect')).not.toBeOnTheScreen();
  });
});

describe('boot flow: the welcome screen', () => {
  it('sends a visitor who is neither signed in nor a guest to /welcome', () => {
    renderWithProviders(<TabsLayout />);

    expect(screen.getByTestId('redirect')).toHaveTextContent('/welcome');
    expect(screen.queryByTestId('tab-(home)')).not.toBeOnTheScreen();
  });

  it('asks again after a sign-out when the login was never skipped', () => {
    signIn('CUSTOMER');
    const view = renderWithProviders(<TabsLayout />);
    expect(screen.getByTestId('tab-(home)')).toBeOnTheScreen();
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

    expect(screen.getByTestId('tab-(home)')).toBeOnTheScreen();
  });

  it('never holds another account, or a guest, for an onboarding that is not theirs', () => {
    useProfileStore.getState().requireOnboarding('another-user-id');
    signIn('CUSTOMER');
    const other = renderWithProviders(<TabsLayout />);
    expect(screen.getByTestId('tab-(home)')).toBeOnTheScreen();
    other.unmount();

    useAuthStore.getState().clearSession();
    useOnboardingStore.getState().skipAuthWall();
    renderWithProviders(<TabsLayout />);

    expect(screen.getByTestId('tab-(home)')).toBeOnTheScreen();
  });
});
