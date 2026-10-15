import { recordNotificationMessage, vendors, type Database } from '@hamro-pasal/db';
import { eq } from 'drizzle-orm';

import type { NotificationAdapter, VendorNotice } from './notification-adapter';

/** Where a vendor notice is kept for the Seller app's notification centre. */
export interface NoticeInbox {
  record(notice: VendorNotice): Promise<void>;
}

/** The dedupe key of a notice's message: one per event and shop, whatever the retries. */
export function noticeDedupeKey(notice: VendorNotice): string {
  return `notice:${notice.eventId}:${notice.vendorId}`;
}

/**
 * Stores the notice as a VENDOR message for the shop's own account (vendors.user_id). Idempotent:
 * a retried or replayed event finds its message already there. A deactivated shop's notice is
 * kept too, so it is waiting when an admin reopens the shop.
 */
export class DatabaseNoticeInbox implements NoticeInbox {
  constructor(private readonly db: Database) {}

  async record(notice: VendorNotice): Promise<void> {
    const [vendor] = await this.db
      .select({ userId: vendors.user_id })
      .from(vendors)
      .where(eq(vendors.id, notice.vendorId));
    // An unknown shop has nobody to keep it for; the SMS still goes to the number in the event.
    if (vendor === undefined) return;
    await recordNotificationMessage(this.db, {
      audience: 'VENDOR',
      source: 'SYSTEM',
      title: notice.push.title,
      body: notice.push.body,
      data: { event_type: notice.eventType },
      dedupeKey: noticeDedupeKey(notice),
      recipientUserIds: [vendor.userId],
    });
  }
}

/**
 * Step 7.1: the notification centre is written before the SMS and push are attempted. A failure
 * to store it fails the notice like a refused SMS (retried, then dead-lettered), because the
 * notification centre is the record the vendor can always come back to.
 */
export class InboxNotificationAdapter implements NotificationAdapter {
  readonly name: string;

  constructor(
    private readonly inbox: NoticeInbox,
    private readonly inner: NotificationAdapter,
  ) {
    this.name = inner.name;
  }

  async send(notice: VendorNotice): Promise<void> {
    await this.inbox.record(notice);
    await this.inner.send(notice);
  }
}
