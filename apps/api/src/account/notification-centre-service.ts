import { notificationReads, notificationRecipients, type Database } from '@hamro-pasal/db';
import type { NotificationView } from '@hamro-pasal/shared-types';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';

import { HttpError } from '../http/errors';

/** Whose notification centre: the token's account and the role it signed in with. */
export interface InboxOwner {
  readonly userId: string;
  /** Broadcasts to all customers are seen by an account signed in as a customer. */
  readonly signedInAsCustomer: boolean;
}

interface VisibleRow extends Record<string, unknown> {
  id: string;
  audience: NotificationView['audience'];
  source: NotificationView['source'];
  title: string;
  body: string;
  data: Record<string, unknown>;
  created_at: Date | string;
  read_at: Date | string | null;
  /** RECIPIENT: a targeted message; BROADCAST: an ALL_CUSTOMERS one. */
  via: 'RECIPIENT' | 'BROADCAST';
}

const iso = (value: Date | string): string => new Date(value).toISOString();

function viewOf(row: VisibleRow): NotificationView {
  return {
    id: row.id,
    audience: row.audience,
    source: row.source,
    title: row.title,
    body: row.body,
    data: row.data as NotificationView['data'],
    created_at: iso(row.created_at),
    read_at: row.read_at === null ? null : iso(row.read_at),
  };
}

/**
 * Every message the owner may see: its own recipient rows, and (signed in as a customer) the
 * broadcasts sent since its account was created (SPEC edge case 23). Read receipts of broadcasts
 * live in notification_reads, one row per reader, so a broadcast is stored once.
 */
function visible(owner: InboxOwner): SQL {
  return sql`
    SELECT m.id, m.audience, m.source, m.title, m.body, m.data, m.created_at, r.read_at,
           'RECIPIENT' AS via
      FROM notification_messages m
      JOIN notification_recipients r ON r.message_id = m.id AND r.user_id = ${owner.userId}
    UNION ALL
    SELECT m.id, m.audience, m.source, m.title, m.body, m.data, m.created_at, nr.read_at,
           'BROADCAST' AS via
      FROM notification_messages m
      LEFT JOIN notification_reads nr ON nr.message_id = m.id AND nr.user_id = ${owner.userId}
     WHERE ${owner.signedInAsCustomer}
       AND m.audience = 'ALL_CUSTOMERS'
       AND m.created_at >= (SELECT u.created_at FROM users u WHERE u.id = ${owner.userId})`;
}

/** The notification centre of the signed-in account (step 7.1, SPEC core 11). */
export class NotificationCentreService {
  constructor(private readonly db: Database) {}

  /** Newest first, keyset on (created_at, id), compared in SQL. */
  async list(
    owner: InboxOwner,
    page: { limit: number; cursor?: string | undefined },
  ): Promise<{ notifications: NotificationView[]; nextCursor: string | null }> {
    let after = sql``;
    if (page.cursor !== undefined) {
      const { rows } = await this.db.execute<{ id: string }>(
        sql`SELECT v.id FROM (${visible(owner)}) v WHERE v.id = ${page.cursor}`,
      );
      if (rows[0] === undefined) {
        throw new HttpError(400, 'INVALID_CURSOR', 'The cursor is not one of your notifications');
      }
      after = sql`WHERE (v.created_at, v.id) < (
        (SELECT created_at FROM notification_messages WHERE id = ${page.cursor}), ${page.cursor}::uuid)`;
    }
    const { rows } = await this.db.execute<VisibleRow>(
      sql`SELECT * FROM (${visible(owner)}) v ${after}
          ORDER BY v.created_at DESC, v.id DESC LIMIT ${page.limit + 1}`,
    );
    const shown = rows.slice(0, page.limit);
    return {
      notifications: shown.map(viewOf),
      nextCursor: rows.length > page.limit ? (shown.at(-1)?.id ?? null) : null,
    };
  }

  async unreadCount(owner: InboxOwner): Promise<number> {
    const { rows } = await this.db.execute<{ unread: number }>(
      sql`SELECT count(*)::int AS unread FROM (${visible(owner)}) v WHERE v.read_at IS NULL`,
    );
    return rows[0]?.unread ?? 0;
  }

  /** Marks one message read (also on repeat: the first time is kept). */
  async read(owner: InboxOwner, messageId: string): Promise<NotificationView> {
    const row = await this.find(owner, messageId);
    if (row.via === 'RECIPIENT') {
      await this.db
        .update(notificationRecipients)
        .set({ read_at: sql`coalesce(${notificationRecipients.read_at}, now())` })
        .where(
          and(
            eq(notificationRecipients.message_id, messageId),
            eq(notificationRecipients.user_id, owner.userId),
          ),
        );
    } else {
      await this.db
        .insert(notificationReads)
        .values({ message_id: messageId, user_id: owner.userId })
        .onConflictDoNothing();
    }
    return viewOf(await this.find(owner, messageId));
  }

  /** Marks everything the owner sees read; answers how many were unread. */
  async readAll(owner: InboxOwner): Promise<number> {
    return this.db.transaction(async (tx) => {
      const targeted = await tx
        .update(notificationRecipients)
        .set({ read_at: sql`now()` })
        .where(
          and(
            eq(notificationRecipients.user_id, owner.userId),
            isNull(notificationRecipients.read_at),
          ),
        )
        .returning({ id: notificationRecipients.message_id });
      const { rows } = await tx.execute<{ message_id: string }>(sql`
        INSERT INTO notification_reads (message_id, user_id)
        SELECT v.id, ${owner.userId}::uuid FROM (${visible(owner)}) v
         WHERE v.via = 'BROADCAST' AND v.read_at IS NULL
        ON CONFLICT DO NOTHING
        RETURNING message_id`);
      return targeted.length + rows.length;
    });
  }

  /** Someone else's message, or one the owner cannot see, is the same 404 as an unknown id. */
  private async find(owner: InboxOwner, messageId: string): Promise<VisibleRow> {
    const { rows } = await this.db.execute<VisibleRow>(
      sql`SELECT * FROM (${visible(owner)}) v WHERE v.id = ${messageId}`,
    );
    const row = rows[0];
    if (row === undefined) {
      throw new HttpError(404, 'NOTIFICATION_NOT_FOUND', 'Notification not found');
    }
    return row;
  }
}
