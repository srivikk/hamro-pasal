import { Client, type Notification, type Pool } from 'pg';

import {
  adjustVendorWallet,
  createOrder,
  createTestPool,
  createUser,
  createVendor,
  firstRow,
  getVendorWallet,
  insertJournal,
  pgError,
  postJournal,
  systemAccountId,
  vendorAccountId,
} from './support/fixtures';

describe('double-entry ledger', () => {
  let pool: Pool;
  let customerId: string;
  let revenue: string;
  let escrow: string;

  beforeAll(async () => {
    pool = createTestPool();
    customerId = await createUser(pool);
    revenue = await systemAccountId(pool, 'PLATFORM_REVENUE');
    escrow = await systemAccountId(pool, 'SYSTEM_ESCROW');
  });

  afterAll(async () => {
    await pool.end();
  });

  const accountBalance = async (accountId: string): Promise<string> =>
    firstRow(
      (
        await pool.query<{ balance_npr: string }>(
          'SELECT balance_npr FROM ledger_accounts WHERE id = $1',
          [accountId],
        )
      ).rows,
    ).balance_npr;

  describe('accounts', () => {
    it('seeds exactly one escrow, one revenue and one clearing account per gateway', async () => {
      const { rows } = await pool.query<{ account_type: string; gateway: string | null }>(
        `SELECT account_type, gateway FROM ledger_accounts
         WHERE account_type IN ('SYSTEM_ESCROW', 'PLATFORM_REVENUE', 'GATEWAY_CLEARING')
         ORDER BY account_type, gateway`,
      );

      // ORDER BY on an enum follows its declaration order.
      expect(rows).toEqual([
        { account_type: 'SYSTEM_ESCROW', gateway: null },
        { account_type: 'PLATFORM_REVENUE', gateway: null },
        { account_type: 'GATEWAY_CLEARING', gateway: 'ESEWA' },
        { account_type: 'GATEWAY_CLEARING', gateway: 'KHALTI' },
      ]);
    });

    it('opens a zero-balance VENDOR_WALLET account for every new vendor', async () => {
      const vendorId = await createVendor(pool);

      expect(await accountBalance(await vendorAccountId(pool, vendorId))).toBe('0.00');
    });

    it('rejects a second escrow account and owner/type mismatches', async () => {
      const second = await pgError(
        pool.query(`INSERT INTO ledger_accounts (account_type) VALUES ('SYSTEM_ESCROW')`),
      );
      expect(second.constraint).toBe('ledger_accounts_system_singleton_idx');

      const mismatch = await pgError(
        pool.query(`INSERT INTO ledger_accounts (account_type) VALUES ('VENDOR_WALLET')`),
      );
      expect(mismatch.constraint).toBe('ledger_accounts_owner_check');
    });

    it('keeps account type, owner and balance immutable outside postings', async () => {
      const vendorAccount = await vendorAccountId(pool, await createVendor(pool));

      const balance = await pgError(
        pool.query('UPDATE ledger_accounts SET balance_npr = 500 WHERE id = $1', [vendorAccount]),
      );
      const owner = await pgError(
        pool.query(`UPDATE ledger_accounts SET account_type = 'DRIVER_WALLET' WHERE id = $1`, [
          vendorAccount,
        ]),
      );
      const del = await pgError(
        pool.query('DELETE FROM ledger_accounts WHERE id = $1', [vendorAccount]),
      );

      expect(balance.message).toMatch(/only through ledger postings/);
      expect(owner.message).toMatch(/immutable/);
      expect(del.message).toMatch(/cannot be deleted/);
    });
  });

  describe('journal integrity', () => {
    it('applies a balanced journal to every account balance', async () => {
      const vendorId = await createVendor(pool);
      const vendorAccount = await vendorAccountId(pool, vendorId);
      const revenueBefore = Number(await accountBalance(revenue));

      await adjustVendorWallet(pool, vendorId, 250.5);

      expect(await accountBalance(vendorAccount)).toBe('250.50');
      expect(Number(await accountBalance(revenue))).toBeCloseTo(revenueBefore - 250.5, 2);
      expect((await getVendorWallet(pool, vendorId)).wallet_balance_npr).toBe('250.50');
    });

    it('rejects an unbalanced journal at COMMIT and leaves no trace', async () => {
      const vendorId = await createVendor(pool);
      const vendorAccount = await vendorAccountId(pool, vendorId);

      const error = await pgError(
        postJournal(pool, [
          { accountId: vendorAccount, amountNpr: 100 },
          { accountId: revenue, amountNpr: -99.99 },
        ]),
      );

      expect(error.code).toBe('23514');
      expect(error.message).toMatch(/unbalanced: 2 posting\(s\) summing to 0.01 NPR/);
      expect(await accountBalance(vendorAccount)).toBe('0.00');
    });

    it('rejects a journal with a single posting or none', async () => {
      const one = await pgError(postJournal(pool, [{ accountId: revenue, amountNpr: 0.01 }]));
      const none = await pgError(postJournal(pool, []));

      expect(one.message).toMatch(/1 posting\(s\)/);
      expect(none.message).toMatch(/0 posting\(s\)/);
    });

    it('rejects zero-amount postings', async () => {
      const error = await pgError(
        postJournal(pool, [
          { accountId: revenue, amountNpr: 0 },
          { accountId: escrow, amountNpr: 0 },
        ]),
      );

      expect(error.constraint).toBe('ledger_entries_amount_non_zero_check');
    });

    it('rejects postings added to a journal committed in an earlier transaction', async () => {
      const vendorId = await createVendor(pool);
      const transactionId = await adjustVendorWallet(pool, vendorId, 10);
      const vendorAccount = await vendorAccountId(pool, vendorId);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const error = await pgError(
          client.query(
            'INSERT INTO ledger_entries (transaction_id, account_id, amount_npr) VALUES ($1, $2, 5), ($1, $3, -5)',
            [transactionId, vendorAccount, revenue],
          ),
        );
        expect(error.message).toMatch(/only be added in the transaction that created/);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('accepts postings made inside a savepoint (nested transaction)', async () => {
      const vendorId = await createVendor(pool);
      const vendorAccount = await vendorAccountId(pool, vendorId);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT nested');
        await insertJournal(client, [
          { accountId: vendorAccount, amountNpr: 42 },
          { accountId: revenue, amountNpr: -42 },
        ]);
        await client.query('RELEASE SAVEPOINT nested');
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      expect(await accountBalance(vendorAccount)).toBe('42.00');
    });

    it('rejects a duplicate idempotency key without moving any balance', async () => {
      const vendorId = await createVendor(pool);
      await adjustVendorWallet(pool, vendorId, -100, { idempotencyKey: `dup-${vendorId}` });

      const error = await pgError(
        adjustVendorWallet(pool, vendorId, -100, { idempotencyKey: `dup-${vendorId}` }),
      );

      expect(error.constraint).toBe('ledger_transactions_idempotency_key_key');
      expect((await getVendorWallet(pool, vendorId)).wallet_balance_npr).toBe('-100.00');
    });

    it('never lets escrow pay out more than it holds', async () => {
      const vendorAccount = await vendorAccountId(pool, await createVendor(pool));
      const held = Number(await accountBalance(escrow));

      const error = await pgError(
        postJournal(pool, [
          { accountId: escrow, amountNpr: -(held + 1) },
          { accountId: vendorAccount, amountNpr: held + 1 },
        ]),
      );

      expect(error.constraint).toBe('ledger_accounts_escrow_non_negative_check');
    });

    it('is append-only', async () => {
      const vendorId = await createVendor(pool);
      const transactionId = await adjustVendorWallet(pool, vendorId, 10);

      const updateTx = await pgError(
        pool.query(`UPDATE ledger_transactions SET description = 'x' WHERE id = $1`, [
          transactionId,
        ]),
      );
      const deleteEntries = await pgError(
        pool.query('DELETE FROM ledger_entries WHERE transaction_id = $1', [transactionId]),
      );

      expect(updateTx.message).toMatch(/ledger_transactions is append-only/);
      expect(deleteEntries.message).toMatch(/ledger_entries is append-only/);
    });

    it('applies concurrent postings to the same account exactly once each', async () => {
      const vendorId = await createVendor(pool);

      await Promise.all(Array.from({ length: 20 }, () => adjustVendorWallet(pool, vendorId, -10)));

      expect((await getVendorWallet(pool, vendorId)).wallet_balance_npr).toBe('-200.00');
      expect(await accountBalance(await vendorAccountId(pool, vendorId))).toBe('-200.00');
    });
  });

  describe('vendor wallet projection (SPEC §5 negative wallet invariant)', () => {
    it('rejects direct edits of vendors.wallet_balance_npr', async () => {
      const vendorId = await createVendor(pool);

      const error = await pgError(
        pool.query('UPDATE vendors SET wallet_balance_npr = -5000 WHERE id = $1', [vendorId]),
      );

      expect(error.message).toMatch(/projection of the VENDOR_WALLET ledger account/);
    });

    it('rejects vendors created with a non-zero wallet', async () => {
      const userId = await createUser(pool, 'VENDOR');
      const error = await pgError(
        pool.query(
          `INSERT INTO vendors (user_id, business_name, phone, commission_rate, delivery_scope, radius_km,
                                municipality_palika_string, min_order_value, base_delivery_fee_npr,
                                location, wallet_balance_npr)
           VALUES ($1, 'X', '+9779811111111', 0.1, 'RADIUS_BOUND', 5, 'Kathmandu Metropolitan City', 0, 0,
                   ST_SetSRID(ST_MakePoint(85.3, 27.7), 4326), -10)`,
          [userId],
        ),
      );

      expect(error.message).toMatch(/must open with a 0 NPR wallet/);
    });

    it('debits 100 NPR for a 1000 NPR COD order at 10% commission and stays LIVE', async () => {
      const vendorId = await createVendor(pool, { commissionRate: 0.1 });

      await adjustVendorWallet(pool, vendorId, -(1000 * 0.1));

      expect(await getVendorWallet(pool, vendorId)).toEqual({
        status: 'LIVE',
        wallet_balance_npr: '-100.00',
      });
    });

    it('stays LIVE at exactly -2000 NPR (suspension requires a breach)', async () => {
      const vendorId = await createVendor(pool, { walletBalanceNpr: -2000 });

      expect(await getVendorWallet(pool, vendorId)).toEqual({
        status: 'LIVE',
        wallet_balance_npr: '-2000.00',
      });
    });

    it('records the breaching debit and suspends the vendor in the same transaction', async () => {
      const vendorId = await createVendor(pool, { walletBalanceNpr: -1950 });
      const orderId = await createOrder(pool, { vendorId, customerId });

      await adjustVendorWallet(pool, vendorId, -100, { kind: 'ORDER_SETTLEMENT', orderId });

      expect(await getVendorWallet(pool, vendorId)).toEqual({
        status: 'SUSPENDED',
        wallet_balance_npr: '-2050.00',
      });
      expect(await accountBalance(await vendorAccountId(pool, vendorId))).toBe('-2050.00');
    });

    it('emits a vendor_wallet_suspended notification carrying the breach depth', async () => {
      const vendorId = await createVendor(pool, { walletBalanceNpr: -1990 });
      const listener = new Client({ connectionString: process.env.TEST_DATABASE_URL });
      await listener.connect();
      try {
        const received = new Promise<Notification>((resolve) => {
          listener.on('notification', (msg) => {
            if (msg.payload?.includes(vendorId) === true) resolve(msg);
          });
        });
        await listener.query('LISTEN vendor_wallet_suspended');

        await adjustVendorWallet(pool, vendorId, -25);

        expect(JSON.parse((await received).payload ?? '')).toEqual({
          vendor_id: vendorId,
          wallet_balance_npr: -2015,
          depth_npr: 2015,
          limit_npr: -2000,
        });
      } finally {
        await listener.end();
      }
    });

    it('keeps the vendor SUSPENDED until the balance is topped up above the limit', async () => {
      const vendorId = await createVendor(pool, { walletBalanceNpr: -2150 });
      const reactivate = () =>
        pool.query(`UPDATE vendors SET status = 'LIVE' WHERE id = $1`, [vendorId]);

      const blocked = await pgError(reactivate());
      expect(blocked.code).toBe('23514');
      expect(blocked.message).toMatch(/cannot leave SUSPENDED/);

      await adjustVendorWallet(pool, vendorId, 500, { kind: 'VENDOR_TOP_UP' });
      await reactivate();

      expect(await getVendorWallet(pool, vendorId)).toEqual({
        status: 'LIVE',
        wallet_balance_npr: '-1650.00',
      });
    });

    it('enforces the -2000 CHECK floor even if the suspension trigger is bypassed', async () => {
      const vendorAccount = await vendorAccountId(pool, await createVendor(pool));
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('ALTER TABLE vendors DISABLE TRIGGER vendors_enforce_wallet_limit');
        const error = await pgError(
          insertJournal(client, [
            { accountId: vendorAccount, amountNpr: -2500 },
            { accountId: revenue, amountNpr: 2500 },
          ]),
        );
        expect(error.code).toBe('23514');
        expect(error.constraint).toBe('vendors_wallet_balance_floor_check');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('suspends at a stricter Superadmin-configured limit', async () => {
      const vendorId = await createVendor(pool, { walletBalanceNpr: -1450 });
      const vendorAccount = await vendorAccountId(pool, vendorId);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'UPDATE platform_settings SET vendor_wallet_suspension_limit_npr = -1500',
        );
        await insertJournal(client, [
          { accountId: vendorAccount, amountNpr: -100 },
          { accountId: revenue, amountNpr: 100 },
        ]);
        const { rows } = await client.query<{ status: string }>(
          'SELECT status FROM vendors WHERE id = $1',
          [vendorId],
        );
        expect(rows[0]?.status).toBe('SUSPENDED');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('never allows the configurable limit to be looser than -2000 or positive', async () => {
      for (const limit of [-2000.01, 0.01]) {
        const error = await pgError(
          pool.query('UPDATE platform_settings SET vendor_wallet_suspension_limit_npr = $1', [
            limit,
          ]),
        );
        expect(error.constraint).toBe('platform_settings_wallet_limit_check');
      }
      const deleteError = await pgError(pool.query('DELETE FROM platform_settings'));
      expect(deleteError.message).toMatch(/cannot be deleted/);
    });
  });
});
