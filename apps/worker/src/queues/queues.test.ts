import { randomUUID } from 'node:crypto';

import type { Job } from 'bullmq';

import {
  ghostCustomerTimerOptions,
  midnightSchedulerId,
  vendorAcceptanceDelayMs,
  vendorAcceptanceTimeoutOptions,
} from './definitions';
import { createProcessors, createTimerHandlers, type TimerHandlers } from './processors';

const job = (data: unknown) => ({ data }) as Job;

function handlers() {
  const mocks = {
    onVendorAcceptanceTimeout: jest.fn<
      Promise<void>,
      Parameters<TimerHandlers['onVendorAcceptanceTimeout']>
    >(),
    onGhostCustomerTimerElapsed: jest.fn<
      Promise<void>,
      Parameters<TimerHandlers['onGhostCustomerTimerElapsed']>
    >(),
    runMidnightTask: jest.fn<Promise<void>, Parameters<TimerHandlers['runMidnightTask']>>(),
  };
  for (const mock of Object.values(mocks)) mock.mockResolvedValue(undefined);
  const impl: TimerHandlers = mocks;
  return { mocks, impl };
}

describe('timer job options', () => {
  it('delays the vendor acceptance timeout by exactly 90 s, keyed by order', () => {
    const orderId = randomUUID();

    expect(vendorAcceptanceTimeoutOptions(orderId)).toMatchObject({
      jobId: orderId,
      delay: 90_000,
    });
  });

  it('delays the ghost customer timer by exactly 8 minutes, keyed by order', () => {
    const orderId = randomUUID();

    expect(ghostCustomerTimerOptions(orderId)).toMatchObject({ jobId: orderId, delay: 480_000 });
  });

  it('derives colon-free scheduler ids (BullMQ forbids ":" in ids)', () => {
    expect(midnightSchedulerId('SUBSCRIPTION_DOWNGRADE')).toBe('subscription-downgrade');
  });
});

describe('processors', () => {
  it('pass validated payloads to their handlers', async () => {
    const { mocks, impl } = handlers();
    const processors = createProcessors(impl);
    const vendorJob = { order_id: randomUUID(), vendor_id: randomUUID() };
    const ghostJob = { order_id: randomUUID(), driver_user_id: randomUUID() };

    await processors.vendorAcceptance(job(vendorJob));
    await processors.ghostCustomer(job(ghostJob));
    await processors.midnight(job({ task: 'SUBSCRIPTION_DOWNGRADE' }));

    expect(mocks.onVendorAcceptanceTimeout).toHaveBeenCalledWith(vendorJob);
    expect(mocks.onGhostCustomerTimerElapsed).toHaveBeenCalledWith(ghostJob);
    expect(mocks.runMidnightTask).toHaveBeenCalledWith('SUBSCRIPTION_DOWNGRADE');
  });

  it('fail malformed jobs without calling the handler', async () => {
    const { mocks, impl } = handlers();
    const processors = createProcessors(impl);

    await expect(processors.vendorAcceptance(job({ order_id: 'nope' }))).rejects.toThrow();
    await expect(processors.midnight(job({ task: 'DROP_TABLES' }))).rejects.toThrow();
    expect(mocks.onVendorAcceptanceTimeout).not.toHaveBeenCalled();
    expect(mocks.runMidnightTask).not.toHaveBeenCalled();
  });
});

describe('vendor acceptance deadline (Phase 10)', () => {
  const placedAt = new Date('2026-09-30T10:00:00.000Z');
  const at = (seconds: number) => new Date(placedAt.getTime() + seconds * 1000);

  it('fires 90 s after placement, however late the worker hears about it', () => {
    expect(vendorAcceptanceDelayMs(placedAt, at(0))).toBe(90_000);
    expect(vendorAcceptanceDelayMs(placedAt, at(2.5))).toBe(87_500);
    expect(vendorAcceptanceDelayMs(placedAt, at(89))).toBe(1_000);
  });

  it('fires at once when the deadline has already passed (worker was down)', () => {
    expect(vendorAcceptanceDelayMs(placedAt, at(90))).toBe(0);
    expect(vendorAcceptanceDelayMs(placedAt, at(600))).toBe(0);
  });

  it('keeps an explicit delay in the job options', () => {
    const orderId = randomUUID();

    expect(vendorAcceptanceTimeoutOptions(orderId, 1_000)).toMatchObject({
      jobId: orderId,
      delay: 1_000,
    });
  });
});

const noDebt = { suspendIndebtedVendors: () => Promise.resolve([]) };
const noOrders = {
  reconcileDeliveredOrders: () => Promise.resolve({ reconciled: [], discrepancies: [] }),
};

describe('createTimerHandlers', () => {
  it('runs the escalation for a fired vendor acceptance timer', async () => {
    const escalateIfUnanswered = jest.fn().mockResolvedValue('ESCALATED');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const vendorJob = { order_id: randomUUID(), vendor_id: randomUUID() };

    await createTimerHandlers({
      escalation: { escalateIfUnanswered },
      debtReconciliation: noDebt,
      orderReconciliation: noOrders,
    }).onVendorAcceptanceTimeout(vendorJob);

    expect(escalateIfUnanswered).toHaveBeenCalledWith(vendorJob);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(vendorJob.order_id));
    warn.mockRestore();
  });

  it('fails the job when the escalation cannot be written (BullMQ retries it)', async () => {
    const escalateIfUnanswered = jest.fn().mockRejectedValue(new Error('database down'));

    await expect(
      createTimerHandlers({
        escalation: { escalateIfUnanswered },
        debtReconciliation: noDebt,
        orderReconciliation: noOrders,
      }).onVendorAcceptanceTimeout({
        order_id: randomUUID(),
        vendor_id: randomUUID(),
      }),
    ).rejects.toThrow('database down');
  });
});

describe('the midnight debt reconciliation handler', () => {
  const escalation = { escalateIfUnanswered: jest.fn() };
  const orderReconciliation = { reconcileDeliveredOrders: jest.fn() };

  it('runs the sweep and writes one structured audit line per suspended vendor', async () => {
    const vendorId = randomUUID();
    const suspendIndebtedVendors = jest.fn().mockResolvedValue([
      {
        vendorId,
        previousStatus: 'LIVE',
        walletBalanceNpr: -1500,
        suspensionLimitNpr: -1000,
        suspendedAt: new Date('2026-09-30T18:15:00.000Z'),
      },
    ]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);

    await createTimerHandlers({
      escalation,
      debtReconciliation: { suspendIndebtedVendors },
      orderReconciliation,
    }).runMidnightTask('VENDOR_DEBT_RECONCILIATION');

    expect(suspendIndebtedVendors).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
      audit: 'vendor.suspended_for_debt',
      vendor_id: vendorId,
      previous_status: 'LIVE',
      wallet_balance_npr: -1500,
      suspension_limit_npr: -1000,
      suspended_at: '2026-09-30T18:15:00.000Z',
    });
    warn.mockRestore();
    info.mockRestore();
  });

  it('fails the job when the sweep fails (BullMQ retries it)', async () => {
    const suspendIndebtedVendors = jest.fn().mockRejectedValue(new Error('database down'));

    await expect(
      createTimerHandlers({
        escalation,
        debtReconciliation: { suspendIndebtedVendors },
        orderReconciliation,
      }).runMidnightTask('VENDOR_DEBT_RECONCILIATION'),
    ).rejects.toThrow('database down');
  });

  it('does not sweep for the other midnight task', async () => {
    const suspendIndebtedVendors = jest.fn().mockResolvedValue([]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await createTimerHandlers({
      escalation,
      debtReconciliation: { suspendIndebtedVendors },
      orderReconciliation,
    }).runMidnightTask('SUBSCRIPTION_DOWNGRADE');

    expect(suspendIndebtedVendors).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('the midnight order reconciliation handler', () => {
  const escalation = { escalateIfUnanswered: jest.fn() };

  it('runs the reconciliation, audits each discrepancy and does not fail the job for them', async () => {
    const orderId = randomUUID();
    const vendorId = randomUUID();
    const reconcileDeliveredOrders = jest.fn().mockResolvedValue({
      reconciled: [
        {
          status: 'RECONCILED',
          orderId: randomUUID(),
          vendorId,
          vendorWalletNpr: 900,
          commissionNpr: 100,
          settlementPosted: true,
          reconciledAt: new Date('2026-10-02T18:15:00.000Z'),
        },
      ],
      discrepancies: [
        {
          status: 'DISCREPANCY',
          orderId,
          vendorId,
          reason: 'SETTLEMENT_MISMATCH',
          expectedVendorWalletNpr: 900,
          actualVendorWalletNpr: 800,
          message: 'settlement journal posted 800 NPR to the vendor, the order gives 900 NPR',
        },
      ],
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);

    await createTimerHandlers({
      escalation,
      debtReconciliation: noDebt,
      orderReconciliation: { reconcileDeliveredOrders },
    }).runMidnightTask('ORDER_RECONCILIATION');

    expect(reconcileDeliveredOrders).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
      audit: 'order.reconciliation_discrepancy',
      order_id: orderId,
      vendor_id: vendorId,
      reason: 'SETTLEMENT_MISMATCH',
      expected_vendor_wallet_npr: 900,
      actual_vendor_wallet_npr: 800,
      message: 'settlement journal posted 800 NPR to the vendor, the order gives 900 NPR',
    });
    expect(info).toHaveBeenCalledWith(
      '[worker] order reconciliation: 1 order(s) reconciled (1 settlement(s) posted), 1 discrepancy(ies)',
    );
    warn.mockRestore();
    info.mockRestore();
  });

  it('fails the job when the scan itself fails (BullMQ retries it)', async () => {
    const reconcileDeliveredOrders = jest.fn().mockRejectedValue(new Error('database down'));

    await expect(
      createTimerHandlers({
        escalation,
        debtReconciliation: noDebt,
        orderReconciliation: { reconcileDeliveredOrders },
      }).runMidnightTask('ORDER_RECONCILIATION'),
    ).rejects.toThrow('database down');
  });

  it('does not reconcile orders for the other midnight tasks', async () => {
    const reconcileDeliveredOrders = jest.fn();
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);

    await createTimerHandlers({
      escalation,
      debtReconciliation: noDebt,
      orderReconciliation: { reconcileDeliveredOrders },
    }).runMidnightTask('VENDOR_DEBT_RECONCILIATION');

    expect(reconcileDeliveredOrders).not.toHaveBeenCalled();
    info.mockRestore();
  });
});
