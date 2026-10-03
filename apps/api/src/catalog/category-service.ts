import { categories, products, type Database, type Transaction } from '@hamro-pasal/db';
import {
  buildCategoryTree,
  flattenCategoryTree,
  MAX_CATEGORY_DEPTH,
  type AdminCategoryWrite,
} from '@hamro-pasal/shared-types';
import { count, eq, sql } from 'drizzle-orm';

import { isForeignKeyViolation, isUniqueViolation } from '../infra/pg-errors';
import { placementProblem } from './taxonomy-rules';

export type CategoryRow = typeof categories.$inferSelect;
export type AdminCategoryRow = CategoryRow & { readonly product_count: number };

export class CategoryNotFoundError extends Error {
  constructor(readonly categoryId: string) {
    super(`Category ${categoryId} not found`);
    this.name = 'CategoryNotFoundError';
  }
}

export class CategorySlugTakenError extends Error {
  constructor(readonly slug: string) {
    super(`Another category already uses the slug "${slug}"`);
    this.name = 'CategorySlugTakenError';
  }
}

export class CategoryParentNotFoundError extends Error {
  constructor(readonly parentId: string) {
    super(`Parent category ${parentId} does not exist`);
    this.name = 'CategoryParentNotFoundError';
  }
}

/** The new parent is the category itself or one of its own descendants. */
export class CategoryCycleError extends Error {
  constructor(
    readonly categoryId: string,
    readonly parentId: string,
  ) {
    super('A category cannot be moved under itself or one of its own subcategories');
    this.name = 'CategoryCycleError';
  }
}

export class CategoryTooDeepError extends Error {
  constructor(readonly maxDepth: number) {
    super(`Categories may be nested at most ${String(maxDepth)} levels deep`);
    this.name = 'CategoryTooDeepError';
  }
}

/** The category still has subcategories or products mapped to it. */
export class CategoryInUseError extends Error {
  constructor(
    readonly categoryId: string,
    readonly childCount: number,
    readonly productCount: number,
  ) {
    super('This category still has subcategories or products; move or remove them first');
    this.name = 'CategoryInUseError';
  }
}

/** Advisory lock key that serialises every taxonomy write (any stable 64-bit number). */
const TAXONOMY_LOCK_KEY = 1_700_017;

/**
 * The Master Category Taxonomy (SPEC Super Admin flow 2, Phase 17). Only a Super Admin writes it;
 * vendors map products to it and customers browse it.
 *
 * Every write takes one transaction-scoped advisory lock, so the tree rules (parent exists, no
 * cycle, depth limit) are checked against a taxonomy no other write is changing.
 */
export class CategoryService {
  constructor(private readonly db: Database) {}

  /**
   * GET /api/categories: active categories in tree order. A category under an inactive ancestor
   * is hidden with it.
   */
  async listActive(): Promise<CategoryRow[]> {
    const rows = await this.db.select().from(categories).where(eq(categories.is_active, true));
    return inTreeOrder(rows);
  }

  /** GET /api/admin/categories: the whole taxonomy in tree order, with direct product counts. */
  async listAll(): Promise<AdminCategoryRow[]> {
    const [rows, usage] = await Promise.all([
      this.db.select().from(categories),
      this.db
        .select({ category_id: products.category_id, total: count() })
        .from(products)
        .groupBy(products.category_id),
    ]);
    const counts = new Map(usage.map((row) => [row.category_id, row.total]));
    return inTreeOrder(rows.map((row) => ({ ...row, product_count: counts.get(row.id) ?? 0 })));
  }

  create(input: AdminCategoryWrite): Promise<AdminCategoryRow> {
    return this.write(input.slug, async (tx) => {
      await this.assertPlacement(tx, null, input.parent_id);
      const [created] = await tx.insert(categories).values(input).returning();
      if (created === undefined) throw new Error('Category insert returned no row');
      return { ...created, product_count: 0 };
    });
  }

  /** PUT: replaces every editable field. Moving a category moves its whole subtree. */
  update(categoryId: string, input: AdminCategoryWrite): Promise<AdminCategoryRow> {
    return this.write(input.slug, async (tx) => {
      await this.assertPlacement(tx, categoryId, input.parent_id);
      const [updated] = await tx
        .update(categories)
        .set(input)
        .where(eq(categories.id, categoryId))
        .returning();
      if (updated === undefined) throw new CategoryNotFoundError(categoryId);
      return { ...updated, product_count: await productCount(tx, categoryId) };
    });
  }

  /**
   * DELETE: only an unused category (no subcategories, no products) can be removed; a used one
   * is hidden with `is_active: false` instead. The RESTRICT foreign key backs the product count
   * against a product mapped concurrently.
   */
  async remove(categoryId: string): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        await lockTaxonomy(tx);
        const [existing] = await tx
          .select({ id: categories.id })
          .from(categories)
          .where(eq(categories.id, categoryId));
        if (existing === undefined) throw new CategoryNotFoundError(categoryId);
        const [children] = await tx
          .select({ total: count() })
          .from(categories)
          .where(eq(categories.parent_id, categoryId));
        const childCount = children?.total ?? 0;
        const mapped = await productCount(tx, categoryId);
        if (childCount > 0 || mapped > 0) {
          throw new CategoryInUseError(categoryId, childCount, mapped);
        }
        await tx.delete(categories).where(eq(categories.id, categoryId));
      });
    } catch (error: unknown) {
      if (isForeignKeyViolation(error, 'products_category_id_categories_id_fk')) {
        throw new CategoryInUseError(categoryId, 0, 1);
      }
      throw error;
    }
  }

  private async write<T>(slug: string, apply: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction(async (tx) => {
        await lockTaxonomy(tx);
        return apply(tx);
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error, 'categories_slug_key')) throw new CategorySlugTakenError(slug);
      throw error;
    }
  }

  private async assertPlacement(
    tx: Transaction,
    categoryId: string | null,
    parentId: string | null,
  ): Promise<void> {
    const all = await tx
      .select({ id: categories.id, parent_id: categories.parent_id })
      .from(categories);
    if (categoryId !== null && !all.some((node) => node.id === categoryId)) {
      throw new CategoryNotFoundError(categoryId);
    }
    switch (placementProblem(all, categoryId, parentId)) {
      case 'PARENT_NOT_FOUND':
        throw new CategoryParentNotFoundError(parentId ?? '');
      case 'CYCLE':
        throw new CategoryCycleError(categoryId ?? '', parentId ?? '');
      case 'TOO_DEEP':
        throw new CategoryTooDeepError(MAX_CATEGORY_DEPTH);
      case null:
        return;
    }
  }
}

async function lockTaxonomy(tx: Transaction): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${TAXONOMY_LOCK_KEY}::bigint)`);
}

async function productCount(tx: Transaction, categoryId: string): Promise<number> {
  const [usage] = await tx
    .select({ total: count() })
    .from(products)
    .where(eq(products.category_id, categoryId));
  return usage?.total ?? 0;
}

/** Each parent before its children, siblings by display_order then name; orphans dropped. */
function inTreeOrder<T extends CategoryRow>(rows: readonly T[]): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return flattenCategoryTree(buildCategoryTree(rows)).flatMap((node) => {
    const row = byId.get(node.id);
    return row === undefined ? [] : [row];
  });
}
