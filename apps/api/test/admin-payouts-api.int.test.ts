import { randomUUID } from 'node:crypto';

import {
  auditLogs,
  ledgerAccounts,
  ledgerTransactions,
  payoutRequests,
  vendors,
} from '@hamro-pasal/db';
import {
  adminPayoutDecisionResponseSchema,
  adminPayoutListResponseSchema,
  payoutRequestResponseSchema,
  vendorFinanceLedgerResponseSchema,
  vendorWalletLedgerResponseSchema,
} from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import { createUser, createVendor, vendorUserIdOf } from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * Phase 22: the Super Admin's side of the payout state machine at /api/admin/finance/payouts
 * (PENDING → APPROVED | REJECTED), through real Express, PostgreSQL and the double-entry ledger.
 */
describe('admin payouts API', () => {
  let t: TestApp;
  let adminId: string;
  let warn: jest.SpyInstance;

  beforeAll(async () => {
    t = buildTestApp();
    adminId = await createUser(t.container.db, 'SUPER_ADMIN');
  });

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  afterAll(async () => {
    await t.container.close();
  });

  const db = () => t.container.db;
  type Role = 'VENDOR' | 'CUSTOMER' | 'DRIVER' | 'SUPER_ADMIN';

  /** A vendor with `balanceNpr` in the wallet and one PENDING payout of `amountNpr`. */
  async function pendingPayout(amountNpr = 400, balanceNpr = 1000, panVerified = true) {
    const vendorId = await createVendor(db());
    const userId = await vendorUserIdOf(db(), vendorId);
    if (panVerified) {
      // Approving records a bank transfer, which the PAN payout gate holds until verification.
      await db()
        .update(vendors)
        .set({ tax_id: '302118845', pan_verified_at: new Date(), pan_verified_by_user_id: adminId })
        .where(eq(vendors.id, vendorId));
    }
    const topUp = await request(t.app)
      .post('/api/vendors/wallet/top-up')
      .set('authorization', bearer(userId, 'VENDOR'))
      .send({ idempotency_key: randomUUID(), amount_npr: balanceNpr });
    expect(topUp.status).toBe(201);
    const res = await request(t.app)
      .post('/api/vendor/finance/payout')
      .set('authorization', bearer(userId, 'VENDOR'))
      .send({ idempotency_key: randomUUID(), amount_npr: amountNpr });
    expect(res.status).toBe(201);
    return { vendorId, userId, payoutId: bodyOf(payoutRequestResponseSchema, res).payout.id };
  }

  describe('the PAN payout gate', () => {
    it('holds an approval while the PAN is unverified, and lets a rejection through', async () => {
      const { vendorId, payoutId } = await pendingPayout(400, 1000, false);
      await db().update(vendors).set({ tax_id: '302118845' }).where(eq(vendors.id, vendorId));

      const held = await approve(payoutId);

      expect(held.status).toBe(422);
      expect(errorOf(held)).toMatchObject({
        code: 'PAN_NOT_VERIFIED',
        details: { vendor_id: vendorId },
      });
      // Still PENDING, nothing recorded: the request waits for the verification.
      expect(await rowOf(payoutId)).toMatchObject({ status: 'PENDING', bank_reference: null });
      const audited = await db().select().from(auditLogs).where(eq(auditLogs.entity_id, payoutId));
      expect(audited).toEqual([]);

      const verified = await request(t.app)
        .post(`/api/admin/vendors/${vendorId}/pan-verification`)
        .set('authorization', bearer(adminId, 'SUPER_ADMIN'));
      expect(verified.status).toBe(200);
      expect((await approve(payoutId)).status).toBe(200);
    });

    it('does not gate a rejection: the held amount goes back to the wallet', async () => {
      const { vendorId, payoutId } = await pendingPayout(400, 1000, false);

      expect((await reject(payoutId)).status).toBe(200);
      expect(await walletOf(vendorId)).toBe(1000);
    });
  });

  const list = (query: Record<string, string> = {}, role: Role = 'SUPER_ADMIN') =>
    request(t.app)
      .get('/api/admin/finance/payouts')
      .query(query)
      .set('authorization', bearer(adminId, role));

  const approve = (
    payoutId: string,
    body: unknown = { bank_reference: 'NIC-ASIA-778812' },
    by = adminId,
  ) =>
    request(t.app)
      .post(`/api/admin/finance/payouts/${payoutId}/approve`)
      .set('authorization', bearer(by, 'SUPER_ADMIN'))
      .send(body as object);

  const reject = (payoutId: string, body?: unknown, by = adminId) => {
    const req = request(t.app)
      .post(`/api/admin/finance/payouts/${payoutId}/reject`)
      .set('authorization', bearer(by, 'SUPER_ADMIN'));
    return body === undefined ? req : req.send(body as object);
  };

  async function walletOf(vendorId: string): Promise<number> {
    const [row] = await db()
      .select({ balance: vendors.wallet_balance_npr })
      .from(vendors)
      .where(eq(vendors.id, vendorId));
    if (row === undefined) throw new Error('vendor not found');
    return row.balance;
  }

  async function clearingBalance(): Promise<number> {
    const [account] = await db()
      .select({ balance: ledgerAccounts.balance_npr })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.account_type, 'PAYOUT_CLEARING'));
    return account?.balance ?? 0;
  }

  async function rowOf(payoutId: string) {
    const [row] = await db().select().from(payoutRequests).where(eq(payoutRequests.id, payoutId));
    if (row === undefined) throw new Error('payout not found');
    return row;
  }

  /** Phase 25: a decision's audit_logs entries (it was a console line before). */
  const auditEntries = (payoutId: string) =>
    db().select().from(auditLogs).where(eq(auditLogs.entity_id, payoutId));

  describe('GET /api/admin/finance/payouts', () => {
    it('lists requests newest first with their vendor, filtered by status and paged', async () => {
      const first = await pendingPayout(100);
      const second = await pendingPayout(200);
      const third = await pendingPayout(300);
      expect((await approve(second.payoutId)).status).toBe(200);

      const res = await list({ limit: '100' });
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const mine = bodyOf(adminPayoutListResponseSchema, res).payouts.filter((p) =>
        [first.payoutId, second.payoutId, third.payoutId].includes(p.id),
      );
      expect(mine.map((p) => [p.id, p.status, p.amount_npr])).toEqual([
        [third.payoutId, 'PENDING', 300],
        [second.payoutId, 'APPROVED', 200],
        [first.payoutId, 'PENDING', 100],
      ]);
      expect(mine[0]?.vendor).toEqual({
        id: third.vendorId,
        business_name: expect.any(String) as string,
        phone: expect.stringMatching(/^\+9779\d{9}$/) as string,
        wallet_balance_npr: 700,
      });

      const pending = bodyOf(
        adminPayoutListResponseSchema,
        await list({ status: 'PENDING', limit: '100' }),
      );
      expect(pending.payouts.every((p) => p.status === 'PENDING')).toBe(true);
      expect(pending.payouts.some((p) => p.id === second.payoutId)).toBe(false);

      // Two pages of one: the newest two requests of the whole table, without gaps or repeats.
      const pageOne = bodyOf(adminPayoutListResponseSchema, await list({ limit: '1' }));
      expect(pageOne.payouts.map((p) => p.id)).toEqual([third.payoutId]);
      expect(pageOne.next_cursor).toBe(third.payoutId);
      const pageTwo = bodyOf(
        adminPayoutListResponseSchema,
        await list({ limit: '1', cursor: third.payoutId }),
      );
      expect(pageTwo.payouts.map((p) => p.id)).toEqual([second.payoutId]);
    });

    it('refuses bad queries and other roles', async () => {
      for (const query of [
        { limit: '0' },
        { limit: '101' },
        { status: 'PAID' },
        { cursor: 'nope' },
        { offset: '5' },
      ]) {
        const res = await list(query);
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
      const unknown = await list({ cursor: randomUUID() });
      expect(unknown.status).toBe(400);
      expect(errorOf(unknown).code).toBe('INVALID_CURSOR');

      expect((await request(t.app).get('/api/admin/finance/payouts')).status).toBe(401);
      for (const role of ['VENDOR', 'CUSTOMER', 'DRIVER'] as const) {
        expect((await list({}, role)).status).toBe(403);
      }
    });
  });

  describe('POST /api/admin/finance/payouts/:id/approve', () => {
    it('marks the request APPROVED with the bank reference and moves no more money', async () => {
      const { vendorId, userId, payoutId } = await pendingPayout(400);
      const clearingBefore = await clearingBalance();

      const res = await approve(payoutId, { bank_reference: '  NIC-ASIA-778812  ' });

      expect(res.status).toBe(200);
      const { payout } = bodyOf(adminPayoutDecisionResponseSchema, res);
      expect(payout).toMatchObject({
        id: payoutId,
        status: 'APPROVED',
        amount_npr: 400,
        bank_reference: 'NIC-ASIA-778812',
        rejection_reason: null,
        decided_by: adminId,
        vendor: { id: vendorId, wallet_balance_npr: 600 },
      });
      expect(payout.decided_at).not.toBeNull();
      // The amount left the wallet at the request; approval deducts nothing a second time.
      expect(await walletOf(vendorId)).toBe(600);
      expect(await clearingBalance()).toBe(clearingBefore);
      expect((await rowOf(payoutId)).reversal_transaction_id).toBeNull();

      const entries = await auditEntries(payoutId);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        action: 'PAYOUT_APPROVED',
        entity_type: 'payout_request',
        actor_user_id: adminId,
        actor_role: 'SUPER_ADMIN',
        vendor_id: vendorId,
        before_state: { status: 'PENDING', amount_npr: 400 },
        after_state: { status: 'APPROVED', amount_npr: 400, bank_reference: 'NIC-ASIA-778812' },
      });
      // No console line any more.
      expect(warn.mock.calls.filter(([line]) => String(line).includes(payoutId))).toEqual([]);

      const ledger = bodyOf(
        vendorFinanceLedgerResponseSchema,
        await request(t.app)
          .get('/api/vendor/finance/ledger')
          .set('authorization', bearer(userId, 'VENDOR')),
      );
      expect(ledger).toMatchObject({ available_balance_npr: 600, pending_payout_npr: 0 });
      expect(ledger.payouts[0]).toMatchObject({
        status: 'APPROVED',
        bank_reference: 'NIC-ASIA-778812',
      });
    });

    it('answers the same for a repeat and refuses another bank reference', async () => {
      const { vendorId, payoutId } = await pendingPayout(400);
      const first = await approve(payoutId);

      const repeat = await approve(payoutId, undefined, await createUser(db(), 'SUPER_ADMIN'));
      expect(repeat.status).toBe(200);
      expect(bodyOf(adminPayoutDecisionResponseSchema, repeat)).toEqual(
        bodyOf(adminPayoutDecisionResponseSchema, first),
      );
      expect(await auditEntries(payoutId)).toHaveLength(1);

      const other = await approve(payoutId, { bank_reference: 'OTHER-1' });
      expect(other.status).toBe(409);
      expect(errorOf(other)).toMatchObject({
        code: 'PAYOUT_ALREADY_DECIDED',
        details: { status: 'APPROVED' },
      });
      expect((await rowOf(payoutId)).bank_reference).toBe('NIC-ASIA-778812');
      expect(await walletOf(vendorId)).toBe(600);
    });

    it('approves once when 5 admins press at the same moment', async () => {
      const { vendorId, payoutId } = await pendingPayout(400);

      const responses = await Promise.all(Array.from({ length: 5 }, () => approve(payoutId)));

      expect(responses.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
      expect(await auditEntries(payoutId)).toHaveLength(1);
      expect(await walletOf(vendorId)).toBe(600);
    });

    it('needs a bank reference, a real id and a Super Admin', async () => {
      const { payoutId } = await pendingPayout();
      for (const body of [
        {},
        { bank_reference: '   ' },
        { bank_reference: 'x'.repeat(101) },
        { bank_reference: 'OK', amount_npr: 1 },
      ]) {
        const res = await approve(payoutId, body);
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
      expect((await rowOf(payoutId)).status).toBe('PENDING');

      const unknown = await approve(randomUUID());
      expect(unknown.status).toBe(404);
      expect(errorOf(unknown).code).toBe('PAYOUT_NOT_FOUND');
      expect((await approve('not-a-uuid')).status).toBe(400);

      for (const role of ['VENDOR', 'CUSTOMER', 'DRIVER'] as const) {
        const res = await request(t.app)
          .post(`/api/admin/finance/payouts/${payoutId}/approve`)
          .set('authorization', bearer(adminId, role))
          .send({ bank_reference: 'NIC-1' });
        expect(res.status).toBe(403);
      }
      expect((await rowOf(payoutId)).status).toBe('PENDING');
    });
  });

  describe('POST /api/admin/finance/payouts/:id/reject', () => {
    it('posts the held amount back to the wallet and records the reason', async () => {
      const { vendorId, userId, payoutId } = await pendingPayout(400);
      const clearingBefore = await clearingBalance();

      const res = await reject(payoutId, { reason: '  Bank account name does not match  ' });

      expect(res.status).toBe(200);
      expect(bodyOf(adminPayoutDecisionResponseSchema, res).payout).toMatchObject({
        status: 'REJECTED',
        bank_reference: null,
        rejection_reason: 'Bank account name does not match',
        decided_by: adminId,
        vendor: { wallet_balance_npr: 1000 },
      });
      expect(await walletOf(vendorId)).toBe(1000);
      expect((await clearingBalance()) - clearingBefore).toBe(-400);

      const row = await rowOf(payoutId);
      const [reversal] = await db()
        .select()
        .from(ledgerTransactions)
        .where(eq(ledgerTransactions.id, row.reversal_transaction_id ?? ''));
      expect(reversal).toMatchObject({
        kind: 'VENDOR_PAYOUT_REVERSAL',
        idempotency_key: `vendor-payout-reversal:${payoutId}`,
      });
      const entries = await auditEntries(payoutId);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        action: 'PAYOUT_REJECTED',
        actor_user_id: adminId,
        before_state: { status: 'PENDING', amount_npr: 400 },
        after_state: {
          status: 'REJECTED',
          amount_npr: 400,
          reversal_transaction_id: row.reversal_transaction_id,
        },
      });

      const wallet = bodyOf(
        vendorWalletLedgerResponseSchema,
        await request(t.app)
          .get('/api/vendors/wallet/ledger')
          .set('authorization', bearer(userId, 'VENDOR')),
      );
      expect(wallet.entries.slice(0, 2).map((e) => [e.entry_type, e.amount_npr])).toEqual([
        ['PAYOUT_REVERSAL', 400],
        ['PAYOUT_HOLD', -400],
      ]);
    });

    it('works without a body, and a repeat returns the money only once', async () => {
      const { vendorId, payoutId } = await pendingPayout(400);

      const first = await reject(payoutId);
      const repeat = await reject(payoutId, { reason: 'another reason' });

      expect(first.status).toBe(200);
      expect(repeat.status).toBe(200);
      expect(bodyOf(adminPayoutDecisionResponseSchema, repeat).payout.rejection_reason).toBeNull();
      expect(await walletOf(vendorId)).toBe(1000);
      expect(await auditEntries(payoutId)).toHaveLength(1);
    });

    it('lets the vendor request the returned money again', async () => {
      const { userId, payoutId } = await pendingPayout(1000);
      const again = () =>
        request(t.app)
          .post('/api/vendor/finance/payout')
          .set('authorization', bearer(userId, 'VENDOR'))
          .send({ idempotency_key: randomUUID(), amount_npr: 1000 });
      expect((await again()).status).toBe(422);

      expect((await reject(payoutId)).status).toBe(200);

      expect((await again()).status).toBe(201);
    });

    it('validates the reason and the id', async () => {
      const { payoutId } = await pendingPayout();
      for (const body of [{ reason: 'x'.repeat(501) }, { reason: 5 }, { why: 'no' }]) {
        expect((await reject(payoutId, body)).status).toBe(400);
      }
      expect((await rowOf(payoutId)).status).toBe('PENDING');
      expect(errorOf(await reject(randomUUID())).code).toBe('PAYOUT_NOT_FOUND');
      const forbidden = await request(t.app)
        .post(`/api/admin/finance/payouts/${payoutId}/reject`)
        .set('authorization', bearer(adminId, 'VENDOR'));
      expect(forbidden.status).toBe(403);
    });
  });

  describe('the state machine', () => {
    it('is final: an approved request cannot be rejected, a rejected one cannot be approved', async () => {
      const approved = await pendingPayout(400);
      await approve(approved.payoutId);
      const lateReject = await reject(approved.payoutId);
      expect(lateReject.status).toBe(409);
      expect(errorOf(lateReject)).toMatchObject({
        code: 'PAYOUT_ALREADY_DECIDED',
        details: { status: 'APPROVED' },
      });
      expect(await walletOf(approved.vendorId)).toBe(600);

      const rejected = await pendingPayout(400);
      await reject(rejected.payoutId);
      const lateApprove = await approve(rejected.payoutId);
      expect(lateApprove.status).toBe(409);
      expect(errorOf(lateApprove).details).toEqual({ status: 'REJECTED' });
      expect((await rowOf(rejected.payoutId)).bank_reference).toBeNull();
      expect(await walletOf(rejected.vendorId)).toBe(1000);
    });

    it('gives a simultaneous approve and reject exactly one winner (8 rounds)', async () => {
      for (let round = 0; round < 8; round += 1) {
        const { vendorId, payoutId } = await pendingPayout(400);

        const [approval, rejection] = await Promise.all([approve(payoutId), reject(payoutId)]);

        expect([approval.status, rejection.status].sort()).toEqual([200, 409]);
        const row = await rowOf(payoutId);
        // Paid out or returned, never both and never neither.
        if (approval.status === 200) {
          expect(row).toMatchObject({ status: 'APPROVED', reversal_transaction_id: null });
          expect(await walletOf(vendorId)).toBe(600);
        } else {
          expect(row).toMatchObject({ status: 'REJECTED', bank_reference: null });
          expect(await walletOf(vendorId)).toBe(1000);
        }
      }
    });

    it('is enforced by the table: a decision needs its evidence', async () => {
      const { payoutId } = await pendingPayout();
      const constraint = { cause: { constraint: 'payout_requests_status_check' } };

      await expect(
        db()
          .update(payoutRequests)
          .set({ status: 'APPROVED' })
          .where(eq(payoutRequests.id, payoutId)),
      ).rejects.toMatchObject(constraint);
      await expect(
        db()
          .update(payoutRequests)
          .set({
            status: 'APPROVED',
            decided_at: new Date(),
            decided_by_user_id: adminId,
            bank_reference: ' ',
          })
          .where(eq(payoutRequests.id, payoutId)),
      ).rejects.toMatchObject(constraint);
      await expect(
        db()
          .update(payoutRequests)
          .set({ status: 'REJECTED', decided_at: new Date(), decided_by_user_id: adminId })
          .where(eq(payoutRequests.id, payoutId)),
      ).rejects.toMatchObject(constraint);
      await expect(
        db()
          .update(payoutRequests)
          .set({ bank_reference: 'EARLY' })
          .where(eq(payoutRequests.id, payoutId)),
      ).rejects.toMatchObject(constraint);
      await expect(
        db().update(payoutRequests).set({ amount_npr: 0 }).where(eq(payoutRequests.id, payoutId)),
      ).rejects.toMatchObject({ cause: { constraint: 'payout_requests_amount_check' } });
    });
  });
});
