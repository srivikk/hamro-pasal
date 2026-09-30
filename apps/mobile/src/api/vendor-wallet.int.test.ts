import { http, HttpResponse } from 'msw';

import { errorBody, walletBalance, walletEntry, walletLedgerPage } from '../test/api-fixtures';
import {
  apiUrl,
  capture,
  server,
  setupApiTestEnvironment,
  TEST_ACCESS_TOKEN,
  type CapturedRequest,
} from '../test/msw';
import { CLIENT_ERROR_CODES } from './http';
import {
  fetchVendorWalletBalance,
  fetchVendorWalletLedger,
  TOP_UP_UNAVAILABLE,
  topUpVendorWallet,
  VENDOR_WALLET_BALANCE_PATH,
  VENDOR_WALLET_LEDGER_PATH,
  VENDOR_WALLET_TOP_UP_PATH,
} from './vendor-wallet';

setupApiTestEnvironment();

describe('GET /api/vendors/wallet/balance', () => {
  it('sends the Bearer token and parses vendorWalletBalanceResponseSchema', async () => {
    const received: CapturedRequest[] = [];
    const body = walletBalance({
      wallet_balance_npr: -2500,
      status: 'SUSPENDED',
      is_suspended: true,
    });
    server.use(
      http.get(apiUrl(VENDOR_WALLET_BALANCE_PATH), async ({ request }) => {
        received.push(await capture(request));
        return HttpResponse.json(body);
      }),
    );

    await expect(fetchVendorWalletBalance()).resolves.toEqual(body);
    expect(received[0]?.url.pathname).toBe('/api/vendors/wallet/balance');
    expect(received[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
  });

  it('rejects a body that breaks the contract', async () => {
    server.use(
      http.get(apiUrl(VENDOR_WALLET_BALANCE_PATH), () =>
        HttpResponse.json({ ...walletBalance(), is_suspended: 'no' }),
      ),
    );

    await expect(fetchVendorWalletBalance()).rejects.toMatchObject({
      code: CLIENT_ERROR_CODES.badResponse,
    });
  });
});

describe('GET /api/vendors/wallet/ledger', () => {
  it('asks for the first page without a cursor, then passes next_cursor', async () => {
    const received: CapturedRequest[] = [];
    const next = walletEntry().id;
    server.use(
      http.get(apiUrl(VENDOR_WALLET_LEDGER_PATH), async ({ request }) => {
        received.push(await capture(request));
        return HttpResponse.json(walletLedgerPage([walletEntry()], next));
      }),
    );

    const first = await fetchVendorWalletLedger();
    await fetchVendorWalletLedger(first.next_cursor);

    expect(first.entries).toEqual([walletEntry()]);
    expect(received.map((r) => r.url.search)).toEqual(['', `?cursor=${next}`]);
  });
});

describe('POST /api/vendors/wallet/top-up', () => {
  it('sends the key and the amount, and parses walletTopUpResponseSchema', async () => {
    const received: CapturedRequest[] = [];
    const body = {
      transaction_id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
      amount_npr: 2500,
      wallet_balance_npr: 0,
      status: 'LIVE',
      is_suspended: false,
      restored: true,
      replayed: false,
    };
    server.use(
      http.post(apiUrl(VENDOR_WALLET_TOP_UP_PATH), async ({ request }) => {
        received.push(await capture(request));
        return HttpResponse.json(body, { status: 201 });
      }),
    );

    await expect(topUpVendorWallet(2500, 'key-0123456789')).resolves.toEqual(body);
    expect(received[0]?.method).toBe('POST');
    expect(received[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
    expect(received[0]?.body).toEqual({ idempotency_key: 'key-0123456789', amount_npr: 2500 });
  });

  it('surfaces 503 TOP_UP_UNAVAILABLE as an ApiError code', async () => {
    server.use(
      http.post(apiUrl(VENDOR_WALLET_TOP_UP_PATH), () =>
        HttpResponse.json(errorBody(TOP_UP_UNAVAILABLE), { status: 503 }),
      ),
    );

    await expect(topUpVendorWallet(10, 'key-0123456789')).rejects.toMatchObject({
      status: 503,
      code: 'TOP_UP_UNAVAILABLE',
    });
  });
});
