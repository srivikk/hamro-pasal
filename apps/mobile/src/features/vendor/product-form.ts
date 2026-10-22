import {
  buildCategoryTree,
  flattenCategoryTree,
  toAsciiDigits,
  type CategoryView,
  type VendorProductView,
} from '@hamro-pasal/shared-types';

import type { ProductDraft } from '../../api/vendor-products';

import { sanitizeAmountInput } from './shop-settings';

/** The limits of `POST /api/vendor/products` (shared-types `api/catalog.ts`). */
export const MAX_PRODUCT_NAME_LENGTH = 120;
export const MAX_PRODUCT_PRICE_NPR = 1_000_000;
export const MAX_STOCK_QUANTITY = 1_000_000;

/** One choice of the category picker. */
export interface ProductCategoryOption {
  /** The category's id: what `POST / PUT /api/vendor/products` take as `category_id`. */
  readonly value: string;
  /** Indented by depth, for the list. */
  readonly label: string;
  readonly name: string;
}

/**
 * The categories a product can be filed under: the live taxonomy from `GET /api/categories`, in
 * tree order, subcategories indented. Decided 2026-10-20: a category the Super Admin has hidden is
 * never offered, nor is anything below it, even if it is active itself. The server already leaves
 * them out; the tree is rebuilt from its roots here as well, so a category whose parent is missing
 * from the list is dropped rather than offered on its own.
 */
export function productCategoryOptions(
  categories: readonly CategoryView[],
): ProductCategoryOption[] {
  return flattenCategoryTree(buildCategoryTree(categories)).map((node) => ({
    value: node.id,
    label: `${'— '.repeat(node.depth - 1)}${node.name}`,
    name: node.name,
  }));
}

/** The name of an offered category, or null when it is hidden or unknown. */
export function categoryNameOf(
  options: readonly ProductCategoryOption[],
  value: string,
): string | null {
  return options.find((option) => option.value === value)?.name ?? null;
}

/** What the vendor fills in for a product (sent to the API by `useSaveProduct`). */
export type ProductDetails = ProductDraft;

/** The form's fields as typed. */
export interface ProductForm {
  name: string;
  price: string;
  categoryId: string | null;
  stock: string;
}

export const EMPTY_PRODUCT_FORM: ProductForm = {
  name: '',
  price: '',
  categoryId: null,
  stock: '0',
};

export type ProductField = 'name' | 'price' | 'categoryId' | 'stock';
export type ProductFormError = 'name' | 'nameTaken' | 'price' | 'category' | 'stock';
export type ProductFormErrors = Partial<Record<ProductField, ProductFormError>>;

export type ProductFormResult =
  { ok: true; details: ProductDetails } | { ok: false; errors: ProductFormErrors };

/** The form for a product as the server holds it (a product older than the taxonomy has none). */
export function formFromProduct(product: VendorProductView): ProductForm {
  return {
    name: product.name,
    price: String(product.price_npr),
    categoryId: product.category_id,
    stock: String(product.stock_quantity),
  };
}

export { sanitizeAmountInput as sanitizePriceInput };

/** What the stock field holds: ASCII digits only (Nepali digits converted). */
export function sanitizeStockInput(input: string): string {
  return toAsciiDigits(input)
    .replace(/[^0-9]/g, '')
    .slice(0, 7);
}

const normaliseName = (name: string): string => name.trim().replace(/\s+/g, ' ');

/**
 * Checks the form and builds the product. `otherNames` are the shop's other products: a name is
 * unique per shop (the API answers 409 PRODUCT_NAME_TAKEN), compared without regard to case.
 */
export function validateProductForm(
  form: ProductForm,
  otherNames: readonly string[] = [],
  categories: readonly ProductCategoryOption[] = [],
): ProductFormResult {
  const errors: ProductFormErrors = {};

  const name = normaliseName(form.name);
  if (name === '' || name.length > MAX_PRODUCT_NAME_LENGTH) {
    errors.name = 'name';
  } else if (otherNames.some((other) => other.toLowerCase() === name.toLowerCase())) {
    errors.name = 'nameTaken';
  }

  const price = /^[0-9]{1,7}(\.[0-9]{1,2})?$/.test(form.price.trim())
    ? Number(form.price)
    : Number.NaN;
  if (Number.isNaN(price) || price <= 0 || price > MAX_PRODUCT_PRICE_NPR) errors.price = 'price';

  const categoryId = form.categoryId;
  // Only a category that is still offered: one hidden since the form was opened is refused.
  if (categoryId === null || categoryNameOf(categories, categoryId) === null) {
    errors.categoryId = 'category';
  }

  const stock = /^[0-9]{1,7}$/.test(form.stock.trim()) ? Number(form.stock) : Number.NaN;
  if (Number.isNaN(stock) || stock > MAX_STOCK_QUANTITY) errors.stock = 'stock';

  if (Object.keys(errors).length > 0 || categoryId === null) return { ok: false, errors };
  return { ok: true, details: { name, priceNpr: price, categoryId, stockQuantity: stock } };
}

/**
 * What a Catalogue row says about a product (2026-10-21), most decisive first: hidden by the
 * Super Admin (moderation), switched out of stock by the vendor, no stock left, or orderable.
 */
export type ProductStatus = 'HIDDEN_BY_ADMIN' | 'SWITCHED_OFF' | 'NO_STOCK' | 'ORDERABLE';

export function productStatusOf(
  product: Pick<VendorProductView, 'is_active' | 'in_stock' | 'stock_quantity'>,
): ProductStatus {
  if (!product.is_active) return 'HIDDEN_BY_ADMIN';
  if (!product.in_stock) return 'SWITCHED_OFF';
  return product.stock_quantity > 0 ? 'ORDERABLE' : 'NO_STOCK';
}
