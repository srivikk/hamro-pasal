import {
  adminCategoryWriteRequestSchema,
  buildCategoryTree,
  flattenCategoryTree,
  MAX_CATEGORY_DEPTH,
  slugifyCategoryName,
  type AdminCategoryView,
  type AdminCategoryWrite,
  type CategoryNode,
} from '@hamro-pasal/shared-types';

import { ApiError } from '../../api/client';

export type CategoryRow = CategoryNode<AdminCategoryView>;

/** The taxonomy as the screen lists it: tree order, each row knowing its depth and children. */
export function categoryRows(categories: readonly AdminCategoryView[]): CategoryRow[] {
  return flattenCategoryTree(buildCategoryTree(categories));
}

/**
 * What customers and vendors actually see of a category (decided 2026-10-20): hiding a category
 * hides everything below it, so an active category under a hidden ancestor is not visible either.
 * INHERITED_HIDDEN names the nearest hidden ancestor, the one to show again.
 */
export type CategoryVisibility =
  | { readonly kind: 'ACTIVE' }
  | { readonly kind: 'HIDDEN' }
  | { readonly kind: 'INHERITED_HIDDEN'; readonly hiddenAncestorName: string };

export function categoryVisibility(
  category: Pick<AdminCategoryView, 'is_active' | 'parent_id'>,
  byId: ReadonlyMap<string, Pick<AdminCategoryView, 'name' | 'is_active' | 'parent_id'>>,
): CategoryVisibility {
  if (!category.is_active) return { kind: 'HIDDEN' };
  const seen = new Set<string>();
  for (let id = category.parent_id; id !== null && !seen.has(id);) {
    seen.add(id);
    const ancestor = byId.get(id);
    if (ancestor === undefined) break;
    if (!ancestor.is_active) return { kind: 'INHERITED_HIDDEN', hiddenAncestorName: ancestor.name };
    id = ancestor.parent_id;
  }
  return { kind: 'ACTIVE' };
}

/** The badge of one row: green Active, red Hidden, amber when a parent hides it. */
export function visibilityBadge(visibility: CategoryVisibility): {
  readonly label: string;
  readonly className: string;
  readonly title: string;
} {
  switch (visibility.kind) {
    case 'ACTIVE':
      return {
        label: 'Active',
        className: 'status-replayed',
        title: 'Visible to vendors and customers.',
      };
    case 'HIDDEN':
      return {
        label: 'Hidden',
        className: 'status-pending',
        title: 'Hidden, with everything below it.',
      };
    case 'INHERITED_HIDDEN':
      return {
        label: 'Inactive (Parent Hidden)',
        className: 'status-warn',
        title: `Active itself, but hidden because "${visibility.hiddenAncestorName}" above it is hidden. Show that category to make this one visible again.`,
      };
  }
}

/** How many categories customers cannot see: hidden themselves, or under a hidden one. */
export function hiddenCounts(categories: readonly AdminCategoryView[]): {
  readonly hidden: number;
  readonly inherited: number;
} {
  const byId = new Map(categories.map((category) => [category.id, category]));
  let hidden = 0;
  let inherited = 0;
  for (const category of categories) {
    const kind = categoryVisibility(category, byId).kind;
    if (kind === 'HIDDEN') hidden += 1;
    if (kind === 'INHERITED_HIDDEN') inherited += 1;
  }
  return { hidden, inherited };
}

/** The modal's fields, as typed (text inputs hold text). `parentId` '' means a root category. */
export interface CategoryFormValues {
  readonly name: string;
  readonly slug: string;
  readonly parentId: string;
  readonly iconUrl: string;
  readonly displayOrder: string;
  readonly isActive: boolean;
}

export type CategoryFormField = 'name' | 'slug' | 'parentId' | 'iconUrl' | 'displayOrder';

export function emptyCategoryForm(parentId: string | null = null): CategoryFormValues {
  return {
    name: '',
    slug: '',
    parentId: parentId ?? '',
    iconUrl: '',
    displayOrder: '0',
    isActive: true,
  };
}

export function formFromCategory(category: AdminCategoryView): CategoryFormValues {
  return {
    name: category.name,
    slug: category.slug,
    parentId: category.parent_id ?? '',
    iconUrl: category.icon_url ?? '',
    displayOrder: String(category.display_order),
    isActive: category.is_active,
  };
}

/**
 * Typing a name fills the slug, until the admin edits the slug by hand (it then no longer matches
 * the suggestion for the previous name and is left alone).
 */
export function withName(values: CategoryFormValues, name: string): CategoryFormValues {
  const slugFollowsName = values.slug === slugifyCategoryName(values.name);
  return { ...values, name, slug: slugFollowsName ? slugifyCategoryName(name) : values.slug };
}

const FIELD_OF_PATH: Readonly<Record<string, CategoryFormField>> = {
  name: 'name',
  slug: 'slug',
  parent_id: 'parentId',
  icon_url: 'iconUrl',
  display_order: 'displayOrder',
};

const FIELD_MESSAGES: Readonly<Record<CategoryFormField, string>> = {
  name: 'Enter a name of at most 80 characters.',
  slug: 'Use lower-case letters and digits, with single hyphens between words.',
  parentId: 'Choose a parent from the list.',
  iconUrl: 'Enter a full http(s) address, or leave it empty.',
  displayOrder: 'Enter a whole number from 0 to 100000.',
};

export type CategoryFormResult =
  | { readonly ok: true; readonly request: AdminCategoryWrite }
  | { readonly ok: false; readonly errors: Readonly<Partial<Record<CategoryFormField, string>>> };

/** Checks the form with the API's own schema, so the screen and the server cannot disagree. */
export function validateCategoryForm(values: CategoryFormValues): CategoryFormResult {
  const order = values.displayOrder.trim();
  const parsed = adminCategoryWriteRequestSchema.safeParse({
    name: values.name,
    slug: values.slug,
    parent_id: values.parentId === '' ? null : values.parentId,
    icon_url: values.iconUrl.trim() === '' ? null : values.iconUrl.trim(),
    // Not a whole number: NaN fails the schema's integer check.
    display_order: /^\d+$/.test(order) ? Number(order) : Number.NaN,
    is_active: values.isActive,
  });
  if (parsed.success) return { ok: true, request: parsed.data };
  const errors: Partial<Record<CategoryFormField, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = FIELD_OF_PATH[String(issue.path[0])];
    if (field !== undefined) errors[field] = FIELD_MESSAGES[field];
  }
  return { ok: false, errors };
}

export interface ParentOption {
  readonly id: string;
  readonly label: string;
}

/**
 * Where a category may be placed, mirroring the server's rules: never under itself or its own
 * subcategories, and never so deep that its subtree would pass the depth limit. `editingId` is
 * null for a new category. The server still decides (and answers 409 / 422 on a stale list).
 */
export function parentOptions(
  rows: readonly CategoryRow[],
  editingId: string | null,
): ParentOption[] {
  const editing = editingId === null ? undefined : rows.find((row) => row.id === editingId);
  const subtree = new Set(
    editing === undefined ? [] : flattenCategoryTree([editing]).map((r) => r.id),
  );
  const height = editing === undefined ? 1 : subtreeHeight(editing);
  return rows
    .filter((row) => !subtree.has(row.id) && row.depth + height <= MAX_CATEGORY_DEPTH)
    .map((row) => ({ id: row.id, label: `${'— '.repeat(row.depth - 1)}${row.name}` }));
}

function subtreeHeight(row: CategoryRow): number {
  return 1 + Math.max(0, ...row.children.map(subtreeHeight));
}

/** Whether a new subcategory still fits under this row. */
export function canHaveChildren(row: CategoryRow): boolean {
  return row.depth < MAX_CATEGORY_DEPTH;
}

/** Why Delete is unavailable, or null when the category is unused and can be removed. */
export function deleteBlockedReason(row: CategoryRow): string | null {
  if (row.children.length > 0) {
    return 'Has subcategories: move or delete them first.';
  }
  if (row.product_count > 0) {
    return `${String(row.product_count)} product${row.product_count === 1 ? ' is' : 's are'} mapped here: hide the category instead.`;
  }
  return null;
}

export function categoryErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'CATEGORY_SLUG_TAKEN':
        return 'Another category already uses this slug.';
      case 'CATEGORY_PARENT_NOT_FOUND':
        return 'The chosen parent no longer exists. The list has been refreshed.';
      case 'CATEGORY_CYCLE':
        return 'A category cannot be placed under itself or one of its own subcategories.';
      case 'CATEGORY_TOO_DEEP':
        return `Categories can be nested at most ${String(MAX_CATEGORY_DEPTH)} levels deep.`;
      case 'CATEGORY_IN_USE':
        return 'This category still has subcategories or products. Hide it instead.';
      case 'CATEGORY_NOT_FOUND':
        return 'This category no longer exists. The list has been refreshed.';
      case 'VALIDATION_FAILED':
        return 'The server refused these values. Check the fields and try again.';
      case 'NETWORK_ERROR':
        return 'The API cannot be reached. Try again.';
      default:
        break;
    }
  }
  return 'The change could not be saved. Try again.';
}
