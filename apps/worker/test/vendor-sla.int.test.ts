import { randomInt, randomUUID } from 'node:crypto';

import {
  createDatabase,
  enqueueDomainEvent,
  orders,
  outboxEvents,
  outboxRowToDomainEvent,
  users,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import type { KafkaJS } from '@hamro-pasal/kafka';
import type { OrderState, VendorEscalationRequiredEvent } from '@hamro-pasal/shared-types';
import { Worker } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';

import {
  BullVendorAcceptanceTimers,
  vendorSlaSchedulerConsumer,
} from '../src/consumers/vendor-sla-scheduler';
import { buildBullConnection } from '../src/infra/redis';
import { allTimerQueues, createTimerQueues, type TimerQueues } from '../src/queues/definitions';
import { createProcessors, createTimerHandlers } from '../src/queues/processors';
import { VendorEscalationService } from '../src/sla/vendor-escalation';
import { VendorDebtReconciliationService } from '../src/wallet/vendor-debt-reconciliation';

const VENDOR_PHONE = '+9779800000011';

/**
 * Phase 10: the 90-second vendor acceptance SLA (vendor flow step 6) against real PostgreSQL
 * (hamro_pasal_worker_test) and real Redis/BullMQ (logical DB 14, per-run prefix):
 *   PLACED outbox event → scheduler consumer → delayed job at placed_at + 90 s → processor →
 *   `vendor.escalation.required` in the outbox, only if the order is still PLACED.
 * Nothing here waits 90 s: placements are backdated and delayed jobs are promoted.
 */
describe('vendor acceptance SLA (real PostgreSQL + BullMQ)', () => {
  const prefix = `test-${randomUUID()}`;
  const connection = buildBullConnection(process.env.TEST_REDIS_URL ?? '');
  let db: Database;
  let queues: TimerQueues;
  let escalation: VendorEscalationService;

  beforeAll(() => {
    db = createDatabase(process.env.TEST_DATABASE_URL ?? '', { max: 10 });
    queues = createTimerQueues(connection, prefix);
    escalation = new VendorEscalationService(db);
  });

  afterAll(async () => {
    await Promise.all(allTimerQueues(queues).map((q) => q.obliterate({ force: true })));
    await Promise.all(allTimerQueues(queues).map((q) => q.close()));
    await db.$client.end();
  });

  async function user(role: 'CUSTOMER' | 'VENDOR'): Promise<string> {
    const phone = `+9779${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
    const [row] = await db.insert(users).values({ phone, role }).returning({ id: users.id });
    if (row === undefined) throw new Error('user not created');
    return row.id;
  }

  /** A LIVE vendor and an order of theirs, PLACED `secondsAgo` seconds ago (database clock). */
  async function placedOrder(secondsAgo: number) {
    const [vendor] = await db
      .insert(vendors)
      .values({
        user_id: await user('VENDOR'),
        business_name: 'Thamel Kirana Pasal',
        phone: VENDOR_PHONE,
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
    if (vendor === undefined) throw new Error('vendor not created');
    const [order] = await db
      .insert(orders)
      .values({
        idempotency_key: randomUUID(),
        customer_id: await user('CUSTOMER'),
        vendor_id: vendor.id,
        state: 'PLACED',
        placed_at: sql`now() - make_interval(secs => ${secondsAgo}::float8)`,
        subtotal: 1000,
        delivery_fee: 50,
        platform_commission_amount: 100,
        fulfillment_locked: 'SELF_DELIVERY',
        payment_method: 'COD',
        delivery_otp: '$2b$10$abcdefghijklmnopqrstuuM3bJ0n9ZkZ2p9Y5o0t7m6c1QwV8e2yG',
      })
      .returning();
    if (order?.placed_at == null) throw new Error('order not created');
    return { orderId: order.id, vendorId: vendor.id, placedAt: order.placed_at };
  }

  async function setState(orderId: string, state: OrderState) {
    await db.update(orders).set({ state }).where(eq(orders.id, orderId));
  }

  async function escalations(orderId: string): Promise<VendorEscalationRequiredEvent[]> {
    const rows = await db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.aggregate_id, orderId),
          eq(outboxEvents.event_type, 'vendor.escalation.required'),
        ),
      );
    return rows.map((row) => {
      expect(row.topic).toBe('notifications.broadcast');
      const event = outboxRowToDomainEvent(row);
      if (event.event_type !== 'vendor.escalation.required') throw new Error('wrong type');
      return event;
    });
  }

  /** The Kafka message the relay produces for this order's PLACED state change. */
  async function placedMessage(orderId: string, vendorId: string, placedAt: Date) {
    const event = await enqueueDomainEvent(db, {
      type: 'order.state_changed',
      aggregateId: orderId,
      payload: {
        order_id: orderId,
        customer_id: randomUUID(),
        vendor_id: vendorId,
        from_state: 'PENDING_PAYMENT',
        to_state: 'PLACED',
        payment_status: 'PENDING',
        refund_required: false,
        placed_at: placedAt.toISOString(),
        delivered_at: null,
        changed_at: placedAt.toISOString(),
      },
    });
    const payload: KafkaJS.EachMessagePayload = {
      topic: 'order.lifecycle',
      partition: 0,
      message: {
        key: Buffer.from(orderId),
        value: Buffer.from(JSON.stringify(event)), // exactly what DomainEventPublisher sends
        offset: '0',
        timestamp: String(Date.now()),
        attributes: 0,
        headers: {},
      },
      heartbeat: () => Promise.resolve(),
      pause: () => () => undefined,
    };
    return payload;
  }

  async function until(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  describe('the escalation when the timer fires', () => {
    it('escalates an order still PLACED after 90 s with the vendor number for the IVR/SMS', async () => {
      const { orderId, vendorId, placedAt } = await placedOrder(91);

      await expect(
        escalation.escalateIfUnanswered({ order_id: orderId, vendor_id: vendorId }),
      ).resolves.toBe('ESCALATED');

      const [event, ...others] = await escalations(orderId);
      expect(others).toEqual([]);
      expect(event?.payload).toEqual({
        order_id: orderId,
        vendor_id: vendorId,
        vendor_phone: VENDOR_PHONE,
        placed_at: placedAt.toISOString(),
        sla_seconds: 90,
        escalated_at: event?.occurred_at,
      });
    });

    it.each<OrderState>(['PREPARING', 'CANCELED'])(
      'does nothing once the order left PLACED (%s: the vendor or customer acted)',
      async (state) => {
        const { orderId, vendorId } = await placedOrder(91);
        await setState(orderId, state);

        await expect(
          escalation.escalateIfUnanswered({ order_id: orderId, vendor_id: vendorId }),
        ).resolves.toBe('NOT_PENDING');
        expect(await escalations(orderId)).toEqual([]);
      },
    );

    it('does nothing for an order that does not exist', async () => {
      await expect(
        escalation.escalateIfUnanswered({ order_id: randomUUID(), vendor_id: randomUUID() }),
      ).resolves.toBe('NOT_PENDING');
    });

    it('never calls the vendor twice for one order: retried and concurrent runs escalate once', async () => {
      const { orderId, vendorId } = await placedOrder(91);
      const job = { order_id: orderId, vendor_id: vendorId };

      const outcomes = await Promise.all(
        Array.from({ length: 5 }, () => escalation.escalateIfUnanswered(job)),
      );
      const retried = await escalation.escalateIfUnanswered(job);

      expect(outcomes.filter((outcome) => outcome === 'ESCALATED')).toHaveLength(1);
      expect(retried).toBe('ALREADY_ESCALATED');
      expect(await escalations(orderId)).toHaveLength(1);
    });

    it('is backed by the database: a second escalation row for the order is refused', async () => {
      const { orderId, vendorId, placedAt } = await placedOrder(91);
      const write = () =>
        enqueueDomainEvent(db, {
          type: 'vendor.escalation.required',
          aggregateId: orderId,
          payload: {
            order_id: orderId,
            vendor_id: vendorId,
            vendor_phone: VENDOR_PHONE,
            placed_at: placedAt.toISOString(),
            sla_seconds: 90,
            escalated_at: new Date().toISOString(),
          },
        });

      await write();
      await expect(write()).rejects.toThrow();
      expect(await escalations(orderId)).toHaveLength(1);
    });
  });

  describe('the timer, from the PLACED event to the escalation', () => {
    let worker: Worker;

    beforeAll(() => {
      worker = new Worker(
        queues.vendorAcceptance.name,
        createProcessors(
          createTimerHandlers({
            escalation,
            debtReconciliation: new VendorDebtReconciliationService(db),
            orderReconciliation: {
              reconcileDeliveredOrders: () =>
                Promise.resolve({ reconciled: [], discrepancies: [] }),
            },
          }),
        ).vendorAcceptance,
        { connection, prefix },
      );
    });

    afterAll(async () => {
      await worker.close();
    });

    const scheduler = () =>
      vendorSlaSchedulerConsumer({
        timers: new BullVendorAcceptanceTimers(queues.vendorAcceptance),
      });

    it('schedules the job to fire 90 s after placed_at, keyed by the order', async () => {
      const { orderId, vendorId, placedAt } = await placedOrder(0);
      const before = Date.now();

      await scheduler().handle(await placedMessage(orderId, vendorId, placedAt));

      const job = await queues.vendorAcceptance.getJob(orderId);
      expect(job?.data).toEqual({ order_id: orderId, vendor_id: vendorId, kind: 'ESCALATE' });
      expect(await job?.getState()).toBe('delayed');
      const firesAt = (job?.timestamp ?? 0) + (job?.opts.delay ?? 0);
      expect(Math.abs(firesAt - (placedAt.getTime() + 90_000))).toBeLessThan(1_000);
      // Step 7.3: the 5-minute expiry is its own job, keyed apart from the escalation.
      const expire = await queues.vendorAcceptance.getJob(`expire-${orderId}`);
      expect(expire?.data).toEqual({ order_id: orderId, vendor_id: vendorId, kind: 'EXPIRE' });
      const expiresAt = (expire?.timestamp ?? 0) + (expire?.opts.delay ?? 0);
      expect(Math.abs(expiresAt - (placedAt.getTime() + 300_000))).toBeLessThan(1_000);
      expect(firesAt - before).toBeGreaterThan(85_000);
      expect(await escalations(orderId)).toEqual([]);

      // Kafka redelivers: the same event schedules nothing new.
      await scheduler().handle(await placedMessage(orderId, vendorId, placedAt));
      const delayed = await queues.vendorAcceptance.getDelayed();
      expect(delayed.filter((candidate) => candidate.id === orderId)).toHaveLength(1);
    });

    it('fires at once for an order whose 90 s already passed and escalates it', async () => {
      const { orderId, vendorId, placedAt } = await placedOrder(91);

      await scheduler().handle(await placedMessage(orderId, vendorId, placedAt));

      await until(async () => (await escalations(orderId)).length === 1);
      expect(await queues.vendorAcceptance.getJob(orderId).then((job) => job?.getState())).toBe(
        'completed',
      );
    });

    it('a vendor who accepts before the timer fires is not escalated', async () => {
      const { orderId, vendorId, placedAt } = await placedOrder(0);
      await scheduler().handle(await placedMessage(orderId, vendorId, placedAt));

      await setState(orderId, 'PREPARING'); // the vendor pressed Accept at, say, 40 s
      await (await queues.vendorAcceptance.getJob(orderId))?.promote(); // 90 s pass

      await until(
        async () =>
          (await queues.vendorAcceptance.getJob(orderId).then((job) => job?.getState())) ===
          'completed',
      );
      expect(await escalations(orderId)).toEqual([]);
    });

    it('an unanswered order escalates when its delayed job comes due', async () => {
      const { orderId, vendorId, placedAt } = await placedOrder(0);
      await scheduler().handle(await placedMessage(orderId, vendorId, placedAt));

      await (await queues.vendorAcceptance.getJob(orderId))?.promote(); // 90 s pass, no decision

      await until(async () => (await escalations(orderId)).length === 1);
      const [event] = await escalations(orderId);
      expect(event?.payload).toMatchObject({ order_id: orderId, vendor_phone: VENDOR_PHONE });
    });
  });
});
