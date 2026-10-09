import { randomUUID } from 'node:crypto';

import {
  auditLogs,
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  payoutRequests,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import {
  adminSettlementListResponseSchema,
  panVerificationResponseSchema,
  settlementPayoutResponseSchema,
  vendorFinanceLedgerResponseSchema,
} from '@hamro-pasal/shared-types';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';

import { createOrder, createUser, createVendor, vendorUserIdOf } from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * Phase 26: admin-initiated settlement payouts behind the PAN payout gate (SPEC core 5, SPEC
 * verification 18), through real Express, PostgreSQL and the double-entry ledger.
 */
describe('admin settlements API', () => {
  let t: TestApp;
  let db: Database;
  let adminId: string;
  let admin: string;

  beforeAll(async () => {
    t = buildTestApp();
    db = t.container.db;
    adminId = await createUser(db, 'SUPER_ADMIN');
    admin = bearer(adminId, 'SUPER_ADMIN');
  });

  afterAll(async () => {
    await t.container.close();
  });

  /** A LIVE shop with `balanceNpr` in its wallet and a saved PAN, verified or not. */
  async function shop(
    balanceNpr: number,
    options: {
      pan?: string | null;
      verified?: boolean;
      businessName?: string;
      bankAccount?: boolean;
    } = {},
  ) {
    const vendorId = await createVendor(db, {
      businessName: options.businessName ?? `Settle ${randomUUID()}`,
    });
    const userId = await vendorUserIdOf(db, vendorId);
    if (balanceNpr > 0) {
      const topUp = await request(t.app)
        .post('/api/vendors/wallet/top-up')
        .set('Authorization', bearer(userId, 'VENDOR'))
        .send({ idempotency_key: randomUUID(), amount_npr: balanceNpr });
      expect(topUp.status).toBe(201);
    }
    const pan = options.pan === undefined ? '302118845' : options.pan;
    if (pan !== null) {
      await db
        .update(vendors)
        .set({ tax_id: pan, pan_document_url: `kyc/pan/${vendorId}/${randomUUID()}.webp` })
        .where(eq(vendors.id, vendorId));
    }
    if (options.verified === true) await verify(vendorId);
    // A payout needs somewhere to go: the shop's primary bank account.
    if (options.bankAccount !== false) {
      const account = await request(t.app)
        .post('/api/vendor/bank-accounts')
        .set('Authorization', bearer(userId, 'VENDOR'))
        .send({
          bank_name: 'Nabil Bank',
          branch_name: 'Thamel',
          account_name: 'Settle Traders',
          account_number: '0123456789012',
          routing_or_swift_code: null,
          is_primary: true,
        });
      expect(account.status).toBe(201);
    }
    return { vendorId, userId };
  }

  async function verify(vendorId: string) {
    // A PAN is verified against its document (Phase 35); a changed PAN number removes it.
    await db
      .update(vendors)
      .set({ pan_document_url: `kyc/pan/${vendorId}/${randomUUID()}.webp` })
      .where(eq(vendors.id, vendorId));
    const res = await request(t.app)
      .post(`/api/admin/vendors/${vendorId}/pan-verification`)
      .set('Authorization', admin);
    expect(res.status).toBe(200);
    return bodyOf(panVerificationResponseSchema, res).vendor;
  }

  const list = (token: string | null = admin) => {
    const req = request(t.app).get('/api/admin/finance/settlements');
    return token === null ? req : req.set('Authorization', token);
  };

  async function listed(vendorId: string) {
    const res = await list();
    expect(res.status).toBe(200);
    return bodyOf(adminSettlementListResponseSchema, res).vendors.find(
      (vendor) => vendor.vendor_id === vendorId,
    );
  }

  const payout = (
    vendorId: string,
    body: Record<string, unknown> = {},
    token: string | null = admin,
  ) => {
    const req = request(t.app).post(`/api/admin/finance/settlements/${vendorId}/payout`);
    return (token === null ? req : req.set('Authorization', token)).send({
      amount_npr: 400,
      bank_reference: 'NIC-ASIA-778812',
      idempotency_key: randomUUID(),
      ...body,
    });
  };

  async function walletOf(vendorId: string): Promise<number> {
    const [row] = await db
      .select({ balance: vendors.wallet_balance_npr })
      .from(vendors)
      .where(eq(vendors.id, vendorId));
    if (row === undefined) throw new Error('vendor not found');
    return row.balance;
  }

  async function clearingBalance(): Promise<number> {
    const [account] = await db
      .select({ balance: ledgerAccounts.balance_npr })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.account_type, 'PAYOUT_CLEARING'));
    return account?.balance ?? 0;
  }

  const payoutRows = (vendorId: string) =>
    db.select().from(payoutRequests).where(eq(payoutRequests.vendor_id, vendorId));

  const processedEntries = (vendorId: string) =>
    db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entity_id, vendorId), eq(auditLogs.action, 'PAYOUT_PROCESSED')));

  describe('GET /api/admin/finance/settlements', () => {
    it('lists the shops with money to pay, each with its PAN verification', async () => {
      const verified = await shop(8450, { verified: true });
      const unverified = await shop(15400);
      const noPan = await shop(120, { pan: null });
      const empty = await shop(0, { verified: true });
      const inDebt = await shop(0);
      await db.update(vendors).set({ tax_id: null }).where(eq(vendors.id, inDebt.vendorId));

      const res = await list();

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = bodyOf(adminSettlementListResponseSchema, res);
      const row = (id: string) => body.vendors.find((vendor) => vendor.vendor_id === id);
      expect(row(verified.vendorId)).toMatchObject({
        settlement_model: 'PLATFORM_ESCROW',
        available_for_payout_npr: 8450,
        pending_escrow_npr: 0,
        tax_id: '302118845',
        phone: '+9779800000000',
      });
      expect(row(verified.vendorId)?.pan_verified_at).not.toBeNull();
      // Listed, so the screen can show why its payout is held.
      expect(row(unverified.vendorId)).toMatchObject({
        available_for_payout_npr: 15400,
        tax_id: '302118845',
        pan_verified_at: null,
      });
      expect(row(noPan.vendorId)).toMatchObject({ tax_id: null, pan_verified_at: null });
      // Nothing available: nothing to approve.
      expect(row(empty.vendorId)).toBeUndefined();
      expect(row(inDebt.vendorId)).toBeUndefined();
      expect(body.vendors.every((vendor) => vendor.available_for_payout_npr > 0)).toBe(true);
      const names = body.vendors.map((vendor) => vendor.business_name);
      expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    });

    it('shows prepaid earnings still in escrow apart from what is payable', async () => {
      const { vendorId } = await shop(500, { verified: true });
      // Paid online, not delivered yet: 1000 - 100 commission + the shop's own 50 delivery fee.
      const order = await createOrder(db, {
        vendorId,
        customerId: await createUser(db),
        paymentMethod: 'ESEWA',
      });
      await db.execute(
        `UPDATE orders SET state = 'PLACED', placed_at = now(), payment_status = 'PAID',
           payment_gateway_ref = '${randomUUID()}' WHERE id = '${order.id}'`,
      );

      expect(await listed(vendorId)).toMatchObject({
        available_for_payout_npr: 500,
        pending_escrow_npr: 950,
      });
    });
  });

  describe('POST /api/admin/finance/settlements/:vendor_id/payout', () => {
    it('pays a verified shop: one balanced journal, an APPROVED record and the audit entry', async () => {
      const { vendorId, userId } = await shop(1000, { verified: true });
      const clearingBefore = await clearingBalance();

      const res = await payout(vendorId, { amount_npr: 400.5, bank_reference: ' NABIL-0042 ' });

      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = bodyOf(settlementPayoutResponseSchema, res);
      expect(body.replayed).toBe(false);
      expect(body.payout).toMatchObject({
        amount_npr: 400.5,
        status: 'APPROVED',
        bank_reference: 'NABIL-0042',
        rejection_reason: null,
      });
      expect(body.payout.decided_at).not.toBeNull();
      expect(body.vendor).toMatchObject({ vendor_id: vendorId, available_for_payout_npr: 599.5 });

      // The ledger: wallet down, payout clearing up, by the same amount, in one journal.
      expect(await walletOf(vendorId)).toBe(599.5);
      expect((await clearingBalance()) - clearingBefore).toBeCloseTo(400.5, 2);
      const [row] = await payoutRows(vendorId);
      expect(row).toMatchObject({
        status: 'APPROVED',
        amount_npr: 400.5,
        bank_reference: 'NABIL-0042',
        decided_by_user_id: adminId,
        reversal_transaction_id: null,
      });
      const [journal] = await db
        .select()
        .from(ledgerTransactions)
        .where(eq(ledgerTransactions.id, row?.hold_transaction_id ?? ''));
      expect(journal?.kind).toBe('VENDOR_PAYOUT');
      const postings = await db
        .select({ amount: ledgerEntries.amount_npr })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.transaction_id, journal?.id ?? ''));
      expect(postings.map((posting) => posting.amount).sort((a, b) => a - b)).toEqual([
        -400.5, 400.5,
      ]);

      const entries = await processedEntries(vendorId);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actor_user_id: adminId,
        actor_role: 'SUPER_ADMIN',
        entity_type: 'vendor_ledger',
        vendor_id: vendorId,
        before_state: { wallet_balance_npr: 1000 },
        after_state: {
          wallet_balance_npr: 599.5,
          payout: {
            id: row?.id,
            amount_npr: 400.5,
            bank_reference: 'NABIL-0042',
            ledger_transaction_id: journal?.id,
          },
        },
        request_id: res.headers['x-request-id'],
      });

      // The vendor sees it in its own history.
      const ledger = bodyOf(
        vendorFinanceLedgerResponseSchema,
        await request(t.app)
          .get('/api/vendor/finance/ledger')
          .set('Authorization', bearer(userId, 'VENDOR')),
      );
      expect(ledger.available_balance_npr).toBe(599.5);
      expect(ledger.payouts.map((p) => [p.id, p.status])).toEqual([[row?.id, 'APPROVED']]);
    });

    it('refuses an unverified PAN with 422 PAN_NOT_VERIFIED and moves nothing', async () => {
      for (const options of [{}, { pan: null }]) {
        const { vendorId } = await shop(1000, options);
        const clearingBefore = await clearingBalance();

        const res = await payout(vendorId);

        expect(res.status).toBe(422);
        expect(errorOf(res)).toMatchObject({
          code: 'PAN_NOT_VERIFIED',
          message: 'Cannot disburse funds: PAN not verified.',
          details: { vendor_id: vendorId },
        });
        expect(await walletOf(vendorId)).toBe(1000);
        expect(await clearingBalance()).toBe(clearingBefore);
        expect(await payoutRows(vendorId)).toEqual([]);
        expect(await processedEntries(vendorId)).toEqual([]);
      }
    });

    it('opens once the PAN is verified, and closes again when the PAN changes', async () => {
      const { vendorId, userId } = await shop(1000);
      expect((await payout(vendorId)).status).toBe(422);

      await verify(vendorId);
      expect((await payout(vendorId, { amount_npr: 300 })).status).toBe(201);

      // A different PAN is a different document: the verification is cleared with it.
      const changed = await request(t.app)
        .put('/api/vendor/tax-identity')
        .set('Authorization', bearer(userId, 'VENDOR'))
        .send({ tax_id: '609988776', is_vat_registered: false });
      expect(changed.status).toBe(200);
      const frozen = await payout(vendorId, { amount_npr: 300 });
      expect(frozen.status).toBe(422);
      expect(errorOf(frozen).code).toBe('PAN_NOT_VERIFIED');
      // The payout already made is not reversed; the shop is still LIVE and still owed the rest.
      expect(await walletOf(vendorId)).toBe(700);
      expect(await listed(vendorId)).toMatchObject({
        available_for_payout_npr: 700,
        pan_verified_at: null,
      });

      await verify(vendorId);
      expect((await payout(vendorId, { amount_npr: 300 })).status).toBe(201);
      expect(await walletOf(vendorId)).toBe(400);
    });

    it('never pays on a verification that a PAN change cleared first', async () => {
      const { vendorId } = await shop(1000, { verified: true });
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let lockTaken = (): void => undefined;
      const locked = new Promise<void>((resolve) => {
        lockTaken = resolve;
      });
      // The vendor's PAN change, uncommitted, holding the vendor row.
      const panChange = db.transaction(async (tx) => {
        await tx
          .update(vendors)
          .set({ tax_id: '609988776', pan_verified_at: null, pan_verified_by_user_id: null })
          .where(eq(vendors.id, vendorId));
        lockTaken();
        await held;
      });
      await locked;

      const racing = payout(vendorId).then((res) => res);
      await new Promise((resolve) => setTimeout(resolve, 200));
      release();
      await panChange;
      const res = await racing;

      // Without the row lock it would read the old verification and pay.
      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe('PAN_NOT_VERIFIED');
      expect(await walletOf(vendorId)).toBe(1000);
      expect(await payoutRows(vendorId)).toEqual([]);
    });

    it('pays up to exactly what is available, and no paisa more', async () => {
      const { vendorId } = await shop(250, { verified: true });

      const over = await payout(vendorId, { amount_npr: 250.01 });
      expect(over.status).toBe(422);
      expect(errorOf(over)).toMatchObject({
        code: 'INSUFFICIENT_BALANCE',
        details: { requested_npr: 250.01, available_balance_npr: 250 },
      });
      expect(await walletOf(vendorId)).toBe(250);

      // No minimum for a manual payout: 1 rupee is fine, and so is the whole balance.
      expect((await payout(vendorId, { amount_npr: 1 })).status).toBe(201);
      const rest = await payout(vendorId, { amount_npr: 249 });
      expect(rest.status).toBe(201);
      expect(bodyOf(settlementPayoutResponseSchema, rest).vendor.available_for_payout_npr).toBe(0);
      expect(await listed(vendorId)).toBeUndefined();
      const nothing = await payout(vendorId, { amount_npr: 0.01 });
      expect(nothing.status).toBe(422);
      expect(errorOf(nothing).code).toBe('INSUFFICIENT_BALANCE');
    });

    it('never lets simultaneous payouts exceed the balance', async () => {
      const { vendorId } = await shop(1000, { verified: true });

      const results = await Promise.all(
        Array.from({ length: 6 }, () => payout(vendorId, { amount_npr: 300 })),
      );

      expect(results.map((res) => res.status).sort()).toEqual([201, 201, 201, 422, 422, 422]);
      expect(await walletOf(vendorId)).toBe(100);
      expect(await payoutRows(vendorId)).toHaveLength(3);
      expect(await processedEntries(vendorId)).toHaveLength(3);
    });

    it('answers a retried request with the payout it already made', async () => {
      const { vendorId } = await shop(1000, { verified: true });
      const body = { amount_npr: 400, idempotency_key: `retry-${randomUUID()}` };

      const first = await payout(vendorId, body);
      const again = await payout(vendorId, body);
      const together = await Promise.all([1, 2, 3].map(() => payout(vendorId, body)));

      expect(first.status).toBe(201);
      const firstBody = bodyOf(settlementPayoutResponseSchema, first);
      for (const res of [again, ...together]) {
        expect(res.status).toBe(200);
        const replay = bodyOf(settlementPayoutResponseSchema, res);
        expect(replay.replayed).toBe(true);
        expect(replay.payout).toEqual(firstBody.payout);
      }
      expect(await walletOf(vendorId)).toBe(600);
      expect(await payoutRows(vendorId)).toHaveLength(1);
      expect(await processedEntries(vendorId)).toHaveLength(1);

      // The same key for another amount or another transfer is not a retry.
      for (const other of [{ amount_npr: 401 }, { bank_reference: 'OTHER-REF' }]) {
        const res = await payout(vendorId, { ...body, ...other });
        expect(res.status).toBe(409);
        expect(errorOf(res).code).toBe('IDEMPOTENCY_KEY_REUSED');
      }
      expect(await walletOf(vendorId)).toBe(600);
    });

    it('keeps an admin key apart from the vendor’s own payout request with the same key', async () => {
      const { vendorId, userId } = await shop(1000, { verified: true });
      const key = `shared-${randomUUID()}`;
      const requested = await request(t.app)
        .post('/api/vendor/finance/payout')
        .set('Authorization', bearer(userId, 'VENDOR'))
        .send({ idempotency_key: key, amount_npr: 400 });
      expect(requested.status).toBe(201);

      const res = await payout(vendorId, { idempotency_key: key, amount_npr: 400 });

      // A new payout, not a replay of the vendor's pending request.
      expect(res.status).toBe(201);
      expect(bodyOf(settlementPayoutResponseSchema, res).payout.status).toBe('APPROVED');
      expect(await walletOf(vendorId)).toBe(200);
      expect((await payoutRows(vendorId)).map((row) => row.status).sort()).toEqual([
        'APPROVED',
        'PENDING',
      ]);
    });

    it('refuses invalid bodies and unknown vendors, and moves nothing', async () => {
      const { vendorId } = await shop(1000, { verified: true });
      for (const body of [
        { amount_npr: 0 },
        { amount_npr: -5 },
        { amount_npr: 10.005 },
        { amount_npr: '400' },
        { amount_npr: 1_000_000.01 },
        { bank_reference: '   ' },
        { bank_reference: 'x'.repeat(101) },
        { idempotency_key: 'short' },
        { vendor_id: vendorId },
        { status: 'APPROVED' },
      ]) {
        const res = await payout(vendorId, body);
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
      for (const missing of ['amount_npr', 'bank_reference', 'idempotency_key']) {
        const res = await request(t.app)
          .post(`/api/admin/finance/settlements/${vendorId}/payout`)
          .set('Authorization', admin)
          .send(
            Object.fromEntries(
              Object.entries({
                amount_npr: 400,
                bank_reference: 'REF-1',
                idempotency_key: randomUUID(),
              }).filter(([name]) => name !== missing),
            ),
          );
        expect(res.status).toBe(400);
      }
      expect(await walletOf(vendorId)).toBe(1000);

      const unknown = await payout(randomUUID());
      expect(unknown.status).toBe(404);
      expect(errorOf(unknown).code).toBe('VENDOR_NOT_FOUND');
      const malformed = await payout('not-a-uuid');
      expect(malformed.status).toBe(400);
    });
  });

  describe('settlement models', () => {
    it('lists and pays Model B shops only', async () => {
      const { vendorId } = await shop(1000, { verified: true });
      expect(await listed(vendorId)).toMatchObject({ settlement_model: 'PLATFORM_ESCROW' });

      for (const model of ['COD_CREDIT', 'DIRECT_PREPAID'] as const) {
        await db.update(vendors).set({ settlement_model: model }).where(eq(vendors.id, vendorId));

        expect(await listed(vendorId)).toBeUndefined();
        const res = await payout(vendorId);
        expect(res.status).toBe(422);
        expect(errorOf(res)).toMatchObject({
          code: 'SETTLEMENT_MODEL_NOT_ESCROW',
          details: { settlement_model: model },
        });
      }
      expect(await walletOf(vendorId)).toBe(1000);
      expect(await payoutRows(vendorId)).toEqual([]);
    });
  });

  it('serves Super Admins only: no vendor can pay itself or request a settlement', async () => {
    const { vendorId, userId } = await shop(1000, { verified: true });
    const tokens = [
      bearer(userId, 'VENDOR'),
      bearer(await createUser(db), 'CUSTOMER'),
      bearer(await createUser(db, 'DRIVER'), 'DRIVER'),
    ];

    expect((await list(null)).status).toBe(401);
    expect((await payout(vendorId, {}, null)).status).toBe(401);
    for (const token of tokens) {
      expect((await list(token)).status).toBe(403);
      const res = await payout(vendorId, {}, token);
      expect(res.status).toBe(403);
      expect(errorOf(res).code).toBe('FORBIDDEN');
    }
    expect(await walletOf(vendorId)).toBe(1000);
  });
});
