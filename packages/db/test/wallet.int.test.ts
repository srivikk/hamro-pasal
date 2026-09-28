import { Client, type Notification, type Pool } from 'pg';

import {
  createOrder,
  createTestPool,
  createUser,
  createVendor,
  getVendorWallet,
  pgError,
} from './support/fixtures';

/** SPEC §5 negative wallet invariant, edge case #2, and verification #3. */
describe('vendor wallet invariant', () => {
  let pool: Pool;
  let customerId: string;

  beforeAll(async () => {
    pool = createTestPool();
    customerId = await createUser(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function postLedger(
    vendorId: string,
    entryType: string,
    amountNpr: number,
    orderId: string | null = null,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO wallet_ledgers (vendor_id, order_id, entry_type, amount_npr) VALUES ($1, $2, $3, $4)`,
      [vendorId, orderId, entryType, amountNpr],
    );
  }

  async function codCommission(vendorId: string, amountNpr: number): Promise<string> {
    const orderId = await createOrder(pool, { vendorId, customerId, commission: amountNpr });
    await postLedger(vendorId, 'COD_COMMISSION', -amountNpr, orderId);
    return orderId;
  }

  it('debits 100 NPR for a 1000 NPR COD order at 10% commission and stays LIVE', async () => {
    const vendorId = await createVendor(pool, { commissionRate: 0.1 });
    const subtotal = 1000;
    const commission = subtotal * 0.1;

    await codCommission(vendorId, commission);

    expect(await getVendorWallet(pool, vendorId)).toEqual({
      status: 'LIVE',
      wallet_balance_npr: '-100.00',
    });
  });

  it('stays LIVE at exactly -2000 NPR (suspension requires a breach)', async () => {
    const vendorId = await createVendor(pool, { walletBalanceNpr: -1900 });

    await codCommission(vendorId, 100);

    expect(await getVendorWallet(pool, vendorId)).toEqual({
      status: 'LIVE',
      wallet_balance_npr: '-2000.00',
    });
  });

  it('records the breaching debit and suspends the vendor in the same transaction', async () => {
    const vendorId = await createVendor(pool, { walletBalanceNpr: -1950 });

    await codCommission(vendorId, 100);

    expect(await getVendorWallet(pool, vendorId)).toEqual({
      status: 'SUSPENDED',
      wallet_balance_npr: '-2050.00',
    });
    const { rows } = await pool.query<{ sum: string }>(
      'SELECT sum(amount_npr) FROM wallet_ledgers WHERE vendor_id = $1',
      [vendorId],
    );
    expect(rows[0]?.sum).toBe('-100.00');
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

      await codCommission(vendorId, 25);

      const msg = await received;
      expect(JSON.parse(msg.payload ?? '')).toEqual({
        vendor_id: vendorId,
        wallet_balance_npr: -2015,
        depth_npr: 2015,
        limit_npr: -2000,
      });
    } finally {
      await listener.end();
    }
  });

  it('suspends on a direct vendors.wallet_balance_npr update as well', async () => {
    const vendorId = await createVendor(pool);

    await pool.query('UPDATE vendors SET wallet_balance_npr = -2000.01 WHERE id = $1', [vendorId]);

    expect(await getVendorWallet(pool, vendorId)).toEqual({
      status: 'SUSPENDED',
      wallet_balance_npr: '-2000.01',
    });
  });

  it('keeps the vendor SUSPENDED until the balance is topped up above the limit', async () => {
    const vendorId = await createVendor(pool, { walletBalanceNpr: -1950 });
    await codCommission(vendorId, 200);

    const reactivate = () =>
      pool.query(`UPDATE vendors SET status = 'LIVE' WHERE id = $1`, [vendorId]);
    const blocked = await pgError(reactivate());
    expect(blocked.code).toBe('23514');
    expect(blocked.message).toMatch(/cannot leave SUSPENDED/);

    await postLedger(vendorId, 'TOP_UP', 500);
    await reactivate();

    expect(await getVendorWallet(pool, vendorId)).toEqual({
      status: 'LIVE',
      wallet_balance_npr: '-1650.00',
    });
  });

  it('enforces the -2000 CHECK floor even if the trigger is bypassed', async () => {
    const vendorId = await createVendor(pool);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE vendors DISABLE TRIGGER vendors_enforce_wallet_limit');
      const error = await pgError(
        client.query('UPDATE vendors SET wallet_balance_npr = -2500 WHERE id = $1', [vendorId]),
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
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE platform_settings SET vendor_wallet_suspension_limit_npr = -1500');
      await client.query(
        `INSERT INTO wallet_ledgers (vendor_id, entry_type, amount_npr) VALUES ($1, 'ADJUSTMENT', -100)`,
        [vendorId],
      );
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
        pool.query('UPDATE platform_settings SET vendor_wallet_suspension_limit_npr = $1', [limit]),
      );
      expect(error.constraint).toBe('platform_settings_wallet_limit_check');
    }
    const deleteError = await pgError(pool.query('DELETE FROM platform_settings'));
    expect(deleteError.message).toMatch(/cannot be deleted/);
  });

  it('applies every concurrent debit exactly once', async () => {
    const vendorId = await createVendor(pool);

    await Promise.all(
      Array.from({ length: 20 }, () =>
        pool.query(
          `INSERT INTO wallet_ledgers (vendor_id, entry_type, amount_npr) VALUES ($1, 'ADJUSTMENT', -10)`,
          [vendorId],
        ),
      ),
    );

    expect((await getVendorWallet(pool, vendorId)).wallet_balance_npr).toBe('-200.00');
  });

  describe('ledger idempotency and immutability', () => {
    it('rejects a duplicate entry of the same type for the same order without moving the balance', async () => {
      const vendorId = await createVendor(pool);
      const orderId = await codCommission(vendorId, 100);

      const duplicate = await pgError(postLedger(vendorId, 'COD_COMMISSION', -100, orderId));

      expect(duplicate.code).toBe('23505');
      expect(duplicate.constraint).toBe('wallet_ledgers_order_id_entry_type_key');
      expect((await getVendorWallet(pool, vendorId)).wallet_balance_npr).toBe('-100.00');
    });

    it('does not move the balance when ON CONFLICT DO NOTHING skips a duplicate', async () => {
      const vendorId = await createVendor(pool);
      const orderId = await codCommission(vendorId, 100);

      const { rowCount } = await pool.query(
        `INSERT INTO wallet_ledgers (vendor_id, order_id, entry_type, amount_npr)
         VALUES ($1, $2, 'COD_COMMISSION', -100)
         ON CONFLICT (order_id, entry_type) DO NOTHING`,
        [vendorId, orderId],
      );

      expect(rowCount).toBe(0);
      expect((await getVendorWallet(pool, vendorId)).wallet_balance_npr).toBe('-100.00');
    });

    it('rejects an entry whose order belongs to a different vendor', async () => {
      const vendorA = await createVendor(pool);
      const vendorB = await createVendor(pool);
      const orderOfA = await createOrder(pool, { vendorId: vendorA, customerId });

      const error = await pgError(postLedger(vendorB, 'COD_COMMISSION', -100, orderOfA));

      expect(error.constraint).toBe('wallet_ledgers_order_vendor_fk');
    });

    it('rejects debits recorded with the wrong sign', async () => {
      const vendorId = await createVendor(pool);
      const orderId = await createOrder(pool, { vendorId, customerId });

      const error = await pgError(postLedger(vendorId, 'COD_COMMISSION', 100, orderId));

      expect(error.constraint).toBe('wallet_ledgers_amount_sign_check');
    });

    it('is append-only', async () => {
      const vendorId = await createVendor(pool);
      await codCommission(vendorId, 100);

      const update = await pgError(
        pool.query('UPDATE wallet_ledgers SET amount_npr = -1 WHERE vendor_id = $1', [vendorId]),
      );
      const del = await pgError(
        pool.query('DELETE FROM wallet_ledgers WHERE vendor_id = $1', [vendorId]),
      );

      expect(update.message).toMatch(/append-only/);
      expect(del.message).toMatch(/append-only/);
    });
  });
});
