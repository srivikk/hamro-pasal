import { randomInt, randomUUID } from 'node:crypto';

import {
  adProducts,
  adPurchases,
  auditLogs,
  createDatabase,
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  payoutRequests,
  users,
  vendorBankAccounts,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import { LedgerService, WalletService } from '@hamro-pasal/ledger';
import type { SettlementModel } from '@hamro-pasal/shared-types';
import { and, eq } from 'drizzle-orm';

import {
  payoutCutoff,
  payoutRunDate,
  SettlementPayoutRunService,
} from '../src/finance/settlement-payout-run';
import {
  createProcessors,
  createTimerHandlers,
  pendingImplementationHandlers,
} from '../src/queues/processors';

const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;

describe('payout cut-off (Nepal Time)', () => {
  it('is the first instant of the Monday of the run week, for the Tuesday 02:00 run', () => {
    // Tuesday 6 October 2026, 02:00 NPT = Monday 20:15 UTC. Its Monday starts Sunday 18:15 UTC.
    const cutoff = payoutCutoff(new Date('2026-10-05T20:15:00.000Z'));
    expect(cutoff.toISOString()).toBe('2026-10-04T18:15:00.000Z');
    expect(payoutRunDate(cutoff)).toBe('2026-10-05');
  });

  it('belongs to the Nepal week, not the UTC one', () => {
    // Sunday 23:59 NPT is still last week; one minute later the new week has begun.
    expect(payoutCutoff(new Date('2026-10-04T18:14:00.000Z')).toISOString()).toBe(
      '2026-09-27T18:15:00.000Z',
    );
    expect(payoutCutoff(new Date('2026-10-04T18:15:00.000Z')).toISOString()).toBe(
      '2026-10-04T18:15:00.000Z',
    );
    // A retry on Wednesday is the same run.
    expect(payoutRunDate(payoutCutoff(new Date('2026-10-07T03:00:00.000Z')))).toBe('2026-10-05');
  });
});

/**
 * Phase 29 on real PostgreSQL: the weekly SETTLEMENT_PAYOUT_RUN (SPEC core 5 "Payouts",
 * verification 22). The database is shared with the other suites, so every assertion is about
 * the shops this file created.
 */
describe('settlement payout run (real PostgreSQL)', () => {
  let db: Database;
  let run: SettlementPayoutRunService;
  let adminId: string;
  const now = new Date();
  const cutoff = payoutCutoff(now);
  const beforeCutoff = new Date(cutoff.getTime() - HOUR_MS);

  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL ?? '', { max: 10 });
    run = new SettlementPayoutRunService(db, new LedgerService(new WalletService()));
    adminId = await user('SUPER_ADMIN');
  });

  afterAll(async () => {
    await db.$client.end();
  });

  async function user(role: 'VENDOR' | 'SUPER_ADMIN'): Promise<string> {
    const phone = `+9779${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
    const [row] = await db.insert(users).values({ phone, role }).returning({ id: users.id });
    if (row === undefined) throw new Error('user not created');
    return row.id;
  }

  async function shop(
    options: { model?: SettlementModel; verified?: boolean; bank?: boolean } = {},
  ) {
    const userId = await user('VENDOR');
    const verified = options.verified ?? true;
    const [row] = await db
      .insert(vendors)
      .values({
        user_id: userId,
        business_name: 'Payout Pasal',
        phone: '+9779800000000',
        status: 'LIVE',
        pricing_model: 'COMMISSION',
        commission_rate: 0.1,
        delivery_scope: 'RADIUS_BOUND',
        fulfillment_mode: 'SELF_DELIVERY',
        radius_km: 5,
        municipality_palika_string: 'Kathmandu Metropolitan City',
        min_order_value: 0,
        location: { x: 85.3123, y: 27.7154 },
        settlement_model: options.model ?? 'PLATFORM_ESCROW',
        tax_id: '302118845',
        ...(verified ? { pan_verified_at: new Date(), pan_verified_by_user_id: adminId } : {}),
      })
      .returning({ id: vendors.id });
    if (row === undefined) throw new Error('vendor not created');
    if (options.bank ?? true) {
      await db.insert(vendorBankAccounts).values({
        vendor_id: row.id,
        bank_name: 'NIC Asia Bank',
        branch_name: 'Thamel',
        account_name: 'Payout Pasal',
        account_number: '0012345678909012',
        is_primary: true,
      });
    }
    return { vendorId: row.id, userId };
  }

  /**
   * A balanced journal moving `npr` into (or, negative, out of) the shop's wallet, stamped `at`.
   * Written by hand because LedgerService stamps every posting with the current time, and the
   * cut-off rule is about when a posting was made.
   */
  async function post(vendorId: string, npr: number, at: Date = new Date()): Promise<void> {
    await db.transaction(async (tx) => {
      const [wallet] = await tx
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(eq(ledgerAccounts.vendor_id, vendorId));
      const [revenue] = await tx
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(eq(ledgerAccounts.account_type, 'PLATFORM_REVENUE'));
      const [journal] = await tx
        .insert(ledgerTransactions)
        .values({ kind: 'ADJUSTMENT', idempotency_key: `seed:${randomUUID()}`, order_id: null })
        .returning({ id: ledgerTransactions.id });
      if (wallet === undefined || revenue === undefined || journal === undefined) {
        throw new Error('journal not seeded');
      }
      await tx.insert(ledgerEntries).values([
        { transaction_id: journal.id, account_id: wallet.id, amount_npr: npr, created_at: at },
        { transaction_id: journal.id, account_id: revenue.id, amount_npr: -npr, created_at: at },
      ]);
    });
  }

  const walletOf = async (vendorId: string) =>
    (
      await db
        .select({ balance: vendors.wallet_balance_npr })
        .from(vendors)
        .where(eq(vendors.id, vendorId))
    )[0]?.balance;

  const payoutsOf = (vendorId: string) =>
    db.select().from(payoutRequests).where(eq(payoutRequests.vendor_id, vendorId));

  const clearingBalance = async () =>
    (
      await db
        .select({ balance: ledgerAccounts.balance_npr })
        .from(ledgerAccounts)
        .where(eq(ledgerAccounts.account_type, 'PAYOUT_CLEARING'))
    )[0]?.balance ?? 0;

  it('pays a verified Model B shop: wallet debited, an APPROVED row in PROCESSING_BANK_TRANSFER, audited by the job', async () => {
    const owner = await shop();
    await post(owner.vendorId, 5000, beforeCutoff);
    const clearingBefore = await clearingBalance();

    const summary = await run.run(now);

    const mine = summary.paid.filter((payout) => payout.vendorId === owner.vendorId);
    expect(mine).toEqual([
      { vendorId: owner.vendorId, payoutId: expect.any(String) as string, amountNpr: 5000 },
    ]);
    expect(await walletOf(owner.vendorId)).toBe(0);
    expect((await clearingBalance()) - clearingBefore).toBeGreaterThanOrEqual(5000);

    const [payout, ...others] = await payoutsOf(owner.vendorId);
    expect(others).toHaveLength(0);
    expect(payout).toMatchObject({
      id: mine[0]?.payoutId,
      amount_npr: 5000,
      status: 'APPROVED',
      transfer_state: 'PROCESSING_BANK_TRANSFER',
      system_actor: 'SETTLEMENT_PAYOUT_RUN',
      decided_by_user_id: null,
      bank_reference: null,
      idempotency_key: `settlement-run:${payoutRunDate(cutoff)}`,
    });
    expect(payout?.decided_at).toBeInstanceOf(Date);

    // The journal is the Phase 22 payout: two postings, wallet to PAYOUT_CLEARING.
    const postings = await db
      .select({ amount: ledgerEntries.amount_npr, type: ledgerAccounts.account_type })
      .from(ledgerEntries)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.account_id))
      .where(eq(ledgerEntries.transaction_id, payout?.hold_transaction_id ?? ''));
    expect(postings.sort((a, b) => a.amount - b.amount)).toEqual([
      { amount: -5000, type: 'VENDOR_WALLET' },
      { amount: 5000, type: 'PAYOUT_CLEARING' },
    ]);

    const [entry, ...rest] = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.vendor_id, owner.vendorId), eq(auditLogs.action, 'PAYOUT_PROCESSED')),
      );
    expect(rest).toHaveLength(0);
    expect(entry).toMatchObject({
      actor_user_id: null,
      actor_role: null,
      system_actor: 'SETTLEMENT_PAYOUT_RUN',
      entity_type: 'vendor_ledger',
      entity_id: owner.vendorId,
    });
    expect(entry?.before_state).toMatchObject({ wallet_balance_npr: 5000 });
    expect(entry?.after_state).toMatchObject({
      wallet_balance_npr: 0,
      cutoff_at: cutoff.toISOString(),
      payout: {
        id: payout?.id,
        amount_npr: 5000,
        transfer_state: 'PROCESSING_BANK_TRANSFER',
        bank_account: { bank_name: 'NIC Asia Bank', account_number_masked: '****9012' },
      },
    });
    // The full account number never reaches the trail.
    expect(JSON.stringify(entry?.after_state)).not.toContain('0012345678909012');
  });

  it('leaves money credited after the cut-off for the next run', async () => {
    const owner = await shop();
    await post(owner.vendorId, 3000, beforeCutoff);
    await post(owner.vendorId, 2000); // credited "on Monday": after the cut-off

    await run.run(now);
    expect((await payoutsOf(owner.vendorId)).map((p) => p.amount_npr)).toEqual([3000]);
    expect(await walletOf(owner.vendorId)).toBe(2000);

    // Next Tuesday it is before that run's cut-off.
    await run.run(new Date(now.getTime() + WEEK_MS));
    expect((await payoutsOf(owner.vendorId)).map((p) => p.amount_npr).sort()).toEqual([2000, 3000]);
    expect(await walletOf(owner.vendorId)).toBe(0);
  });

  it('pays less by every debit made after the cut-off, whatever was credited since', async () => {
    const owner = await shop();
    await post(owner.vendorId, 3000, beforeCutoff);
    await post(owner.vendorId, -500); // a cash order's commission, after the cut-off
    await post(owner.vendorId, 800); // and a new credit, which waits

    await run.run(now);

    expect((await payoutsOf(owner.vendorId)).map((p) => p.amount_npr)).toEqual([2500]);
    expect(await walletOf(owner.vendorId)).toBe(800);
  });

  it('never pays more than the wallet holds now', async () => {
    const owner = await shop();
    await post(owner.vendorId, 4000, beforeCutoff);
    await post(owner.vendorId, -2500);

    await run.run(now);

    expect((await payoutsOf(owner.vendorId)).map((p) => p.amount_npr)).toEqual([1500]);
    expect(await walletOf(owner.vendorId)).toBe(0);
  });

  it('pays exactly 1000 NPR and carries 999.99 NPR over', async () => {
    const atMinimum = await shop();
    const under = await shop();
    const underAtCutoff = await shop();
    await post(atMinimum.vendorId, 1000, beforeCutoff);
    await post(under.vendorId, 999.99, beforeCutoff);
    // 1500 in the wallet, but only 900 of it was there at the cut-off.
    await post(underAtCutoff.vendorId, 900, beforeCutoff);
    await post(underAtCutoff.vendorId, 600);

    const summary = await run.run(now);

    expect((await payoutsOf(atMinimum.vendorId)).map((p) => p.amount_npr)).toEqual([1000]);
    expect(await payoutsOf(under.vendorId)).toHaveLength(0);
    expect(await walletOf(under.vendorId)).toBe(999.99);
    expect(await payoutsOf(underAtCutoff.vendorId)).toHaveLength(0);
    expect(await walletOf(underAtCutoff.vendorId)).toBe(1500);
    expect(summary.skipped.BELOW_MINIMUM).toBeGreaterThanOrEqual(1);
  });

  it('skips an unverified PAN, a shop without a primary bank account and every other model', async () => {
    const unverified = await shop({ verified: false });
    const noBank = await shop({ bank: false });
    const modelA = await shop({ model: 'COD_CREDIT' });
    for (const owner of [unverified, noBank, modelA]) {
      await post(owner.vendorId, 5000, beforeCutoff);
    }

    const summary = await run.run(now);

    for (const owner of [unverified, noBank, modelA]) {
      expect(await payoutsOf(owner.vendorId)).toHaveLength(0);
      expect(await walletOf(owner.vendorId)).toBe(5000);
    }
    expect(summary.skipped.NO_PRIMARY_BANK_ACCOUNT).toBeGreaterThanOrEqual(1);
    expect(
      await db
        .select()
        .from(auditLogs)
        .where(
          and(eq(auditLogs.vendor_id, noBank.vendorId), eq(auditLogs.action, 'PAYOUT_PROCESSED')),
        ),
    ).toHaveLength(0);
  });

  it('never pays on a PAN verification that was cleared first (the gate is read under the row lock)', async () => {
    const owner = await shop();
    await post(owner.vendorId, 5000, beforeCutoff);
    let racing: ReturnType<SettlementPayoutRunService['run']> | undefined;

    // A PAN change: the vendor row FOR UPDATE, the verification cleared, then the commit.
    await db.transaction(async (tx) => {
      await tx.select().from(vendors).where(eq(vendors.id, owner.vendorId)).for('update');
      await tx
        .update(vendors)
        .set({ tax_id: '609987712', pan_verified_at: null, pan_verified_by_user_id: null })
        .where(eq(vendors.id, owner.vendorId));
      // The run still sees the shop as verified, and must wait for this transaction.
      racing = run.run(now);
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    const summary = await racing;

    expect(summary?.paid.some((payout) => payout.vendorId === owner.vendorId)).toBe(false);
    expect(summary?.skipped.NOT_ELIGIBLE).toBeGreaterThanOrEqual(1);
    expect(await payoutsOf(owner.vendorId)).toHaveLength(0);
    expect(await walletOf(owner.vendorId)).toBe(5000);
  });

  it('pays each vendor once when the run is repeated or started several times at once', async () => {
    const owners = [await shop(), await shop(), await shop()];
    for (const owner of owners) await post(owner.vendorId, 2400, beforeCutoff);

    const runs = await Promise.all([run.run(now), run.run(now), run.run(now), run.run(now)]);
    const again = await run.run(now);

    for (const owner of owners) {
      expect((await payoutsOf(owner.vendorId)).map((p) => p.amount_npr)).toEqual([2400]);
      expect(await walletOf(owner.vendorId)).toBe(0);
      const winners = runs.filter((summary) =>
        summary.paid.some((payout) => payout.vendorId === owner.vendorId),
      );
      expect(winners).toHaveLength(1);
      expect(again.paid.some((payout) => payout.vendorId === owner.vendorId)).toBe(false);
    }
  });

  it('takes the flat ad fees a shop owes out of the wallet before paying the rest', async () => {
    const owner = await shop();
    await post(owner.vendorId, 3000, beforeCutoff);
    const [product] = await db
      .insert(adProducts)
      .values({
        name: `Ad ${randomUUID()}`,
        slot: 'CAROUSEL',
        billing_model: 'FLAT_RATE',
        price_npr: 800,
        duration_days: 7,
        created_by_user_id: adminId,
      })
      .returning();
    if (product === undefined) throw new Error('product not created');
    const [ad] = await db
      .insert(adPurchases)
      .values({
        vendor_id: owner.vendorId,
        ad_product_id: product.id,
        billing_model: 'FLAT_RATE',
        price_npr: 800,
        budget_npr: null,
        settlement_model: 'PLATFORM_ESCROW',
        starts_at: new Date(Date.now() - HOUR_MS),
        ends_at: new Date(Date.now() + 24 * HOUR_MS),
        agreed_by_user_id: owner.userId,
        idempotency_key: randomUUID(),
      })
      .returning();
    if (ad === undefined) throw new Error('purchase not created');

    await run.run(now);

    expect((await payoutsOf(owner.vendorId)).map((p) => p.amount_npr)).toEqual([2200]);
    expect(await walletOf(owner.vendorId)).toBe(0);
    const [paid] = await db.select().from(adPurchases).where(eq(adPurchases.id, ad.id));
    expect(paid?.amount_paid_npr).toBe(800);
    const [entry] = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.vendor_id, owner.vendorId), eq(auditLogs.action, 'PAYOUT_PROCESSED')),
      );
    expect(entry?.after_state).toMatchObject({ ad_fees_collected_npr: 800 });
  });

  it('the database refuses a processing payout without its job, and a job together with an admin', async () => {
    const owner = await shop();
    await post(owner.vendorId, 1200, beforeCutoff);
    await run.run(now);
    const [payout] = await payoutsOf(owner.vendorId);
    if (payout === undefined) throw new Error('payout missing');
    const refused = (values: Partial<typeof payoutRequests.$inferInsert>) =>
      db
        .insert(payoutRequests)
        .values({
          vendor_id: owner.vendorId,
          amount_npr: 100,
          status: 'APPROVED',
          idempotency_key: randomUUID(),
          hold_transaction_id: randomUUID(),
          decided_at: new Date(),
          ...values,
        })
        .then(
          () => 'stored',
          (error: unknown) => String((error as { cause?: unknown }).cause ?? error),
        );

    expect(await refused({ transfer_state: 'PROCESSING_BANK_TRANSFER' })).toContain(
      'payout_requests_status_check',
    );
    expect(
      await refused({
        transfer_state: 'PROCESSING_BANK_TRANSFER',
        system_actor: 'SETTLEMENT_PAYOUT_RUN',
        decided_by_user_id: adminId,
      }),
    ).toContain('payout_requests_status_check');
    // No bank reference and no transfer state: the transfer is unaccounted for.
    expect(await refused({ system_actor: 'SETTLEMENT_PAYOUT_RUN' })).toContain(
      'payout_requests_status_check',
    );
    expect(
      await refused({
        system_actor: 'SETTLEMENT_PAYOUT_RUN',
        decided_by_user_id: adminId,
        bank_reference: 'NIC-1',
        transfer_state: 'SENT' as never,
      }),
    ).toContain('payout_requests_transfer_state_check');
  });

  it('runs as its own task of the maintenance queue, never as a midnight task', async () => {
    const owner = await shop();
    await post(owner.vendorId, 1800, beforeCutoff);
    const runMidnightTask = jest.fn(() => Promise.resolve());
    const processors = createProcessors({
      ...createTimerHandlers({
        escalation: { escalateIfUnanswered: () => Promise.resolve('NOT_PENDING') },
        debtReconciliation: { suspendIndebtedVendors: () => Promise.resolve([]) },
        orderReconciliation: {
          reconcileDeliveredOrders: () => Promise.reject(new Error('not this task')),
        },
        settlementPayoutRun: run,
      }),
      runMidnightTask,
    });
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);

    await processors.midnight({ data: { task: 'SETTLEMENT_PAYOUT_RUN' } } as never);

    expect((await payoutsOf(owner.vendorId)).map((p) => p.amount_npr)).toEqual([1800]);
    expect(runMidnightTask).not.toHaveBeenCalled();
    expect(info.mock.calls.flat().join(' ')).toContain('settlement payout run');
    info.mockRestore();

    // A worker built without the service logs the task instead of failing it.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(pendingImplementationHandlers.runSettlementPayoutRun()).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
