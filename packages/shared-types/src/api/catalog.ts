import { z } from 'zod';

import {
  CATEGORY_SLUG_REGEX,
  DEFAULT_PRODUCT_UNIT,
  MAX_CATEGORY_NAME_LENGTH,
  MAX_CATEGORY_SLUG_LENGTH,
  MAX_PRODUCT_DESCRIPTION_LENGTH,
  MAX_PRODUCT_IMAGES,
  MAX_PRODUCT_NAME_LENGTH,
  MAX_PRODUCT_PRICE_NPR,
  MAX_PRODUCT_STOCK_QUANTITY,
  MAX_PRODUCT_UNIT_LENGTH,
} from '../domain/constants';
import { jsonValueSchema } from '../domain/entities';
import { vendorStatusSchema } from '../domain/enums';

/*
 * Phase 17 contracts: the Super Admin's Master Category Taxonomy, the vendor's own catalogue and
 * stock, and the public category / product reads. Shared by apps/api, apps/admin and the mobile app.
 */

const imageUrlSchema = z.url({ protocol: /^https?$/ }).max(2048);

/** A page-size query parameter (text) between 1 and `max`. */
const limitQuery = (max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,3}$/, 'limit must be a whole number')
    .transform(Number)
    .pipe(z.number().int().min(1).max(max))
    .optional();

/**
 * A slug suggestion for a category name: lower-case ASCII letters and digits, everything else
 * collapsed into single hyphens. Empty when the name has none (e.g. a Devanagari name): the admin
 * then types the slug.
 */
export function slugifyCategoryName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_CATEGORY_SLUG_LENGTH)
    .replace(/-+$/, '');
}

/*
 * Categories
 */

/**
 * POST /api/admin/categories and PUT /api/admin/categories/:id (SUPER_ADMIN). PUT replaces the
 * whole category: an omitted optional field takes its default.
 */
export const adminCategoryWriteRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(MAX_CATEGORY_NAME_LENGTH),
  slug: z
    .string()
    .trim()
    .max(MAX_CATEGORY_SLUG_LENGTH)
    .regex(CATEGORY_SLUG_REGEX, 'slug must be lower-case words joined by hyphens'),
  /** Null (the default) makes it a root category. */
  parent_id: z.uuid().nullable().default(null),
  icon_url: imageUrlSchema.nullable().default(null),
  display_order: z.number().int().min(0).max(100_000).default(0),
  is_active: z.boolean().default(true),
});
export type AdminCategoryWriteRequest = z.input<typeof adminCategoryWriteRequestSchema>;
export type AdminCategoryWrite = z.output<typeof adminCategoryWriteRequestSchema>;

/** A category as customers and vendors see it (active ones only). */
export const categoryViewSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1),
  slug: z.string().regex(CATEGORY_SLUG_REGEX),
  parent_id: z.uuid().nullable(),
  icon_url: z.string().min(1).nullable(),
  display_order: z.number().int().nonnegative(),
});
export type CategoryView = z.infer<typeof categoryViewSchema>;

/**
 * GET /api/categories: every active category whose ancestors are all active, as a flat list in
 * tree order (each parent before its children, siblings by `display_order` then name).
 */
export const categoryListResponseSchema = z.strictObject({
  categories: z.array(categoryViewSchema),
});
export type CategoryListResponseBody = z.infer<typeof categoryListResponseSchema>;

export const adminCategoryViewSchema = categoryViewSchema.extend({
  is_active: z.boolean(),
  /** Products mapped directly to this category (not to its descendants). */
  product_count: z.number().int().nonnegative(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
export type AdminCategoryView = z.infer<typeof adminCategoryViewSchema>;

/** GET /api/admin/categories: the whole taxonomy, inactive categories included, in tree order. */
export const adminCategoryListResponseSchema = z.strictObject({
  categories: z.array(adminCategoryViewSchema),
});
export type AdminCategoryListResponseBody = z.infer<typeof adminCategoryListResponseSchema>;

/** POST (201) and PUT (200) /api/admin/categories. */
export const adminCategoryResponseSchema = z.strictObject({
  category: adminCategoryViewSchema,
});
export type AdminCategoryResponseBody = z.infer<typeof adminCategoryResponseSchema>;

interface TreeItem {
  readonly id: string;
  readonly parent_id: string | null;
  readonly display_order: number;
  readonly name: string;
}

export type CategoryNode<T extends TreeItem> = T & {
  /** 1 for a root. */
  readonly depth: number;
  readonly children: readonly CategoryNode<T>[];
};

/**
 * Builds the taxonomy tree from a flat list: siblings sorted by `display_order`, then name, then
 * id. A category whose parent is not in the list (e.g. filtered out as inactive) is dropped with
 * its whole subtree, so a hidden branch never resurfaces as roots.
 */
export function buildCategoryTree<T extends TreeItem>(items: readonly T[]): CategoryNode<T>[] {
  const byParent = new Map<string | null, T[]>();
  for (const item of items) {
    const siblings = byParent.get(item.parent_id);
    if (siblings === undefined) byParent.set(item.parent_id, [item]);
    else siblings.push(item);
  }
  const build = (parentId: string | null, depth: number, path: ReadonlySet<string>) =>
    (byParent.get(parentId) ?? [])
      .filter((item) => !path.has(item.id))
      .sort(
        (a, b) =>
          a.display_order - b.display_order ||
          a.name.localeCompare(b.name, 'en') ||
          a.id.localeCompare(b.id, 'en'),
      )
      .map((item): CategoryNode<T> => ({
        ...item,
        depth,
        children: build(item.id, depth + 1, new Set([...path, item.id])),
      }));
  return build(null, 1, new Set());
}

/** The tree flattened depth-first: each parent directly before its descendants. */
export function flattenCategoryTree<T extends TreeItem>(
  nodes: readonly CategoryNode<T>[],
): CategoryNode<T>[] {
  return nodes.flatMap((node) => [node, ...flattenCategoryTree(node.children)]);
}

/*
 * Products
 */

const wholePaisa = (amount: number) => Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6;

/** Largest serialised `metadata` object a vendor may store with a product. */
export const MAX_PRODUCT_METADATA_BYTES = 4000;

/** The product fields a vendor writes, shared by create (POST) and edit (PUT). */
const vendorProductFields = {
  category_id: z.uuid(),
  name: z.string().trim().min(1).max(MAX_PRODUCT_NAME_LENGTH),
  /** Trimmed; a blank one is stored as null. */
  description: z
    .string()
    .trim()
    .max(MAX_PRODUCT_DESCRIPTION_LENGTH)
    .nullish()
    .transform((value) => (value === undefined || value === null || value === '' ? null : value)),
  price_npr: z
    .number()
    .positive()
    .max(MAX_PRODUCT_PRICE_NPR)
    .refine(wholePaisa, 'price_npr must be a whole number of paisa'),
  unit: z.string().trim().min(1).max(MAX_PRODUCT_UNIT_LENGTH).default(DEFAULT_PRODUCT_UNIT),
  /**
   * Decided 2026-10-21: accepted from older Seller app builds and ignored. Showing and hiding a
   * product is the Super Admin's moderation; the vendor's switch is `in_stock`.
   */
  is_active: z.boolean().optional(),
  metadata: z
    .record(z.string().min(1).max(60), jsonValueSchema)
    .refine(
      (value) => JSON.stringify(value).length <= MAX_PRODUCT_METADATA_BYTES,
      `metadata may be at most ${String(MAX_PRODUCT_METADATA_BYTES)} characters of JSON`,
    )
    .default({}),
};

/**
 * POST /api/vendor/products (VENDOR): a new SKU of the caller's own shop, mapped to an active
 * category of the admin taxonomy (SPEC vendor flow step 3).
 */
export const vendorProductCreateRequestSchema = z.strictObject({
  ...vendorProductFields,
  stock_quantity: z.number().int().min(0).max(MAX_PRODUCT_STOCK_QUANTITY).default(0),
  image_urls: z.array(imageUrlSchema).max(MAX_PRODUCT_IMAGES).default([]),
  /** 2026-10-21: whether customers may order it now; a new product is in stock by default. */
  in_stock: z.boolean().default(true),
});
export type VendorProductCreateRequest = z.input<typeof vendorProductCreateRequestSchema>;
export type VendorProductCreate = z.output<typeof vendorProductCreateRequestSchema>;

/**
 * PUT /api/vendor/products/:id (VENDOR, Phase 19): replaces the details of the caller's own
 * product; an omitted optional field takes its default. Since 2026-10-21 a vendor can neither
 * hide nor show a product (`is_active` is ignored): the Super Admin moderates. Three things are
 * deliberately not replaced by default:
 *  - `in_stock`, kept when omitted (its switch is PATCH /api/vendor/products/:id/availability);
 *  - the stock, which has its own endpoint (a `stock_quantity` here is refused);
 *  - the photos: `image_urls` is kept when omitted; when given it becomes the list (to remove or
 *    reorder photos). New photos are added with POST /api/vendor/products/:id/images.
 */
export const vendorProductUpdateRequestSchema = z.strictObject({
  ...vendorProductFields,
  image_urls: z.array(imageUrlSchema).max(MAX_PRODUCT_IMAGES).optional(),
  in_stock: z.boolean().optional(),
});
export type VendorProductUpdateRequest = z.input<typeof vendorProductUpdateRequestSchema>;
export type VendorProductUpdate = z.output<typeof vendorProductUpdateRequestSchema>;

/**
 * PATCH /api/vendor/products/:id/availability (VENDOR, 2026-10-21): the Seller app's In Stock /
 * Out of Stock switch. It never changes `stock_quantity`, and never hides the product.
 */
export const vendorProductAvailabilityRequestSchema = z.strictObject({ in_stock: z.boolean() });
export type VendorProductAvailabilityRequest = z.infer<
  typeof vendorProductAvailabilityRequestSchema
>;

/**
 * PATCH /api/vendor/products/:id/stock (VENDOR): the on-hand quantity the vendor counted. It
 * replaces the stored number (it is not a delta).
 */
export const vendorProductStockRequestSchema = z.strictObject({
  stock_quantity: z.number().int().min(0).max(MAX_PRODUCT_STOCK_QUANTITY),
});
export type VendorProductStockRequest = z.infer<typeof vendorProductStockRequestSchema>;

export const PRODUCT_LIST_DEFAULT_LIMIT = 20;
export const PRODUCT_LIST_MAX_LIMIT = 50;

/**
 * GET /api/vendor/products?limit=&cursor= (VENDOR): the caller's own products, inactive ones
 * included, by name. `cursor` is the previous page's `next_cursor` (the id of its last product).
 */
export const vendorProductListQuerySchema = z.strictObject({
  limit: limitQuery(PRODUCT_LIST_MAX_LIMIT),
  cursor: z.uuid().optional(),
});
export type VendorProductListQuery = z.output<typeof vendorProductListQuerySchema>;

/** A product as its own vendor (and the Super Admin) sees it: exact stock included. */
export const vendorProductViewSchema = z.strictObject({
  id: z.uuid(),
  category_id: z.uuid().nullable(),
  name: z.string().min(1),
  description: z.string().min(1).nullable(),
  price_npr: z.number().positive(),
  unit: z.string().min(1),
  stock_quantity: z.number().int().nonnegative(),
  image_urls: z.array(z.string().min(1)),
  /** False: hidden by the Super Admin (moderation). The vendor sees it, cannot change it. */
  is_active: z.boolean(),
  /** The vendor's In Stock / Out of Stock switch. */
  in_stock: z.boolean(),
  metadata: z.record(z.string(), jsonValueSchema),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
export type VendorProductView = z.infer<typeof vendorProductViewSchema>;

/**
 * POST /api/vendor/products (201), PUT /api/vendor/products/:id (200), PATCH …/:id/stock (200) and
 * POST …/:id/images (201).
 */
export const vendorProductResponseSchema = z.strictObject({
  product: vendorProductViewSchema,
});
export type VendorProductResponseBody = z.infer<typeof vendorProductResponseSchema>;

export const vendorProductListResponseSchema = z.strictObject({
  products: z.array(vendorProductViewSchema),
  next_cursor: z.uuid().nullable(),
});
export type VendorProductListResponseBody = z.infer<typeof vendorProductListResponseSchema>;

export const MAX_PRODUCT_SEARCH_LENGTH = 100;

/**
 * GET /api/products?category_id=&vendor_id=&search=&limit=&cursor= (public): active products of
 * LIVE vendors, by name. `category_id` also matches the category's active descendants; `search` is
 * a full-text prefix match on name and description (every word must match).
 */
export const productListQuerySchema = z.strictObject({
  category_id: z.uuid().optional(),
  vendor_id: z.uuid().optional(),
  search: z.string().trim().min(1).max(MAX_PRODUCT_SEARCH_LENGTH).optional(),
  limit: limitQuery(PRODUCT_LIST_MAX_LIMIT),
  cursor: z.uuid().optional(),
});
export type ProductListQuery = z.output<typeof productListQuerySchema>;

/**
 * A product as a customer sees it. `stock_quantity` (Phase 18) is the vendor's on-hand count, so
 * the app can cap the quantity picker; units held by other customers' 600 s checkout locks are
 * not subtracted, and checkout stays the authority (409 INSUFFICIENT_STOCK).
 */
export const publicProductSchema = z.strictObject({
  /** The products.id to send as `product_id` at checkout. */
  id: z.uuid(),
  vendor: z.strictObject({ id: z.uuid(), business_name: z.string().min(1) }),
  category_id: z.uuid().nullable(),
  name: z.string().min(1),
  description: z.string().min(1).nullable(),
  price_npr: z.number().positive(),
  unit: z.string().min(1),
  in_stock: z.boolean(),
  stock_quantity: z.number().int().nonnegative(),
  image_urls: z.array(z.string().min(1)),
  metadata: z.record(z.string(), jsonValueSchema),
});
export type PublicProduct = z.infer<typeof publicProductSchema>;

export const productListResponseSchema = z.strictObject({
  products: z.array(publicProductSchema),
  next_cursor: z.uuid().nullable(),
});
export type ProductListResponseBody = z.infer<typeof productListResponseSchema>;

export const ADMIN_PRODUCT_LIST_DEFAULT_LIMIT = 50;
export const ADMIN_PRODUCT_LIST_MAX_LIMIT = 100;

/**
 * GET /api/admin/products?vendor_id=&limit=&cursor= (SUPER_ADMIN): every product of every vendor
 * (or of one), inactive ones included, by vendor name then product name.
 */
export const adminProductListQuerySchema = z.strictObject({
  vendor_id: z.uuid().optional(),
  limit: limitQuery(ADMIN_PRODUCT_LIST_MAX_LIMIT),
  cursor: z.uuid().optional(),
});
export type AdminProductListQuery = z.output<typeof adminProductListQuerySchema>;

export const adminProductViewSchema = vendorProductViewSchema.extend({
  vendor: z.strictObject({
    id: z.uuid(),
    business_name: z.string().min(1),
    status: vendorStatusSchema,
  }),
  category_name: z.string().min(1).nullable(),
});
export type AdminProductView = z.infer<typeof adminProductViewSchema>;

export const adminProductListResponseSchema = z.strictObject({
  products: z.array(adminProductViewSchema),
  next_cursor: z.uuid().nullable(),
});
export type AdminProductListResponseBody = z.infer<typeof adminProductListResponseSchema>;

/** PATCH /api/admin/products/:id/active (SUPER_ADMIN): show or hide one product. */
export const adminProductActiveRequestSchema = z.strictObject({
  is_active: z.boolean(),
});
export type AdminProductActiveRequest = z.infer<typeof adminProductActiveRequestSchema>;

export const adminProductResponseSchema = z.strictObject({
  product: adminProductViewSchema,
});
export type AdminProductResponseBody = z.infer<typeof adminProductResponseSchema>;
