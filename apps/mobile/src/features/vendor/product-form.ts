import { toAsciiDigits } from '@hamro-pasal/shared-types';

import { sanitizeAmountInput } from './shop-settings';

/** The limits of `POST /api/vendor/products` (shared-types `api/catalog.ts`). */
export const MAX_PRODUCT_NAME_LENGTH = 120;
export const MAX_PRODUCT_PRICE_NPR = 1_000_000;
export const MAX_STOCK_QUANTITY = 1_000_000;

/**
 * TEMPORARY: the categories a product can be filed under. The seeded taxonomy's subcategories
 * (packages/db seed), keyed by slug. To be replaced by `GET /api/categories` (it is public and
 * the app already reads it for customers).
 */
export const MOCK_PRODUCT_CATEGORIES = [
  { id: 'rice-flour-pulses', name: 'Rice, Flour & Pulses' },
  { id: 'noodles-snacks', name: 'Noodles & Snacks' },
  { id: 'tea-coffee', name: 'Tea & Coffee' },
  { id: 'dairy', name: 'Dairy' },
  { id: 'fresh-vegetables', name: 'Fresh Vegetables' },
  { id: 'honey-spreads', name: 'Honey & Spreads' },
] as const;

export function categoryName(categoryId: string): string | null {
  return MOCK_PRODUCT_CATEGORIES.find((category) => category.id === categoryId)?.name ?? null;
}

/** What the vendor fills in for a product. */
export interface ProductDetails {
  name: string;
  priceNpr: number;
  categoryId: string;
  stockQuantity: number;
}

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

export function formFromProduct(product: ProductDetails): ProductForm {
  return {
    name: product.name,
    price: String(product.priceNpr),
    categoryId: product.categoryId,
    stock: String(product.stockQuantity),
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
  if (categoryId === null || categoryName(categoryId) === null) errors.categoryId = 'category';

  const stock = /^[0-9]{1,7}$/.test(form.stock.trim()) ? Number(form.stock) : Number.NaN;
  if (Number.isNaN(stock) || stock > MAX_STOCK_QUANTITY) errors.stock = 'stock';

  if (Object.keys(errors).length > 0 || categoryId === null) return { ok: false, errors };
  return { ok: true, details: { name, priceNpr: price, categoryId, stockQuantity: stock } };
}
