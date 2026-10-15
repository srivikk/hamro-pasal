import type { VendorOrderView } from '@hamro-pasal/shared-types';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';
import { Alert, type AlertButton } from 'react-native';

import VendorSettingsScreen from '../../../app/(vendor)/settings';
import { selectHasSession, useAuthStore } from '../../store/useAuthStore';
import { useProfileStore } from '../../store/useProfileStore';
import { useToastStore } from '../../store/useToastStore';
import { useVendorBoardStore } from '../../store/useVendorBoardStore';
import { useVendorShopStore } from '../../store/useVendorShopStore';
import { accessTokenFor } from '../../test/access-tokens';
import { walletBalance } from '../../test/api-fixtures';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { createTestQueryClient, renderWithProviders } from '../../test/render';
import { vendorOrdersQueryKey } from './useVendorOrders';
import { vendorWalletBalanceQueryKey } from './useVendorWallet';

setupApiTestEnvironment();

const VENDOR_USER_ID = '9f1c2a10-0000-4000-8000-0000000000aa';
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
  useVendorShopStore.setState({ online: true, stored: null });
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

describe('Shop settings: Delete Shop Account', () => {
  const PATH = '/api/vendor/account/deactivate';
  const closed = {
    vendor_id: '7b1f0c8e-0000-4000-8000-0000000000aa',
    status: 'DEACTIVATED',
    deactivated_at: '2026-10-09T06:15:00.000Z',
    cancelled_ad_count: 1,
    returned_npr: 0,
    closed_opt_in_count: 0,
    wallet_balance_npr: 0,
  };
  /** Serves the route and records what it was sent. */
  function serve(answer: () => Response = () => HttpResponse.json(closed)) {
    const bodies: unknown[] = [];
    server.use(
      http.post(apiUrl(PATH), async ({ request }) => {
        bodies.push(await request.json());
        return answer();
      }),
    );
    return bodies;
  }
  const refusal = (blockers: string[]) => () =>
    HttpResponse.json(
      { error: { code: 'SHOP_NOT_DEACTIVATABLE', message: 'no', details: { blockers } } },
      { status: 409 },
    );
  const signedIn = () => selectHasSession(useAuthStore.getState());

  it('asks to confirm first, and sends nothing on Cancel', () => {
    const bodies = serve();
    renderSettings();

    fireEvent.press(screen.getByTestId('settings-delete-shop'));

    expect(lastAlert().title).toBe('Delete your shop account?');
    expect(lastAlert().message).toContain('You cannot sign in again');
    pressAlertButton('Cancel');
    expect(bodies).toEqual([]);
    expect(signedIn()).toBe(true);
  });

  it('on confirmation closes the shop on the server and signs the vendor out', async () => {
    const bodies = serve();
    renderSettings();

    fireEvent.press(screen.getByTestId('settings-delete-shop'));
    pressAlertButton('Delete Shop Account');

    await waitFor(() => {
      expect(signedIn()).toBe(false);
    });
    expect(bodies).toEqual([{ confirm: true }]);
    expect(toast()).toMatchObject({ message: 'Your shop account is closed.', tone: 'success' });
  });

  it('names every reason the server gives, and leaves the vendor signed in', async () => {
    serve(refusal(['NEGATIVE_BALANCE', 'ACTIVE_ORDERS', 'PENDING_PAYOUT', 'AD_FEES_DUE']));
    renderSettings();

    fireEvent.press(screen.getByTestId('settings-delete-shop'));
    pressAlertButton('Delete Shop Account');

    await waitFor(() => {
      expect(lastAlert().title).toBe("Your shop can't be deleted yet");
    });
    expect(lastAlert().message.split('\n')).toEqual([
      'Your ledger balance is negative. Clear your dues first.',
      'You have active orders. Complete or reject them first.',
      'A payout to your bank is still in progress. Wait until it is settled.',
      'An ad fee is still owed. It is taken from your next earnings; try again after that.',
    ]);
    expect(signedIn()).toBe(true);
    expect(screen.getByTestId('settings-delete-shop')).toBeEnabled();
  });

  it('shows only the reason that applies', async () => {
    serve(refusal(['ACTIVE_ORDERS']));
    renderSettings();

    fireEvent.press(screen.getByTestId('settings-delete-shop'));
    pressAlertButton('Delete Shop Account');

    await waitFor(() => {
      expect(lastAlert().message).toBe('You have active orders. Complete or reject them first.');
    });
  });

  it('says so when the shop could not be closed, and never signs out for it', async () => {
    let answer: () => Response = () => HttpResponse.error();
    const bodies = serve(() => answer());
    renderSettings();

    fireEvent.press(screen.getByTestId('settings-delete-shop'));
    pressAlertButton('Delete Shop Account');
    await waitFor(() => {
      expect(toast()).toMatchObject({
        message: 'No connection. Your shop was not closed.',
        tone: 'error',
      });
    });

    answer = () =>
      HttpResponse.json(
        { error: { code: 'INTERNAL_SERVER_ERROR', message: 'x' } },
        { status: 500 },
      );
    fireEvent.press(screen.getByTestId('settings-delete-shop'));
    pressAlertButton('Delete Shop Account');
    await waitFor(() => {
      expect(toast()).toMatchObject({ message: "Couldn't close your shop. Try again." });
    });

    // A refusal without readable reasons is not shown as an empty list.
    answer = () =>
      HttpResponse.json(
        { error: { code: 'SHOP_NOT_DEACTIVATABLE', message: 'x' } },
        { status: 409 },
      );
    fireEvent.press(screen.getByTestId('settings-delete-shop'));
    pressAlertButton('Delete Shop Account');
    await waitFor(() => {
      expect(bodies).toHaveLength(3);
    });
    expect(signedIn()).toBe(true);
  });
});
