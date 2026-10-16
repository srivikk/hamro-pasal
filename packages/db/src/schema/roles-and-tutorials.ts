import { appVariants } from '@hamro-pasal/shared-types';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, primaryId, updatedAt } from './columns';
import { userRoleEnum } from './enums';
import { users } from './users';

/**
 * Step 7.7 (decided 2026-10-15: one account, several roles). Every role an account holds; each app
 * signs in with its own role for the number. `users.role` stays as the primary role until every
 * reader has moved here.
 */
export const userRoles = pgTable(
  'user_roles',
  {
    user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: userRoleEnum().notNull(),
    granted_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.user_id, t.role] })],
);

export const appVariantEnum = pgEnum('app_variant', appVariants);

/** Step 7.8 (SPEC core 11): the tutorial videos each app shows, managed by a Super Admin. */
export const appTutorials = pgTable(
  'app_tutorials',
  {
    id: primaryId(),
    app: appVariantEnum().notNull(),
    youtube_video_id: text().notNull(),
    title: text().notNull(),
    display_order: integer().notNull().default(0),
    is_active: boolean().notNull().default(true),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    index('app_tutorials_app_order_idx').on(t.app, t.display_order),
    check(
      'app_tutorials_youtube_video_id_check',
      sql`${t.youtube_video_id} ~ '^[A-Za-z0-9_-]{11}$'`,
    ),
    check('app_tutorials_title_check', sql`char_length(btrim(${t.title})) BETWEEN 1 AND 80`),
    check('app_tutorials_display_order_check', sql`${t.display_order} >= 0`),
  ],
);
