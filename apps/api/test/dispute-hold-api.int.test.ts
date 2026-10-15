import {
  auditLogs,
  disputes,
  ledgerAccounts,
  orders,
  outboxEvents,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import {
  adminDisputeListResponseSchema,
  adminDisputeResponseSchema,
  chatHistoryResponseSchema,
  escalationResponseSchema,
  vendorWalletBalanceResponseSchema,
  type Order,
} from '@hamro-pasal/shared-types';
import { and, eq, sql } from 'drizzle-orm';
import request from 'supertest';

import {
  createOrder,
  createUser,
  createVendor,
  markDelivered,
  vendorUserIdOf,
} from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

const HOUR_MS = 3_600_000;

/**
 * Step 7.3 (SPEC core 6, verification 25): the order conversation from placement until 7 days
 * after delivery, escalation, the dispute hold of a prepaid order's earnings, and the Super
 * Admin's resolution. Real Express + PostgreSQL.
 */
describe('Order conversations, the dispute hold and resolution', () => {
  let t: TestApp;
  let db: Database;
  let admin: string;

  beforeAll(async () => {
    t = buildTestApp();
    db = t.container.db;
    admin = bearer(await createUser(db, 'SUPER_ADMIN'), 'SUPER_ADMIN');
  });

  afterAll(async () => {
    await t.container.close();
  });

  interface Fixture {
    readonly order: Order;
    readonly vendorId: string;
    readonly customer: string;
    readonly vendor: string;
  }

  /** A PLACED order (prepaid ones captured into escrow): 1000 + 50 fee, 100 commission. */
  async function placed(paymentMethod: 'ESEWA' | 'COD' = 'ESEWA'): Promise<Fixture> {
    const vendorId = await createVendor(db);
    const customerId = await createUser(db);
    const order = await createOrder(db, { customerId, vendorId, paymentMethod });
    await db
      .update(orders)
      .set({ state: 'PLACED', placed_at: new Date() })
      .where(eq(orders.id, order.id));
    if (paymentMethod !== 'COD') await t.container.settlement.capturePayment(order.id);
    return {
      order,
      vendorId,
      customer: bearer(customerId),
      vendor: bearer(await vendorUserIdOf(db, vendorId), 'VENDOR'),
    };
  }

  /** Delivered (and settled, as the delivery commit does), `hoursAgo` hours ago. */
  async function delivered(f: Fixture, hoursAgo = 1): Promise<void> {
    await markDelivered(db, f.order.id);
    await t.container.settlement.settleOrder(f.order.id);
    await db
      .update(orders)
      .set({ delivered_at: new Date(Date.now() - hoursAgo * HOUR_MS) })
      .where(eq(orders.id, f.order.id));
  }

  const escalate = (f: Fixture, as: 'customer' | 'vendor', reason = 'The jar arrived broken.') =>
    request(t.app)
      .post(
        as === 'customer'
          ? `/api/orders/${f.order.id}/escalate`
          : `/api/vendors/orders/${f.order.id}/escalate`,
      )
      .set('authorization', as === 'customer' ? f.customer : f.vendor)
      .send({ reason });

  const resolve = (disputeId: string, body: object) =>
    request(t.app)
      .post(`/api/admin/disputes/${disputeId}/resolve`)
      .set('authorization', admin)
      .send(body);

  async function balances(vendorId: string) {
    const rows = await db
      .select({
        type: ledgerAccounts.account_type,
        balance: ledgerAccounts.balance_npr,
      })
      .from(ledgerAccounts)
      .where(
        sql`${ledgerAccounts.vendor_id} = ${vendorId} OR ${ledgerAccounts.hold_vendor_id} = ${vendorId}`,
      );
    const of = (type: string) => rows.find((row) => row.type === type)?.balance ?? 0;
    return { wallet: of('VENDOR_WALLET'), hold: of('VENDOR_DISPUTE_HOLD') };
  }

  async function refundClearing(): Promise<number> {
    const [row] = await db
      .select({ balance: ledgerAccounts.balance_npr })
      .from(ledgerAccounts)
      .where(sql`${ledgerAccounts.account_type}::text = 'REFUND_CLEARING'`);
    return row?.balance ?? 0;
  }

  describe('the hold', () => {
    it('credits a delivered prepaid order to the dispute hold, not the payable wallet', async () => {
      const f = await placed('ESEWA');
      await delivered(f);

      // 1000 - 100 commission + its own 50 delivery fee.
      expect(await balances(f.vendorId)).toEqual({ wallet: 0, hold: 950 });
      const res = await request(t.app)
        .get('/api/vendors/wallet/balance')
        .set('authorization', f.vendor);
      expect(bodyOf(vendorWalletBalanceResponseSchema, res)).toMatchObject({
        wallet_balance_npr: 0,
        pending_escrow_npr: 0,
        dispute_hold_npr: 950,
        dispute_hold_order_count: 1,
      });
    });

    it('leaves a cash order out of the hold: the vendor has the cash', async () => {
      const f = await placed('COD');
      await delivered(f);

      expect(await balances(f.vendorId)).toEqual({ wallet: -100, hold: 0 });
    });
  });

  describe('the conversation window', () => {
    it('lets either party escalate from placement, once; the admin may read it only then', async () => {
      const f = await placed('ESEWA');

      // Not escalated: the Super Admin cannot read it.
      expect(
        (await request(t.app).get(`/api/orders/${f.order.id}/chat`).set('authorization', admin))
          .status,
      ).toBe(404);

      const res = await escalate(f, 'vendor', 'The customer is not answering the door.');
      const { conversation } = bodyOf(escalationResponseSchema, res);
      expect(conversation).toMatchObject({ status: 'ESCALATED', window_ends_at: null });
      // Not delivered yet: the order keeps going.
      const [order] = await db.select().from(orders).where(eq(orders.id, f.order.id));
      expect(order?.state).toBe('PLACED');

      const again = await escalate(f, 'customer');
      expect(again.status).toBe(409);
      expect(errorOf(again).code).toBe('ALREADY_ESCALATED');

      const chat = await request(t.app)
        .get(`/api/orders/${f.order.id}/chat`)
        .set('authorization', admin);
      expect(bodyOf(chatHistoryResponseSchema, chat).messages).toEqual([]);

      const audit = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, 'DISPUTE_ESCALATED'),
            eq(auditLogs.entity_id, conversation.dispute_id),
          ),
        );
      expect(audit).toHaveLength(1);
      const events = await db
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.event_type, 'dispute.escalated'),
            eq(outboxEvents.aggregate_id, f.order.id),
          ),
        );
      expect(events[0]?.payload).toMatchObject({ escalated_by: 'VENDOR', vendor_id: f.vendorId });
    });

    it('moves a delivered order to DISPUTED, and refuses at 168 h + 1 s', async () => {
      const inside = await placed('ESEWA');
      await delivered(inside, 167);
      const res = await escalate(inside, 'customer');
      expect(res.status).toBe(200);
      const [order] = await db.select().from(orders).where(eq(orders.id, inside.order.id));
      expect(order?.state).toBe('DISPUTED');
      expect(bodyOf(escalationResponseSchema, res).conversation.window_ends_at).not.toBeNull();

      const late = await placed('ESEWA');
      await delivered(late);
      await db
        .update(orders)
        .set({ delivered_at: new Date(Date.now() - 168 * HOUR_MS - 1000) })
        .where(eq(orders.id, late.order.id));
      const refused = await escalate(late, 'customer');
      expect(refused.status).toBe(422);
      expect(errorOf(refused).code).toBe('DISPUTE_WINDOW_CLOSED');
    });

    it('refuses a short reason, a stranger and another shop', async () => {
      const f = await placed('ESEWA');
      expect((await escalate(f, 'customer', 'too short')).status).toBe(400);

      const stranger = await request(t.app)
        .post(`/api/orders/${f.order.id}/escalate`)
        .set('authorization', bearer(await createUser(db)))
        .send({ reason: 'I am not the customer here.' });
      expect(stranger.status).toBe(404);

      const other = await placed('ESEWA');
      const foreign = await request(t.app)
        .post(`/api/vendors/orders/${f.order.id}/escalate`)
        .set('authorization', other.vendor)
        .send({ reason: 'Not my order at all, really.' });
      expect(foreign.status).toBe(404);
    });

    it('is closed for a cancelled order', async () => {
      const f = await placed('ESEWA');
      await db.update(orders).set({ state: 'CANCELED' }).where(eq(orders.id, f.order.id));
      const res = await escalate(f, 'customer');
      expect(res.status).toBe(422);
    });
  });

  describe('resolution', () => {
    async function escalatedDelivered(paymentMethod: 'ESEWA' | 'COD' = 'ESEWA') {
      const f = await placed(paymentMethod);
      await delivered(f, 2);
      const res = await escalate(f, 'customer');
      return { f, disputeId: bodyOf(escalationResponseSchema, res).conversation.dispute_id };
    }

    it('lists escalated conversations with the held amount', async () => {
      const { f, disputeId } = await escalatedDelivered();
      const res = await request(t.app).get('/api/admin/disputes').set('authorization', admin);
      const row = bodyOf(adminDisputeListResponseSchema, res).disputes.find(
        (d) => d.dispute_id === disputeId,
      );
      expect(row).toMatchObject({
        order_id: f.order.id,
        status: 'ESCALATED',
        order_state: 'DISPUTED',
        held_npr: 950,
        order_total_npr: 1050,
        escalated_by: 'CUSTOMER',
      });
    });

    it('releases the hold to the wallet and returns the order to DELIVERED', async () => {
      const { f, disputeId } = await escalatedDelivered();
      const res = await resolve(disputeId, {
        outcome: 'RELEASE',
        note: 'The photos show it arrived intact.',
      });

      expect(bodyOf(adminDisputeResponseSchema, res).dispute).toMatchObject({
        status: 'RELEASED_TO_VENDOR',
        held_npr: 0,
        refund_npr: 0,
        order_state: 'DELIVERED',
      });
      expect(await balances(f.vendorId)).toEqual({ wallet: 950, hold: 0 });

      const twice = await resolve(disputeId, {
        outcome: 'RELEASE',
        note: 'The photos show it arrived intact.',
      });
      expect(twice.status).toBe(409);
      expect(await balances(f.vendorId)).toEqual({ wallet: 950, hold: 0 });
    });

    it('records a partial refund as owed, and releases the rest', async () => {
      const { f, disputeId } = await escalatedDelivered();
      const before = await refundClearing();
      const res = await resolve(disputeId, {
        outcome: 'PARTIAL_REFUND',
        refund_npr: 300,
        note: 'One of three items was missing.',
      });

      expect(bodyOf(adminDisputeResponseSchema, res).dispute).toMatchObject({
        status: 'PARTIALLY_REFUNDED',
        refund_npr: 300,
      });
      expect(await balances(f.vendorId)).toEqual({ wallet: 650, hold: 0 });
      expect((await refundClearing()) - before).toBeCloseTo(300, 2);
      const [conversation] = await db.select().from(disputes).where(eq(disputes.id, disputeId));
      expect(conversation?.hold_release_transaction_id).not.toBeNull();
    });

    it('refunds everything the customer paid, the part the hold cannot cover from the wallet', async () => {
      const { f, disputeId } = await escalatedDelivered();
      const before = await refundClearing();
      await resolve(disputeId, { outcome: 'REFUND', note: 'Wrong order delivered entirely.' });

      // 1050 paid; 950 was held; the other 100 comes from the wallet.
      expect(await balances(f.vendorId)).toEqual({ wallet: -100, hold: 0 });
      expect((await refundClearing()) - before).toBeCloseTo(1050, 2);
    });

    it('debits a cash refund from the vendor ledger', async () => {
      const { f, disputeId } = await escalatedDelivered('COD');
      await resolve(disputeId, {
        outcome: 'PARTIAL_REFUND',
        refund_npr: 200,
        note: 'Damaged item, agreed on a partial refund.',
      });
      // -100 commission at delivery, -200 refund.
      expect(await balances(f.vendorId)).toEqual({ wallet: -300, hold: 0 });
    });

    it('refuses a partial refund of the whole payment, and a not-escalated conversation', async () => {
      const { disputeId } = await escalatedDelivered();
      const tooMuch = await resolve(disputeId, {
        outcome: 'PARTIAL_REFUND',
        refund_npr: 1050,
        note: 'More than a partial refund.',
      });
      expect(tooMuch.status).toBe(422);
      expect(errorOf(tooMuch).code).toBe('REFUND_EXCEEDS_PAYMENT');

      const missing = await resolve('00000000-0000-4000-8000-000000000000', {
        outcome: 'RELEASE',
        note: 'Nothing to resolve here.',
      });
      expect(missing.status).toBe(404);

      const f = await placed('ESEWA');
      const notEscalated = await escalate(f, 'customer');
      const id = bodyOf(escalationResponseSchema, notEscalated).conversation.dispute_id;
      // Escalated but not delivered: refused until it is.
      const early = await resolve(id, { outcome: 'RELEASE', note: 'Too early to decide this.' });
      expect(early.status).toBe(409);
      expect(errorOf(early).code).toBe('ORDER_NOT_DELIVERED');
    });

    it('is for a Super Admin only', async () => {
      const { f, disputeId } = await escalatedDelivered();
      const res = await request(t.app)
        .post(`/api/admin/disputes/${disputeId}/resolve`)
        .set('authorization', f.vendor)
        .send({ outcome: 'RELEASE', note: 'Release my own money now.' });
      expect(res.status).toBe(403);
      const vendorRow = await db.select().from(vendors).where(eq(vendors.id, f.vendorId));
      expect(vendorRow[0]?.wallet_balance_npr).toBe(0);
    });
  });
});
