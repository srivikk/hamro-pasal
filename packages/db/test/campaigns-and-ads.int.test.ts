import { eq } from 'drizzle-orm';
import type { Pool, PoolClient } from 'pg';

import { createDatabase, type Database } from '../src/client';
import { adProducts, campaignOptIns, platformCampaigns } from '../src/schema';
import { resolveTestDatabaseUrl } from '../src/testing';
import { createTestPool, createUser, createVendor, firstRow, pgError } from './support/fixtures';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
/** What the hand-added triggers raise. */
const RULE_VIOLATION = '23000';

describe('migration 0024: campaigns, opt-ins and ad products', () => {
  let pool: Pool;
  let db: Database;
  let adminId: string;

  beforeAll(async () => {
    pool = createTestPool();
    db = createDatabase(process.env.TEST_DATABASE_URL ?? resolveTestDatabaseUrl());
    adminId = await createUser(pool, 'SUPER_ADMIN');
  });

  afterAll(async () => {
    await db.$client.end();
    await pool.end();
  });

  function insert(table: string, row: Record<string, unknown>, client: Pool | PoolClient = pool) {
    const names = Object.keys(row);
    return client.query<{ id: string }>(
      `INSERT INTO ${table} (${names.join(', ')})
       VALUES (${names.map((_, i) => `$${String(i + 1)}`).join(', ')}) RETURNING id`,
      Object.values(row),
    );
  }

  const campaign = (overrides: Record<string, unknown> = {}) =>
    insert('platform_campaigns', {
      name: 'Dashain 10%',
      kind: 'PERCENTAGE',
      value: 10,
      max_discount_npr: 200,
      min_cart_npr: 500,
      vendor_share_percent: 50,
      starts_at: '2026-10-10T00:00:00+05:45',
      ends_at: '2026-10-25T23:59:59+05:45',
      created_by_user_id: adminId,
      ...overrides,
    });

  const campaignId = async (overrides: Record<string, unknown> = {}) =>
    firstRow((await campaign(overrides)).rows).id;

  const setCampaign = (id: string, assignments: string) =>
    pool.query(`UPDATE platform_campaigns SET ${assignments} WHERE id = $1`, [id]);

  const campaignRow = async (id: string) =>
    firstRow(await db.select().from(platformCampaigns).where(eq(platformCampaigns.id, id)));

  const vendorUserId = async (vendorId: string) =>
    firstRow(
      (
        await pool.query<{ user_id: string }>('SELECT user_id FROM vendors WHERE id = $1', [
          vendorId,
        ])
      ).rows,
    ).user_id;

  const TERMS = { kind: 'PERCENTAGE', value: 10, vendor_share_percent: 50 };

  async function optIn(
    campaign_id: string,
    vendor_id: string,
    overrides: Record<string, unknown> = {},
    client: Pool | PoolClient = pool,
  ) {
    return insert(
      'campaign_opt_ins',
      {
        campaign_id,
        vendor_id,
        opt_in_terms_version: 1,
        terms_snapshot: JSON.stringify(TERMS),
        opted_in_by_user_id: await vendorUserId(vendor_id),
        ...overrides,
      },
      client,
    );
  }

  const optInRows = (id: string) =>
    db
      .select()
      .from(campaignOptIns)
      .where(eq(campaignOptIns.campaign_id, id))
      .orderBy(campaignOptIns.opted_in_at);

  describe('platform_campaigns', () => {
    it('stores a campaign at terms version 1', async () => {
      const row = await campaignRow(await campaignId());
      expect(row).toMatchObject({
        name: 'Dashain 10%',
        kind: 'PERCENTAGE',
        value: 10,
        max_discount_npr: 200,
        min_cart_npr: 500,
        vendor_share_percent: 50,
        terms_version: 1,
        is_active: true,
        created_by_user_id: adminId,
      });
      expect(row.starts_at.toISOString()).toBe('2026-10-09T18:15:00.000Z');
    });

    it('refuses rules that make no discount', async () => {
      for (const overrides of [
        { name: '  ' },
        { value: 0 },
        { value: 101 },
        { max_discount_npr: 0 },
        { kind: 'FLAT', value: 100 }, // a cap on a flat discount
        { min_cart_npr: -1 },
        { vendor_share_percent: -0.01 },
        { vendor_share_percent: 100.01 },
        { ends_at: '2026-10-10T00:00:00+05:45' },
      ]) {
        expect((await pgError(campaign(overrides))).code).toBe(CHECK_VIOLATION);
      }
      await expect(
        campaign({ kind: 'FLAT', value: 150, max_discount_npr: null, vendor_share_percent: 0 }),
      ).resolves.toBeDefined();
    });

    it('always starts at version 1', async () => {
      expect((await pgError(campaign({ terms_version: 2 }))).code).toBe(RULE_VIOLATION);
    });

    it.each([
      ['kind', `kind = 'FLAT', max_discount_npr = NULL`],
      ['value', 'value = 15'],
      ['cap', 'max_discount_npr = 300'],
      ['minimum cart', 'min_cart_npr = 800'],
      ['vendor share', 'vendor_share_percent = 40'],
      ['start date', `starts_at = starts_at + interval '1 day'`],
      ['end date', `ends_at = ends_at - interval '1 day'`],
    ])('lets the %s change only together with terms_version + 1', async (_term, assignment) => {
      const id = await campaignId();

      expect((await pgError(setCampaign(id, assignment))).code).toBe(RULE_VIOLATION);
      expect(
        (await pgError(setCampaign(id, `${assignment}, terms_version = terms_version + 2`))).code,
      ).toBe(RULE_VIOLATION);
      await setCampaign(id, `${assignment}, terms_version = terms_version + 1`);

      expect((await campaignRow(id)).terms_version).toBe(2);
    });

    it('keeps the version when only the name or the publication changes', async () => {
      const id = await campaignId();
      const before = await campaignRow(id);
      await pool.query('SELECT pg_sleep(0.02)');

      await setCampaign(id, `name = 'Dashain Dhamaka', is_active = false`);

      const after = await campaignRow(id);
      expect(after).toMatchObject({ name: 'Dashain Dhamaka', is_active: false, terms_version: 1 });
      expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
      // The version moves for no other reason.
      expect((await pgError(setCampaign(id, 'terms_version = 2'))).code).toBe(RULE_VIOLATION);
      expect((await pgError(setCampaign(id, `name = 'x', terms_version = 2`))).code).toBe(
        RULE_VIOLATION,
      );
    });
  });

  /** A user that is a vendor's account, not an admin. */
  async function vendorUserIdOfNew() {
    return vendorUserId(await createVendor(pool));
  }

  describe('campaign_opt_ins', () => {
    it('records the shop’s own consent with the terms as shown', async () => {
      const id = await campaignId();
      const vendorId = await createVendor(pool);

      await optIn(id, vendorId);

      const [row] = await optInRows(id);
      expect(row).toMatchObject({
        vendor_id: vendorId,
        opt_in_terms_version: 1,
        terms_snapshot: TERMS,
        status: 'ACTIVE',
        opted_in_by_user_id: await vendorUserId(vendorId),
        closed_at: null,
        closed_by_user_id: null,
      });
    });

    it('cannot be created by an admin, or by another shop’s account', async () => {
      const id = await campaignId();
      const vendorId = await createVendor(pool);
      const otherShopUser = await vendorUserIdOfNew();

      for (const userId of [adminId, otherShopUser]) {
        const error = await pgError(optIn(id, vendorId, { opted_in_by_user_id: userId }));
        expect(error.code).toBe(RULE_VIOLATION);
        expect(error.message).toContain('own account');
      }
      expect(await optInRows(id)).toEqual([]);
    });

    it('is refused for a terms version that is not the campaign’s current one', async () => {
      const id = await campaignId();
      const vendorId = await createVendor(pool);
      await setCampaign(id, 'value = 15, terms_version = 2');

      expect((await pgError(optIn(id, vendorId))).code).toBe(RULE_VIOLATION);
      expect((await pgError(optIn(id, vendorId, { opt_in_terms_version: 3 }))).code).toBe(
        RULE_VIOLATION,
      );
      await expect(optIn(id, vendorId, { opt_in_terms_version: 2 })).resolves.toBeDefined();
    });

    it('is created ACTIVE, once per campaign and shop', async () => {
      const id = await campaignId();
      const vendorId = await createVendor(pool);

      expect(
        (
          await pgError(
            optIn(id, vendorId, { status: 'VOIDED', closed_at: new Date().toISOString() }),
          )
        ).code,
      ).toBe(RULE_VIOLATION);
      await optIn(id, vendorId);
      expect((await pgError(optIn(id, vendorId))).code).toBe(UNIQUE_VIOLATION);
      // Another shop joins the same campaign; this shop joins another campaign.
      await expect(optIn(id, await createVendor(pool))).resolves.toBeDefined();
      await expect(optIn(await campaignId(), vendorId)).resolves.toBeDefined();
    });

    it('needs a campaign, a vendor and a JSON object of terms', async () => {
      const id = await campaignId();
      const vendorId = await createVendor(pool);
      const unknown = '11111111-1111-4111-8111-111111111111';

      expect((await pgError(optIn(unknown, vendorId))).code).toBe(FOREIGN_KEY_VIOLATION);
      expect(
        (await pgError(optIn(id, vendorId, { vendor_id: unknown, opted_in_by_user_id: adminId })))
          .code,
      ).toBe(FOREIGN_KEY_VIOLATION);
      expect((await pgError(optIn(id, vendorId, { terms_snapshot: '[1]' }))).code).toBe(
        CHECK_VIOLATION,
      );
    });

    it('is voided, with every other live opt-in, when a term changes', async () => {
      const id = await campaignId();
      const other = await campaignId();
      const [a, b, c] = [
        await createVendor(pool),
        await createVendor(pool),
        await createVendor(pool),
      ];
      await optIn(id, a);
      await optIn(id, b);
      await optIn(other, c);

      // Shortening the campaign by a day is a change of terms (decided 2026-10-07).
      await setCampaign(id, `ends_at = ends_at - interval '1 day', terms_version = 2`);

      const rows = await optInRows(id);
      expect(rows.map((row) => row.status)).toEqual(['VOIDED', 'VOIDED']);
      for (const row of rows) {
        expect(row.closed_at).toBeInstanceOf(Date);
        expect(row.closed_by_user_id).toBeNull();
      }
      expect((await optInRows(other)).map((row) => row.status)).toEqual(['ACTIVE']);
      // The shop joins again, under the new terms; the voided row stays as the record.
      await optIn(id, a, { opt_in_terms_version: 2 });
      expect((await optInRows(id)).map((row) => row.status).sort()).toEqual([
        'ACTIVE',
        'VOIDED',
        'VOIDED',
      ]);
    });

    it('survives a rename or an unpublish', async () => {
      const id = await campaignId();
      await optIn(id, await createVendor(pool));

      await setCampaign(id, `name = 'Renamed', is_active = false`);

      expect((await optInRows(id)).map((row) => row.status)).toEqual(['ACTIVE']);
    });

    it('rolls back with the terms change that voided it', async () => {
      const id = await campaignId();
      await optIn(id, await createVendor(pool));
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'UPDATE platform_campaigns SET value = 20, terms_version = 2 WHERE id = $1',
          [id],
        );
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      expect((await optInRows(id)).map((row) => row.status)).toEqual(['ACTIVE']);
      expect((await campaignRow(id)).terms_version).toBe(1);
    });

    it('never commits against terms that changed while it was being written', async () => {
      const id = await campaignId();
      const vendorId = await createVendor(pool);
      const userId = await vendorUserId(vendorId);
      const client = await pool.connect();
      try {
        // The opt-in is written but not committed: it holds the campaign row FOR SHARE.
        await client.query('BEGIN');
        await optIn(id, vendorId, { opted_in_by_user_id: userId }, client);
        const termsChange = setCampaign(id, 'value = 25, terms_version = 2');
        let finished = false;
        void termsChange.then(() => {
          finished = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(finished).toBe(false);
        await client.query('COMMIT');
        await termsChange;
      } finally {
        client.release();
      }

      // The change waited, then voided the opt-in it had not been able to see.
      expect((await optInRows(id)).map((row) => row.status)).toEqual(['VOIDED']);
    });

    it('can be opted out by the shop’s own account only, once', async () => {
      const id = await campaignId();
      const vendorId = await createVendor(pool);
      const userId = await vendorUserId(vendorId);
      const optInId = firstRow((await optIn(id, vendorId)).rows).id;
      const close = (closedBy: string | null, status = 'OPTED_OUT') =>
        pool.query(
          `UPDATE campaign_opt_ins SET status = $2, closed_at = now(), closed_by_user_id = $3
           WHERE id = $1`,
          [optInId, status, closedBy],
        );

      expect((await pgError(close(adminId))).code).toBe(RULE_VIOLATION);
      expect((await pgError(close(null))).code).toBe(RULE_VIOLATION);
      await close(userId);

      const [row] = await optInRows(id);
      expect(row).toMatchObject({ status: 'OPTED_OUT', closed_by_user_id: userId });
      // Final: not reopened, not re-closed.
      expect((await pgError(close(userId))).code).toBe(RULE_VIOLATION);
      expect(
        (
          await pgError(
            pool.query(
              `UPDATE campaign_opt_ins SET status = 'ACTIVE', closed_at = NULL,
                 closed_by_user_id = NULL WHERE id = $1`,
              [optInId],
            ),
          )
        ).code,
      ).toBe(RULE_VIOLATION);
      // Opting in again is a new row.
      await expect(optIn(id, vendorId)).resolves.toBeDefined();
    });

    it('keeps what was agreed: no column but the closing ones changes, and no row is deleted', async () => {
      const id = await campaignId();
      const vendorId = await createVendor(pool);
      const optInId = firstRow((await optIn(id, vendorId)).rows).id;

      for (const assignment of [
        `terms_snapshot = '{"value": 99}'`,
        'opt_in_terms_version = 2',
        `opted_in_at = now() - interval '1 day'`,
        `vendor_id = '${await createVendor(pool)}'`,
        `opted_in_by_user_id = '${adminId}'`,
      ]) {
        expect(
          (
            await pgError(
              pool.query(`UPDATE campaign_opt_ins SET ${assignment} WHERE id = $1`, [optInId]),
            )
          ).code,
        ).toBe(RULE_VIOLATION);
      }
      expect(
        (await pgError(pool.query('DELETE FROM campaign_opt_ins WHERE id = $1', [optInId]))).code,
      ).toBe(RULE_VIOLATION);
      // Its campaign and its shop cannot be deleted from under it.
      expect(
        (await pgError(pool.query('DELETE FROM platform_campaigns WHERE id = $1', [id]))).code,
      ).toBe(FOREIGN_KEY_VIOLATION);
      expect((await optInRows(id)).map((row) => row.terms_snapshot)).toEqual([TERMS]);
    });

    it('holds the status and its closing columns together', async () => {
      const id = await campaignId();
      const vendorId = await createVendor(pool);
      const optInId = firstRow((await optIn(id, vendorId)).rows).id;

      for (const assignment of [
        `status = 'VOIDED'`, // closed without a time
        'closed_at = now()', // a time on an ACTIVE row
        `status = 'VOIDED', closed_at = now(), closed_by_user_id = '${await vendorUserId(vendorId)}'`,
      ]) {
        expect(
          (
            await pgError(
              pool.query(`UPDATE campaign_opt_ins SET ${assignment} WHERE id = $1`, [optInId]),
            )
          ).code,
        ).toBe(CHECK_VIOLATION);
      }
    });
  });

  describe('ad_products', () => {
    const product = (overrides: Record<string, unknown> = {}) =>
      insert('ad_products', {
        name: 'Carousel Placement (7 days)',
        slot: 'CAROUSEL',
        billing_model: 'FLAT_RATE',
        price_npr: 5000,
        duration_days: 7,
        created_by_user_id: adminId,
        ...overrides,
      });

    const productRow = async (id: string) =>
      firstRow(await db.select().from(adProducts).where(eq(adProducts.id, id)));

    it('stores a price list entry, on sale by default, that names no vendor', async () => {
      const row = await productRow(firstRow((await product()).rows).id);
      expect(row).toMatchObject({
        name: 'Carousel Placement (7 days)',
        slot: 'CAROUSEL',
        billing_model: 'FLAT_RATE',
        price_npr: 5000,
        duration_days: 7,
        is_active: true,
        created_by_user_id: adminId,
      });
      expect(Object.keys(row)).not.toContain('vendor_id');
      await expect(
        product({ slot: 'FEED_LISTING', billing_model: 'PER_ORDER_PREMIUM', price_npr: 15 }),
      ).resolves.toBeDefined();
    });

    it('refuses an unknown placement or billing model, a free product and a bad duration', async () => {
      for (const overrides of [{ slot: 'SEARCH' }, { billing_model: 'PERCENT_PREMIUM' }]) {
        expect((await pgError(product(overrides))).code).toBe('22P02');
      }
      for (const overrides of [
        { name: ' ' },
        { price_npr: 0 },
        { price_npr: -1 },
        { duration_days: 0 },
        { duration_days: 91 },
      ]) {
        expect((await pgError(product(overrides))).code).toBe(CHECK_VIOLATION);
      }
    });

    it('never changes its placement, billing model, price or duration', async () => {
      const id = firstRow((await product()).rows).id;

      for (const assignment of [
        `slot = 'FEED_LISTING'`,
        `billing_model = 'PER_ORDER_PREMIUM'`,
        'price_npr = 4999.99',
        'duration_days = 30',
        `name = 'Cheaper', price_npr = 1`,
      ]) {
        const error = await pgError(
          pool.query(`UPDATE ad_products SET ${assignment} WHERE id = $1`, [id]),
        );
        expect(error.code).toBe(RULE_VIOLATION);
      }
      expect(await productRow(id)).toMatchObject({ slot: 'CAROUSEL', price_npr: 5000 });
    });

    it('can be renamed and taken off sale', async () => {
      const id = firstRow((await product()).rows).id;

      await pool.query(
        `UPDATE ad_products SET name = 'Carousel (retired price)', is_active = false WHERE id = $1`,
        [id],
      );

      expect(await productRow(id)).toMatchObject({
        name: 'Carousel (retired price)',
        is_active: false,
        price_npr: 5000,
      });
    });
  });
});
