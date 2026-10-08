import type { AdminPayoutView } from '@hamro-pasal/shared-types';

import { ApiError } from '../api/client';
import { fakeAdminApi, refusalOf } from '../api/fake-admin-api';
import {
  processingTransfers,
  transferActorLabel,
  transferErrorMessage,
} from './settlements/settlement-rules';

const ID = {
  payout: '11111111-1111-4111-8111-111111111111',
  later: '22222222-2222-4222-8222-222222222222',
  vendor: '33333333-3333-4333-8333-333333333333',
  admin: '44444444-4444-4444-8444-444444444444',
  account: '55555555-5555-4555-8555-555555555555',
} as const;

const processing: AdminPayoutView = {
  id: ID.payout,
  amount_npr: 2400,
  status: 'APPROVED',
  bank_reference: null,
  rejection_reason: null,
  requested_at: '2026-10-06T20:15:01.000Z',
  decided_at: '2026-10-06T20:15:01.000Z',
  transfer_state: 'PROCESSING_BANK_TRANSFER',
  system_actor: 'SETTLEMENT_PAYOUT_RUN',
  vendor: {
    id: ID.vendor,
    business_name: 'Thamel Kirana Pasal',
    phone: '+9779800000011',
    wallet_balance_npr: 600,
  },
  primary_bank_account: {
    id: ID.account,
    bank_name: 'NIC Asia Bank',
    branch_name: 'Thamel',
    account_name: 'Thamel Kirana Pasal',
    account_number: '0012345678909012',
    routing_or_swift_code: null,
  },
  decided_by: null,
};
const completed: AdminPayoutView = {
  ...processing,
  transfer_state: 'COMPLETED',
  bank_reference: 'NIC-ASIA-778812',
  decided_by: ID.admin,
  primary_bank_account: null,
};
const failed: AdminPayoutView = {
  ...processing,
  status: 'REJECTED',
  transfer_state: 'FAILED',
  rejection_reason: 'Account closed',
  decided_by: ID.admin,
  primary_bank_account: null,
};

describe('the payout transfer endpoints', () => {
  it('lists only the payouts waiting for a bank transfer', async () => {
    const { calls, api } = fakeAdminApi(() => ({
      body: { payouts: [processing], next_cursor: null },
    }));

    await expect(api.listPayouts({ transferState: 'PROCESSING_BANK_TRANSFER' })).resolves.toEqual({
      payouts: [processing],
      next_cursor: null,
    });

    expect(calls).toEqual([
      {
        call: 'GET /api/admin/finance/payouts?transfer_state=PROCESSING_BANK_TRANSFER',
        body: undefined,
      },
    ]);
  });

  it('finalizes with the bank reference and fails with the reason, the payout only in the path', async () => {
    const { calls, api } = fakeAdminApi((call) => ({
      body: { payout: call.endsWith('/finalize') ? completed : failed },
    }));

    await expect(api.finalizePayout(ID.payout, 'NIC-ASIA-778812')).resolves.toEqual({
      payout: completed,
    });
    await expect(api.failPayout(ID.payout, 'Account closed')).resolves.toEqual({ payout: failed });
    await api.failPayout(ID.payout, null);

    expect(calls).toEqual([
      {
        call: `POST /api/admin/finance/payouts/${ID.payout}/finalize`,
        body: { bank_reference: 'NIC-ASIA-778812' },
      },
      {
        call: `POST /api/admin/finance/payouts/${ID.payout}/fail`,
        body: { reason: 'Account closed' },
      },
      { call: `POST /api/admin/finance/payouts/${ID.payout}/fail`, body: { reason: null } },
    ]);
  });

  it('reads a payout from an API older than the transfer state as a plain one', async () => {
    const older: Record<string, unknown> = { ...processing };
    for (const key of ['transfer_state', 'system_actor', 'primary_bank_account']) {
      Reflect.deleteProperty(older, key);
    }
    const { api } = fakeAdminApi(() => ({ body: { payouts: [older], next_cursor: null } }));

    const { payouts } = await api.listPayouts({});

    expect(payouts[0]).toMatchObject({
      transfer_state: null,
      system_actor: null,
      primary_bank_account: null,
    });
  });

  it('refuses an answer the contract does not describe, and passes a refusal on with its code', async () => {
    const odd = fakeAdminApi(() => ({
      body: { payout: { ...completed, transfer_state: 'SENT' } },
    }));
    await expect(odd.api.finalizePayout(ID.payout, 'REF')).rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
    });

    const refused = fakeAdminApi(() =>
      refusalOf(409, 'PAYOUT_NOT_PROCESSING', { status: 'APPROVED', transfer_state: 'COMPLETED' }),
    );
    await expect(refused.api.failPayout(ID.payout, null)).rejects.toMatchObject({
      status: 409,
      code: 'PAYOUT_NOT_PROCESSING',
    });
  });
});

describe('the rows of "Bank transfers to make"', () => {
  it('keeps only waiting payouts, the longest-waiting first', () => {
    const later = { ...processing, id: ID.later, decided_at: '2026-10-13T20:15:01.000Z' };

    expect(processingTransfers([later, completed, processing, failed]).map((p) => p.id)).toEqual([
      ID.payout,
      ID.later,
    ]);
    expect(processingTransfers([completed, failed])).toEqual([]);
  });

  it('says who made the payout', () => {
    expect(transferActorLabel(processing)).toBe('Automated: weekly payout run');
    expect(transferActorLabel({ system_actor: 'OTHER_JOB' })).toBe('Automated: OTHER_JOB');
    expect(transferActorLabel({ system_actor: null })).toBe('Recorded by an admin');
  });

  it('words each refusal', () => {
    const refusal = (code: string) => new ApiError(409, code, code);
    expect(transferErrorMessage(refusal('PAYOUT_NOT_PROCESSING'))).toContain(
      'already finalised or failed',
    );
    expect(transferErrorMessage(refusal('PAYOUT_NOT_FOUND'))).toContain('no longer exists');
    expect(transferErrorMessage(refusal('VALIDATION_FAILED'))).toContain('bank reference');
    expect(transferErrorMessage(refusal('NETWORK_ERROR'))).toContain('cannot be reached');
    expect(transferErrorMessage(new Error('boom'))).toBe(
      'The transfer could not be saved. Try again.',
    );
  });
});
