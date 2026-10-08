import {
  AUDIT_ACTION_ENTITY_TYPES,
  auditLogEntrySchema,
  type AuditAction,
  type AuditActor,
  type AuditContext,
  type AuditLog,
  type AuditState,
} from '@hamro-pasal/shared-types';
import { z } from 'zod';

import type { Transaction } from './client';
import { auditLogs } from './schema';

/**
 * What a service hands the audit trail. `entity_type` is not here: it follows from the action.
 * `before_state` is null exactly for a creation.
 */
export interface NewAuditLog {
  readonly actor: AuditActor;
  readonly action: AuditAction;
  /** The id of the row the action is about. */
  readonly entityId: string;
  /** The shop the change concerns; null for a platform-wide change. */
  readonly vendorId: string | null;
  readonly beforeState: AuditState | null;
  readonly afterState: AuditState;
  /** Where the request came from (`auditContextOf(req)` in the API); omit for a job. */
  readonly context?: AuditContext;
}

/** The entry was refused before anything was written: a bug in the caller, never user input. */
export class InvalidAuditLogError extends Error {
  constructor(details: string) {
    super(`Refusing to write an invalid audit entry:\n${details}`);
    this.name = 'InvalidAuditLogError';
  }
}

/**
 * Appends one entry to the audit trail (SPEC core section 7).
 *
 * It takes a **transaction**, not the database: the entry must be written in the transaction of
 * the change it records, so the two commit or roll back together and a change can never exist
 * without its entry. Passing the pooled database does not type-check.
 *
 * It is the only way the code writes `audit_logs`, and it only inserts: there is no update or
 * delete counterpart, and the database refuses both (migration 0021). The entry is validated
 * with the shared contract first, which also refuses any state carrying a secret.
 *
 * Throws `InvalidAuditLogError` for an invalid entry: let it propagate, so the change it would
 * have recorded rolls back.
 */
export async function recordAuditLog(tx: Transaction, entry: NewAuditLog): Promise<AuditLog> {
  const parsed = auditLogEntrySchema.safeParse({
    actor: entry.actor,
    action: entry.action,
    entity_id: entry.entityId,
    vendor_id: entry.vendorId,
    before_state: entry.beforeState,
    after_state: entry.afterState,
    context: entry.context ?? { request_id: null, ip_address: null, user_agent: null },
  });
  if (!parsed.success) throw new InvalidAuditLogError(z.prettifyError(parsed.error));
  const { actor, action, context } = parsed.data;

  const [row] = await tx
    .insert(auditLogs)
    .values({
      actor_user_id: actor.kind === 'USER' ? actor.user_id : null,
      actor_role: actor.kind === 'USER' ? actor.role : null,
      system_actor: actor.kind === 'SYSTEM' ? actor.job : null,
      action,
      vendor_id: parsed.data.vendor_id,
      entity_type: AUDIT_ACTION_ENTITY_TYPES[action],
      entity_id: parsed.data.entity_id,
      before_state: parsed.data.before_state,
      after_state: parsed.data.after_state,
      request_id: context.request_id,
      ip_address: context.ip_address,
      user_agent: context.user_agent,
    })
    .returning();
  if (row === undefined) throw new Error('The audit entry was not stored');
  return row;
}
