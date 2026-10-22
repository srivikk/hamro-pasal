import { authEvents, users, type Database } from '@hamro-pasal/db';
import type { AuthEventKind } from '@hamro-pasal/shared-types';
import { eq, sql } from 'drizzle-orm';

/** Where login-code sends and checks are logged (2026-10-21, the Authentication Logs). */
export interface AuthEventLog {
  record(phone: string, kind: AuthEventKind, detail?: string | null): Promise<void>;
}

/** Logs nothing: tests of the sign-in itself, and anything built before the log existed. */
export const NO_AUTH_EVENT_LOG: AuthEventLog = { record: () => Promise.resolve() };

/**
 * One auth_events row per event, with the number's account when one exists. Best effort: a
 * failed write is reported and swallowed, so the log can never stop anyone from signing in.
 */
export class DatabaseAuthEventLog implements AuthEventLog {
  constructor(
    private readonly db: Database,
    private readonly onError: (error: unknown) => void = (error) => {
      console.error('[api] auth event not logged', error);
    },
  ) {}

  async record(phone: string, kind: AuthEventKind, detail: string | null = null): Promise<void> {
    try {
      await this.db.insert(authEvents).values({
        phone,
        kind,
        detail,
        user_id: sql`(${this.db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.phone, phone))
          .limit(1)})`,
      });
    } catch (error: unknown) {
      this.onError(error);
    }
  }
}
