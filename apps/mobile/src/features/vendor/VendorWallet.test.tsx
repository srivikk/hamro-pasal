import type {
  VendorWalletBalanceResponseBody,
  VendorWalletLedgerResponseBody,
} from '@hamro-pasal/shared-types';
import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import VendorWalletScreen from '../../../app/(vendor)/wallet';
import { VENDOR_WALLET_BALANCE_PATH, VENDOR_WALLET_LEDGER_PATH } from '../../api/vendor-wallet';
import type { AppLocale } from '../../i18n/app-locale';
import { errorBody, walletBalance, walletEntry, walletLedgerPage } from '../../test/api-fixtures';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  router: { push: jest.fn(), replace: jest.fn() },
}));

setupApiTestEnvironment();

/**
 * Phase 12: the vendor wallet screen (SPEC §5) over msw, through the real apiRequest, Zod contracts
 * and TanStack queries. The suspension banner is the SPEC's "app locks until they clear the negative
 * balance": it must appear exactly when the server says the vendor is suspended.
 */

let ledgerRequests: URL[] = [];

function serve(
  balance: VendorWalletBalanceResponseBody,
  pages: Record<string, VendorWalletLedgerResponseBody> = { first: walletLedgerPage([]) },
): void {
  server.use(
    http.get(apiUrl(VENDOR_WALLET_BALANCE_PATH), () => HttpResponse.json(balance)),
    http.get(apiUrl(VENDOR_WALLET_LEDGER_PATH), ({ request }) => {
      const url = new URL(request.url);
      ledgerRequests.push(url);
      const page = pages[url.searchParams.get('cursor') ?? 'first'];
      return page === undefined
        ? HttpResponse.json(errorBody('INVALID_CURSOR'), { status: 400 })
        : HttpResponse.json(page);
    }),
  );
}

async function renderWallet(locale: AppLocale = 'en'): Promise<void> {
  renderWithProviders(<VendorWalletScreen />, { locale });
  await waitFor(() => {
    expect(screen.queryByTestId('wallet-loading')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('wallet-ledger-loading')).not.toBeOnTheScreen();
  });
}

const banner = () => screen.queryByTestId('wallet-suspended-banner');

beforeEach(() => {
  ledgerRequests = [];
});

describe('the suspension banner', () => {
  it('is shown, in red with the dues and the limit, when the vendor is suspended for debt', async () => {
    serve(
      walletBalance({
        status: 'SUSPENDED',
        is_suspended: true,
        wallet_balance_npr: -2500,
        suspension_limit_npr: -2000,
      }),
    );

    await renderWallet();

    const shown = screen.getByTestId('wallet-suspended-banner');
    expect(within(shown).getByText('Your shop is offline')).toBeOnTheScreen();
    expect(
      screen.getByText(
        'You owe Rs. 2500 in platform dues, more than the Rs. 2000 limit. Customers cannot order from you until you pay your dues with eSewa.',
      ),
    ).toBeOnTheScreen();
    expect(screen.getByTestId('wallet-balance')).toHaveTextContent('− Rs. 2500');
  });

  it('is not shown for a healthy wallet', async () => {
    serve(walletBalance({ wallet_balance_npr: 850 }));

    await renderWallet();

    expect(banner()).not.toBeOnTheScreen();
    expect(screen.getByTestId('wallet-balance')).toHaveTextContent('Rs. 850');
  });

  it('is not shown for a negative wallet still within the limit (the shop is live)', async () => {
    serve(walletBalance({ wallet_balance_npr: -1500, suspension_limit_npr: -2000 }));

    await renderWallet();

    expect(banner()).not.toBeOnTheScreen();
    expect(screen.getByTestId('wallet-balance')).toHaveTextContent('− Rs. 1500');
  });

  it('follows the server’s is_suspended, not a client-side comparison with the limit', async () => {
    // Suspended by the nightly sweep after the limit was tightened to −1000.
    serve(
      walletBalance({
        status: 'SUSPENDED',
        is_suspended: true,
        wallet_balance_npr: -1500,
        suspension_limit_npr: -1000,
      }),
    );

    await renderWallet();

    expect(banner()).toBeOnTheScreen();
    expect(screen.getByText(/You owe Rs\. 1500 .* Rs\. 1000 limit/)).toBeOnTheScreen();
  });

  it('explains a suspension that is not about dues without quoting any', async () => {
    serve(walletBalance({ status: 'SUSPENDED', is_suspended: true, wallet_balance_npr: 0 }));

    await renderWallet();

    expect(banner()).toBeOnTheScreen();
    expect(
      screen.getByText(
        'Your shop is suspended, so customers cannot order from you. Contact Hamro Pasal support.',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/You owe/)).not.toBeOnTheScreen();
  });

  it('renders the amounts in Devanagari digits in Nepali', async () => {
    serve(
      walletBalance({
        status: 'SUSPENDED',
        is_suspended: true,
        wallet_balance_npr: -2500,
        suspension_limit_npr: -2000,
      }),
    );

    await renderWallet('ne');

    expect(banner()).toBeOnTheScreen();
    expect(screen.getByText(/रु\. २५०० तिर्न बाँकी/)).toBeOnTheScreen();
    expect(screen.getByTestId('wallet-balance')).toHaveTextContent('− रु. २५००');
  });
});

describe('the balance card', () => {
  it('shows prepaid money still waiting in escrow', async () => {
    serve(walletBalance({ pending_escrow_npr: 1850, pending_escrow_order_count: 2 }));

    await renderWallet();

    expect(screen.getByTestId('wallet-pending-escrow')).toHaveTextContent(
      'In escrow: Rs. 1850 from 2 paid orders, credited when they are delivered.',
    );
  });

  it('offers a retry when the balance cannot be loaded', async () => {
    server.use(
      http.get(apiUrl(VENDOR_WALLET_BALANCE_PATH), () =>
        HttpResponse.json(errorBody('VENDOR_NOT_FOUND'), { status: 404 }),
      ),
      http.get(apiUrl(VENDOR_WALLET_LEDGER_PATH), () => HttpResponse.json(walletLedgerPage([]))),
    );

    renderWithProviders(<VendorWalletScreen />);

    expect(
      await screen.findByText("Couldn't load your wallet. Check your connection."),
    ).toBeOnTheScreen();
    serve(walletBalance());
    fireEvent.press(screen.getByText('Try again'));
    expect(await screen.findByTestId('wallet-balance')).toHaveTextContent('Rs. 850');
  });
});

describe('the transaction list', () => {
  const payout = walletEntry({
    id: '8d9e0f1a-2b3c-4d4e-9f5a-6b7c8d9e0f1a',
    entry_type: 'ORDER_PAYOUT',
    kind: 'ORDER_SETTLEMENT',
    amount_npr: 950,
    balance_after_npr: 850,
    order: {
      id: '9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b',
      payment_method: 'ESEWA',
      fulfillment: 'SELF_DELIVERY',
      subtotal_npr: 1000,
      delivery_fee_npr: 50,
      commission_npr: 100,
    },
  });
  const commission = walletEntry();

  it('renders each posting with its label, signed amount, order and running balance', async () => {
    serve(walletBalance(), { first: walletLedgerPage([payout, commission]) });

    await renderWallet();

    const credit = screen.getByTestId(`wallet-entry-${payout.id}`);
    expect(within(credit).getByText('Order payout')).toBeOnTheScreen();
    expect(screen.getByTestId(`wallet-entry-amount-${payout.id}`)).toHaveTextContent('+ Rs. 950');
    expect(within(credit).getByText('Order #0F1A2B')).toBeOnTheScreen();
    expect(within(credit).getByText('Balance after: Rs. 850')).toBeOnTheScreen();

    const debit = screen.getByTestId(`wallet-entry-${commission.id}`);
    expect(within(debit).getByText('Commission on a cash order')).toBeOnTheScreen();
    expect(screen.getByTestId(`wallet-entry-amount-${commission.id}`)).toHaveTextContent(
      '− Rs. 100',
    );
    expect(within(debit).getByText('Commission Rs. 100 on Rs. 1000')).toBeOnTheScreen();
    expect(within(debit).getByText('Balance after: − Rs. 100')).toBeOnTheScreen();
  });

  it('says so when there are no postings yet', async () => {
    serve(walletBalance({ wallet_balance_npr: 0 }));

    await renderWallet();

    expect(screen.getByTestId('wallet-ledger-empty')).toBeOnTheScreen();
  });

  it('loads the next page with the cursor when the list reaches its end', async () => {
    serve(walletBalance(), {
      first: walletLedgerPage([payout], payout.id),
      [payout.id]: walletLedgerPage([commission]),
    });
    await renderWallet();
    expect(screen.queryByTestId(`wallet-entry-${commission.id}`)).not.toBeOnTheScreen();

    fireEvent(screen.getByTestId('wallet-ledger'), 'onEndReached');

    expect(await screen.findByTestId(`wallet-entry-${commission.id}`)).toBeOnTheScreen();
    expect(screen.getByTestId(`wallet-entry-${payout.id}`)).toBeOnTheScreen();
    expect(ledgerRequests.map((url) => url.searchParams.get('cursor'))).toEqual([null, payout.id]);

    // Last page (next_cursor null): reaching the end again asks for nothing more.
    fireEvent(screen.getByTestId('wallet-ledger'), 'onEndReached');
    await waitFor(() => {
      expect(ledgerRequests).toHaveLength(2);
    });
  });
});
