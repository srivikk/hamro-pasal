import { authEventKinds, type AuthEventKind } from '@hamro-pasal/shared-types';
import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { createdAt, primaryId } from './columns';
import { users } from './users';

/**
 * 2026-10-21 (Task 5): the Authentication Logs. One row per login-code send and per check, by
 * number; never the code. Read by the Super Admin's Authentication Logs screen (newest first,
 * by number). `kind` is text checked against the list, so a new kind needs no enum migration.
 */
export const authEvents = pgTable(
  'auth_events',
  {
    id: primaryId(),
    phone: text().notNull(),
    user_id: uuid().references(() => users.id, { onDelete: 'set null' }),
    kind: text().$type<AuthEventKind>().notNull(),
    /** The gateway's error, or the attempts left. Never the code. */
    detail: text(),
    created_at: createdAt(),
  },
  (t) => [
    index('auth_events_created_at_idx').on(t.created_at, t.id),
    index('auth_events_phone_created_at_idx').on(t.phone, t.created_at),
    check(
      'auth_events_kind_check',
      sql.raw(`kind IN (${authEventKinds.map((kind) => `'${kind}'`).join(', ')})`),
    ),
    check('auth_events_phone_check', sql`${t.phone} ~ '^\\+977[0-9]{10}$'`),
  ],
);
