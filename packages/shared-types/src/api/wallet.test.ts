import { randomUUID } from 'node:crypto';

import { vendorWalletLedgerQuerySchema, walletTopUpRequestSchema } from './requests';
import { vendorWalletBalanceResponseSchema, vendorWalletLedgerResponseSchema } from './responses';

describe('vendorWalletLedgerQuerySchema', () => {
  it('parses the page size from the query string and accepts an entry id as cursor', () => {
    const cursor = randomUUID();
    expect(vendorWalletLedgerQuerySchema.parse({ limit: '25', cursor })).toEqual({
      limit: 25,
      cursor,
    });
    expect(vendorWalletLedgerQuerySchema.parse({})).toEqual({});
  });

  it('refuses page sizes outside 1–50, non-numbers, bad cursors and unknown keys', () => {
    const ok = (query: Record<string, unknown>) =>
      vendorWalletLedgerQuerySchema.safeParse(query).success;
    expect(ok({ limit: '0' })).toBe(false);
    expect(ok({ limit: '51' })).toBe(false);
    expect(ok({ limit: '2.5' })).toBe(false);
    expect(ok({ limit: 'ten' })).toBe(false);
    expect(ok({ cursor: 'not-a-uuid' })).toBe(false);
    expect(ok({ offset: '20' })).toBe(false);
    expect(ok({ limit: '50' })).toBe(true);
  });
});

describe('vendor wallet responses', () => {
  const balance = {
    vendor_id: randomUUID(),
    status: 'SUSPENDED',
    is_suspended: true,
    suspended_for_debt: true,
    wallet_balance_npr: -2500,
    suspension_limit_npr: -2000,
    pending_escrow_npr: 0,
    pending_escrow_order_count: 0,
  };

  it('accepts a suspended balance and refuses a positive limit or negative escrow', () => {
    expect(vendorWalletBalanceResponseSchema.safeParse(balance).success).toBe(true);
    expect(
      vendorWalletBalanceResponseSchema.safeParse({ ...balance, suspension_limit_npr: 10 }).success,
    ).toBe(false);
    expect(
      vendorWalletBalanceResponseSchema.safeParse({ ...balance, pending_escrow_npr: -1 }).success,
    ).toBe(false);
  });

  it('accepts a ledger page and refuses a zero posting', () => {
    const entry = {
      id: randomUUID(),
      transaction_id: randomUUID(),
      kind: 'ORDER_SETTLEMENT',
      entry_type: 'COD_COMMISSION_DEBIT',
      amount_npr: -100,
      balance_after_npr: -100,
      description: 'COD / SELF_DELIVERY settlement',
      created_at: '2026-09-30T10:00:00.000Z',
      order: {
        id: randomUUID(),
        payment_method: 'COD',
        fulfillment: 'SELF_DELIVERY',
        subtotal_npr: 1000,
        delivery_fee_npr: 50,
        commission_npr: 100,
      },
    };
    expect(
      vendorWalletLedgerResponseSchema.safeParse({ entries: [entry], next_cursor: null }).success,
    ).toBe(true);
    expect(
      vendorWalletLedgerResponseSchema.safeParse({
        entries: [{ ...entry, amount_npr: 0 }],
        next_cursor: null,
      }).success,
    ).toBe(false);
  });
});

describe('walletTopUpRequestSchema', () => {
  const ok = (body: Record<string, unknown>) =>
    walletTopUpRequestSchema.safeParse({ idempotency_key: randomUUID(), ...body }).success;

  it('accepts a positive amount in whole paisa up to the cap', () => {
    expect(ok({ amount_npr: 2500 })).toBe(true);
    expect(ok({ amount_npr: 12.5 })).toBe(true);
    expect(ok({ amount_npr: 100_000 })).toBe(true);
  });

  it('refuses zero, negative, sub-paisa, oversized and string amounts, and a missing key', () => {
    expect(ok({ amount_npr: 0 })).toBe(false);
    expect(ok({ amount_npr: -100 })).toBe(false);
    expect(ok({ amount_npr: 10.005 })).toBe(false);
    expect(ok({ amount_npr: 100_000.01 })).toBe(false);
    expect(ok({ amount_npr: '2500' })).toBe(false);
    expect(walletTopUpRequestSchema.safeParse({ amount_npr: 100 }).success).toBe(false);
  });
});
