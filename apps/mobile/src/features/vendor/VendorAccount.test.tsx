import type { VendorOrderView } from '@hamro-pasal/shared-types';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Alert, type AlertButton } from 'react-native';

import VendorSettingsScreen from '../../../app/(vendor)/settings';
import { useAuthStore } from '../../store/useAuthStore';
import { useProfileStore } from '../../store/useProfileStore';
import { useToastStore } from '../../store/useToastStore';
import { useVendorBoardStore } from '../../store/useVendorBoardStore';
import { useVendorShopStore } from '../../store/useVendorShopStore';
import { accessTokenFor } from '../../test/access-tokens';
import { vendorOrder, walletBalance } from '../../test/api-fixtures';
import { setupApiTestEnvironment } from '../../test/msw';
import { createTestQueryClient, renderWithProviders } from '../../test/render';
import { shopDeletionBlockers } from './shop-deletion';
import { vendorOrdersQueryKey } from './useVendorOrders';
import { vendorWalletBalanceQueryKey } from './useVendorWallet';

setupApiTestEnvironment();

const VENDOR_USER_ID = '9f1c2a10-0000-4000-8000-0000000000aa';
const shop = () => useVendorShopStore.getState();
const toast = () => useToastStore.getState().toast;

let alert: jest.SpiedFunction<typeof Alert.alert>;
const lastAlert = (): { title: string; message: string; buttons: AlertButton[] } => {
  const call = alert.mock.calls.at(-1);
  if (call === undefined) throw new Error('No alert was shown');
  return { title: call[0], message: call[1] ?? '', buttons: call[2] ?? [] };
};
function pressAlertButton(label: string): void {
  const button = lastAlert().buttons.find((each) => each.text === label);
  if (button === undefined) throw new Error(`No alert button "${label}"`);
  act(() => {
    button.onPress?.();
  });
}

/** Opens Shop settings with what the app has already loaded about the shop. */
function renderSettings(known: { balanceNpr?: number; orders?: VendorOrderView[] } = {}): void {
  const queryClient = createTestQueryClient();
  if (known.balanceNpr !== undefined) {
    queryClient.setQueryData(
      vendorWalletBalanceQueryKey,
      walletBalance({ wallet_balance_npr: known.balanceNpr }),
    );
  }
  if (known.orders !== undefined) queryClient.setQueryData(vendorOrdersQueryKey, known.orders);
  renderWithProviders(<VendorSettingsScreen />, { queryClient });
}

beforeEach(() => {
  useAuthStore.getState().setLocale('en');
  useAuthStore.getState().setSession({
    accessToken: accessTokenFor('VENDOR', VENDOR_USER_ID),
    refreshToken: 'r.jwt',
  });
  useVendorShopStore.setState({ online: true, stored: null, deletionRequest: null });
  useVendorBoardStore.getState().reset();
  useProfileStore.setState({ consents: null });
  useToastStore.setState({ toast: null });
  alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
});

afterEach(() => {
  alert.mockRestore();
});

describe('Shop settings: language', () => {
  it('switches the app language between English and Nepali', () => {
    renderSettings();
    expect(screen.getByText('Preferences')).toBeOnTheScreen();

    fireEvent.press(screen.getByTestId('language-toggle-ne'));

    // The store is what the app's i18n follows (bindLocale); the test renderer's is fixed.
    expect(useAuthStore.getState().locale).toBe('ne');
    expect(screen.getByTestId('language-toggle-ne')).toBeSelected();

    fireEvent.press(screen.getByTestId('language-toggle-en'));
    expect(useAuthStore.getState().locale).toBe('en');
  });
});

describe('Shop settings: WhatsApp updates', () => {
  it('is off by default and turns on for this account', async () => {
    renderSettings();
    const toggle = () => screen.getByTestId('settings-whatsapp');
    expect(toggle().props.value).toBe(false);

    fireEvent(toggle(), 'valueChange', true);

    expect(toggle().props.value).toBe(true); // at once, before the server answers
    await waitFor(() => {
      expect(toggle()).toBeEnabled();
    });
    expect(useProfileStore.getState().consents).toMatchObject({
      user_id: VENDOR_USER_ID,
      whatsapp_opt_in: true,
    });
  });
});

describe('shop deletion rules', () => {
  it('blocks a shop that owes money or has orders in hand', () => {
    expect(shopDeletionBlockers({ balanceNpr: 0, activeOrders: 0 })).toEqual([]);
    expect(shopDeletionBlockers({ balanceNpr: 850, activeOrders: 0 })).toEqual([]);
    expect(shopDeletionBlockers({ balanceNpr: -0.01, activeOrders: 0 })).toEqual([
      'NEGATIVE_BALANCE',
    ]);
    expect(shopDeletionBlockers({ balanceNpr: 0, activeOrders: 1 })).toEqual(['ACTIVE_ORDERS']);
    expect(shopDeletionBlockers({ balanceNpr: -100, activeOrders: 2 })).toEqual([
      'NEGATIVE_BALANCE',
      'ACTIVE_ORDERS',
    ]);
  });
});

describe('Shop settings: Delete Shop Account', () => {
  it('refuses while the ledger balance is negative, saying why', () => {
    renderSettings({ balanceNpr: -100 });

    fireEvent.press(screen.getByTestId('settings-delete-shop'));

    expect(lastAlert().title).toBe("Your shop can't be deleted yet");
    expect(lastAlert().message).toBe('Your ledger balance is negative. Clear your dues first.');
    expect(lastAlert().buttons).toEqual([]); // nothing to confirm
    expect(shop().deletionRequest).toBeNull();
  });

  it('refuses while the shop has active orders', () => {
    renderSettings({ balanceNpr: 500, orders: [vendorOrder({ state: 'PREPARING' })] });

    fireEvent.press(screen.getByTestId('settings-delete-shop'));

    expect(lastAlert().message).toBe('You have active orders. Complete or reject them first.');
    expect(shop().deletionRequest).toBeNull();
  });

  it('counts a fleet order still waiting for its rider as active, and names both reasons', () => {
    useVendorBoardStore
      .getState()
      .recordDeparted(vendorOrder({ state: 'OUT_FOR_DELIVERY', fulfillment: 'PLATFORM_FLEET' }));
    renderSettings({ balanceNpr: -2500 });

    fireEvent.press(screen.getByTestId('settings-delete-shop'));

    expect(lastAlert().message).toBe(
      'Your ledger balance is negative. Clear your dues first.\nYou have active orders. Complete or reject them first.',
    );
  });

  it('does not count an order already delivered', () => {
    useVendorBoardStore.getState().recordDeparted(vendorOrder({ state: 'DELIVERED' }));
    renderSettings({ balanceNpr: 0 });

    fireEvent.press(screen.getByTestId('settings-delete-shop'));

    expect(lastAlert().title).toBe('Delete your shop account?');
  });

  it('asks to confirm when clear, and changes nothing on Cancel', () => {
    renderSettings({ balanceNpr: 0, orders: [] });

    fireEvent.press(screen.getByTestId('settings-delete-shop'));
    expect(lastAlert().buttons.map((button) => button.text)).toEqual([
      'Cancel',
      'Delete Shop Account',
    ]);
    pressAlertButton('Cancel');

    expect(shop()).toMatchObject({ deletionRequest: null, online: true });
    expect(screen.getByTestId('settings-delete-shop')).toBeOnTheScreen();
  });

  it('on confirmation marks the account for deletion and takes the shop offline', () => {
    renderSettings({ balanceNpr: 0, orders: [] });

    fireEvent.press(screen.getByTestId('settings-delete-shop'));
    pressAlertButton('Delete Shop Account');

    expect(shop().deletionRequest).toMatchObject({ userId: VENDOR_USER_ID });
    expect(shop().online).toBe(false);
    expect(screen.getByTestId('settings-deletion-pending')).toHaveTextContent(
      /Deletion requested on \d{4}-\d{2}-\d{2}/,
    );
    expect(screen.queryByTestId('settings-delete-shop')).not.toBeOnTheScreen();
    expect(toast()?.message).toBe('Deletion requested. Your shop is offline.');
    // A soft delete: the vendor is still signed in and can change their mind.
    expect(useAuthStore.getState().refreshToken).toBe('r.jwt');
  });

  it('lets the vendor cancel the request', () => {
    shop().requestDeletion(VENDOR_USER_ID, Date.now());
    renderSettings();

    fireEvent.press(screen.getByTestId('settings-delete-cancel'));

    expect(shop().deletionRequest).toBeNull();
    expect(screen.getByTestId('settings-delete-shop')).toBeOnTheScreen();
  });

  it("never shows another account's request", () => {
    shop().requestDeletion('another-vendor-user', Date.now());
    renderSettings();

    expect(screen.queryByTestId('settings-deletion-pending')).not.toBeOnTheScreen();
    expect(screen.getByTestId('settings-delete-shop')).toBeOnTheScreen();
  });
});
