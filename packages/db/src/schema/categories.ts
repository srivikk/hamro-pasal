import { CATEGORY_SLUG_PATTERN } from '@hamro-pasal/shared-types';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { createdAt, primaryId, updatedAt } from './columns';

/**
 * Phase 17: the Super Admin's Master Category Taxonomy (SPEC Super Admin flow 2), a tree through
 * `parent_id`. Cycles and the depth limit are enforced by the API's CategoryService, which
 * serialises every taxonomy write; the database refuses a self-parent and deleting a category that
 * still has children or products (both foreign keys are RESTRICT).
 */
export const categories = pgTable(
  'categories',
  {
    id: primaryId(),
    name: text().notNull(),
    slug: text().notNull(),
    parent_id: uuid().references((): AnyPgColumn => categories.id, { onDelete: 'restrict' }),
    icon_url: text(),
    display_order: integer().notNull().default(0),
    is_active: boolean().notNull().default(true),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    unique('categories_slug_key').on(t.slug),
    index('categories_parent_id_display_order_idx').on(t.parent_id, t.display_order),
    check('categories_name_check', sql`btrim(${t.name}) <> ''`),
    check('categories_slug_check', sql`${t.slug} ~ '${sql.raw(CATEGORY_SLUG_PATTERN)}'`),
    check('categories_icon_url_check', sql`${t.icon_url} IS NULL OR btrim(${t.icon_url}) <> ''`),
    check('categories_display_order_check', sql`${t.display_order} >= 0`),
    check('categories_not_own_parent_check', sql`${t.parent_id} IS DISTINCT FROM ${t.id}`),
  ],
);
