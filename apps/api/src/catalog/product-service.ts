import {
  categories,
  products,
  productSearchDocument,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import {
  ADMIN_PRODUCT_LIST_DEFAULT_LIMIT,
  PRODUCT_LIST_DEFAULT_LIMIT,
  type AdminProductListQuery,
  type ProductListQuery,
  type VendorProductCreate,
  type VendorProductListQuery,
  type VendorStatus,
} from '@hamro-pasal/shared-types';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';

import { isForeignKeyViolation, isUniqueViolation } from '../infra/pg-errors';
import { VendorAccountNotFoundError } from '../orders/vendor-order-service';
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
 *
 * Every list is keyset-paginated on a product id, with the cursor row compared in SQL.
 */
export class ProductService {
  constructor(private readonly db: Database) {}

  /** POST /api/vendor/products. Any vendor status may build its catalogue (vendor flow step 3). */
  async create(vendorUserId: string, input: VendorProductCreate): Promise<ProductRow> {
    const vendorId = await this.vendorIdOf(vendorUserId);
    const [category] = await this.db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, input.category_id), eq(categories.is_active, true)));
    if (category === undefined) throw new CategoryUnavailableError(input.category_id);
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
    const [updated] = await this.db
      .update(products)
      .set({ stock_quantity: stockQuantity })
      .where(and(eq(products.id, productId), eq(products.vendor_id, vendorId)))
      .returning();
    if (updated === undefined) throw new ProductNotFoundError(productId);
    return updated;
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
   * category's active descendants (an unknown or inactive category is 404); `search` is served by
   * the GIN index `products_search_idx`.
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
        .where(and(eq(categories.id, categoryId), eq(categories.is_active, true)));
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
    const [updated] = await this.db
      .update(products)
      .set({ is_active: isActive })
      .where(eq(products.id, productId))
      .returning({ id: products.id });
    if (updated === undefined) throw new ProductNotFoundError(productId);
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
