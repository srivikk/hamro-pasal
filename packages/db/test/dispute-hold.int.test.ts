import type { Pool } from 'pg';

import {
  createOrder,
  createTestPool,
  createUser,
  createVendor,
  firstRow,
  pgError,
  postJournal,
  systemAccountId,
} from './support/fixtures';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const INTEGRITY_VIOLATION = '23000';

/** Migration 0042 (step 7.3, SPEC core 6): the dispute hold account and the conversation row. */
describe('migration 0042: dispute hold and order conversations', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createTestPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function holdAccount(vendorId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO ledger_accounts (account_type, hold_vendor_id)
       VALUES ('VENDOR_DISPUTE_HOLD', $1) RETURNING id`,
      [vendorId],
    );
    return firstRow(rows).id;
  }

  describe('VENDOR_DISPUTE_HOLD', () => {
    it('is owned through hold_vendor_id only, once per vendor, and its owner is immutable', async () => {
      const vendorId = await createVendor(pool);
      const id = await holdAccount(vendorId);

      expect((await pgError(holdAccount(vendorId))).code).toBe(UNIQUE_VIOLATION);
      expect(
        (
          await pgError(
            pool.query(
              `INSERT INTO ledger_accounts (account_type, vendor_id) VALUES ('VENDOR_DISPUTE_HOLD', $1)`,
              [await createVendor(pool)],
            ),
          )
        ).code,
      ).toBe(CHECK_VIOLATION);
      expect(
        (
          await pgError(
            pool.query(
              `INSERT INTO ledger_accounts (account_type, hold_vendor_id) VALUES ('VENDOR_WALLET', $1)`,
              [await createVendor(pool)],
            ),
          )
        ).code,
      ).toBe(CHECK_VIOLATION);
      expect(
        (
          await pgError(
            pool.query('UPDATE ledger_accounts SET hold_vendor_id = $2 WHERE id = $1', [
              id,
              await createVendor(pool),
            ]),
          )
        ).code,
      ).toBe(INTEGRITY_VIOLATION);
    });

    it('is never overdrawn', async () => {
      const hold = await holdAccount(await createVendor(pool));
      const escrow = await systemAccountId(pool, 'SYSTEM_ESCROW');
      const revenue = await systemAccountId(pool, 'PLATFORM_REVENUE');
      // Fund escrow so only the hold's own floor can refuse the journal.
      await postJournal(pool, [
        { accountId: escrow, amountNpr: 100 },
        { accountId: revenue, amountNpr: -100 },
      ]);

      await postJournal(pool, [
        { accountId: hold, amountNpr: 50 },
        { accountId: escrow, amountNpr: -50 },
      ]);
      expect(
        (
          await pgError(
            postJournal(pool, [
              { accountId: hold, amountNpr: -60 },
              { accountId: revenue, amountNpr: 60 },
            ]),
          )
        ).code,
      ).toBe(CHECK_VIOLATION);
    });
  });

  describe('disputes', () => {
    async function conversation() {
      const vendorId = await createVendor(pool);
      const customerId = await createUser(pool);
      const orderId = await createOrder(pool, { vendorId, customerId });
      return { orderId, customerId };
    }

    it('opens without a reason, and a system row has no opener', async () => {
      const a = await conversation();
      await pool.query('INSERT INTO disputes (order_id, opened_by_user_id) VALUES ($1, $2)', [
        a.orderId,
        a.customerId,
      ]);
      const b = await conversation();
      await pool.query(
        `INSERT INTO disputes (order_id, status, resolved_at) VALUES ($1, 'CLOSED', now())`,
        [b.orderId],
      );
    });

    it('needs who, when and a 10–500 character reason to be ESCALATED', async () => {
      const { orderId, customerId } = await conversation();
      const escalate = (reason: string | null, at: string | null) =>
        pool.query(
          `INSERT INTO disputes (order_id, opened_by_user_id, status, escalated_at,
                                 escalated_by_user_id, escalation_reason)
           VALUES ($1, $2, 'ESCALATED', $3, $2, $4)`,
          [orderId, customerId, at, reason],
        );

      expect((await pgError(escalate('Short', new Date().toISOString()))).code).toBe(
        CHECK_VIOLATION,
      );
      expect((await pgError(escalate(null, null))).code).toBe(CHECK_VIOLATION);
      await escalate('The jar arrived broken.', new Date().toISOString());
    });

    it('records a resolution with its resolver, note and refund, after an escalation only', async () => {
      const { orderId, customerId } = await conversation();
      const admin = await createUser(pool, 'SUPER_ADMIN');
      // Resolved without an escalation: refused.
      expect(
        (
          await pgError(
            pool.query(
              `INSERT INTO disputes (order_id, opened_by_user_id, status, resolved_by_user_id,
                                     resolved_at, resolution_note, refund_npr)
               VALUES ($1, $2, 'RELEASED_TO_VENDOR', $3, now(), 'Looked fine.', 0)`,
              [orderId, customerId, admin],
            ),
          )
        ).code,
      ).toBe(CHECK_VIOLATION);

      await pool.query(
        `INSERT INTO disputes (order_id, opened_by_user_id, status, escalated_at,
                               escalated_by_user_id, escalation_reason)
         VALUES ($1, $2, 'ESCALATED', now(), $2, 'The jar arrived broken.')`,
        [orderId, customerId],
      );
      // A resolution without a note is refused; with one it is kept.
      expect(
        (
          await pgError(
            pool.query(
              `UPDATE disputes SET status = 'PARTIALLY_REFUNDED', resolved_by_user_id = $2,
                      resolved_at = now(), refund_npr = 300 WHERE order_id = $1`,
              [orderId, admin],
            ),
          )
        ).code,
      ).toBe(CHECK_VIOLATION);
      await pool.query(
        `UPDATE disputes SET status = 'PARTIALLY_REFUNDED', resolved_by_user_id = $2,
                resolved_at = now(), refund_npr = 300, resolution_note = 'One item missing.'
          WHERE order_id = $1`,
        [orderId, admin],
      );
    });
  });
});
