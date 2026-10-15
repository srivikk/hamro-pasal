import { randomInt, randomUUID } from 'node:crypto';

import {
  createDatabase,
  disputes,
  ledgerAccounts,
  orders,
  users,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import {
  disputeReleaseKey,
  LedgerService,
  SettlementService,
  WalletService,
} from '@hamro-pasal/ledger';
import { and, eq, sql } from 'drizzle-orm';

import { DisputeHoldReleaseService } from '../src/finance/dispute-hold-release';

const HOUR_MS = 3_600_000;

/**
 * Step 7.3 (SPEC core 6, verification 25, edge case 19): the hourly day-8 release of a prepaid
 * order's held earnings, against real PostgreSQL.
 */
describe('day-8 dispute hold release (real PostgreSQL)', () => {
  let db: Database;
  let ledger: LedgerService;
  let settlement: SettlementService;
  let release: DisputeHoldReleaseService;

  beforeAll(() => {
    db = createDatabase(process.env.TEST_DATABASE_URL ?? '', { max: 10 });
    ledger = new LedgerService(new WalletService());
    settlement = new SettlementService(db, ledger);
    release = new DisputeHoldReleaseService(db, ledger);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  async function user(role: 'CUSTOMER' | 'VENDOR'): Promise<string> {
    const phone = `+9779${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
    const [row] = await db.insert(users).values({ phone, role }).returning({ id: users.id });
    if (row === undefined) throw new Error('user not created');
    return row.id;
  }

  async function vendor(): Promise<string> {
    const [row] = await db
      .insert(vendors)
      .values({
        user_id: await user('VENDOR'),
        business_name: 'Thamel Kirana Pasal',
        phone: '+9779800000011',
        status: 'LIVE',
        pricing_model: 'COMMISSION',
        commission_rate: 0.1,
        delivery_scope: 'RADIUS_BOUND',
        fulfillment_mode: 'SELF_DELIVERY',
        radius_km: 5,
        municipality_palika_string: 'Kathmandu Metropolitan City',
        min_order_value: 0,
        base_delivery_fee_npr: 50,
        location: { x: 85.3123, y: 27.7154 },
      })
      .returning({ id: vendors.id });
    if (row === undefined) throw new Error('vendor not created');
    return row.id;
  }

  /** A prepaid order (1000 + 50, 100 commission) captured, delivered and settled `hoursAgo` ago. */
  async function deliveredPrepaid(hoursAgo: number, vendorId?: string) {
    const shop = vendorId ?? (await vendor());
    const [order] = await db
      .insert(orders)
      .values({
        idempotency_key: randomUUID(),
        customer_id: await user('CUSTOMER'),
        vendor_id: shop,
        subtotal: 1000,
        delivery_fee: 50,
        platform_commission_amount: 100,
        fulfillment_locked: 'SELF_DELIVERY',
        payment_method: 'ESEWA',
        state: 'PLACED',
        placed_at: new Date(Date.now() - (hoursAgo + 1) * HOUR_MS),
        delivery_otp: '$2b$10$abcdefghijklmnopqrstuuM3bJ0n9ZkZ2p9Y5o0t7m6c1QwV8e2yG',
      })
      .returning();
    if (order === undefined) throw new Error('order not created');
    await settlement.capturePayment(order.id);
    await db
      .update(orders)
      .set({ state: 'DELIVERED', delivered_at: new Date(Date.now() - hoursAgo * HOUR_MS) })
      .where(eq(orders.id, order.id));
    await settlement.settleOrder(order.id);
    return { orderId: order.id, vendorId: shop, customerId: order.customer_id };
  }

  async function balances(vendorId: string) {
    const rows = await db
      .select({ type: ledgerAccounts.account_type, balance: ledgerAccounts.balance_npr })
      .from(ledgerAccounts)
      .where(
        sql`${ledgerAccounts.vendor_id} = ${vendorId} OR ${ledgerAccounts.hold_vendor_id} = ${vendorId}`,
      );
    const of = (type: string) => rows.find((row) => row.type === type)?.balance ?? 0;
    return { wallet: of('VENDOR_WALLET'), hold: of('VENDOR_DISPUTE_HOLD') };
  }

  const conversationOf = async (orderId: string) =>
    (await db.select().from(disputes).where(eq(disputes.order_id, orderId)))[0];

  it('releases the held earnings to the wallet once the 168 h are over, exactly once', async () => {
    const o = await deliveredPrepaid(168.1);
    expect(await balances(o.vendorId)).toEqual({ wallet: 0, hold: 950 });

    await expect(release.releaseOne(o.orderId)).resolves.toEqual({
      status: 'RELEASED',
      amountNpr: 950,
    });
    expect(await balances(o.vendorId)).toEqual({ wallet: 950, hold: 0 });
    // Nobody chatted: a conversation row is created CLOSED, naming the journal.
    expect(await conversationOf(o.orderId)).toMatchObject({
      status: 'CLOSED',
      opened_by_user_id: null,
    });
    expect((await conversationOf(o.orderId))?.hold_release_transaction_id).not.toBeNull();

    await expect(release.releaseOne(o.orderId)).resolves.toEqual({ status: 'SKIPPED' });
    expect(await balances(o.vendorId)).toEqual({ wallet: 950, hold: 0 });
  });

  it('leaves an order inside its window alone', async () => {
    const o = await deliveredPrepaid(167.9);
    await expect(release.releaseOne(o.orderId)).resolves.toEqual({ status: 'SKIPPED' });
    expect(await balances(o.vendorId)).toEqual({ wallet: 0, hold: 950 });
  });

  it('never releases an escalated order: only the resolution moves it', async () => {
    const o = await deliveredPrepaid(200);
    await db.insert(disputes).values({
      order_id: o.orderId,
      opened_by_user_id: o.customerId,
      status: 'ESCALATED',
      escalated_at: new Date(Date.now() - 190 * HOUR_MS),
      escalated_by_user_id: o.customerId,
      escalation_reason: 'The jar arrived broken.',
    });
    await db.update(orders).set({ state: 'DISPUTED' }).where(eq(orders.id, o.orderId));

    await release.run();
    expect(await balances(o.vendorId)).toEqual({ wallet: 0, hold: 950 });
  });

  it('closes an OPEN conversation it releases', async () => {
    const o = await deliveredPrepaid(170);
    await db.insert(disputes).values({ order_id: o.orderId, opened_by_user_id: o.customerId });

    await release.releaseOne(o.orderId);
    expect(await conversationOf(o.orderId)).toMatchObject({
      status: 'CLOSED',
      opened_by_user_id: o.customerId,
      resolved_by_user_id: null,
    });
  });

  it('releases once under five simultaneous runs', async () => {
    const o = await deliveredPrepaid(169);
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => release.releaseOne(o.orderId)),
    );

    expect(outcomes.filter((out) => out.status === 'RELEASED')).toHaveLength(1);
    expect(await balances(o.vendorId)).toEqual({ wallet: 950, hold: 0 });
    const [journals] = await db
      .execute<{ count: string }>(
        sql`SELECT count(*) FROM ledger_transactions WHERE idempotency_key = ${disputeReleaseKey(o.orderId)}`,
      )
      .then((result) => result.rows);
    expect(Number(journals?.count)).toBe(1);
  });

  it('runs over due orders only, per order, leaving other orders of the shop held', async () => {
    const due = await deliveredPrepaid(171);
    const notDue = await deliveredPrepaid(10, due.vendorId);

    const summary = await release.run();
    expect(summary.released).toBeGreaterThanOrEqual(1);
    // 950 released for the due order; the other order's 950 stays held.
    expect(await balances(due.vendorId)).toEqual({ wallet: 950, hold: 950 });
    expect(await conversationOf(notDue.orderId)).toBeUndefined();
  });

  it('never touches an order credited to the wallet before the hold existed', async () => {
    const shop = await vendor();
    const [order] = await db
      .insert(orders)
      .values({
        idempotency_key: randomUUID(),
        customer_id: await user('CUSTOMER'),
        vendor_id: shop,
        subtotal: 1000,
        delivery_fee: 50,
        platform_commission_amount: 100,
        fulfillment_locked: 'SELF_DELIVERY',
        payment_method: 'ESEWA',
        state: 'DELIVERED',
        payment_status: 'PAID',
        placed_at: new Date(Date.now() - 300 * HOUR_MS),
        delivered_at: new Date(Date.now() - 299 * HOUR_MS),
      })
      .returning();
    if (order === undefined) throw new Error('order not created');

    await release.run();
    expect(await conversationOf(order.id)).toBeUndefined();
    expect(
      await db
        .select()
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.hold_vendor_id, shop))),
    ).toEqual([]);
  });
});
