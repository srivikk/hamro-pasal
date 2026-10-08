import { auditLogs, users, vendors, type Database } from '@hamro-pasal/db';
import {
  ADMIN_AUDIT_LOG_DEFAULT_LIMIT,
  type AdminAuditLogListQuery,
  type AuditLog,
} from '@hamro-pasal/shared-types';
import { and, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

export interface AuditLogRow {
  readonly entry: AuditLog;
  /** The actor's own name and number; null for a job's entry. */
  readonly actorFirstName: string | null;
  readonly actorPhone: string | null;
  /** The shop a VENDOR actor runs. */
  readonly actorShopName: string | null;
  /** The shop the change concerns. */
  readonly vendorName: string | null;
}

export interface AuditLogPage {
  readonly rows: readonly AuditLogRow[];
  readonly nextCursor: string | null;
}

/** The `cursor` is not a stored audit entry. */
export class InvalidAuditLogCursorError extends Error {
  constructor(readonly cursor: string) {
    super(`Cursor ${cursor} is not an audit entry`);
    this.name = 'InvalidAuditLogCursorError';
  }
}

/**
 * The Super Admin's view of the audit trail (SPEC core section 7). READ ONLY: this service has
 * one method and it selects. Entries are written by `recordAuditLog` in the transaction of the
 * change they record, and the database refuses every UPDATE, DELETE and TRUNCATE on the table.
 */
export class AuditLogService {
  constructor(private readonly db: Database) {}

  /** Newest first, keyset-paginated on (occurred_at, id), compared in SQL (microsecond exact). */
  async list({
    vendor_id: vendorId,
    actor_user_id: actorUserId,
    entity_type: entityType,
    entity_id: entityId,
    action,
    limit = ADMIN_AUDIT_LOG_DEFAULT_LIMIT,
    cursor,
  }: AdminAuditLogListQuery): Promise<AuditLogPage> {
    if (cursor !== undefined) {
      const [known] = await this.db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(eq(auditLogs.id, cursor));
      if (known === undefined) throw new InvalidAuditLogCursorError(cursor);
    }
    const actor = alias(users, 'actor');
    const actorShop = alias(vendors, 'actor_shop');
    const subjectShop = alias(vendors, 'subject_shop');
    const rows = await this.db
      .select({
        entry: auditLogs,
        actorFirstName: actor.first_name,
        actorPhone: actor.phone,
        actorShopName: actorShop.business_name,
        vendorName: subjectShop.business_name,
      })
      .from(auditLogs)
      .leftJoin(actor, eq(actor.id, auditLogs.actor_user_id))
      // vendors.user_id is unique: at most one shop per actor, so the join adds no rows.
      .leftJoin(
        actorShop,
        and(eq(actorShop.user_id, auditLogs.actor_user_id), eq(auditLogs.actor_role, 'VENDOR')),
      )
      .leftJoin(subjectShop, eq(subjectShop.id, auditLogs.vendor_id))
      .where(
        and(
          vendorId === undefined ? undefined : eq(auditLogs.vendor_id, vendorId),
          actorUserId === undefined ? undefined : eq(auditLogs.actor_user_id, actorUserId),
          entityType === undefined ? undefined : sql`${auditLogs.entity_type} = ${entityType}`,
          entityId === undefined ? undefined : eq(auditLogs.entity_id, entityId),
          action === undefined ? undefined : sql`${auditLogs.action} = ${action}`,
          cursor === undefined
            ? undefined
            : sql`(${auditLogs.occurred_at}, ${auditLogs.id}) <
                (SELECT c.occurred_at, c.id FROM audit_logs c WHERE c.id = ${cursor})`,
        ),
      )
      .orderBy(desc(auditLogs.occurred_at), desc(auditLogs.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      rows: page,
      nextCursor: rows.length > limit && last !== undefined ? last.entry.id : null,
    };
  }
}
