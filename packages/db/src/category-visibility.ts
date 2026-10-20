import { sql, type AnyColumn, type SQL } from 'drizzle-orm';

/*
 * Hierarchical category visibility (decided 2026-10-20): a category is visible to customers and
 * vendors only if it is active and so is every ancestor up to its root. Hiding "Groceries" hides
 * "Tea & Coffee" under it, whatever its own `is_active` says, and every product filed there.
 *
 * Computed, never stored: the tree is small and shallow (CategoryService caps its depth), and a
 * stored flag would have to be rewritten for a whole subtree on every hide, show or move.
 */

/**
 * The ids of every visible category: a recursive walk down from the active roots that stops at
 * the first inactive category, so nothing under a hidden one is reached. UNION, not UNION ALL,
 * so the walk ends even on a cycle (CategoryService refuses them; this does not rely on it).
 */
export function visibleCategoryIds(): SQL {
  return sql`(
    WITH RECURSIVE visible_categories AS (
      SELECT vc_root.id FROM categories vc_root
       WHERE vc_root.parent_id IS NULL AND vc_root.is_active
      UNION
      SELECT vc_child.id FROM categories vc_child
        JOIN visible_categories vc_parent ON vc_child.parent_id = vc_parent.id
       WHERE vc_child.is_active
    )
    SELECT id FROM visible_categories
  )`;
}

/**
 * A product's category column (or any category id) is visible. A product with no category is
 * never hidden by the taxonomy.
 */
export function inVisibleCategory(categoryId: AnyColumn | SQL): SQL {
  return sql`(${categoryId} IS NULL OR ${categoryId} IN ${visibleCategoryIds()})`;
}

/** One category, by id, is visible (an unknown id is not). */
export function isVisibleCategory(categoryId: string): SQL {
  return sql`${categoryId}::uuid IN ${visibleCategoryIds()}`;
}
