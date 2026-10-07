import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import VendorWalletScreen from '../../../app/(vendor)/wallet';
import { VENDOR_WALLET_BALANCE_PATH, VENDOR_WALLET_LEDGER_PATH } from '../../api/vendor-wallet';
import { errorBody, walletBalance, walletLedgerPage } from '../../test/api-fixtures';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import type * as VendorFinanceMocksModule from './vendor-finance-mocks';
import {
  creditUsedFraction,
  mockWalletBalance,
  useVendorFinanceStore,
  type SettlementModel,
} from './vendor-finance-mocks';
import { WalletSummary } from './WalletSummary';

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  router: { push: jest.fn() },
}));

// The Ledger as a development build shows it: sample figures on (Jest turns them off by default).
jest.mock('./vendor-finance-mocks', () => ({
  ...jest.requireActual<typeof VendorFinanceMocksModule>('./vendor-finance-mocks'),
  VENDOR_FINANCE_MOCKS_ENABLED: true,
}));

setupApiTestEnvironment();

const noop = (): void => undefined;
const summary = (model: SettlementModel, overrides: Parameters<typeof walletBalance>[0] = {}) =>
  renderWithProviders(
    <WalletSummary
      balance={walletBalance(overrides)}
      model={model}
      onPayDues={noop}
      paying={false}
    />,
  );

beforeEach(() => {
  useVendorFinanceStore.setState({ settlementModel: 'PLATFORM_ESCROW' });
});

describe('creditUsedFraction', () => {
  it('is the share of the credit limit a negative balance has used', () => {
    expect(creditUsedFraction(0, -2000)).toBe(0);
    expect(creditUsedFraction(850, -2000)).toBe(0);
    expect(creditUsedFraction(-500, -2000)).toBe(0.25);
    expect(creditUsedFraction(-2000, -2000)).toBe(1);
    expect(creditUsedFraction(-2500, -2000)).toBe(1); // past the limit: suspended, the bar is full
  });
});

describe('the balance card by settlement model', () => {
  it('Model A: the credit balance and a bar towards the Rs. 2000 limit', () => {
    summary('COD_CREDIT', { wallet_balance_npr: -1200 });

    expect(screen.getByTestId('wallet-model')).toHaveTextContent(/Model A/);
    expect(screen.getByText('Credit balance')).toBeOnTheScreen();
    expect(screen.getByTestId('wallet-balance')).toHaveTextContent('− Rs. 1200');
    expect(screen.getByTestId('wallet-credit-bar').props.accessibilityValue).toEqual({
      min: 0,
      max: 100,
      now: 60,
    });
    expect(screen.getByTestId('wallet-credit-used')).toHaveTextContent(
      'Rs. 1200 of your Rs. 2000 credit used',
    );
    expect(screen.queryByTestId('wallet-escrow-amount')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('wallet-reserve')).not.toBeOnTheScreen();
  });

  it('Model A: an empty bar while nothing is owed, a full one at the limit', () => {
    const none = summary('COD_CREDIT', { wallet_balance_npr: 300 });
    expect(screen.getByTestId('wallet-credit-bar').props.accessibilityValue).toMatchObject({
      now: 0,
    });
    expect(screen.getByTestId('wallet-credit-used')).toHaveTextContent(
      'Rs. 0 of your Rs. 2000 credit used',
    );
    none.unmount();

    summary('COD_CREDIT', { wallet_balance_npr: -2600 });
    expect(screen.getByTestId('wallet-credit-bar').props.accessibilityValue).toMatchObject({
      now: 100,
    });
    expect(screen.getByTestId('wallet-credit-used')).toHaveTextContent(
      'Rs. 2000 of your Rs. 2000 credit used',
    );
  });

  it('Model B: Pending Escrow and Available for Payout', () => {
    summary('PLATFORM_ESCROW', {
      wallet_balance_npr: 8450,
      pending_escrow_npr: 3200,
      pending_escrow_order_count: 4,
    });

    expect(screen.getByTestId('wallet-model')).toHaveTextContent(/Model B/);
    expect(screen.getByText('Pending escrow')).toBeOnTheScreen();
    expect(screen.getByTestId('wallet-escrow-amount')).toHaveTextContent('Rs. 3200');
    expect(screen.getByText('Available for payout')).toBeOnTheScreen();
    expect(screen.getByTestId('wallet-available-amount')).toHaveTextContent('Rs. 8450');
    expect(screen.queryByTestId('wallet-credit-bar')).not.toBeOnTheScreen();
  });

  it('Model B: nothing is available for payout while the wallet is negative', () => {
    summary('PLATFORM_ESCROW', { wallet_balance_npr: -100 });

    expect(screen.getByTestId('wallet-balance')).toHaveTextContent('− Rs. 100');
    expect(screen.getByTestId('wallet-available-amount')).toHaveTextContent('Rs. 0');
  });

  it('Model C: the active reserve balance against the Fixed Reserve', () => {
    summary('DIRECT_PREPAID', { wallet_balance_npr: 7500 });

    expect(screen.getByTestId('wallet-model')).toHaveTextContent(/Model C/);
    expect(screen.getByText('Active reserve balance')).toBeOnTheScreen();
    expect(screen.getByTestId('wallet-balance')).toHaveTextContent('Rs. 7500');
    expect(screen.getByTestId('wallet-reserve')).toHaveTextContent(
      'Fixed reserve: Rs. 5000 · Rs. 2500 above it',
    );
    expect(screen.queryByTestId('wallet-escrow-amount')).not.toBeOnTheScreen();
  });

  it('defaults to Model B, the model every shop runs on today', () => {
    renderWithProviders(
      <WalletSummary balance={walletBalance()} onPayDues={noop} paying={false} />,
    );
    expect(screen.getByTestId('wallet-model')).toHaveTextContent(/Model B/);
  });
});

describe('Ledger tab with sample figures (development builds)', () => {
  function serve(balance: () => Response): void {
    server.use(
      http.get(apiUrl(VENDOR_WALLET_BALANCE_PATH), balance),
      http.get(apiUrl(VENDOR_WALLET_LEDGER_PATH), () => HttpResponse.json(walletLedgerPage([]))),
    );
  }

  it('shows the real balance for Model B, and sample figures when A or C is previewed', async () => {
    serve(() => HttpResponse.json(walletBalance({ wallet_balance_npr: 850 })));
    renderWithProviders(<VendorWalletScreen />);

    // Until the server answers, the Model B sample stands in.
    expect(screen.getByTestId('ledger-sample-note')).toBeOnTheScreen();
    await waitFor(() => {
      expect(screen.getByTestId('wallet-balance')).toHaveTextContent('Rs. 850');
    });
    expect(screen.queryByTestId('ledger-sample-note')).not.toBeOnTheScreen();

    fireEvent.press(screen.getByTestId('ledger-model-COD_CREDIT'));
    expect(screen.getByTestId('ledger-sample-note')).toHaveTextContent(
      'Sample figures, not your real balance.',
    );
    expect(screen.getByTestId('wallet-balance')).toHaveTextContent('− Rs. 1200');
    expect(screen.getByTestId('wallet-credit-bar')).toBeOnTheScreen();

    fireEvent.press(screen.getByTestId('ledger-model-DIRECT_PREPAID'));
    expect(screen.getByTestId('wallet-balance')).toHaveTextContent('Rs. 7500');
    expect(screen.getByTestId('wallet-reserve')).toBeOnTheScreen();

    fireEvent.press(screen.getByTestId('ledger-model-PLATFORM_ESCROW'));
    expect(screen.getByTestId('wallet-balance')).toHaveTextContent('Rs. 850');
    expect(screen.queryByTestId('ledger-sample-note')).not.toBeOnTheScreen();
  });

  it('falls back to the Model B sample when the wallet cannot be loaded', async () => {
    serve(() => HttpResponse.json(errorBody('VENDOR_NOT_FOUND'), { status: 404 }));
    renderWithProviders(<VendorWalletScreen />);

    expect(await screen.findByTestId('wallet-ledger-empty')).toBeOnTheScreen();
    expect(screen.getByTestId('ledger-sample-note')).toBeOnTheScreen();
    expect(screen.getByTestId('wallet-escrow-amount')).toHaveTextContent('Rs. 3200');
    expect(screen.getByTestId('wallet-available-amount')).toHaveTextContent('Rs. 8450');
    expect(screen.queryByTestId('wallet-loading')).not.toBeOnTheScreen();
  });

  it('never shows a sample shop as suspended', () => {
    for (const model of ['COD_CREDIT', 'PLATFORM_ESCROW', 'DIRECT_PREPAID'] as const) {
      expect(mockWalletBalance(model)).toMatchObject({ is_suspended: false, status: 'LIVE' });
    }
  });
});
