import {
  enqueueDomainEvent,
  notificationMessages,
  recordAuditLog,
  recordNotificationMessage,
  users,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import {
  ALL_CUSTOMERS_BROADCAST_INTERVAL_MINUTES,
  type AdminNotificationListQuery,
  type AdminNotificationRequest,
  type AdminNotificationView,
  type AdminVendorSearchQuery,
  type AdminVendorSearchResult,
  type AuditContext,
} from '@hamro-pasal/shared-types';
import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';

import { HttpError } from '../http/errors';

/** pg_advisory_xact_lock key serialising broadcasts to all customers (the 10-minute rule). */
const ALL_CUSTOMERS_BROADCAST_LOCK = 7_500_017;

export interface SentNotification {
  readonly messageId: string;
  readonly recipientCount: number;
}

export interface AdminNotificationPage {
  readonly notifications: readonly AdminNotificationView[];
  readonly nextCursor: string | null;
}

/** `HPV-00042`, `hpv42`, `HPV-0004` -> the Vendor Code prefix to match; null for a name search. */
export function vendorCodePrefix(q: string): string | null {
  const match = /^HPV-?(\d*)$/i.exec(q.trim());
  return match === null ? null : `HPV-${match[1] ?? ''}`;
}

/** `42` -> `HPV-00042`: a number alone is read as a Vendor Code too. */
function vendorCodeOfNumber(q: string): string | null {
  return /^\d{1,9}$/.test(q.trim()) ? `HPV-${q.trim().padStart(5, '0')}` : null;
}

const likeEscaped = (q: string): string => q.replace(/[\\%_]/g, (c) => `\\${c}`);

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

/**
 * Step 7.5 (SPEC core 11, Super Admin flow 10, verification 31): the Super Admin's push. A
 * message to chosen shops (1 to 500) or to all customers is stored once in the notification
 * centre (recipient rows for shops; a broadcast is seen by every customer whose account existed
 * when it was sent), audited, and handed to the worker through the outbox for the push itself.
 */
export class AdminNotificationService {
  constructor(private readonly db: Database) {}

  /**
   * GET /api/admin/vendors/search. A Vendor Code (or its prefix, or the bare number) matches the
   * code; anything else matches the business name by trigram similarity (pg_trgm) or substring,
   * the closest first. Every result carries its Vendor Code, so similar names are told apart.
   */
  async searchVendors(query: AdminVendorSearchQuery): Promise<AdminVendorSearchResult[]> {
    const columns = {
      id: vendors.id,
      vendor_code: vendors.vendor_code,
      business_name: vendors.business_name,
      municipality_palika_string: vendors.municipality_palika_string,
      status: vendors.status,
    };
    const prefix = vendorCodePrefix(query.q);
    if (prefix !== null) {
      return this.db
        .select(columns)
        .from(vendors)
        .where(sql`${vendors.vendor_code} LIKE ${`${likeEscaped(prefix)}%`}`)
        .orderBy(asc(vendors.vendor_code))
        .limit(query.limit);
    }
    const code = vendorCodeOfNumber(query.q);
    const q = query.q.trim();
    return this.db
      .select(columns)
      .from(vendors)
      .where(
        or(
          sql`${vendors.business_name} % ${q}`,
          sql`${vendors.business_name} ILIKE ${`%${likeEscaped(q)}%`}`,
          code === null ? undefined : eq(vendors.vendor_code, code),
        ),
      )
      .orderBy(
        // A number that is a Vendor Code puts that shop first.
        ...(code === null ? [] : [desc(sql`${vendors.vendor_code} = ${code}`)]),
        desc(sql`similarity(${vendors.business_name}, ${q})`),
        asc(vendors.business_name),
        asc(vendors.id),
      )
      .limit(query.limit);
  }

  /** POST /api/admin/notifications: stored, audited and queued in one transaction. */
  async send(
    adminUserId: string,
    request: AdminNotificationRequest,
    context: AuditContext,
  ): Promise<SentNotification> {
    return this.db.transaction(async (tx) => {
      let recipientUserIds: string[] = [];
      let recipientCount: number;
      if (request.audience === 'VENDORS') {
        const found = await tx
          .select({ id: vendors.id, userId: vendors.user_id })
          .from(vendors)
          .where(inArray(vendors.id, request.vendor_ids));
        const known = new Set(found.map((row) => row.id));
        const missing = request.vendor_ids.filter((id) => !known.has(id));
        if (missing.length > 0) {
          throw new HttpError(422, 'VENDOR_NOT_FOUND', 'Some of the chosen shops do not exist', {
            vendor_ids: missing,
          });
        }
        recipientUserIds = found.map((row) => row.userId);
        recipientCount = found.length;
      } else {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${ALL_CUSTOMERS_BROADCAST_LOCK})`);
        const [recent] = await tx
          .select({ createdAt: notificationMessages.created_at })
          .from(notificationMessages)
          .where(
            and(
              eq(notificationMessages.audience, 'ALL_CUSTOMERS'),
              eq(notificationMessages.source, 'ADMIN'),
              sql`${notificationMessages.created_at} > now() - make_interval(mins => ${ALL_CUSTOMERS_BROADCAST_INTERVAL_MINUTES})`,
            ),
          )
          .orderBy(desc(notificationMessages.created_at))
          .limit(1);
        if (recent !== undefined) {
          const retryAfter = Math.max(
            1,
            Math.ceil(
              (recent.createdAt.getTime() +
                ALL_CUSTOMERS_BROADCAST_INTERVAL_MINUTES * 60_000 -
                Date.now()) /
                1000,
            ),
          );
          throw new HttpError(
            429,
            'BROADCAST_RATE_LIMITED',
            `One broadcast to all customers per ${String(ALL_CUSTOMERS_BROADCAST_INTERVAL_MINUTES)} minutes`,
            { retry_after_seconds: retryAfter },
          );
        }
        const [customers] = await tx
          .select({ count: sql<number>`count(*)`.mapWith(Number) })
          .from(users)
          .where(eq(users.role, 'CUSTOMER'));
        recipientCount = customers?.count ?? 0;
      }

      const stored = await recordNotificationMessage(tx, {
        audience: request.audience === 'VENDORS' ? 'VENDOR' : 'ALL_CUSTOMERS',
        source: 'ADMIN',
        title: request.title,
        body: request.body,
        data: request.deep_link === undefined ? {} : { deep_link: request.deep_link },
        createdByUserId: adminUserId,
        recipientUserIds,
      });
      await tx
        .update(notificationMessages)
        .set({ recipient_count: recipientCount })
        .where(eq(notificationMessages.id, stored.id));

      await recordAuditLog(tx, {
        actor: { kind: 'USER', user_id: adminUserId, role: 'SUPER_ADMIN' },
        action: 'NOTIFICATION_SENT',
        entityId: stored.id,
        vendorId: null,
        beforeState: {},
        afterState: {
          audience: request.audience,
          title: request.title,
          body: request.body,
          recipient_count: recipientCount,
          ...(request.audience === 'VENDORS' ? { vendor_ids: request.vendor_ids } : {}),
        },
        context,
      });
      await enqueueDomainEvent(tx, {
        type: 'notification.broadcast_requested',
        aggregateId: stored.id,
        payload: {
          message_id: stored.id,
          audience: request.audience === 'VENDORS' ? 'VENDOR' : 'ALL_CUSTOMERS',
        },
      });
      return { messageId: stored.id, recipientCount };
    });
  }

  /** GET /api/admin/notifications: what Super Admins sent, newest first, with the push counts. */
  async list(query: AdminNotificationListQuery): Promise<AdminNotificationPage> {
    let after;
    if (query.cursor !== undefined) {
      const [cursor] = await this.db
        .select({ at: notificationMessages.created_at, id: notificationMessages.id })
        .from(notificationMessages)
        .where(
          and(eq(notificationMessages.id, query.cursor), eq(notificationMessages.source, 'ADMIN')),
        );
      if (cursor === undefined) {
        throw new HttpError(400, 'INVALID_CURSOR', 'The cursor is not a message sent by an admin');
      }
      after = or(
        lt(notificationMessages.created_at, cursor.at),
        and(eq(notificationMessages.created_at, cursor.at), lt(notificationMessages.id, cursor.id)),
      );
    }
    const rows = await this.db
      .select()
      .from(notificationMessages)
      .where(and(eq(notificationMessages.source, 'ADMIN'), after))
      .orderBy(desc(notificationMessages.created_at), desc(notificationMessages.id))
      .limit(query.limit + 1);
    const shown = rows.slice(0, query.limit);
    return {
      notifications: shown.map((row) => ({
        id: row.id,
        audience: row.audience,
        title: row.title,
        body: row.body,
        deep_link: typeof row.data.deep_link === 'string' ? row.data.deep_link : null,
        recipient_count: row.recipient_count ?? 0,
        push_sent: row.push_sent_count,
        push_failed: row.push_failed_count,
        push_completed_at: iso(row.push_completed_at),
        created_by_user_id: row.created_by_user_id ?? '',
        created_at: row.created_at.toISOString(),
      })),
      nextCursor: rows.length > query.limit ? (shown.at(-1)?.id ?? null) : null,
    };
  }
}
