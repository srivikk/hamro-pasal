import {
  categories,
  enqueueDomainEvent,
  inVisibleCategory,
  isVisibleCategory,
  products,
  productSearchDocument,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import {
  ADMIN_PRODUCT_LIST_DEFAULT_LIMIT,
  MAX_PRODUCT_IMAGES,
  PRODUCT_LIST_DEFAULT_LIMIT,
  type AdminProductListQuery,
  type ProductListQuery,
  type VendorProductCreate,
  type VendorProductListQuery,
  type VendorProductUpdate,
  type VendorStatus,
} from '@hamro-pasal/shared-types';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';

import { isForeignKeyViolation, isUniqueViolation } from '../infra/pg-errors';
import { VendorAccountNotFoundError } from '../orders/vendor-order-service';
import type {
  ProductImageContentType,
  ProductImageStorage,
} from '../uploads/product-image-storage';
import { CategoryNotFoundError } from './category-service';

export type ProductRow = typeof products.$inferSelect;

export interface PublicProductRow {
  readonly product: ProductRow;
  readonly vendorBusinessName: string;
}

export interface AdminProductRow {
  readonly product: ProductRow;
  readonly vendor: {
    readonly id: string;
    readonly business_name: string;
    readonly status: VendorStatus;
  };
  readonly categoryName: string | null;
}

export interface ProductPage<T> {
  readonly rows: readonly T[];
  readonly nextCursor: string | null;
}

export class ProductNotFoundError extends Error {
  constructor(readonly productId: string) {
    super(`Product ${productId} not found`);
    this.name = 'ProductNotFoundError';
  }
}

/** The vendor already sells a product with this name (names are unique per shop). */
export class ProductNameTakenError extends Error {
  constructor(readonly productName: string) {
    super(`Your shop already has a product named "${productName}"`);
    this.name = 'ProductNameTakenError';
  }
}

/** The category a vendor chose does not exist or was deactivated by the Super Admin. */
export class CategoryUnavailableError extends Error {
  constructor(readonly categoryId: string) {
    super(`Category ${categoryId} is not available`);
    this.name = 'CategoryUnavailableError';
  }
}

/** The upload would give the product more than MAX_PRODUCT_IMAGES photos. */
export class ProductImageLimitError extends Error {
  readonly maxImages = MAX_PRODUCT_IMAGES;

  constructor(readonly currentImages: number) {
    super(`A product can have at most ${String(MAX_PRODUCT_IMAGES)} photos`);
    this.name = 'ProductImageLimitError';
  }
}

/** One uploaded photo, its type already read from its own bytes. */
export interface ProductImageUpload {
  readonly bytes: Buffer;
  readonly contentType: ProductImageContentType;
}

/** The `cursor` is not a product of the list being paged. */
export class InvalidProductCursorError extends Error {
  constructor(readonly cursor: string) {
    super(`Cursor ${cursor} is not a product of this list`);
    this.name = 'InvalidProductCursorError';
  }
}

/**
 * The words of a search as a prefix tsquery for the 'simple' configuration: `wai noo` becomes
 * `wai:* & noo:*` (every word must start a word of the product). Only letters, combining marks
 * and digits survive, so no tsquery operator can be injected; null when nothing is left.
 */
export function prefixSearchQuery(search: string): string | null {
  const words = search
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((word) => word !== '');
  return words.length === 0 ? null : words.map((word) => `${word}:*`).join(' & ');
}

function page<T>(rows: readonly T[], limit: number, idOf: (row: T) => string): ProductPage<T> {
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  return {
    rows: shown,
    nextCursor: rows.length > limit && last !== undefined ? idOf(last) : null,
  };
}

/**
 * Products and their stock (Phase 17). Vendors create SKUs mapped to the admin taxonomy and keep
 * `stock_quantity` current; customers browse active products of LIVE vendors; a Super Admin sees
 * everything and can hide a product. Checkout (CheckoutService) reads the same `stock_quantity`.
 * Phase 19: vendors also edit, hide and photograph their own products.
 *
 * Every list is keyset-paginated on a product id, with the cursor row compared in SQL.
 */
export class ProductService {
  constructor(
    private readonly db: Database,
    private readonly images: ProductImageStorage,
  ) {}

  /** POST /api/vendor/products. Any vendor status may build its catalogue (vendor flow step 3). */
  async create(vendorUserId: string, input: VendorProductCreate): Promise<ProductRow> {
    const vendorId = await this.vendorIdOf(vendorUserId);
    await this.assertCategoryActive(input.category_id);
    try {
      const [created] = await this.db
        .insert(products)
        .values({ ...input, vendor_id: vendorId })
        .returning();
      if (created === undefined) throw new Error('Product insert returned no row');
      return created;
    } catch (error: unknown) {
      if (isUniqueViolation(error, 'products_vendor_id_name_key')) {
        throw new ProductNameTakenError(input.name);
      }
      // The category was deleted between the check and the insert.
      if (isForeignKeyViolation(error, 'products_category_id_categories_id_fk')) {
        throw new CategoryUnavailableError(input.category_id);
      }
      throw error;
    }
  }

  /**
   * PATCH /api/vendor/products/:id/stock: sets the on-hand quantity of the caller's own product.
   * Another shop's product is "not found". Live checkout holds (Redis) are not touched: a hold
   * larger than the new stock fails at its claim, whose decrement is guarded in PostgreSQL.
   */
  async setStock(
    vendorUserId: string,
    productId: string,
    stockQuantity: number,
  ): Promise<ProductRow> {
    const vendorId = await this.vendorIdOf(vendorUserId);
    const scope = and(eq(products.id, productId), eq(products.vendor_id, vendorId));
    return this.db.transaction(async (tx) => {
      const before = await orderableBefore(tx, scope);
      if (before === undefined) throw new ProductNotFoundError(productId);
      const [updated] = await tx
        .update(products)
        .set({ stock_quantity: stockQuantity })
        .where(scope)
        .returning();
      if (updated === undefined) throw new ProductNotFoundError(productId);
      await announceIfBackInStock(tx, before, updated);
      return updated;
    });
  }

  /**
   * PUT /api/vendor/products/:id (Phase 19): replaces the details of the caller's own product.
   * The vendor is part of the WHERE of every statement, so another shop's product is "not found"
   * and stays untouched. The stock is never written here; the photos only when a list is given.
   */
  async update(
    vendorUserId: string,
    productId: string,
    input: VendorProductUpdate,
  ): Promise<ProductRow> {
    const vendorId = await this.vendorIdOf(vendorUserId);
    const scope = and(eq(products.id, productId), eq(products.vendor_id, vendorId));
    const [current] = await this.db
      .select({ category_id: products.category_id, image_urls: products.image_urls })
      .from(products)
      .where(scope);
    if (current === undefined) throw new ProductNotFoundError(productId);
    // A product may stay in a category the Super Admin has since hidden; it cannot move into one.
    if (input.category_id !== current.category_id) {
      await this.assertCategoryActive(input.category_id);
    }
    const { image_urls: imageUrls, ...fields } = input;
    let updated: ProductRow | undefined;
    try {
      updated = await this.db.transaction(async (tx) => {
        const before = await orderableBefore(tx, scope);
        const [row] = await tx
          .update(products)
          .set(imageUrls === undefined ? fields : { ...fields, image_urls: imageUrls })
          .where(scope)
          .returning();
        // Showing a hidden product with stock again is a restock for whoever waits for it.
        if (before !== undefined && row !== undefined) await announceIfBackInStock(tx, before, row);
        return row;
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error, 'products_vendor_id_name_key')) {
        throw new ProductNameTakenError(input.name);
      }
      if (isForeignKeyViolation(error, 'products_category_id_categories_id_fk')) {
        throw new CategoryUnavailableError(input.category_id);
      }
      throw error;
    }
    if (updated === undefined) throw new ProductNotFoundError(productId);
    if (imageUrls !== undefined) {
      // Best effort: a photo the vendor dropped from the list no longer needs its file.
      const kept = new Set(imageUrls);
      await this.discard(
        productId,
        current.image_urls.filter((url) => !kept.has(url)),
      );
    }
    return updated;
  }

  /**
   * DELETE /api/vendor/products/:id (Phase 19): a soft delete. The row stays (order history and
   * `order_items` point at it) with `is_active = false`: gone from customers' lists, menus and
   * checkout. Repeating it changes nothing; PUT with `is_active: true` shows the product again.
   */
  async hide(vendorUserId: string, productId: string): Promise<void> {
    const vendorId = await this.vendorIdOf(vendorUserId);
    const [hidden] = await this.db
      .update(products)
      .set({ is_active: false })
      .where(and(eq(products.id, productId), eq(products.vendor_id, vendorId)))
      .returning({ id: products.id });
    if (hidden === undefined) throw new ProductNotFoundError(productId);
  }

  /**
   * POST /api/vendor/products/:id/images (Phase 19): stores the photos and appends their URLs to
   * the caller's own product, at most MAX_PRODUCT_IMAGES in all. Ownership and the limit are
   * checked before anything is written to disk, and again in the UPDATE itself (a concurrent
   * upload cannot push the product past the limit); files of a refused upload are deleted.
   */
  async addImages(
    vendorUserId: string,
    productId: string,
    images: readonly ProductImageUpload[],
  ): Promise<ProductRow> {
    const vendorId = await this.vendorIdOf(vendorUserId);
    const scope = and(eq(products.id, productId), eq(products.vendor_id, vendorId));
    const imageCount = async (): Promise<number> => {
      const [product] = await this.db
        .select({ image_urls: products.image_urls })
        .from(products)
        .where(scope);
      if (product === undefined) throw new ProductNotFoundError(productId);
      return product.image_urls.length;
    };
    const current = await imageCount();
    if (current + images.length > MAX_PRODUCT_IMAGES) throw new ProductImageLimitError(current);

    const urls: string[] = [];
    try {
      for (const image of images) {
        urls.push(await this.images.save(productId, image.bytes, image.contentType));
      }
      const added = sql.join(
        urls.map((url) => sql`${url}`),
        sql`, `,
      );
      const [updated] = await this.db
        .update(products)
        .set({ image_urls: sql`array_cat(${products.image_urls}, ARRAY[${added}]::text[])` })
        .where(
          and(
            scope,
            sql`cardinality(${products.image_urls}) + ${urls.length} <= ${MAX_PRODUCT_IMAGES}`,
          ),
        )
        .returning();
      // Photos added by another request since the first check left no room (or the product went).
      if (updated === undefined) throw new ProductImageLimitError(await imageCount());
      return updated;
    } catch (error: unknown) {
      await this.discard(productId, urls);
      throw error;
    }
  }

  /** Deletes stored photos without failing the request that no longer needs them. */
  private async discard(productId: string, urls: readonly string[]): Promise<void> {
    await Promise.allSettled(urls.map((url) => this.images.remove(productId, url)));
  }

  /** The category exists and is visible: active, under active ancestors (2026-10-20). */
  private async assertCategoryActive(categoryId: string): Promise<void> {
    const [category] = await this.db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, categoryId), isVisibleCategory(categoryId)));
    if (category === undefined) throw new CategoryUnavailableError(categoryId);
  }

  /** GET /api/vendor/products: the caller's own products, inactive included, by name. */
  async listForVendor(
    vendorUserId: string,
    { limit = PRODUCT_LIST_DEFAULT_LIMIT, cursor }: VendorProductListQuery,
  ): Promise<ProductPage<ProductRow>> {
    const vendorId = await this.vendorIdOf(vendorUserId);
    const scope = eq(products.vendor_id, vendorId);
    if (cursor !== undefined) await this.assertCursor(cursor, scope);
    const rows = await this.db
      .select()
      .from(products)
      .where(and(scope, afterNameCursor(cursor)))
      .orderBy(asc(products.name), asc(products.id))
      .limit(limit + 1);
    return page(rows, limit, (row) => row.id);
  }

  /**
   * GET /api/products: active products of LIVE vendors, by name. `category_id` also matches the
   * category's active descendants (an unknown or hidden category is 404); `search` is served by
   * the GIN index `products_search_idx`.
   *
   * Decided 2026-10-20: a product filed under a hidden category, or under any category below a
   * hidden one, is never listed, filtered or not; nor is a category under a hidden ancestor.
   */
  async listPublic({
    category_id: categoryId,
    vendor_id: vendorId,
    search,
    limit = PRODUCT_LIST_DEFAULT_LIMIT,
    cursor,
  }: ProductListQuery): Promise<ProductPage<PublicProductRow>> {
    if (categoryId !== undefined) {
      const [category] = await this.db
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.id, categoryId), isVisibleCategory(categoryId)));
      if (category === undefined) throw new CategoryNotFoundError(categoryId);
    }
    const tsquery = search === undefined ? undefined : prefixSearchQuery(search);
    // A search made only of punctuation matches nothing.
    if (tsquery === null) return { rows: [], nextCursor: null };
    if (cursor !== undefined) await this.assertCursor(cursor);

    const rows = await this.db
      .select({ product: products, vendorBusinessName: vendors.business_name })
      .from(products)
      .innerJoin(vendors, eq(vendors.id, products.vendor_id))
      .where(
        and(
          eq(products.is_active, true),
          eq(vendors.status, 'LIVE'),
          inVisibleCategory(products.category_id),
          vendorId === undefined ? undefined : eq(products.vendor_id, vendorId),
          categoryId === undefined ? undefined : inActiveSubtree(categoryId),
          tsquery === undefined
            ? undefined
            : sql`${productSearchDocument} @@ to_tsquery('simple', ${tsquery})`,
          afterNameCursor(cursor),
        ),
      )
      .orderBy(asc(products.name), asc(products.id))
      .limit(limit + 1);
    return page(rows, limit, (row) => row.product.id);
  }

  /** GET /api/admin/products: every product, by vendor name then product name. */
  async listForAdmin({
    vendor_id: vendorId,
    limit = ADMIN_PRODUCT_LIST_DEFAULT_LIMIT,
    cursor,
  }: AdminProductListQuery): Promise<ProductPage<AdminProductRow>> {
    if (cursor !== undefined) await this.assertCursor(cursor);
    const rows = await this.adminRows(
      and(
        vendorId === undefined ? undefined : eq(products.vendor_id, vendorId),
        cursor === undefined
          ? undefined
          : sql`(${vendors.business_name}, ${products.vendor_id}, ${products.name}, ${products.id}) >
              (SELECT cv.business_name, c.vendor_id, c.name, c.id
                 FROM products c JOIN vendors cv ON cv.id = c.vendor_id
                WHERE c.id = ${cursor})`,
      ),
      limit + 1,
    );
    return page(rows, limit, (row) => row.product.id);
  }

  /** PATCH /api/admin/products/:id/active: the Super Admin shows or hides one product. */
  async setActive(productId: string, isActive: boolean): Promise<AdminProductRow> {
    await this.db.transaction(async (tx) => {
      const scope = eq(products.id, productId);
      const before = await orderableBefore(tx, scope);
      if (before === undefined) throw new ProductNotFoundError(productId);
      const [updated] = await tx
        .update(products)
        .set({ is_active: isActive })
        .where(scope)
        .returning();
      if (updated === undefined) throw new ProductNotFoundError(productId);
      await announceIfBackInStock(tx, before, updated);
    });
    const [row] = await this.adminRows(eq(products.id, productId), 1);
    if (row === undefined) throw new ProductNotFoundError(productId);
    return row;
  }

  private adminRows(where: SQL | undefined, limit: number): Promise<AdminProductRow[]> {
    return this.db
      .select({
        product: products,
        vendor: { id: vendors.id, business_name: vendors.business_name, status: vendors.status },
        categoryName: categories.name,
      })
      .from(products)
      .innerJoin(vendors, eq(vendors.id, products.vendor_id))
      .leftJoin(categories, eq(categories.id, products.category_id))
      .where(where)
      .orderBy(
        asc(vendors.business_name),
        asc(products.vendor_id),
        asc(products.name),
        asc(products.id),
      )
      .limit(limit);
  }

  private async vendorIdOf(userId: string): Promise<string> {
    const [vendor] = await this.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(eq(vendors.user_id, userId));
    if (vendor === undefined) throw new VendorAccountNotFoundError(userId);
    return vendor.id;
  }

  private async assertCursor(cursor: string, scope?: SQL): Promise<void> {
    const [known] = await this.db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.id, cursor), scope));
    if (known === undefined) throw new InvalidProductCursorError(cursor);
  }
}

/** Rows after the cursor product in (name, id) order. */
function afterNameCursor(cursor: string | undefined): SQL | undefined {
  return cursor === undefined
    ? undefined
    : sql`(${products.name}, ${products.id}) >
        (SELECT c.name, c.id FROM products c WHERE c.id = ${cursor})`;
}

/** The product is mapped to `categoryId` or to one of its active descendants. */
function inActiveSubtree(categoryId: string): SQL {
  return sql`${products.category_id} IN (
    WITH RECURSIVE subtree AS (
      SELECT root.id FROM categories root WHERE root.id = ${categoryId} AND root.is_active
      UNION ALL
      SELECT child.id FROM categories child
        JOIN subtree ON child.parent_id = subtree.id
       WHERE child.is_active
    )
    SELECT id FROM subtree
  )`;
}

/** Whether a product can be ordered: shown, with stock (Notify Me waits for exactly this). */
function isOrderable(product: { is_active: boolean; stock_quantity: number }): boolean {
  return product.is_active && product.stock_quantity > 0;
}

/** The product's standing before a change, its row locked so two changes cannot both announce. */
async function orderableBefore(
  tx: Transaction,
  scope: SQL | undefined,
): Promise<boolean | undefined> {
  const [row] = await tx
    .select({ is_active: products.is_active, stock_quantity: products.stock_quantity })
    .from(products)
    .where(scope)
    .for('update');
  return row === undefined ? undefined : isOrderable(row);
}

/**
 * Step 7.4 (SPEC core 11): a product that could not be ordered and now can writes
 * `product.back_in_stock` in the same transaction; the worker tells the customers waiting.
 */
async function announceIfBackInStock(
  tx: Transaction,
  wasOrderable: boolean,
  after: ProductRow,
): Promise<void> {
  if (wasOrderable || !isOrderable(after)) return;
  await enqueueDomainEvent(tx, {
    type: 'product.back_in_stock',
    aggregateId: after.id,
    payload: { product_id: after.id, vendor_id: after.vendor_id },
  });
}
