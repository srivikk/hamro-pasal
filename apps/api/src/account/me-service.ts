import { users, type Database } from '@hamro-pasal/db';
import type { MePatchRequest, MeUser } from '@hamro-pasal/shared-types';
import { eq, sql } from 'drizzle-orm';

import { HttpError } from '../http/errors';
import { isUniqueViolation } from '../infra/pg-errors';

type UserRow = typeof users.$inferSelect;

/**
 * "Sita Kumari Gurung" is stored as first_name "Sita", last_name "Kumari Gurung". Kept apart so
 * the dispute chat's privacy filter (SPEC implicit requirement 6) keeps showing the first name
 * only; full_name is their join.
 */
export function splitFullName(fullName: string): { first: string; last: string | null } {
  const [first = '', ...rest] = fullName.split(' ');
  return { first, last: rest.length > 0 ? rest.join(' ') : null };
}

export function meView(row: UserRow): MeUser {
  const fullName = [row.first_name, row.last_name].filter((part) => part !== null).join(' ');
  return {
    id: row.id,
    phone: row.phone,
    role: row.role,
    full_name: fullName === '' ? null : fullName,
    email: row.email,
    profile_complete: row.first_name !== null,
    language_preference: row.language_preference,
    terms_accepted_at: row.terms_accepted_at?.toISOString() ?? null,
    whatsapp_opt_in: row.whatsapp_opt_in,
    account_status: row.account_status,
  };
}

/** The signed-in account's own record (step 7.1, STATE_HANDOFF §8Z.10). Any role. */
export class MeService {
  constructor(private readonly db: Database) {}

  async get(userId: string): Promise<MeUser> {
    const [row] = await this.db.select().from(users).where(eq(users.id, userId));
    if (row === undefined) throw accountGone();
    return meView(row);
  }

  /** One statement: only the keys sent change. A second `accept_terms` keeps the first stamp. */
  async update(userId: string, patch: MePatchRequest): Promise<MeUser> {
    const name = patch.full_name === undefined ? undefined : splitFullName(patch.full_name);
    let row: UserRow | undefined;
    try {
      [row] = await this.db
        .update(users)
        .set({
          ...(name === undefined ? {} : { first_name: name.first, last_name: name.last }),
          ...(patch.email === undefined ? {} : { email: patch.email }),
          ...(patch.language_preference === undefined
            ? {}
            : { language_preference: patch.language_preference }),
          ...(patch.whatsapp_opt_in === undefined
            ? {}
            : { whatsapp_opt_in: patch.whatsapp_opt_in }),
          ...(patch.accept_terms === true
            ? { terms_accepted_at: sql`coalesce(${users.terms_accepted_at}, now())` }
            : {}),
        })
        .where(eq(users.id, userId))
        .returning();
    } catch (error: unknown) {
      if (isUniqueViolation(error, 'users_email_uidx')) {
        throw new HttpError(409, 'EMAIL_TAKEN', 'This email is already used by another account');
      }
      throw error;
    }
    if (row === undefined) throw accountGone();
    return meView(row);
  }
}

/** A valid token whose account was deleted: the app's refresh then ends the session. */
function accountGone(): HttpError {
  return new HttpError(401, 'UNAUTHENTICATED', 'Invalid or expired token');
}
