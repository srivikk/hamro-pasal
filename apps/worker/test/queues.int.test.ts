import { randomUUID } from 'node:crypto';

import { Worker } from 'bullmq';

import { buildBullConnection } from '../src/infra/redis';
import {
  allTimerQueues,
  cancelGhostCustomerTimer,
  cancelVendorAcceptanceTimeout,
  createTimerQueues,
  registerMidnightJobs,
  scheduleGhostCustomerTimer,
  scheduleVendorAcceptanceTimeout,
  type TimerQueues,
} from '../src/queues/definitions';
import { createProcessors, type TimerHandlers } from '../src/queues/processors';

/** BullMQ against real Redis (logical DB 14, per-run key prefix). */
describe('timer queues (real Redis)', () => {
  const prefix = `test-${randomUUID()}`;
  const connection = buildBullConnection(process.env.TEST_REDIS_URL ?? '');
  let queues: TimerQueues;

  beforeAll(() => {
    queues = createTimerQueues(connection, prefix);
  });

  afterAll(async () => {
    await Promise.all(allTimerQueues(queues).map((q) => q.obliterate({ force: true })));
    await Promise.all(allTimerQueues(queues).map((q) => q.close()));
  });

  describe('90-second vendor acceptance timeout', () => {
    it('schedules a delayed job keyed by order id that fires 90 s later', async () => {
      const data = { order_id: randomUUID(), vendor_id: randomUUID() };
      const before = Date.now();

      await scheduleVendorAcceptanceTimeout(queues.vendorAcceptance, data);

      const job = await queues.vendorAcceptance.getJob(data.order_id);
      expect(job?.data).toEqual(data);
      expect(await job?.getState()).toBe('delayed');
      expect(job?.opts.delay).toBe(90_000);
      const firesAt = (job?.timestamp ?? 0) + (job?.opts.delay ?? 0);
      expect(firesAt - before).toBeGreaterThanOrEqual(90_000);
      expect(firesAt - before).toBeLessThan(91_000);
    });

    it('is idempotent per order and cancellable when the vendor responds', async () => {
      const data = { order_id: randomUUID(), vendor_id: randomUUID() };
      await scheduleVendorAcceptanceTimeout(queues.vendorAcceptance, data);
      await scheduleVendorAcceptanceTimeout(queues.vendorAcceptance, data);

      const delayed = await queues.vendorAcceptance.getDelayed();
      expect(delayed.filter((j) => j.id === data.order_id)).toHaveLength(1);

      await expect(
        cancelVendorAcceptanceTimeout(queues.vendorAcceptance, data.order_id),
      ).resolves.toBe(true);
      await expect(
        cancelVendorAcceptanceTimeout(queues.vendorAcceptance, data.order_id),
      ).resolves.toBe(false);
      expect(await queues.vendorAcceptance.getJob(data.order_id)).toBeUndefined();
    });
  });

  describe('8-minute ghost customer timer', () => {
    it('schedules a 480 s delayed job and can be cancelled', async () => {
      const data = { order_id: randomUUID(), driver_user_id: randomUUID() };

      await scheduleGhostCustomerTimer(queues.ghostCustomer, data);

      const job = await queues.ghostCustomer.getJob(data.order_id);
      expect(job?.opts.delay).toBe(480_000);
      expect(await job?.getState()).toBe('delayed');
      await expect(cancelGhostCustomerTimer(queues.ghostCustomer, data.order_id)).resolves.toBe(
        true,
      );
    });
  });

  describe('midnight crons', () => {
    it('registers one scheduler per task at 00:00 Asia/Kathmandu, idempotently', async () => {
      await registerMidnightJobs(queues.midnight);
      await registerMidnightJobs(queues.midnight);

      const schedulers = await queues.midnight.getJobSchedulers();
      expect(schedulers.map((s) => s.key).sort()).toEqual([
        'order-reconciliation',
        'subscription-downgrade',
        'vendor-debt-reconciliation',
      ]);
      for (const scheduler of schedulers) {
        expect(scheduler).toMatchObject({ pattern: '0 0 * * *', tz: 'Asia/Kathmandu' });

        // Nepal is UTC+05:45, so local midnight is 18:15 UTC.
        const next = new Date(scheduler.next ?? 0);
        expect([next.getUTCHours(), next.getUTCMinutes()]).toEqual([18, 15]);
        expect(next.getTime() - Date.now()).toBeGreaterThan(0);
        expect(next.getTime() - Date.now()).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
      }
    });
  });

  it('runs a due job through its processor end-to-end', async () => {
    const data = { order_id: randomUUID(), vendor_id: randomUUID() };
    let resolveFired: (value: unknown) => void = () => undefined;
    const fired = new Promise((resolve) => {
      resolveFired = resolve;
    });
    const handlers: TimerHandlers = {
      onVendorAcceptanceTimeout: (job) => {
        resolveFired(job);
        return Promise.resolve();
      },
      onGhostCustomerTimerElapsed: () => Promise.resolve(),
      runMidnightTask: () => Promise.resolve(),
    };
    const worker = new Worker(
      queues.vendorAcceptance.name,
      createProcessors(handlers).vendorAcceptance,
      {
        connection,
        prefix,
      },
    );
    try {
      await scheduleVendorAcceptanceTimeout(queues.vendorAcceptance, data);
      // Fast-forward instead of waiting 90 s: promote the delayed job to waiting.
      await (await queues.vendorAcceptance.getJob(data.order_id))?.promote();

      await expect(fired).resolves.toEqual(data);
    } finally {
      await worker.close();
    }
  });
});
