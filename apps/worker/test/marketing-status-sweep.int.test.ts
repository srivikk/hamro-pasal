import { randomInt, randomUUID } from 'node:crypto';

import {
  adProducts,
  adPurchases,
  auditLogs,
  createDatabase,
  users,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import { LedgerService, WalletService } from '@hamro-pasal/ledger';
import type { AdPurchaseStatus, AuditAction, SettlementModel } from '@hamro-pasal/shared-types';
import { and, eq } from 'drizzle-orm';

import { MarketingStatusSweepService } from '../src/marketing/marketing-status-sweep';
import {
  createProcessors,
  createTimerHandlers,
  pendingImplementationHandlers,
} from '../src/queues/processors';

const DAY_MS = 86_400_000;

/**
 * Phase 28 on real PostgreSQL: the hourly MARKETING_STATUS_SWEEP (SPEC core 8, edge case 8). It
 * audits with the job as the actor.
 */
describe('marketing status sweep (real PostgreSQL)', () => {
  let db: Database;
  let sweep: MarketingStatusSweepService;
  let adminId: string;
  const ledger = new LedgerService(new WalletService());

  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL ?? '', { max: 10 });
    sweep = new MarketingStatusSweepService(db, ledger);
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

  async function shop(model: SettlementModel = 'PLATFORM_ESCROW') {
    const userId = await user('VENDOR');
    const [row] = await db
      .insert(vendors)
      .values({
        user_id: userId,
        business_name: 'Test Pasal',
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
        settlement_model: model,
      })
      .returning({ id: vendors.id });
    if (row === undefined) throw new Error('vendor not created');
    return { vendorId: row.id, userId };
  }

  /** A purchase as the API would have stored it; `endsInDays` negative means its period is over. */
  async function purchase(
    owner: { vendorId: string; userId: string },
    options: {
      endsInDays: number;
      status?: AdPurchaseStatus;
      perOrder?: { budget: number; paid?: number };
      model?: SettlementModel;
    },
  ) {
    const perOrder = options.perOrder;
    const [product] = await db
      .insert(adProducts)
      .values({
        name: `Ad ${randomUUID()}`,
        slot: perOrder === undefined ? 'CAROUSEL' : 'FEED_LISTING',
        billing_model: perOrder === undefined ? 'FLAT_RATE' : 'PER_ORDER_PREMIUM',
        price_npr: perOrder === undefined ? 1000 : 25,
        duration_days: 7,
        created_by_user_id: adminId,
      })
      .returning();
    if (product === undefined) throw new Error('product not created');
    const endsAt = new Date(Date.now() + options.endsInDays * DAY_MS);
    const [row] = await db
      .insert(adPurchases)
      .values({
        vendor_id: owner.vendorId,
        ad_product_id: product.id,
        billing_model: product.billing_model,
        price_npr: product.price_npr,
        budget_npr: perOrder?.budget ?? null,
        settlement_model: options.model ?? 'PLATFORM_ESCROW',
        status: options.status ?? 'ACTIVE',
        starts_at: new Date(endsAt.getTime() - 7 * DAY_MS),
        ends_at: endsAt,
        amount_paid_npr: perOrder?.paid ?? 0,
        agreed_by_user_id: owner.userId,
        idempotency_key: randomUUID(),
      })
      .returning();
    if (row === undefined) throw new Error('purchase not created');
    return row;
  }

  /** What the API posts when a Model A shop buys a per-order ad: wallet funded, budget held. */
  async function holdBudget(vendorId: string, purchaseId: string, budgetNpr: number) {
    const paisa = budgetNpr * 100;
    const wallet = { type: 'VENDOR_WALLET', vendorId } as const;
    await db.transaction(async (tx) => {
      await ledger.post(tx, {
        kind: 'ADJUSTMENT',
        idempotencyKey: `seed:${randomUUID()}`,
        orderId: null,
        postings: [
          { account: wallet, amountPaisa: paisa },
          { account: { type: 'PLATFORM_REVENUE' }, amountPaisa: -paisa },
        ],
      });
      const line = { lineType: 'AD_BUDGET_HOLD', adPurchaseId: purchaseId } as const;
      await ledger.post(tx, {
        kind: 'AD_PURCHASE',
        idempotencyKey: `ad-budget-hold:${purchaseId}`,
        orderId: null,
        postings: [
          { account: wallet, amountPaisa: -paisa, ...line },
          { account: { type: 'AD_BUDGET_CLEARING' }, amountPaisa: paisa, ...line },
        ],
      });
    });
  }

  const statusOf = async (purchaseId: string) =>
    (await db.select().from(adPurchases).where(eq(adPurchases.id, purchaseId)))[0]?.status;

  const walletOf = async (vendorId: string) =>
    (
      await db
        .select({ balance: vendors.wallet_balance_npr })
        .from(vendors)
        .where(eq(vendors.id, vendorId))
    )[0]?.balance;

  const entries = (purchaseId: string, action: AuditAction) =>
    db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entity_id, purchaseId), eq(auditLogs.action, action)));

  it('ends a purchase whose period is over, with the job as the actor, and no other', async () => {
    const owner = await shop();
    const over = await purchase(owner, { endsInDays: -1 });
    const pausedOver = await purchase(owner, { endsInDays: -1, status: 'PAUSED' });
    const running = await purchase(owner, { endsInDays: 3 });
    const cancelled = await purchase(owner, { endsInDays: -1, status: 'CANCELLED' });

    const summary = await sweep.run();

    expect(summary.ended).toBeGreaterThanOrEqual(2);
    expect(await statusOf(over.id)).toBe('ENDED');
    expect(await statusOf(pausedOver.id)).toBe('ENDED');
    expect(await statusOf(running.id)).toBe('ACTIVE');
    expect(await statusOf(cancelled.id)).toBe('CANCELLED');

    const [entry, ...rest] = await entries(over.id, 'AD_ENDED');
    expect(rest).toHaveLength(0);
    expect(entry).toMatchObject({
      actor_user_id: null,
      actor_role: null,
      system_actor: 'MARKETING_STATUS_SWEEP',
      vendor_id: owner.vendorId,
      entity_type: 'ad_purchase',
    });
    expect(entry?.before_state).toMatchObject({ status: 'ACTIVE' });
    expect(entry?.after_state).toMatchObject({ status: 'ENDED', returned_npr: 0 });
    expect(await entries(running.id, 'AD_ENDED')).toHaveLength(0);
    expect(await entries(cancelled.id, 'AD_ENDED')).toHaveLength(0);
  });

  it('returns the unused part of a held budget when the ad ends', async () => {
    const owner = await shop('COD_CREDIT');
    const ad = await purchase(owner, {
      endsInDays: -1,
      model: 'COD_CREDIT',
      perOrder: { budget: 300, paid: 75 },
    });
    await holdBudget(owner.vendorId, ad.id, 300);
    expect(await walletOf(owner.vendorId)).toBe(0);

    const summary = await sweep.run();

    expect(summary.budgetReleasedNpr).toBeGreaterThanOrEqual(225);
    expect(await statusOf(ad.id)).toBe('ENDED');
    expect(await walletOf(owner.vendorId)).toBe(225);
    const [entry] = await entries(ad.id, 'AD_ENDED');
    expect(entry?.after_state).toMatchObject({ returned_npr: 225 });
  });

  it('changes a purchase once under a rerun and four concurrent runs', async () => {
    const owner = await shop('COD_CREDIT');
    const ad = await purchase(owner, {
      endsInDays: -1,
      model: 'COD_CREDIT',
      perOrder: { budget: 200 },
    });
    await holdBudget(owner.vendorId, ad.id, 200);

    await Promise.all([sweep.run(), sweep.run(), sweep.run(), sweep.run()]);
    await sweep.run();

    expect(await statusOf(ad.id)).toBe('ENDED');
    expect(await entries(ad.id, 'AD_ENDED')).toHaveLength(1);
    expect(await walletOf(owner.vendorId)).toBe(200);
  });

  it('pauses a per-order ad whose budget cannot cover one more fee, and not one that can', async () => {
    const owner = await shop();
    const exhausted = await purchase(owner, { endsInDays: 3, perOrder: { budget: 100, paid: 80 } });
    const funded = await purchase(owner, { endsInDays: 3, perOrder: { budget: 100, paid: 75 } });
    const flat = await purchase(owner, { endsInDays: 3 });

    const summary = await sweep.run();
    await sweep.run();

    expect(summary.paused).toBeGreaterThanOrEqual(1);
    expect(await statusOf(exhausted.id)).toBe('PAUSED');
    expect(await statusOf(funded.id)).toBe('ACTIVE');
    expect(await statusOf(flat.id)).toBe('ACTIVE');
    const [entry, ...rest] = await entries(exhausted.id, 'AD_PAUSED_BUDGET_EXHAUSTED');
    expect(rest).toHaveLength(0);
    expect(entry).toMatchObject({ system_actor: 'MARKETING_STATUS_SWEEP', actor_user_id: null });
  });

  it('runs as the hourly task of the maintenance queue, and never as a midnight task', async () => {
    const owner = await shop();
    const over = await purchase(owner, { endsInDays: -1 });
    const runMidnightTask = jest.fn(() => Promise.resolve());
    const processors = createProcessors({
      ...createTimerHandlers({
        escalation: { escalateIfUnanswered: () => Promise.resolve('NOT_PENDING') },
        debtReconciliation: { suspendIndebtedVendors: () => Promise.resolve([]) },
        orderReconciliation: {
          reconcileDeliveredOrders: () => Promise.reject(new Error('not this task')),
        },
        marketingSweep: sweep,
      }),
      runMidnightTask,
    });
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);

    await processors.midnight({ data: { task: 'MARKETING_STATUS_SWEEP' } } as never);

    expect(await statusOf(over.id)).toBe('ENDED');
    expect(runMidnightTask).not.toHaveBeenCalled();
    expect(info.mock.calls.flat().join(' ')).toContain('marketing sweep');
    info.mockRestore();

    // A worker built without the service logs the task instead of failing it.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(pendingImplementationHandlers.runMarketingStatusSweep()).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
