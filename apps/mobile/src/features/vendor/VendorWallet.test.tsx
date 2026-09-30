import type {
  VendorWalletBalanceResponseBody,
  VendorWalletLedgerResponseBody,
} from '@hamro-pasal/shared-types';
import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { walletTopUpResponseSchema } from '@hamro-pasal/shared-types';
import { delay, http, HttpResponse } from 'msw';

import VendorWalletScreen from '../../../app/(vendor)/wallet';
import {
  VENDOR_WALLET_BALANCE_PATH,
  VENDOR_WALLET_LEDGER_PATH,
  VENDOR_WALLET_TOP_UP_PATH,
} from '../../api/vendor-wallet';
import type { AppLocale } from '../../i18n/app-locale';
import { errorBody, walletBalance, walletEntry, walletLedgerPage } from '../../test/api-fixtures';
import { apiUrl, capture, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import { useToastStore } from '../../store/useToastStore';

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  router: { push: jest.fn(), replace: jest.fn() },
}));

setupApiTestEnvironment();

/**
 * Phase 12: the vendor wallet screen (SPEC §5) over msw, through the real apiRequest, Zod contracts
 * and TanStack queries. The suspension banner is the SPEC's "app locks until they clear the negative
 * balance": it must appear exactly when the server says the vendor is suspended. Phase 12.5 adds
 * the "Pay Outstanding Balance" button (a mock top-up of exactly the dues).
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

/** A vendor suspended for wallet debt (−2500 against the −2000 limit) by default. */
const inDebt = (overrides: Partial<VendorWalletBalanceResponseBody> = {}) =>
  walletBalance({
    status: 'SUSPENDED',
    is_suspended: true,
    suspended_for_debt: true,
    wallet_balance_npr: -2500,
    suspension_limit_npr: -2000,
    ...overrides,
  });

const payButton = () => screen.queryByTestId('wallet-pay-dues');

describe('the suspension banner', () => {
  it('is shown, in red with the dues, the limit and a pay button, when suspended for debt', async () => {
    serve(inDebt());

    await renderWallet();

    const shown = screen.getByTestId('wallet-suspended-banner');
    expect(within(shown).getByText('Your shop is offline')).toBeOnTheScreen();
    expect(
      screen.getByText(
        'Your wallet went past the Rs. 2000 limit, so customers cannot order from you. Pay the Rs. 2500 you owe to bring your shop back online.',
      ),
    ).toBeOnTheScreen();
    expect(within(shown).getByTestId('wallet-pay-dues')).toHaveTextContent(
      'Pay outstanding balance (Rs. 2500)',
    );
    expect(screen.getByTestId('wallet-balance')).toHaveTextContent('− Rs. 2500');
  });

  it('is not shown for a healthy wallet', async () => {
    serve(walletBalance({ wallet_balance_npr: 850 }));

    await renderWallet();

    expect(banner()).not.toBeOnTheScreen();
    expect(payButton()).not.toBeOnTheScreen();
    expect(screen.getByTestId('wallet-balance')).toHaveTextContent('Rs. 850');
  });

  it('is not shown for a negative wallet still within the limit (the shop is live)', async () => {
    serve(walletBalance({ wallet_balance_npr: -1500, suspension_limit_npr: -2000 }));

    await renderWallet();

    expect(banner()).not.toBeOnTheScreen();
    expect(screen.getByTestId('wallet-balance')).toHaveTextContent('− Rs. 1500');
  });

  it('follows the server’s debt flag, not a comparison with the limit (after a partial payment)', async () => {
    // −1500 is above the −2000 limit, but the shop stays offline until the debt is cleared.
    serve(inDebt({ wallet_balance_npr: -1500 }));

    await renderWallet();

    expect(banner()).toBeOnTheScreen();
    expect(payButton()).toHaveTextContent('Pay outstanding balance (Rs. 1500)');
  });

  it('explains a suspension that is not about dues, with no pay button', async () => {
    serve(
      walletBalance({
        status: 'SUSPENDED',
        is_suspended: true,
        suspended_for_debt: false,
        wallet_balance_npr: -300,
      }),
    );

    await renderWallet();

    expect(banner()).toBeOnTheScreen();
    expect(
      screen.getByText(
        'Your shop is suspended, so customers cannot order from you. Contact Hamro Pasal support.',
      ),
    ).toBeOnTheScreen();
    expect(payButton()).not.toBeOnTheScreen();
  });

  it('renders the amounts in Devanagari digits in Nepali', async () => {
    serve(inDebt());

    await renderWallet('ne');

    expect(banner()).toBeOnTheScreen();
    expect(screen.getByText(/बाँकी रु\. २५०० तिर्नुहोस्/)).toBeOnTheScreen();
    expect(payButton()).toHaveTextContent('बाँकी रकम तिर्नुहोस् (रु. २५००)');
    expect(screen.getByTestId('wallet-balance')).toHaveTextContent('− रु. २५००');
  });
});

describe('Pay Outstanding Balance (Phase 12.5)', () => {
  const topUpEntry = walletEntry({
    id: '0f1a2b3c-4d5e-4f6a-8b7c-8d9e0f1a2b3c',
    kind: 'VENDOR_TOP_UP',
    entry_type: 'TOP_UP',
    amount_npr: 2500,
    balance_after_npr: 0,
    description: 'Mock top-up (no payment taken)',
    order: null,
  });
  let topUps: { idempotency_key: string; amount_npr: number }[] = [];
  const toast = () => useToastStore.getState().toast;

  beforeEach(() => {
    topUps = [];
    useToastStore.setState({ toast: null });
  });

  function serveTopUp(respond: () => Response | Promise<Response>): void {
    server.use(
      http.post(apiUrl(VENDOR_WALLET_TOP_UP_PATH), async ({ request }) => {
        topUps.push((await capture(request)).body as (typeof topUps)[number]);
        return respond();
      }),
    );
  }

  const restoredBody = () =>
    walletTopUpResponseSchema.parse({
      transaction_id: topUpEntry.transaction_id,
      amount_npr: 2500,
      wallet_balance_npr: 0,
      status: 'LIVE',
      is_suspended: false,
      restored: true,
      replayed: false,
    });

  it('pays exactly what is owed, clears the banner at once, then refetches balance and ledger', async () => {
    serve(inDebt());
    await renderWallet();
    let paid = false;
    let refetchAnswered = false;
    serveTopUp(() => {
      paid = true;
      return HttpResponse.json(restoredBody(), { status: 201 });
    });
    server.use(
      http.get(apiUrl(VENDOR_WALLET_BALANCE_PATH), async () => {
        if (!paid) return HttpResponse.json(inDebt());
        await delay(300); // the refetch is slow: the banner must already be gone
        refetchAnswered = true;
        return HttpResponse.json(walletBalance({ wallet_balance_npr: 0 }));
      }),
      http.get(apiUrl(VENDOR_WALLET_LEDGER_PATH), ({ request }) => {
        ledgerRequests.push(new URL(request.url));
        return HttpResponse.json(walletLedgerPage(paid ? [topUpEntry] : []));
      }),
    );

    fireEvent.press(screen.getByTestId('wallet-pay-dues'));

    await waitFor(() => {
      expect(banner()).not.toBeOnTheScreen();
    });
    expect(refetchAnswered).toBe(false);
    expect(screen.getByTestId('wallet-balance')).toHaveTextContent('Rs. 0');
    expect(topUps).toHaveLength(1);
    expect(topUps[0]?.amount_npr).toBe(2500);
    expect(topUps[0]?.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(toast()).toMatchObject({
      message: 'Dues paid. Your shop is back online.',
      tone: 'success',
    });
    expect(await screen.findByTestId(`wallet-entry-${topUpEntry.id}`)).toBeOnTheScreen();
    expect(screen.getByText('Dues paid')).toBeOnTheScreen();
    await waitFor(() => {
      expect(refetchAnswered).toBe(true);
    });
    expect(banner()).not.toBeOnTheScreen();
  });

  it('shows "Paying…" and cannot be pressed twice while the payment is in flight', async () => {
    serve(inDebt());
    await renderWallet();
    serveTopUp(async () => {
      await delay(200);
      return HttpResponse.json(restoredBody(), { status: 201 });
    });

    fireEvent.press(screen.getByTestId('wallet-pay-dues'));
    expect(await screen.findByText('Paying…')).toBeOnTheScreen();
    fireEvent.press(screen.getByTestId('wallet-pay-dues'));

    await waitFor(() => {
      expect(toast()?.tone).toBe('success');
    });
    expect(topUps).toHaveLength(1);
  });

  it('keeps the banner when the server says the shop is still suspended', async () => {
    serve(inDebt());
    await renderWallet();
    serveTopUp(() =>
      HttpResponse.json(
        {
          ...restoredBody(),
          wallet_balance_npr: -100,
          status: 'SUSPENDED',
          is_suspended: true,
          restored: false,
        },
        { status: 201 },
      ),
    );

    fireEvent.press(screen.getByTestId('wallet-pay-dues'));

    await waitFor(() => {
      expect(toast()?.message).toBe(
        'Payment received. Your shop stays offline until the balance is cleared.',
      );
    });
    expect(banner()).toBeOnTheScreen();
  });

  it('says so when the server has no top-up flow (503 TOP_UP_UNAVAILABLE)', async () => {
    serve(inDebt());
    await renderWallet();
    serveTopUp(() => HttpResponse.json(errorBody('TOP_UP_UNAVAILABLE'), { status: 503 }));

    fireEvent.press(screen.getByTestId('wallet-pay-dues'));

    await waitFor(() => {
      expect(toast()).toMatchObject({
        message: "Paying dues in the app isn't available yet.",
        tone: 'error',
      });
    });
    expect(banner()).toBeOnTheScreen();
  });

  it('retries a failed payment with the same idempotency key, so it can never pay twice', async () => {
    serve(inDebt());
    await renderWallet();
    let calls = 0;
    serveTopUp(() => {
      calls += 1;
      return calls === 1
        ? HttpResponse.json(errorBody('INTERNAL_SERVER_ERROR'), { status: 500 })
        : HttpResponse.json(restoredBody(), { status: 201 });
    });
    // The server's balance reflects the payment once the second attempt went through.
    server.use(
      http.get(apiUrl(VENDOR_WALLET_BALANCE_PATH), () =>
        HttpResponse.json(calls >= 2 ? walletBalance({ wallet_balance_npr: 0 }) : inDebt()),
      ),
    );

    fireEvent.press(screen.getByTestId('wallet-pay-dues'));
    await waitFor(() => {
      expect(toast()?.message).toBe("Couldn't complete the payment. Please try again.");
    });
    await waitFor(() => {
      expect(screen.getByTestId('wallet-pay-dues')).toBeEnabled();
    });
    fireEvent.press(screen.getByTestId('wallet-pay-dues'));

    await waitFor(() => {
      expect(banner()).not.toBeOnTheScreen();
    });
    expect(topUps).toHaveLength(2);
    expect(topUps[1]?.idempotency_key).toBe(topUps[0]?.idempotency_key);
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
