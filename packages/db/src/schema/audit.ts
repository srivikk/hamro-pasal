import {
  AUDIT_ACTION_PATTERN,
  type AuditAction,
  type AuditEntityType,
  type AuditState,
} from '@hamro-pasal/shared-types';
import { sql } from 'drizzle-orm';
import { check, index, inet, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { primaryId } from './columns';
import { userRoleEnum } from './enums';
import { users } from './users';
import { vendors } from './vendors';

/**
 * Phase 25: the audit trail (SPEC core section 7, "Audit"). One row per audited change, inserted
 * by `recordAuditLog` in the same transaction as the change, so the row exists if and only if the
 * change committed.
 *
 * APPEND-ONLY, enforced by the database and not by convention: the triggers of migration 0021
 * refuse UPDATE, DELETE and TRUNCATE for every role. A wrong entry is corrected by a later entry,
 * never by editing this one.
 *
 * `action` and `entity_type` are text (checked by shape), so a new action needs no enum migration;
 * the allowed values are `AUDIT_ACTION_ENTITY_TYPES` in shared-types.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: primaryId(),
    /** The database clock at the insert (not the transaction's start time). */
    occurred_at: timestamp({ withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
    /** The signed-in account that acted; null when the platform itself did (see `system_actor`). */
    actor_user_id: uuid().references(() => users.id, { onDelete: 'restrict' }),
    /** The role the actor's access token carried at that moment. */
    actor_role: userRoleEnum(),
    /** The scheduled job that acted (BILLING_CYCLE_RENEWAL, …); set exactly when no user did. */
    system_actor: text(),
    action: text().$type<AuditAction>().notNull(),
    /** The shop the change concerns; null for a platform-wide change. */
    vendor_id: uuid().references(() => vendors.id, { onDelete: 'restrict' }),
    entity_type: text().$type<AuditEntityType>().notNull(),
    entity_id: uuid().notNull(),
    /** Null exactly for a creation. */
    before_state: jsonb().$type<AuditState>(),
    after_state: jsonb().$type<AuditState>().notNull(),
    request_id: text(),
    ip_address: inet(),
    user_agent: text(),
  },
  (t) => [
    // The admin's list: newest first, keyset on (occurred_at, id).
    index('audit_logs_occurred_at_idx').on(t.occurred_at, t.id),
    // One shop's history; also serves the vendors FK check.
    index('audit_logs_vendor_idx')
      .on(t.vendor_id, t.occurred_at)
      .where(sql`${t.vendor_id} IS NOT NULL`),
    // One record's history (a dispute: "who opted this shop in, and when").
    index('audit_logs_entity_idx').on(t.entity_type, t.entity_id, t.occurred_at),
    // Serves the users FK check; a job's rows name no user.
    index('audit_logs_actor_user_id_idx')
      .on(t.actor_user_id)
      .where(sql`${t.actor_user_id} IS NOT NULL`),
    // Exactly one kind of actor: a user with their role, or a named job.
    check(
      'audit_logs_actor_check',
      sql`(${t.actor_user_id} IS NOT NULL AND ${t.actor_role} IS NOT NULL AND ${t.system_actor} IS NULL)
        OR (${t.actor_user_id} IS NULL AND ${t.actor_role} IS NULL AND ${t.system_actor} IS NOT NULL)`,
    ),
    check(
      'audit_logs_system_actor_check',
      sql`${t.system_actor} IS NULL OR ${t.system_actor} ~ ${sql.raw(`'${AUDIT_ACTION_PATTERN}'`)}`,
    ),
    check('audit_logs_action_check', sql`${t.action} ~ ${sql.raw(`'${AUDIT_ACTION_PATTERN}'`)}`),
    check('audit_logs_entity_type_check', sql`${t.entity_type} ~ '^[a-z][a-z0-9_]*$'`),
    // A state is a JSON object: never an array, a scalar or the JSON null.
    check(
      'audit_logs_before_state_check',
      sql`${t.before_state} IS NULL OR jsonb_typeof(${t.before_state}) = 'object'`,
    ),
    check('audit_logs_after_state_check', sql`jsonb_typeof(${t.after_state}) = 'object'`),
  ],
);
