import { randomUUID } from 'node:crypto';

import { authEvents, recordAuditLog, type Database } from '@hamro-pasal/db';
import {
  maskPhone,
  NO_AUDIT_CONTEXT,
  type AdminAuthLogListQuery,
  type AdminOtpRevealRequest,
  type AuditContext,
  type AuthLogEntry,
} from '@hamro-pasal/shared-types';
import { and, desc, eq, sql } from 'drizzle-orm';

import { HttpError } from '../http/http-error';
import type { LiveOtp, OtpStore } from './otp-store';

export interface AuthLogPage {
  readonly entries: readonly AuthLogEntry[];
  readonly nextCursor: string | null;
  readonly revealEnabled: boolean;
}

export interface RevealedOtp extends LiveOtp {
  readonly phone: string;
}

/**
 * 2026-10-21 (Task 5, decided by the user: "guarded reveal"): the Super Admin's Authentication
 * Logs, a failsafe when an SMS is late.
 *
 * - `list`: every send and check, newest first, filterable by number; the newest send of a number
 *   whose code is still live is marked revealable.
 * - `reveal`: the live code of one number, only where OTP_ADMIN_REVEAL is on, only with a written
 *   reason, and always written to the audit trail first (the masked number and the reason; never
 *   the code). Revealing counts no attempt and does not use the code up.
 */
export class AuthLogService {
  constructor(
    private readonly db: Database,
    private readonly otps: Pick<OtpStore, 'peek' | 'revealable' | 'revealEnabled'>,
  ) {}

  async list({ phone, cursor, limit }: AdminAuthLogListQuery): Promise<AuthLogPage> {
    const rows = await this.db
      .select()
      .from(authEvents)
      .where(
        and(
          phone === undefined ? undefined : eq(authEvents.phone, phone),
          cursor === undefined
            ? undefined
            : sql`(${authEvents.created_at}, ${authEvents.id}) <
                (SELECT c.created_at, c.id FROM auth_events c WHERE c.id = ${cursor})`,
        ),
      )
      .orderBy(desc(authEvents.created_at), desc(authEvents.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);

    // The newest send of each number on the page, if its code is still live.
    const phones = [...new Set(page.map((row) => row.phone))];
    const live = await this.otps.revealable(phones);
    const newestSends =
      live.size === 0
        ? new Set<string>()
        : new Set(
            (
              await this.db
                .selectDistinctOn([authEvents.phone], { id: authEvents.id })
                .from(authEvents)
                .where(
                  and(sql`${authEvents.phone} IN ${[...live]}`, eq(authEvents.kind, 'OTP_SENT')),
                )
                .orderBy(authEvents.phone, desc(authEvents.created_at), desc(authEvents.id))
            ).map((row) => row.id),
          );

    return {
      entries: page.map((row) => ({
        id: row.id,
        phone: row.phone,
        user_id: row.user_id,
        kind: row.kind,
        detail: row.detail,
        created_at: row.created_at.toISOString(),
        revealable: newestSends.has(row.id),
      })),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      revealEnabled: this.otps.revealEnabled,
    };
  }

  async reveal(
    adminUserId: string,
    { phone, reason }: AdminOtpRevealRequest,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<RevealedOtp> {
    if (!this.otps.revealEnabled) {
      throw new HttpError(
        403,
        'OTP_REVEAL_DISABLED',
        'Login codes are not revealable on this server (OTP_ADMIN_REVEAL is off)',
      );
    }
    const live = await this.otps.peek(phone);
    if (live === null) {
      throw new HttpError(404, 'OTP_NOT_LIVE', 'No live login code for this number');
    }
    const [send] = await this.db
      .select({ id: authEvents.id })
      .from(authEvents)
      .where(and(eq(authEvents.phone, phone), eq(authEvents.kind, 'OTP_SENT')))
      .orderBy(desc(authEvents.created_at), desc(authEvents.id))
      .limit(1);
    // The trail is written before the code leaves the server: no reveal without its entry.
    await this.db.transaction((tx) =>
      recordAuditLog(tx, {
        actor: { kind: 'USER', user_id: adminUserId, role: 'SUPER_ADMIN' },
        action: 'LOGIN_CODE_REVEALED',
        // The send's log row; a fresh id if that row was never written (the log is best effort).
        entityId: send?.id ?? randomUUID(),
        vendorId: null,
        beforeState: null,
        afterState: { phone_masked: maskPhone(phone), reason, send_logged: send !== undefined },
        context,
      }),
    );
    return { phone, ...live };
  }
}
