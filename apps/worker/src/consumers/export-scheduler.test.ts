import { randomUUID } from 'node:crypto';

import type { KafkaJS } from '@hamro-pasal/kafka';
import type { Job } from 'bullmq';

import { createExportProcessor } from '../queues/processors';
import { exportSchedulerConsumer } from './export-scheduler';

function kafkaMessage(event: unknown, raw?: string): KafkaJS.EachMessagePayload {
  return {
    topic: 'notifications.broadcast',
    partition: 0,
    message: { value: Buffer.from(raw ?? JSON.stringify(event)), offset: '5' },
  } as unknown as KafkaJS.EachMessagePayload;
}

const envelope = (type: string, payload: object) => ({
  event_id: randomUUID(),
  event_type: type,
  event_version: 1,
  occurred_at: '2026-10-16T08:00:00.000Z',
  aggregate_id: randomUUID(),
  payload,
});

describe('exportSchedulerConsumer (step 7.6)', () => {
  it('puts a queued export on the DATA_EXPORT queue, and ignores everything else', async () => {
    const schedule = jest.fn((_id: string) => Promise.resolve());
    const consumer = exportSchedulerConsumer({ scheduler: { schedule } });
    const jobId = randomUUID();

    await consumer.handle(kafkaMessage(envelope('export.requested', { job_id: jobId })));
    await consumer.handle(
      kafkaMessage(
        envelope('vendor.opened', {
          vendor_id: randomUUID(),
          opened_at: '2026-10-16T08:00:00.000Z',
        }),
      ),
    );
    await consumer.handle(kafkaMessage(null, 'not json'));

    expect(schedule.mock.calls).toEqual([[jobId]]);
  });
});

describe('the DATA_EXPORT processor', () => {
  const job = (attemptsMade: number) =>
    ({ data: { job_id: randomUUID() }, attemptsMade, opts: { attempts: 3 } }) as unknown as Job;

  beforeEach(() => {
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('tells the service whether this is the last attempt', async () => {
    const run = jest.fn(() => Promise.resolve({ status: 'SKIPPED' as const }));
    const processor = createExportProcessor({ run });

    await processor(job(0));
    await processor(job(2));

    expect(run.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      { finalAttempt: false },
      { finalAttempt: true },
    ]);
  });

  it('refuses a malformed job', async () => {
    const run = jest.fn(() => Promise.resolve({ status: 'SKIPPED' as const }));
    await expect(
      createExportProcessor({ run })({
        data: { job_id: 'nope' },
        attemptsMade: 0,
        opts: {},
      } as unknown as Job),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});
