import { randomUUID } from 'node:crypto';

import { Worker } from 'bullmq';

import { buildBullConnection } from '../src/infra/redis';
import {
  allTimerQueues,
  cancelGhostCustomerTimer,
  cancelVendorAcceptanceTimeout,
  createTimerQueues,
  queueComplianceSweepNow,
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
      expect(job?.data).toEqual({ ...data, kind: 'ESCALATE' });
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
    it('queues one compliance sweep at start-up, besides the midnight one (2026-10-20)', async () => {
      await queueComplianceSweepNow(queues.midnight);

      const waiting = await queues.midnight.getJobs(['waiting', 'prioritized', 'delayed']);
      const sweeps = waiting.filter((job) => job.name === 'VENDOR_COMPLIANCE_SWEEP');
      expect(sweeps).toHaveLength(1);
      expect(sweeps[0]?.data).toEqual({ task: 'VENDOR_COMPLIANCE_SWEEP' });
      await Promise.all(sweeps.map((job) => job.remove()));
    });

    it('registers one scheduler per task at 00:00 Asia/Kathmandu, idempotently', async () => {
      await registerMidnightJobs(queues.midnight);
      await registerMidnightJobs(queues.midnight);

      const all = await queues.midnight.getJobSchedulers();
      // The one hourly task shares the queue: on the hour, every hour (Phase 28).
      const hourly = all.filter((s) => s.key === 'marketing-status-sweep');
      expect(hourly).toHaveLength(1);
      expect(hourly[0]).toMatchObject({ pattern: '0 * * * *', name: 'MARKETING_STATUS_SWEEP' });
      const untilNext = (hourly[0]?.next ?? 0) - Date.now();
      expect(untilNext).toBeGreaterThan(0);
      expect(untilNext).toBeLessThanOrEqual(60 * 60 * 1000);

      // Step 7.3: the day-8 release, hourly at half past.
      const release = all.filter((s) => s.key === 'dispute-hold-release');
      expect(release).toHaveLength(1);
      expect(release[0]).toMatchObject({ pattern: '30 * * * *', name: 'DISPUTE_HOLD_RELEASE' });

      // Step 7.4: the Notify Me sweep, every 5 minutes.
      const notifyMe = all.filter((s) => s.key === 'notify-me-sweep');
      expect(notifyMe).toHaveLength(1);
      expect(notifyMe[0]).toMatchObject({ pattern: '*/5 * * * *', name: 'NOTIFY_ME_SWEEP' });
      expect((notifyMe[0]?.next ?? 0) - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);

      // The weekly payout run (Phase 29): Tuesday 02:00 Nepal Time, which is Monday 20:15 UTC.
      const weekly = all.filter((s) => s.key === 'settlement-payout-run');
      expect(weekly).toHaveLength(1);
      expect(weekly[0]).toMatchObject({
        pattern: '0 2 * * 2',
        tz: 'Asia/Kathmandu',
        name: 'SETTLEMENT_PAYOUT_RUN',
      });
      const nextRun = new Date(weekly[0]?.next ?? 0);
      expect([nextRun.getUTCDay(), nextRun.getUTCHours(), nextRun.getUTCMinutes()]).toEqual([
        1, 20, 15,
      ]);
      expect(nextRun.getTime() - Date.now()).toBeGreaterThan(0);
      expect(nextRun.getTime() - Date.now()).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);

      const schedulers = all.filter(
        (s) =>
          s.key !== 'marketing-status-sweep' &&
          s.key !== 'settlement-payout-run' &&
          s.key !== 'notify-me-sweep' &&
          s.key !== 'dispute-hold-release',
      );
      expect(schedulers.map((s) => s.key).sort()).toEqual([
        'billing-cycle-renewal',
        'export-file-sweep',
        'order-reconciliation',
        'subscription-downgrade',
        'vendor-compliance-sweep',
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
      onVendorAcceptanceExpiry: () => Promise.resolve(),
      onGhostCustomerTimerElapsed: () => Promise.resolve(),
      runMidnightTask: () => Promise.resolve(),
      runMarketingStatusSweep: () => Promise.resolve(),
      runSettlementPayoutRun: () => Promise.resolve(),
      runNotifyMeSweep: () => Promise.resolve(),
      runDisputeHoldRelease: () => Promise.resolve(),
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

      await expect(fired).resolves.toEqual({ ...data, kind: 'ESCALATE' });
    } finally {
      await worker.close();
    }
  });
});
