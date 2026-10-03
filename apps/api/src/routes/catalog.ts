import {
  adminCategoryWriteRequestSchema,
  adminProductActiveRequestSchema,
  adminProductListQuerySchema,
  idParamSchema,
  productListQuerySchema,
  vendorProductCreateRequestSchema,
  vendorProductListQuerySchema,
  vendorProductStockRequestSchema,
  type AdminCategoryListResponseBody,
  type AdminCategoryResponseBody,
  type AdminCategoryView,
  type AdminProductListResponseBody,
  type AdminProductResponseBody,
  type AdminProductView,
  type CategoryListResponseBody,
  type CategoryView,
  type ProductListResponseBody,
  type PublicProduct,
  type VendorProductListResponseBody,
  type VendorProductResponseBody,
  type VendorProductView,
} from '@hamro-pasal/shared-types';
import { Router } from 'express';

import type { AdminCategoryRow, CategoryRow, CategoryService } from '../catalog/category-service';
import type {
  AdminProductRow,
  ProductRow,
  ProductService,
  PublicProductRow,
} from '../catalog/product-service';
import { authOf } from '../http/auth';
import { parseInput } from '../http/validate';

export function categoryView(row: CategoryRow): CategoryView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    parent_id: row.parent_id,
    icon_url: row.icon_url,
    display_order: row.display_order,
  };
}

export function adminCategoryView(row: AdminCategoryRow): AdminCategoryView {
  return {
    ...categoryView(row),
    is_active: row.is_active,
    product_count: row.product_count,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export function vendorProductView(row: ProductRow): VendorProductView {
  return {
    id: row.id,
    category_id: row.category_id,
    name: row.name,
    description: row.description,
    price_npr: row.price_npr,
    unit: row.unit,
    stock_quantity: row.stock_quantity,
    image_urls: row.image_urls,
    is_active: row.is_active,
    metadata: row.metadata,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/** The customer's view: the on-hand stock (Phase 18, for the quantity picker), no timestamps. */
export function publicProductView({
  product,
  vendorBusinessName,
}: PublicProductRow): PublicProduct {
  return {
    id: product.id,
    vendor: { id: product.vendor_id, business_name: vendorBusinessName },
    category_id: product.category_id,
    name: product.name,
    description: product.description,
    price_npr: product.price_npr,
    unit: product.unit,
    // Stock held by other customers' 600 s locks is not subtracted; checkout re-checks.
    in_stock: product.stock_quantity > 0,
    stock_quantity: product.stock_quantity,
    image_urls: product.image_urls,
    metadata: product.metadata,
  };
}

export function adminProductView(row: AdminProductRow): AdminProductView {
  return {
    ...vendorProductView(row.product),
    vendor: row.vendor,
    category_name: row.categoryName,
  };
}

/**
 * Mounted at /api/categories without authentication (Phase 17): the active taxonomy, for browsing
 * and for the vendor's category picker.
 */
export function categoriesRouter(categories: CategoryService): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const body: CategoryListResponseBody = {
      categories: (await categories.listActive()).map(categoryView),
    };
    res.json(body);
  });

  return router;
}

/** Mounted at /api/products without authentication: active products of LIVE vendors. */
export function productsRouter(products: ProductService): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const query = parseInput(productListQuerySchema, { ...req.query });
    const page = await products.listPublic(query);
    const body: ProductListResponseBody = {
      products: page.rows.map(publicProductView),
      next_cursor: page.nextCursor,
    };
    res.json(body);
  });

  return router;
}

/**
 * Mounted at /api/vendor/products behind requireAuth(VENDOR): the caller's own catalogue and
 * stock. A product of another shop is 404 on every route.
 */
export function vendorProductsRouter(products: ProductService): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/', async (req, res) => {
    const query = parseInput(vendorProductListQuerySchema, { ...req.query });
    const page = await products.listForVendor(authOf(req).userId, query);
    const body: VendorProductListResponseBody = {
      products: page.rows.map(vendorProductView),
      next_cursor: page.nextCursor,
    };
    res.json(body);
  });

  router.post('/', async (req, res) => {
    const input = parseInput(vendorProductCreateRequestSchema, req.body);
    const body: VendorProductResponseBody = {
      product: vendorProductView(await products.create(authOf(req).userId, input)),
    };
    res.status(201).json(body);
  });

  router.patch('/:id/stock', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const { stock_quantity: stockQuantity } = parseInput(vendorProductStockRequestSchema, req.body);
    const body: VendorProductResponseBody = {
      product: vendorProductView(await products.setStock(authOf(req).userId, id, stockQuantity)),
    };
    res.json(body);
  });

  return router;
}

/**
 * The taxonomy and product routes of /api/admin (SUPER_ADMIN, `no-store`; added to the Phase 15
 * admin router). Categories are replaced whole with PUT; DELETE only removes an unused one.
 */
export function mountAdminCatalog(
  router: Router,
  categories: CategoryService,
  products: ProductService,
): void {
  router.get('/categories', async (_req, res) => {
    const body: AdminCategoryListResponseBody = {
      categories: (await categories.listAll()).map(adminCategoryView),
    };
    res.json(body);
  });

  router.post('/categories', async (req, res) => {
    const input = parseInput(adminCategoryWriteRequestSchema, req.body);
    const body: AdminCategoryResponseBody = {
      category: adminCategoryView(await categories.create(input)),
    };
    res.status(201).json(body);
  });

  router.put('/categories/:id', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const input = parseInput(adminCategoryWriteRequestSchema, req.body);
    const body: AdminCategoryResponseBody = {
      category: adminCategoryView(await categories.update(id, input)),
    };
    res.json(body);
  });

  router.delete('/categories/:id', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    await categories.remove(id);
    res.status(204).end();
  });

  router.get('/products', async (req, res) => {
    const query = parseInput(adminProductListQuerySchema, { ...req.query });
    const page = await products.listForAdmin(query);
    const body: AdminProductListResponseBody = {
      products: page.rows.map(adminProductView),
      next_cursor: page.nextCursor,
    };
    res.json(body);
  });

  router.patch('/products/:id/active', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const { is_active: isActive } = parseInput(adminProductActiveRequestSchema, req.body);
    const body: AdminProductResponseBody = {
      product: adminProductView(await products.setActive(id, isActive)),
    };
    res.json(body);
  });
}
