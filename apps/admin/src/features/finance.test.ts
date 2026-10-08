import type {
  AdminPayoutView,
  AuthUser,
  VendorFinanceLedgerResponseBody,
} from '@hamro-pasal/shared-types';

import { createAdminApi } from '../api/admin-api';
import { ApiError, createApiClient, type FetchLike } from '../api/client';
import { createSessionStore } from '../auth/session-store';
import { tabFromHash, VENDOR_TABS, vendorTabFromHash } from '../tabs';
import {
  canRequestPayout,
  parseBankReference,
  parsePayoutAmount,
  parseRejectionReason,
  PAYOUT_FILTERS,
  payoutDecisionErrorMessage,
  payoutRequestErrorMessage,
  replacePayout,
} from './finance/payout-rules';

const ID = {
  payout: '11111111-1111-4111-8111-111111111111',
  other: '22222222-2222-4222-8222-222222222222',
  vendor: '33333333-3333-4333-8333-333333333333',
  admin: '44444444-4444-4444-8444-444444444444',
  order: '55555555-5555-4555-8555-555555555555',
} as const;

const payout: AdminPayoutView = {
  id: ID.payout,
  amount_npr: 400,
  status: 'PENDING',
  bank_reference: null,
  rejection_reason: null,
  requested_at: '2026-10-03T06:00:00.000Z',
  decided_at: null,
  vendor: {
    id: ID.vendor,
    business_name: 'Thamel Kirana Pasal',
    phone: '+9779800000011',
    wallet_balance_npr: 600,
  },
  decided_by: null,
  transfer_state: null,
  system_actor: null,
  primary_bank_account: null,
};

const ledger: VendorFinanceLedgerResponseBody = {
  vendor_id: ID.vendor,
  available_balance_npr: 600,
  pending_balance_npr: 950,
  pending_payout_npr: 400,
  unreconciled_order_count: 1,
  reconciled_orders: [
    {
      order_id: ID.order,
      payment_method: 'ESEWA',
      fulfillment: 'SELF_DELIVERY',
      subtotal_npr: 1000,
      delivery_fee_npr: 50,
      commission_npr: 100,
      vendor_cut_npr: 950,
      wallet_amount_npr: 950,
      delivered_at: '2026-10-02T09:00:00.000Z',
      reconciled_at: '2026-10-02T18:15:00.000Z',
    },
  ],
  payouts: [],
};

describe('tabs', () => {
  it('adds Payouts to the dashboard and Earnings to the Vendor Portal', () => {
    expect(tabFromHash('#/payouts')).toBe('payouts');
    expect(VENDOR_TABS.map((tab) => tab.id)).toEqual(['my-products', 'earnings']);
    expect(vendorTabFromHash('#/earnings')).toBe('earnings');
    expect(vendorTabFromHash('')).toBe('my-products');
    // An admin section is not a vendor section.
    expect(vendorTabFromHash('#/payouts')).toBe('my-products');
  });

  it('opens the payout list on the requests that need a decision', () => {
    expect(PAYOUT_FILTERS[0]).toEqual({ label: 'Pending', status: 'PENDING' });
    expect(PAYOUT_FILTERS.at(-1)).toEqual({ label: 'All', status: undefined });
  });
});

describe('the admin decision inputs', () => {
  it('needs a bank reference of at most 100 characters, trimmed', () => {
    expect(parseBankReference('  NIC-ASIA-778812 ')).toEqual({
      ok: true,
      value: 'NIC-ASIA-778812',
    });
    expect(parseBankReference('   ')).toEqual({
      ok: false,
      error: 'Enter the reference of the bank transfer.',
    });
    expect(parseBankReference('x'.repeat(101)).ok).toBe(false);
    expect(parseBankReference('x'.repeat(100)).ok).toBe(true);
  });

  it('takes an optional rejection reason: blank is none', () => {
    expect(parseRejectionReason('')).toEqual({ ok: true, value: null });
    expect(parseRejectionReason('  Name mismatch ')).toEqual({ ok: true, value: 'Name mismatch' });
    expect(parseRejectionReason('x'.repeat(501)).ok).toBe(false);
  });

  it('replaces a decided request in every cached page', () => {
    const approved: AdminPayoutView = { ...payout, status: 'APPROVED', bank_reference: 'NIC-1' };
    const other: AdminPayoutView = { ...payout, id: ID.other };
    const data = {
      pageParams: [undefined, ID.other],
      pages: [
        { payouts: [other], next_cursor: ID.other },
        { payouts: [payout], next_cursor: null },
      ],
    };

    expect(replacePayout(data, approved)?.pages.map((page) => page.payouts)).toEqual([
      [other],
      [approved],
    ]);
    expect(replacePayout(undefined, approved)).toBeUndefined();
  });

  it('explains a refused decision', () => {
    expect(payoutDecisionErrorMessage(new ApiError(409, 'PAYOUT_ALREADY_DECIDED', 'x'))).toMatch(
      /already decided/,
    );
    expect(payoutDecisionErrorMessage(new ApiError(404, 'PAYOUT_NOT_FOUND', 'x'))).toMatch(
      /no longer exists/,
    );
    expect(payoutDecisionErrorMessage(new Error('boom'))).toBe(
      'The decision could not be saved. Try again.',
    );
  });
});

describe('the vendor payout amount', () => {
  it('accepts rupees with up to two decimals, up to the available balance', () => {
    expect(parsePayoutAmount(' 600 ', 600)).toEqual({ ok: true, value: 600 });
    expect(parsePayoutAmount('0.01', 600)).toEqual({ ok: true, value: 0.01 });
    expect(parsePayoutAmount('599.99', 600)).toEqual({ ok: true, value: 599.99 });
  });

  it('refuses more than the balance, naming what can be withdrawn', () => {
    expect(parsePayoutAmount('600.01', 600)).toEqual({
      ok: false,
      error: 'You can withdraw at most Rs. 600.',
    });
    expect(parsePayoutAmount('1', -100)).toEqual({
      ok: false,
      error: 'You can withdraw at most Rs. 0.',
    });
  });

  it('refuses zero, text, negatives, three decimals and more than one payout allows', () => {
    for (const input of ['', 'abc', '-5', '10.005', '1e3', '1,000']) {
      expect(parsePayoutAmount(input, 5000).ok).toBe(false);
    }
    expect(parsePayoutAmount('0', 5000)).toEqual({
      ok: false,
      error: 'Enter an amount above zero.',
    });
    expect(parsePayoutAmount('1000000.01', 2_000_000)).toEqual({
      ok: false,
      error: 'That is more than one payout allows.',
    });
  });

  it('offers a payout only from a positive balance', () => {
    expect(canRequestPayout(ledger)).toBe(true);
    expect(canRequestPayout({ ...ledger, available_balance_npr: 0 })).toBe(false);
    expect(canRequestPayout({ ...ledger, available_balance_npr: -100 })).toBe(false);
  });

  it('explains a refused request', () => {
    expect(payoutRequestErrorMessage(new ApiError(422, 'INSUFFICIENT_BALANCE', 'x'))).toMatch(
      /balance is lower/,
    );
    expect(payoutRequestErrorMessage(new ApiError(0, 'NETWORK_ERROR', 'x'))).toMatch(
      /will not be made twice/,
    );
    expect(payoutRequestErrorMessage(new Error('boom'))).toBe(
      'The payout could not be requested. Try again.',
    );
  });
});

interface Call {
  readonly call: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

function setup(user: AuthUser) {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({
      call: `${init.method ?? ''} ${url}`,
      authorization: new Headers(init.headers).get('authorization'),
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : init.body,
    });
    const body = url.endsWith('/api/vendor/finance/ledger')
      ? ledger
      : url.endsWith('/api/vendor/finance/payout')
        ? {
            payout: {
              ...payout,
              vendor: undefined,
              decided_by: undefined,
              primary_bank_account: undefined,
            },
            available_balance_npr: 200,
            replayed: false,
          }
        : /\/(approve|reject)$/.test(url)
          ? { payout }
          : { payouts: [payout], next_cursor: null };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  };
  const session = createSessionStore();
  session.getState().setSession({ phone: '+9779800000099', user, accessToken: 'access-1' });
  return { calls, api: createAdminApi(createApiClient({ baseUrl: '', fetch, session })) };
}

describe('createAdminApi (finance endpoints)', () => {
  it('lists, approves and rejects payouts under /api/admin/finance', async () => {
    const { calls, api } = setup({ id: ID.admin, role: 'SUPER_ADMIN', first_name: null });

    await expect(api.listPayouts({})).resolves.toEqual({ payouts: [payout], next_cursor: null });
    await api.listPayouts({ status: 'PENDING', cursor: ID.other });
    await api.approvePayout(ID.payout, 'NIC-ASIA-778812');
    await api.rejectPayout(ID.payout, 'Name mismatch');
    await api.rejectPayout(ID.payout, null);

    expect(calls.map(({ call, body }) => ({ call, body }))).toEqual([
      { call: 'GET /api/admin/finance/payouts', body: undefined },
      { call: `GET /api/admin/finance/payouts?status=PENDING&cursor=${ID.other}`, body: undefined },
      {
        call: `POST /api/admin/finance/payouts/${ID.payout}/approve`,
        body: { bank_reference: 'NIC-ASIA-778812' },
      },
      {
        call: `POST /api/admin/finance/payouts/${ID.payout}/reject`,
        body: { reason: 'Name mismatch' },
      },
      { call: `POST /api/admin/finance/payouts/${ID.payout}/reject`, body: { reason: null } },
    ]);
    expect(calls.every((call) => call.authorization === 'Bearer access-1')).toBe(true);
  });

  it("reads the vendor's ledger and requests a payout with its idempotency key", async () => {
    const { calls, api } = setup({ id: ID.vendor, role: 'VENDOR', first_name: 'Sita' });

    await expect(api.getOwnFinanceLedger()).resolves.toEqual(ledger);
    const result = await api.requestOwnPayout(400, 'key-0123456789');

    expect(result).toMatchObject({ available_balance_npr: 200, payout: { amount_npr: 400 } });
    expect(calls.map(({ call, body }) => ({ call, body }))).toEqual([
      { call: 'GET /api/vendor/finance/ledger', body: undefined },
      {
        call: 'POST /api/vendor/finance/payout',
        body: { idempotency_key: 'key-0123456789', amount_npr: 400 },
      },
    ]);
  });
});
