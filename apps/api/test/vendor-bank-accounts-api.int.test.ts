import { randomUUID } from 'node:crypto';

import { auditLogs, vendorBankAccounts, vendors, type Database } from '@hamro-pasal/db';
import {
  adminSettlementListResponseSchema,
  bankAccountListResponseSchema,
  bankAccountResponseSchema,
  settlementPayoutResponseSchema,
  type BankAccountView,
} from '@hamro-pasal/shared-types';
import { asc, eq } from 'drizzle-orm';
import request from 'supertest';

import { createUser, createVendor, vendorUserIdOf } from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * Phase 26: a shop's bank accounts, and the final payout gate that needs a primary one (SPEC core
 * 5, "Payouts"), over HTTP on real PostgreSQL.
 */
describe('vendor bank accounts API', () => {
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

  const NABIL = {
    bank_name: 'Nabil Bank',
    branch_name: 'Thamel',
    account_name: 'Thamel Kirana Pasal',
    account_number: '0123456789012',
    routing_or_swift_code: null,
    is_primary: false,
  };
  const NIC = { ...NABIL, bank_name: 'NIC Asia Bank', account_number: '9988776655443' };

  async function shop() {
    const vendorId = await createVendor(db);
    const userId = await vendorUserIdOf(db, vendorId);
    return { vendorId, userId, token: bearer(userId, 'VENDOR') };
  }

  const list = (token: string | null) => {
    const req = request(t.app).get('/api/vendor/bank-accounts');
    return token === null ? req : req.set('Authorization', token);
  };
  const post = (token: string | null, body: unknown) => {
    const req = request(t.app).post('/api/vendor/bank-accounts');
    return (token === null ? req : req.set('Authorization', token)).send(body as object);
  };
  const put = (token: string | null, id: string, body: unknown) => {
    const req = request(t.app).put(`/api/vendor/bank-accounts/${id}`);
    return (token === null ? req : req.set('Authorization', token)).send(body as object);
  };

  async function added(token: string, body: unknown): Promise<BankAccountView> {
    const res = await post(token, body);
    expect(res.status).toBe(201);
    return bodyOf(bankAccountResponseSchema, res).bank_account;
  }

  async function accounts(token: string): Promise<BankAccountView[]> {
    const res = await list(token);
    expect(res.status).toBe(200);
    return bodyOf(bankAccountListResponseSchema, res).bank_accounts;
  }

  const entries = (vendorId: string) =>
    db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.vendor_id, vendorId))
      .orderBy(asc(auditLogs.occurred_at), asc(auditLogs.id));

  describe('POST and GET /api/vendor/bank-accounts', () => {
    it('adds the first account as the primary one, whatever the request says', async () => {
      const { vendorId, userId, token } = await shop();
      expect(await accounts(token)).toEqual([]);

      const res = await post(token, { ...NABIL, bank_name: '  Nabil Bank ', is_primary: false });

      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const account = bodyOf(bankAccountResponseSchema, res).bank_account;
      expect(account).toMatchObject({ ...NABIL, is_primary: true });
      expect(await accounts(token)).toEqual([account]);
      const [row] = await db
        .select()
        .from(vendorBankAccounts)
        .where(eq(vendorBankAccounts.id, account.id));
      expect(row).toMatchObject({ vendor_id: vendorId, account_number: '0123456789012' });

      // Audited by the vendor's own account, with the number masked.
      const audited = await entries(vendorId);
      expect(audited).toHaveLength(1);
      expect(audited[0]).toMatchObject({
        action: 'BANK_ACCOUNT_ADDED',
        actor_user_id: userId,
        actor_role: 'VENDOR',
        entity_type: 'vendor_bank_account',
        entity_id: account.id,
        before_state: null,
        after_state: {
          bank_name: 'Nabil Bank',
          branch_name: 'Thamel',
          account_name: 'Thamel Kirana Pasal',
          account_number_masked: '****9012',
          routing_or_swift_code: null,
          is_primary: true,
        },
        request_id: res.headers['x-request-id'],
      });
      expect(JSON.stringify(audited)).not.toContain('0123456789012');
    });

    it('keeps one primary: a second account is secondary unless it asks to be the primary', async () => {
      const { vendorId, token } = await shop();
      const first = await added(token, NABIL);
      const second = await added(token, NIC);
      expect(second.is_primary).toBe(false);

      const third = await added(token, {
        ...NABIL,
        bank_name: 'Global IME Bank',
        account_number: 'GIME00012345',
        routing_or_swift_code: 'GLBBNPKA',
        is_primary: true,
      });

      const all = await accounts(token);
      // The primary first, then the oldest first.
      expect(all.map((account) => [account.id, account.is_primary])).toEqual([
        [third.id, true],
        [first.id, false],
        [second.id, false],
      ]);
      // The account that lost the primary mark has its own entry.
      const audited = await entries(vendorId);
      expect(audited.map((entry) => [entry.action, entry.entity_id])).toEqual([
        ['BANK_ACCOUNT_ADDED', first.id],
        ['BANK_ACCOUNT_ADDED', second.id],
        ['BANK_ACCOUNT_UPDATED', first.id],
        ['BANK_ACCOUNT_ADDED', third.id],
      ]);
      expect(audited[2]).toMatchObject({
        before_state: { is_primary: true },
        after_state: { is_primary: false },
      });
    });

    it('refuses the same account twice, a sixth account, and malformed bodies', async () => {
      const { token } = await shop();
      await added(token, NABIL);

      const twice = await post(token, { ...NABIL, branch_name: 'Durbar Marg' });
      expect(twice.status).toBe(409);
      expect(errorOf(twice).code).toBe('BANK_ACCOUNT_EXISTS');

      for (const body of [
        {},
        { ...NIC, bank_name: '  ' },
        { ...NIC, account_name: '' },
        { ...NIC, account_number: '123' },
        { ...NIC, account_number: '0123 4567 8901' },
        { ...NIC, account_number: 'x'.repeat(35) },
        { ...NIC, routing_or_swift_code: 'NAR' },
        { ...NIC, routing_or_swift_code: 'NARB-NPKA' },
        { ...NIC, is_primary: 'yes' },
        { ...NIC, vendor_id: randomUUID() },
        { ...NIC, id: randomUUID() },
        { bank_name: 'NIC Asia Bank', account_number: '9988776655443' },
      ]) {
        const res = await post(token, body);
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }

      for (let i = 0; i < 4; i += 1) {
        await added(token, { ...NIC, account_number: `99887766554${String(i)}0` });
      }
      const sixth = await post(token, { ...NIC, account_number: '1111222233334444' });
      expect(sixth.status).toBe(422);
      expect(errorOf(sixth)).toMatchObject({
        code: 'BANK_ACCOUNT_LIMIT_REACHED',
        details: { max: 5 },
      });
      expect(await accounts(token)).toHaveLength(5);
    });

    it('gives a shop one primary account when five are added at once', async () => {
      const { token } = await shop();

      const results = await Promise.all(
        [0, 1, 2, 3, 4].map((i) =>
          post(token, { ...NIC, account_number: `55554444333${String(i)}`, is_primary: true }),
        ),
      );

      expect(results.map((res) => res.status)).toEqual([201, 201, 201, 201, 201]);
      const all = await accounts(token);
      expect(all).toHaveLength(5);
      expect(all.filter((account) => account.is_primary)).toHaveLength(1);
    });

    it('lets another shop hold the same account number, and shows each shop only its own', async () => {
      const one = await shop();
      const other = await shop();
      const mine = await added(one.token, NABIL);
      const theirs = await added(other.token, NABIL);

      expect(theirs.id).not.toBe(mine.id);
      expect((await accounts(one.token)).map((account) => account.id)).toEqual([mine.id]);
      expect((await accounts(other.token)).map((account) => account.id)).toEqual([theirs.id]);
    });
  });

  describe('PUT /api/vendor/bank-accounts/:id', () => {
    it('replaces the account’s fields and audits the change with masked numbers', async () => {
      const { vendorId, token } = await shop();
      const account = await added(token, NABIL);

      const res = await put(token, account.id, {
        ...NABIL,
        branch_name: 'Durbar Marg',
        account_number: '0123456780000',
        routing_or_swift_code: 'NARBNPKA',
        is_primary: true,
      });

      expect(res.status).toBe(200);
      expect(bodyOf(bankAccountResponseSchema, res).bank_account).toMatchObject({
        id: account.id,
        branch_name: 'Durbar Marg',
        account_number: '0123456780000',
        routing_or_swift_code: 'NARBNPKA',
        is_primary: true,
      });
      const audited = await entries(vendorId);
      expect(audited.at(-1)).toMatchObject({
        action: 'BANK_ACCOUNT_UPDATED',
        entity_id: account.id,
        before_state: { branch_name: 'Thamel', account_number_masked: '****9012' },
        after_state: { branch_name: 'Durbar Marg', account_number_masked: '****0000' },
      });
      expect(JSON.stringify(audited)).not.toMatch(/0123456789012|0123456780000/);
    });

    it('moves the primary mark to another account in one transaction', async () => {
      const { token } = await shop();
      const first = await added(token, NABIL);
      const second = await added(token, NIC);

      const res = await put(token, second.id, { ...NIC, is_primary: true });

      expect(res.status).toBe(200);
      expect((await accounts(token)).map((account) => [account.id, account.is_primary])).toEqual([
        [second.id, true],
        [first.id, false],
      ]);
    });

    it('never leaves a shop with accounts and no primary one', async () => {
      const { token } = await shop();
      const primary = await added(token, NABIL);
      await added(token, NIC);

      const res = await put(token, primary.id, { ...NABIL, is_primary: false });

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('PRIMARY_BANK_ACCOUNT_REQUIRED');
      expect((await accounts(token)).filter((account) => account.is_primary)).toHaveLength(1);
    });

    it('changes and records nothing when the stored account is saved again', async () => {
      const { vendorId, token } = await shop();
      const account = await added(token, NABIL);

      const res = await put(token, account.id, { ...NABIL, is_primary: true });

      expect(res.status).toBe(200);
      expect(bodyOf(bankAccountResponseSchema, res).bank_account).toEqual(account);
      expect(await entries(vendorId)).toHaveLength(1);
    });

    it('cannot turn one account into a copy of another, or touch another shop’s account', async () => {
      const one = await shop();
      const other = await shop();
      await added(one.token, NABIL);
      const second = await added(one.token, NIC);
      const theirs = await added(other.token, NABIL);

      const copy = await put(one.token, second.id, { ...NABIL });
      expect(copy.status).toBe(409);
      expect(errorOf(copy).code).toBe('BANK_ACCOUNT_EXISTS');

      const foreign = await put(one.token, theirs.id, { ...NABIL, account_name: 'Hijacked' });
      expect(foreign.status).toBe(404);
      expect(errorOf(foreign).code).toBe('BANK_ACCOUNT_NOT_FOUND');
      expect((await accounts(other.token))[0]).toEqual(theirs);

      expect((await put(one.token, randomUUID(), NABIL)).status).toBe(404);
      expect((await put(one.token, 'not-a-uuid', NABIL)).status).toBe(400);
      expect((await put(one.token, second.id, { branch_name: 'Only this' })).status).toBe(400);
    });

    it('has no route that deletes an account', async () => {
      const { token } = await shop();
      const account = await added(token, NABIL);

      const res = await request(t.app)
        .delete(`/api/vendor/bank-accounts/${account.id}`)
        .set('Authorization', token);

      expect(res.status).toBe(404);
      expect(await accounts(token)).toHaveLength(1);
    });
  });

  describe('the final payout gate', () => {
    async function payableShop() {
      const made = await shop();
      const topUp = await request(t.app)
        .post('/api/vendors/wallet/top-up')
        .set('Authorization', made.token)
        .send({ idempotency_key: randomUUID(), amount_npr: 1000 });
      expect(topUp.status).toBe(201);
      await db
        .update(vendors)
        .set({ tax_id: '302118845', pan_verified_at: new Date(), pan_verified_by_user_id: adminId })
        .where(eq(vendors.id, made.vendorId));
      return made;
    }

    const payout = (vendorId: string) =>
      request(t.app)
        .post(`/api/admin/finance/settlements/${vendorId}/payout`)
        .set('Authorization', admin)
        .send({
          amount_npr: 400,
          bank_reference: 'NIC-ASIA-778812',
          idempotency_key: randomUUID(),
        });

    const walletOf = async (vendorId: string) => {
      const [row] = await db
        .select({ balance: vendors.wallet_balance_npr })
        .from(vendors)
        .where(eq(vendors.id, vendorId));
      return row?.balance;
    };

    it('refuses a payout with 422 BANK_ACCOUNT_MISSING until the shop has a primary account', async () => {
      const { vendorId, token } = await payableShop();

      const held = await payout(vendorId);

      expect(held.status).toBe(422);
      expect(errorOf(held)).toMatchObject({
        code: 'BANK_ACCOUNT_MISSING',
        details: { vendor_id: vendorId },
      });
      expect(await walletOf(vendorId)).toBe(1000);

      const account = await added(token, NABIL);
      const paid = await payout(vendorId);

      expect(paid.status).toBe(201);
      expect(
        bodyOf(settlementPayoutResponseSchema, paid).vendor.primary_bank_account,
      ).toMatchObject({ id: account.id, bank_name: 'Nabil Bank', account_number: '0123456789012' });
      expect(await walletOf(vendorId)).toBe(600);
      // The audit entry says where the money went, with the number masked.
      const [entry] = (await entries(vendorId)).filter((e) => e.action === 'PAYOUT_PROCESSED');
      expect(entry?.after_state).toMatchObject({
        payout: {
          bank_account: {
            id: account.id,
            bank_name: 'Nabil Bank',
            account_name: 'Thamel Kirana Pasal',
            account_number_masked: '****9012',
          },
        },
      });
      expect(JSON.stringify(entry)).not.toContain('0123456789012');
    });

    it('shows the admin the primary account in full on the settlement list, or that it is missing', async () => {
      const withAccount = await payableShop();
      const without = await payableShop();
      await added(withAccount.token, NABIL);
      await added(withAccount.token, { ...NIC, is_primary: true });

      const res = await request(t.app)
        .get('/api/admin/finance/settlements')
        .set('Authorization', admin);

      const rows = bodyOf(adminSettlementListResponseSchema, res).vendors;
      expect(
        rows.find((row) => row.vendor_id === withAccount.vendorId)?.primary_bank_account,
      ).toMatchObject({ bank_name: 'NIC Asia Bank', account_number: '9988776655443' });
      expect(rows.find((row) => row.vendor_id === without.vendorId)).toMatchObject({
        available_for_payout_npr: 1000,
        primary_bank_account: null,
      });
    });

    it('checks the PAN before the bank account', async () => {
      const { vendorId, token } = await shop();
      await request(t.app)
        .post('/api/vendors/wallet/top-up')
        .set('Authorization', token)
        .send({ idempotency_key: randomUUID(), amount_npr: 1000 });

      // Neither gate is open: the PAN is named first.
      expect(errorOf(await payout(vendorId)).code).toBe('PAN_NOT_VERIFIED');
      await added(token, NABIL);
      // A bank account alone opens nothing.
      expect(errorOf(await payout(vendorId)).code).toBe('PAN_NOT_VERIFIED');
    });
  });

  it('serves vendors only, each its own shop', async () => {
    const { token } = await shop();
    const account = await added(token, NABIL);
    const shopless = bearer(await createUser(db, 'VENDOR'), 'VENDOR');
    const calls = [
      (as: string | null) => list(as),
      (as: string | null) => post(as, NIC),
      (as: string | null) => put(as, account.id, NABIL),
    ];
    for (const call of calls) {
      expect((await call(null)).status).toBe(401);
      for (const as of [
        admin,
        bearer(await createUser(db), 'CUSTOMER'),
        bearer(await createUser(db, 'DRIVER'), 'DRIVER'),
      ]) {
        const res = await call(as);
        expect(res.status).toBe(403);
        expect(errorOf(res).code).toBe('FORBIDDEN');
      }
      const res = await call(shopless);
      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('VENDOR_NOT_FOUND');
    }
  });
});
