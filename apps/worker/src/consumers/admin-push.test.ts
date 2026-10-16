import { randomUUID } from 'node:crypto';

import type { KafkaJS } from '@hamro-pasal/kafka';

import { adminPushConsumer } from './admin-push';

function kafkaMessage(event: unknown, raw?: string): KafkaJS.EachMessagePayload {
  return {
    topic: 'notifications.broadcast',
    partition: 0,
    message: { value: Buffer.from(raw ?? JSON.stringify(event)), offset: '3' },
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

describe('adminPushConsumer (step 7.5)', () => {
  beforeEach(() => {
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('pushes the message a Super Admin sent', async () => {
    const deliver = jest.fn((_id: string) =>
      Promise.resolve({ status: 'PUSHED' as const, sent: 2, failed: 0 }),
    );
    const messageId = randomUUID();
    await adminPushConsumer({ adminPush: { deliver } }).handle(
      kafkaMessage(
        envelope('notification.broadcast_requested', { message_id: messageId, audience: 'VENDOR' }),
      ),
    );
    expect(deliver).toHaveBeenCalledWith(messageId);
  });

  it('ignores other events and broken envelopes, and lets a failure through for a retry', async () => {
    const deliver = jest.fn((_id: string) => Promise.reject(new Error('database down')));
    const consumer = adminPushConsumer({ adminPush: { deliver } });
    await consumer.handle(
      kafkaMessage(
        envelope('vendor.opened', {
          vendor_id: randomUUID(),
          opened_at: '2026-10-16T08:00:00.000Z',
        }),
      ),
    );
    await consumer.handle(kafkaMessage(null, '{oops'));
    expect(deliver).not.toHaveBeenCalled();

    await expect(
      consumer.handle(
        kafkaMessage(
          envelope('notification.broadcast_requested', {
            message_id: randomUUID(),
            audience: 'ALL_CUSTOMERS',
          }),
        ),
      ),
    ).rejects.toThrow('database down');
  });
});
