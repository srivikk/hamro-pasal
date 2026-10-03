import { randomUUID } from 'node:crypto';

import { ledgerAccountTypes, ledgerTransactionKinds, payoutStatuses } from '../domain/enums';
import { midnightTaskSchema } from '../jobs/queues';
import {
  adminPayoutApproveRequestSchema,
  adminPayoutListQuerySchema,
  adminPayoutRejectRequestSchema,
  adminPayoutViewSchema,
  payoutRequestSchema,
  payoutViewSchema,
  vendorFinanceLedgerResponseSchema,
} from './finance';
import { walletEntryTypeSchema } from './responses';

const payout = {
  id: randomUUID(),
  amount_npr: 400,
  status: 'PENDING',
  bank_reference: null,
  rejection_reason: null,
  requested_at: '2026-10-03T06:00:00.000Z',
  decided_at: null,
};

describe('payoutRequestSchema', () => {
  const key = 'payout-key-1';
  const ok = (body: unknown) => payoutRequestSchema.safeParse(body).success;

  it('takes a key and a positive amount in whole paisa, up to 10 lakh', () => {
    expect(payoutRequestSchema.parse({ idempotency_key: `  ${key} `, amount_npr: 1500.5 })).toEqual(
      {
        idempotency_key: key,
        amount_npr: 1500.5,
      },
    );
    expect(ok({ idempotency_key: key, amount_npr: 0.01 })).toBe(true);
    expect(ok({ idempotency_key: key, amount_npr: 1_000_000 })).toBe(true);
  });

  it('refuses zero, negatives, fractions of a paisa, too much, a short key and extra keys', () => {
    expect(ok({ idempotency_key: key, amount_npr: 0 })).toBe(false);
    expect(ok({ idempotency_key: key, amount_npr: -1 })).toBe(false);
    expect(ok({ idempotency_key: key, amount_npr: 10.005 })).toBe(false);
    expect(ok({ idempotency_key: key, amount_npr: 1_000_000.01 })).toBe(false);
    expect(ok({ idempotency_key: 'short', amount_npr: 10 })).toBe(false);
    expect(ok({ amount_npr: 10 })).toBe(false);
    // The shop comes from the token; a request can never name one or decide itself.
    expect(ok({ idempotency_key: key, amount_npr: 10, vendor_id: randomUUID() })).toBe(false);
    expect(ok({ idempotency_key: key, amount_npr: 10, status: 'APPROVED' })).toBe(false);
  });
});

describe('admin payout requests', () => {
  it('requires a non-blank bank reference of at most 100 characters', () => {
    expect(adminPayoutApproveRequestSchema.parse({ bank_reference: ' NIC-1 ' })).toEqual({
      bank_reference: 'NIC-1',
    });
    expect(adminPayoutApproveRequestSchema.safeParse({ bank_reference: '  ' }).success).toBe(false);
    expect(adminPayoutApproveRequestSchema.safeParse({}).success).toBe(false);
    expect(
      adminPayoutApproveRequestSchema.safeParse({ bank_reference: 'x'.repeat(101) }).success,
    ).toBe(false);
  });

  it('treats a missing or blank rejection reason as none', () => {
    expect(adminPayoutRejectRequestSchema.parse({})).toEqual({ reason: null });
    expect(adminPayoutRejectRequestSchema.parse({ reason: '   ' })).toEqual({ reason: null });
    expect(adminPayoutRejectRequestSchema.parse({ reason: null })).toEqual({ reason: null });
    expect(adminPayoutRejectRequestSchema.parse({ reason: ' Wrong name ' })).toEqual({
      reason: 'Wrong name',
    });
    expect(adminPayoutRejectRequestSchema.safeParse({ reason: 'x'.repeat(501) }).success).toBe(
      false,
    );
    expect(adminPayoutRejectRequestSchema.safeParse({ why: 'x' }).success).toBe(false);
  });

  it('parses the list query: a status, a page size of 1 to 100 and a cursor', () => {
    const cursor = randomUUID();
    expect(adminPayoutListQuerySchema.parse({ status: 'APPROVED', limit: '25', cursor })).toEqual({
      status: 'APPROVED',
      limit: 25,
      cursor,
    });
    expect(adminPayoutListQuerySchema.parse({})).toEqual({});
    const ok = (query: unknown) => adminPayoutListQuerySchema.safeParse(query).success;
    expect(ok({ limit: '0' })).toBe(false);
    expect(ok({ limit: '101' })).toBe(false);
    expect(ok({ status: 'PAID' })).toBe(false);
    expect(ok({ cursor: 'x' })).toBe(false);
    expect(ok({ offset: '5' })).toBe(false);
  });
});

describe('finance views', () => {
  it('keeps the vendor view of a payout free of who decided it', () => {
    expect(payoutViewSchema.safeParse(payout).success).toBe(true);
    expect(payoutViewSchema.safeParse({ ...payout, decided_by: randomUUID() }).success).toBe(false);
    expect(payoutViewSchema.safeParse({ ...payout, amount_npr: 0 }).success).toBe(false);
    expect(payoutViewSchema.safeParse({ ...payout, status: 'PAID' }).success).toBe(false);
  });

  it('gives the admin the vendor and the deciding admin', () => {
    const admin = {
      ...payout,
      vendor: {
        id: randomUUID(),
        business_name: 'Thamel Kirana Pasal',
        phone: '+9779800000011',
        wallet_balance_npr: -50,
      },
      decided_by: null,
    };
    expect(adminPayoutViewSchema.safeParse(admin).success).toBe(true);
    expect(adminPayoutViewSchema.safeParse(payout).success).toBe(false);
  });

  it('allows a negative available balance but no negative pending amounts', () => {
    const ledger = {
      vendor_id: randomUUID(),
      available_balance_npr: -100,
      pending_balance_npr: 0,
      pending_payout_npr: 0,
      unreconciled_order_count: 0,
      reconciled_orders: [],
      payouts: [payout],
    };
    expect(vendorFinanceLedgerResponseSchema.safeParse(ledger).success).toBe(true);
    expect(
      vendorFinanceLedgerResponseSchema.safeParse({ ...ledger, pending_balance_npr: -1 }).success,
    ).toBe(false);
    expect(
      vendorFinanceLedgerResponseSchema.safeParse({ ...ledger, pending_payout_npr: -1 }).success,
    ).toBe(false);
    // SPEC §5: no stored balance table leaks through; the response has no extra keys.
    expect(
      vendorFinanceLedgerResponseSchema.safeParse({ ...ledger, ledger_id: randomUUID() }).success,
    ).toBe(false);
  });
});

describe('Phase 22 enums', () => {
  it('adds the payout account, journal kinds, statuses, entry types and the midnight task', () => {
    expect(ledgerAccountTypes).toContain('PAYOUT_CLEARING');
    expect(ledgerTransactionKinds).toEqual(
      expect.arrayContaining(['VENDOR_PAYOUT', 'VENDOR_PAYOUT_REVERSAL']),
    );
    expect(payoutStatuses).toEqual(['PENDING', 'APPROVED', 'REJECTED']);
    expect(walletEntryTypeSchema.safeParse('PAYOUT_HOLD').success).toBe(true);
    expect(walletEntryTypeSchema.safeParse('PAYOUT_REVERSAL').success).toBe(true);
    expect(midnightTaskSchema.safeParse('ORDER_RECONCILIATION').success).toBe(true);
  });
});
