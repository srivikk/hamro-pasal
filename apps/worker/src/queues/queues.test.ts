import { randomUUID } from 'node:crypto';

import type { Job } from 'bullmq';

import {
  ghostCustomerTimerOptions,
  midnightSchedulerId,
  vendorAcceptanceTimeoutOptions,
} from './definitions';
import { createProcessors, type TimerHandlers } from './processors';

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
