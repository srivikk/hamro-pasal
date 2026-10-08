import { randomUUID } from 'node:crypto';

import {
  auditLogs,
  ledgerAccounts,
  payoutRequests,
  vendorBankAccounts,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import {
  adminPayoutDecisionResponseSchema,
  adminPayoutListResponseSchema,
  settlementPayoutResponseSchema,
  vendorFinanceLedgerResponseSchema,
} from '@hamro-pasal/shared-types';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';

import { LedgerService } from '../src/ledger/ledger-service';
import { WalletService } from '../src/wallet/wallet-service';
import { balanceOf, createUser, createVendor, vendorUserIdOf } from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * Phase 30 on real Express + PostgreSQL: the two ends of a payout the scheduled run prepared
 * (APPROVED, PROCESSING_BANK_TRANSFER). POST …/finalize records the bank transfer (COMPLETED);
 * POST …/fail posts the amount back to the wallet (FAILED).
 */
describe('admin payout transfers API (finalize / fail)', () => {
  let t: TestApp;
  let db: Database;
  let adminId: string;
  let admin: string;
  const ledger = new LedgerService(new WalletService());

  beforeAll(async () => {
    t = buildTestApp();
    db = t.container.db;
    adminId = await createUser(db, 'SUPER_ADMIN');
    admin = bearer(adminId, 'SUPER_ADMIN');
  });

  afterAll(async () => {
    await t.container.close();
  });

  /**
   * A shop as SETTLEMENT_PAYOUT_RUN leaves it: `amountNpr` moved from its wallet to
   * PAYOUT_CLEARING, and an APPROVED payout row waiting for its bank transfer.
   */
  async function processingPayout(amountNpr = 2400, walletBeforeNpr = 3000, withBank = true) {
    const vendorId = await createVendor(db);
    const userId = await vendorUserIdOf(db, vendorId);
    await db
      .update(vendors)
      .set({ tax_id: '302118845', pan_verified_at: new Date(), pan_verified_by_user_id: adminId })
      .where(eq(vendors.id, vendorId));
    if (withBank) {
      await db.insert(vendorBankAccounts).values({
        vendor_id: vendorId,
        bank_name: 'NIC Asia Bank',
        branch_name: 'Thamel',
        account_name: 'Test Pasal',
        account_number: '0012345678909012',
        is_primary: true,
      });
    }
    const wallet = { type: 'VENDOR_WALLET', vendorId } as const;
    const payoutId = await db.transaction(async (tx) => {
      await ledger.post(tx, {
        kind: 'ADJUSTMENT',
        idempotencyKey: `seed:${randomUUID()}`,
        orderId: null,
        postings: [
          { account: wallet, amountPaisa: walletBeforeNpr * 100 },
          { account: { type: 'PLATFORM_REVENUE' }, amountPaisa: -walletBeforeNpr * 100 },
        ],
      });
      const journal = await ledger.post(tx, {
        kind: 'VENDOR_PAYOUT',
        idempotencyKey: `settlement-run:test:${randomUUID()}`,
        orderId: null,
        postings: [
          { account: wallet, amountPaisa: -amountNpr * 100 },
          { account: { type: 'PAYOUT_CLEARING' }, amountPaisa: amountNpr * 100 },
        ],
      });
      const [row] = await tx
        .insert(payoutRequests)
        .values({
          vendor_id: vendorId,
          amount_npr: amountNpr,
          status: 'APPROVED',
          idempotency_key: `settlement-run:${randomUUID()}`,
          hold_transaction_id: journal.transactionId,
          system_actor: 'SETTLEMENT_PAYOUT_RUN',
          transfer_state: 'PROCESSING_BANK_TRANSFER',
          decided_at: new Date(),
        })
        .returning({ id: payoutRequests.id });
      if (row === undefined) throw new Error('payout not created');
      return row.id;
    });
    return { vendorId, userId, payoutId, amountNpr, walletAfterNpr: walletBeforeNpr - amountNpr };
  }

  const post = (payoutId: string, action: 'finalize' | 'fail', body?: object, token = admin) =>
    request(t.app)
      .post(`/api/admin/finance/payouts/${payoutId}/${action}`)
      .set('authorization', token)
      .send(body);

  const rowOf = async (payoutId: string) =>
    (await db.select().from(payoutRequests).where(eq(payoutRequests.id, payoutId)))[0];

  const clearing = async () =>
    (
      await db
        .select({ balance: ledgerAccounts.balance_npr })
        .from(ledgerAccounts)
        .where(eq(ledgerAccounts.account_type, 'PAYOUT_CLEARING'))
    )[0]?.balance ?? 0;

  const audits = (payoutId: string) =>
    db.select().from(auditLogs).where(eq(auditLogs.entity_id, payoutId));

  describe('the views', () => {
    it('lists the payouts waiting for a transfer, with who made them and where the money goes', async () => {
      const p = await processingPayout();

      const res = await request(t.app)
        .get('/api/admin/finance/payouts?transfer_state=PROCESSING_BANK_TRANSFER&limit=100')
        .set('authorization', admin);

      expect(res.status).toBe(200);
      const { payouts } = bodyOf(adminPayoutListResponseSchema, res);
      expect(payouts.every((payout) => payout.transfer_state === 'PROCESSING_BANK_TRANSFER')).toBe(
        true,
      );
      expect(payouts.find((payout) => payout.id === p.payoutId)).toMatchObject({
        amount_npr: 2400,
        status: 'APPROVED',
        transfer_state: 'PROCESSING_BANK_TRANSFER',
        system_actor: 'SETTLEMENT_PAYOUT_RUN',
        bank_reference: null,
        decided_by: null,
        vendor: { id: p.vendorId, wallet_balance_npr: 600 },
        primary_bank_account: {
          bank_name: 'NIC Asia Bank',
          account_name: 'Test Pasal',
          account_number: '0012345678909012',
        },
      });

      // The other two states are filters too, and an unknown one is refused.
      for (const state of ['COMPLETED', 'FAILED']) {
        const other = await request(t.app)
          .get(`/api/admin/finance/payouts?transfer_state=${state}&limit=100`)
          .set('authorization', admin);
        expect(
          bodyOf(adminPayoutListResponseSchema, other).payouts.map((payout) => payout.id),
        ).not.toContain(p.payoutId);
      }
      const bad = await request(t.app)
        .get('/api/admin/finance/payouts?transfer_state=SENT')
        .set('authorization', admin);
      expect(bad.status).toBe(400);
    });

    it('tells the vendor its payout is automated and still being transferred', async () => {
      const p = await processingPayout();

      const res = await request(t.app)
        .get('/api/vendor/finance/ledger')
        .set('authorization', bearer(p.userId, 'VENDOR'));

      expect(bodyOf(vendorFinanceLedgerResponseSchema, res).payouts).toEqual([
        expect.objectContaining({
          id: p.payoutId,
          status: 'APPROVED',
          transfer_state: 'PROCESSING_BANK_TRANSFER',
          system_actor: 'SETTLEMENT_PAYOUT_RUN',
          bank_reference: null,
        }),
      ]);
    });

    it('marks a manual settlement payout as an admin’s, with no transfer state', async () => {
      const p = await processingPayout(100, 3000);

      const res = await request(t.app)
        .post(`/api/admin/finance/settlements/${p.vendorId}/payout`)
        .set('authorization', admin)
        .send({ amount_npr: 500, bank_reference: 'NIC-1', idempotency_key: randomUUID() });

      expect(res.status).toBe(201);
      expect(bodyOf(settlementPayoutResponseSchema, res).payout).toMatchObject({
        status: 'APPROVED',
        transfer_state: null,
        system_actor: null,
        bank_reference: 'NIC-1',
      });
    });
  });

  describe('finalize', () => {
    it('records the bank reference: COMPLETED, still APPROVED, no money moved, audited', async () => {
      const p = await processingPayout();
      const clearingBefore = await clearing();

      const res = await post(p.payoutId, 'finalize', { bank_reference: '  NIC-ASIA-778812  ' });

      expect(res.status).toBe(200);
      expect(bodyOf(adminPayoutDecisionResponseSchema, res).payout).toMatchObject({
        id: p.payoutId,
        status: 'APPROVED',
        transfer_state: 'COMPLETED',
        system_actor: 'SETTLEMENT_PAYOUT_RUN',
        bank_reference: 'NIC-ASIA-778812',
        decided_by: adminId,
        // The transfer is made: the account is no longer sent.
        primary_bank_account: null,
      });
      expect(await rowOf(p.payoutId)).toMatchObject({
        status: 'APPROVED',
        transfer_state: 'COMPLETED',
        bank_reference: 'NIC-ASIA-778812',
        decided_by_user_id: adminId,
        reversal_transaction_id: null,
      });
      expect(await balanceOf(db, { vendorId: p.vendorId })).toBe(p.walletAfterNpr);
      expect(await clearing()).toBe(clearingBefore);
      // Nor in the list: a bank account is sent only with a payout still to be transferred.
      const listed = await request(t.app)
        .get('/api/admin/finance/payouts?transfer_state=COMPLETED&limit=100')
        .set('authorization', admin);
      expect(
        bodyOf(adminPayoutListResponseSchema, listed).payouts.find(
          (payout) => payout.id === p.payoutId,
        ),
      ).toMatchObject({ transfer_state: 'COMPLETED', primary_bank_account: null });

      const [entry, ...rest] = await audits(p.payoutId);
      expect(rest).toHaveLength(0);
      expect(entry).toMatchObject({
        action: 'PAYOUT_TRANSFER_COMPLETED',
        entity_type: 'payout_request',
        actor_user_id: adminId,
        vendor_id: p.vendorId,
        request_id: res.headers['x-request-id'],
      });
      expect(entry?.before_state).toMatchObject({ transfer_state: 'PROCESSING_BANK_TRANSFER' });
      expect(entry?.after_state).toMatchObject({
        transfer_state: 'COMPLETED',
        bank_reference: 'NIC-ASIA-778812',
        system_actor: 'SETTLEMENT_PAYOUT_RUN',
      });
    });

    it('answers a repeat with the same payout, and refuses another reference or a later failure', async () => {
      const p = await processingPayout();
      expect((await post(p.payoutId, 'finalize', { bank_reference: 'REF-1' })).status).toBe(200);

      const again = await post(p.payoutId, 'finalize', { bank_reference: 'REF-1' });
      expect(again.status).toBe(200);
      expect(bodyOf(adminPayoutDecisionResponseSchema, again).payout.transfer_state).toBe(
        'COMPLETED',
      );

      const other = await post(p.payoutId, 'finalize', { bank_reference: 'REF-2' });
      expect(other.status).toBe(409);
      expect(errorOf(other)).toMatchObject({
        code: 'PAYOUT_NOT_PROCESSING',
        details: { status: 'APPROVED', transfer_state: 'COMPLETED' },
      });
      // A transferred payout cannot be failed: the money has left the platform.
      expect((await post(p.payoutId, 'fail', { reason: 'too late' })).status).toBe(409);
      expect(await balanceOf(db, { vendorId: p.vendorId })).toBe(p.walletAfterNpr);
      expect((await rowOf(p.payoutId))?.bank_reference).toBe('REF-1');
      expect(await audits(p.payoutId)).toHaveLength(1);
    });

    it('needs a bank reference', async () => {
      const p = await processingPayout();

      for (const body of [
        {},
        { bank_reference: '   ' },
        { bank_reference: 'x'.repeat(101) },
        {
          bank_reference: 'REF',
          amount_npr: 1,
        },
      ]) {
        const res = await post(p.payoutId, 'finalize', body);
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
      expect((await rowOf(p.payoutId))?.transfer_state).toBe('PROCESSING_BANK_TRANSFER');
    });
  });

  describe('fail', () => {
    it('posts the amount back (PAYOUT_CLEARING to the wallet): FAILED, REJECTED, audited', async () => {
      const p = await processingPayout();
      const clearingBefore = await clearing();

      const res = await post(p.payoutId, 'fail', { reason: 'Account closed at the bank' });

      expect(res.status).toBe(200);
      expect(bodyOf(adminPayoutDecisionResponseSchema, res).payout).toMatchObject({
        id: p.payoutId,
        status: 'REJECTED',
        transfer_state: 'FAILED',
        system_actor: 'SETTLEMENT_PAYOUT_RUN',
        bank_reference: null,
        rejection_reason: 'Account closed at the bank',
        decided_by: adminId,
        vendor: { wallet_balance_npr: 3000 },
      });
      expect(await balanceOf(db, { vendorId: p.vendorId })).toBe(3000);
      expect(clearingBefore - (await clearing())).toBe(2400);
      const row = await rowOf(p.payoutId);
      expect(row?.reversal_transaction_id).not.toBeNull();

      const [entry, ...rest] = await audits(p.payoutId);
      expect(rest).toHaveLength(0);
      expect(entry).toMatchObject({ action: 'PAYOUT_TRANSFER_FAILED', actor_user_id: adminId });
      expect(entry?.after_state).toMatchObject({
        status: 'REJECTED',
        transfer_state: 'FAILED',
        rejection_reason: 'Account closed at the bank',
        reversal_transaction_id: row?.reversal_transaction_id,
      });
    });

    it('takes no body, answers a repeat once, and cannot be finalized afterwards', async () => {
      const p = await processingPayout(1000, 1000);

      expect((await post(p.payoutId, 'fail')).status).toBe(200);
      const again = await post(p.payoutId, 'fail', { reason: 'second press' });
      expect(again.status).toBe(200);
      expect(bodyOf(adminPayoutDecisionResponseSchema, again).payout.rejection_reason).toBeNull();
      expect(await balanceOf(db, { vendorId: p.vendorId })).toBe(1000);

      const late = await post(p.payoutId, 'finalize', { bank_reference: 'REF-9' });
      expect(late.status).toBe(409);
      expect(errorOf(late)).toMatchObject({
        code: 'PAYOUT_NOT_PROCESSING',
        details: { status: 'REJECTED', transfer_state: 'FAILED' },
      });
      expect(await audits(p.payoutId)).toHaveLength(1);
    });

    it('five simultaneous failures return the money once', async () => {
      const p = await processingPayout();

      const answers = await Promise.all([1, 2, 3, 4, 5].map(() => post(p.payoutId, 'fail')));

      expect(answers.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
      expect(await balanceOf(db, { vendorId: p.vendorId })).toBe(3000);
      expect(await audits(p.payoutId)).toHaveLength(1);
    });
  });

  it('a finalize racing a fail has exactly one winner: the money is never both sent and returned', async () => {
    for (let round = 0; round < 6; round += 1) {
      const p = await processingPayout();

      const [finalized, failed] = await Promise.all([
        post(p.payoutId, 'finalize', { bank_reference: `RACE-${String(round)}` }),
        post(p.payoutId, 'fail'),
      ]);

      expect([finalized.status, failed.status].sort()).toEqual([200, 409]);
      const row = await rowOf(p.payoutId);
      const wallet = await balanceOf(db, { vendorId: p.vendorId });
      if (finalized.status === 200) {
        expect(row).toMatchObject({ transfer_state: 'COMPLETED', status: 'APPROVED' });
        expect(wallet).toBe(p.walletAfterNpr);
      } else {
        expect(row).toMatchObject({ transfer_state: 'FAILED', status: 'REJECTED' });
        expect(wallet).toBe(3000);
      }
      expect(await audits(p.payoutId)).toHaveLength(1);
    }
  });

  it('acts only on a payout waiting for its transfer: not a manual payout, not a pending request', async () => {
    const p = await processingPayout(100, 3000);
    const manual = await request(t.app)
      .post(`/api/admin/finance/settlements/${p.vendorId}/payout`)
      .set('authorization', admin)
      .send({ amount_npr: 500, bank_reference: 'NIC-1', idempotency_key: randomUUID() });
    const manualId = bodyOf(settlementPayoutResponseSchema, manual).payout.id;
    const requested = await request(t.app)
      .post('/api/vendor/finance/payout')
      .set('authorization', bearer(p.userId, 'VENDOR'))
      .send({ amount_npr: 300, idempotency_key: randomUUID() });
    const pendingId = (requested.body as { payout: { id: string } }).payout.id;

    for (const id of [manualId, pendingId]) {
      for (const [action, body] of [
        ['finalize', { bank_reference: 'REF' }],
        ['fail', {}],
      ] as const) {
        const res = await post(id, action, body);
        expect(res.status).toBe(409);
        expect(errorOf(res).code).toBe('PAYOUT_NOT_PROCESSING');
      }
    }
    expect(await balanceOf(db, { vendorId: p.vendorId })).toBe(3000 - 100 - 500 - 300);
    expect(
      await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.vendor_id, p.vendorId),
            eq(auditLogs.action, 'PAYOUT_TRANSFER_COMPLETED'),
          ),
        ),
    ).toHaveLength(0);
  });

  it('a failed payout of a shop in debt lifts its debt suspension', async () => {
    const p = await processingPayout(2400, 2400);
    // After the payout the shop fell 2500 into debt and was suspended for it.
    await db.transaction((tx) =>
      ledger.post(tx, {
        kind: 'ADJUSTMENT',
        idempotencyKey: `seed:${randomUUID()}`,
        orderId: null,
        postings: [
          { account: { type: 'VENDOR_WALLET', vendorId: p.vendorId }, amountPaisa: -220_000 },
          { account: { type: 'PLATFORM_REVENUE' }, amountPaisa: 220_000 },
        ],
      }),
    );
    const [before] = await db.select().from(vendors).where(eq(vendors.id, p.vendorId));
    expect(before).toMatchObject({ wallet_balance_npr: -2200, status: 'SUSPENDED' });

    expect((await post(p.payoutId, 'fail')).status).toBe(200);

    const [after] = await db.select().from(vendors).where(eq(vendors.id, p.vendorId));
    expect(after).toMatchObject({ wallet_balance_npr: 200, status: 'LIVE' });
  });

  it('answers 404 for an unknown payout, 400 for a bad id, and is closed to every other role', async () => {
    const p = await processingPayout();

    expect((await post(randomUUID(), 'finalize', { bank_reference: 'REF' })).status).toBe(404);
    expect(errorOf(await post(randomUUID(), 'fail')).code).toBe('PAYOUT_NOT_FOUND');
    expect((await post('not-a-uuid', 'fail')).status).toBe(400);

    for (const action of ['finalize', 'fail'] as const) {
      const anonymous = await request(t.app)
        .post(`/api/admin/finance/payouts/${p.payoutId}/${action}`)
        .send({ bank_reference: 'REF' });
      expect(anonymous.status).toBe(401);
      for (const role of ['VENDOR', 'CUSTOMER', 'DRIVER'] as const) {
        const token = bearer(role === 'VENDOR' ? p.userId : await createUser(db, role), role);
        expect((await post(p.payoutId, action, { bank_reference: 'REF' }, token)).status).toBe(403);
      }
    }
    expect((await rowOf(p.payoutId))?.transfer_state).toBe('PROCESSING_BANK_TRANSFER');
  });
});
