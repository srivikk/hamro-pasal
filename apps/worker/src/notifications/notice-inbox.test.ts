import { randomUUID } from 'node:crypto';

import type { NotificationAdapter, VendorNotice } from './notification-adapter';
import { InboxNotificationAdapter, noticeDedupeKey, type NoticeInbox } from './notice-inbox';

function noticeOf(): VendorNotice {
  return {
    eventId: randomUUID(),
    eventType: 'marketing.ad_ended',
    vendorId: randomUUID(),
    phone: '+9779800000011',
    sms: 'Hamro Pasal: your ad ended.',
    push: { title: 'Your ad has ended', body: 'Open Marketing to book your next ad.' },
  };
}

describe('InboxNotificationAdapter', () => {
  it('keeps the notice in the notification centre before the SMS and push are attempted', async () => {
    const order: string[] = [];
    const inbox: NoticeInbox = {
      record: () => {
        order.push('inbox');
        return Promise.resolve();
      },
    };
    const inner: NotificationAdapter = {
      name: 'SPARROW',
      send: () => {
        order.push('send');
        return Promise.resolve();
      },
    };
    const adapter = new InboxNotificationAdapter(inbox, inner);

    await adapter.send(noticeOf());

    expect(order).toEqual(['inbox', 'send']);
    expect(adapter.name).toBe('SPARROW');
  });

  it('fails the notice, sending nothing, when it cannot be stored', async () => {
    const send = jest.fn(() => Promise.resolve());
    const adapter = new InboxNotificationAdapter(
      { record: () => Promise.reject(new Error('database down')) },
      { name: 'SPARROW', send },
    );

    await expect(adapter.send(noticeOf())).rejects.toThrow('database down');
    expect(send).not.toHaveBeenCalled();
  });

  it('fails the notice when the SMS fails, after storing it (a retry finds it stored)', async () => {
    const record = jest.fn(() => Promise.resolve());
    const adapter = new InboxNotificationAdapter(
      { record },
      { name: 'SPARROW', send: () => Promise.reject(new Error('SPARROW SMS failed: HTTP 503')) },
    );

    await expect(adapter.send(noticeOf())).rejects.toThrow('HTTP 503');
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('keys each message by event and shop', () => {
    const notice = noticeOf();
    expect(noticeDedupeKey(notice)).toBe(`notice:${notice.eventId}:${notice.vendorId}`);
  });
});
