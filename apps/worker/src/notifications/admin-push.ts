import {
  deviceTokens,
  notificationMessages,
  notificationRecipients,
  users,
  type Database,
} from '@hamro-pasal/db';
import { and, asc, eq, gt, inArray, isNull, sql, type SQL } from 'drizzle-orm';

import type { ExpoPushMessage, PushGateway } from '../push/expo-push';
import { EXPO_DEVICE_NOT_REGISTERED, EXPO_PUSH_BATCH_SIZE } from '../push/expo-push';

/** Device tokens read per page (each page is one Expo request of up to 100 messages). */
export const ADMIN_PUSH_PAGE_SIZE = EXPO_PUSH_BATCH_SIZE;

export type AdminPushOutcome =
  | { readonly status: 'PUSHED'; readonly sent: number; readonly failed: number }
  | { readonly status: 'SKIPPED' };

/**
 * Step 7.5 (SPEC core 11): pushes a message the Super Admin sent. The notification centre already
 * holds it (written with the send), so the push is best effort and happens at most once: the
 * first worker to stamp `push_started_at` sends it; a redelivered event finds it claimed and does
 * nothing. Device tokens are paged by id, 100 per Expo request: a shop's own devices for a
 * VENDOR message, every customer's devices (accounts that existed when it was sent) for an
 * ALL_CUSTOMERS one. Tokens Expo reports as DeviceNotRegistered are deleted; a request that fails
 * as a whole counts its devices as failed and the next page is still sent. The totals are
 * recorded on the message for the admin's history.
 */
export class AdminPushService {
  constructor(
    private readonly db: Database,
    private readonly push: PushGateway,
    private readonly pageSize = ADMIN_PUSH_PAGE_SIZE,
  ) {}

  async deliver(messageId: string): Promise<AdminPushOutcome> {
    const [message] = await this.db
      .update(notificationMessages)
      .set({ push_started_at: sql`now()` })
      .where(
        and(
          eq(notificationMessages.id, messageId),
          eq(notificationMessages.source, 'ADMIN'),
          isNull(notificationMessages.push_started_at),
        ),
      )
      .returning();
    if (message === undefined) return { status: 'SKIPPED' };

    // Qualified by hand: in this one-table select Drizzle prints the token owner column as a bare
    // "user_id", which inside the subquery would bind to notification_recipients.user_id.
    const owner = sql.raw('"device_tokens"."user_id"');
    const audience: SQL =
      message.audience === 'ALL_CUSTOMERS'
        ? sql`EXISTS (SELECT 1 FROM ${users} u WHERE u.id = ${owner}
              AND u.role = 'CUSTOMER' AND u.created_at <= ${message.created_at})`
        : sql`EXISTS (SELECT 1 FROM ${notificationRecipients} r WHERE r.message_id = ${message.id}
              AND r.user_id = ${owner})`;
    const data = {
      type: 'admin.message',
      message_id: message.id,
      ...(typeof message.data.deep_link === 'string' ? { deep_link: message.data.deep_link } : {}),
    };

    let sent = 0;
    let failed = 0;
    let after: string | null = null;
    for (;;) {
      const page: { id: string; token: string }[] = await this.db
        .select({ id: deviceTokens.id, token: deviceTokens.token })
        .from(deviceTokens)
        .where(and(audience, after === null ? undefined : gt(deviceTokens.id, after)))
        .orderBy(asc(deviceTokens.id))
        .limit(this.pageSize);
      if (page.length === 0) break;
      after = page.at(-1)?.id ?? null;

      const messages: ExpoPushMessage[] = page.map(({ token }) => ({
        to: token,
        title: message.title,
        body: message.body,
        sound: 'default',
        priority: 'default',
        data,
      }));
      try {
        const tickets = await this.push.send(messages);
        const gone: string[] = [];
        for (const ticket of tickets) {
          if (ticket.status === 'ok') sent += 1;
          else {
            failed += 1;
            if (ticket.error === EXPO_DEVICE_NOT_REGISTERED) gone.push(ticket.token);
          }
        }
        if (gone.length > 0) {
          await this.db.delete(deviceTokens).where(inArray(deviceTokens.token, gone));
        }
      } catch (error: unknown) {
        failed += page.length;
        console.error(
          JSON.stringify({
            notification: 'admin_push.request_failed',
            message_id: message.id,
            devices: page.length,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      if (page.length < this.pageSize) break;
    }

    await this.db
      .update(notificationMessages)
      .set({ push_sent_count: sent, push_failed_count: failed, push_completed_at: sql`now()` })
      .where(eq(notificationMessages.id, message.id));
    return { status: 'PUSHED', sent, failed };
  }
}
