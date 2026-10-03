import {
  buildCategoryTree,
  flattenCategoryTree,
  MAX_PRODUCT_IMAGE_BYTES,
  MAX_PRODUCT_IMAGES,
  PRODUCT_IMAGE_CONTENT_TYPES,
  vendorProductStockRequestSchema,
  vendorProductUpdateRequestSchema,
  type CategoryView,
  type VendorProductListResponseBody,
  type VendorProductUpdate,
  type VendorProductView,
} from '@hamro-pasal/shared-types';

import { ApiError } from '../../api/client';

/** The edit modal's fields, as typed (text inputs hold text). `categoryId` '' = none chosen. */
export interface ProductFormValues {
  readonly name: string;
  readonly categoryId: string;
  readonly description: string;
  readonly price: string;
  readonly unit: string;
  readonly isActive: boolean;
  /** The photos to keep, in order. Uploading adds to it; "Remove" takes one out until Save. */
  readonly imageUrls: readonly string[];
}

export type ProductFormField = 'name' | 'categoryId' | 'description' | 'price' | 'unit';

export function formFromProduct(product: VendorProductView): ProductFormValues {
  return {
    name: product.name,
    categoryId: product.category_id ?? '',
    description: product.description ?? '',
    price: String(product.price_npr),
    unit: product.unit,
    isActive: product.is_active,
    imageUrls: product.image_urls,
  };
}

const FIELD_OF_PATH: Readonly<Record<string, ProductFormField>> = {
  name: 'name',
  category_id: 'categoryId',
  description: 'description',
  price_npr: 'price',
  unit: 'unit',
};

const FIELD_MESSAGES: Readonly<Record<ProductFormField, string>> = {
  name: 'Enter a name of at most 120 characters.',
  categoryId: 'Choose a category.',
  description: 'Use at most 2000 characters.',
  price: 'Enter a price above 0 with at most two decimals, up to Rs. 10,00,000.',
  unit: 'Enter a unit of at most 20 characters, e.g. piece, kg, pack.',
};

export type ProductFormResult =
  | { readonly ok: true; readonly request: VendorProductUpdate }
  | { readonly ok: false; readonly errors: Readonly<Partial<Record<ProductFormField, string>>> };

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * The PUT body for the form, checked with the API's own schema. PUT replaces the product, so what
 * the form does not edit (`metadata`) is carried over from `product`. The photo list is sent only
 * when the vendor removed one: an untouched list is left to the server, so photos uploaded from
 * another window meanwhile are not dropped.
 */
export function validateProductForm(
  values: ProductFormValues,
  product: VendorProductView,
): ProductFormResult {
  const price = values.price.trim();
  const parsed = vendorProductUpdateRequestSchema.safeParse({
    category_id: values.categoryId,
    name: values.name,
    description: values.description,
    // Not a plain decimal: NaN fails the schema's number check.
    price_npr: /^\d+(\.\d{1,2})?$/.test(price) ? Number(price) : Number.NaN,
    unit: values.unit,
    is_active: values.isActive,
    metadata: product.metadata,
    ...(sameList(values.imageUrls, product.image_urls) ? {} : { image_urls: values.imageUrls }),
  });
  if (parsed.success) return { ok: true, request: parsed.data };
  const errors: Partial<Record<ProductFormField, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = FIELD_OF_PATH[String(issue.path[0])];
    if (field !== undefined) errors[field] = FIELD_MESSAGES[field];
  }
  return { ok: false, errors };
}

/**
 * The PUT body that shows a hidden product again with everything else as it is, or null when the
 * product has no category yet (older than the taxonomy): the vendor must then choose one in Edit.
 */
export function showRequest(product: VendorProductView): VendorProductUpdate | null {
  const result = validateProductForm({ ...formFromProduct(product), isActive: true }, product);
  return result.ok ? result.request : null;
}

/** The typed stock as the whole number the API accepts (0 to 1,000,000), or null. */
export function parseStock(input: string): number | null {
  const text = input.trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = vendorProductStockRequestSchema.safeParse({ stock_quantity: Number(text) });
  return parsed.success ? parsed.data.stock_quantity : null;
}

export interface CategoryOption {
  readonly id: string;
  readonly label: string;
}

/**
 * The category picker: the active taxonomy in tree order, subcategories indented. A product may
 * sit in a category the Super Admin has since hidden; that one is offered too (the product may
 * stay there), marked as hidden.
 */
export function categoryOptions(
  categories: readonly CategoryView[],
  currentId: string | null,
): CategoryOption[] {
  const options = flattenCategoryTree(buildCategoryTree(categories)).map((row) => ({
    id: row.id,
    label: `${'— '.repeat(row.depth - 1)}${row.name}`,
  }));
  if (currentId !== null && !options.some((option) => option.id === currentId)) {
    options.unshift({ id: currentId, label: 'Current category (hidden by the admin)' });
  }
  return options;
}

/** "Groceries › Tea", "No category", or a note that the category is hidden. */
export function categoryLabel(
  categories: readonly CategoryView[],
  categoryId: string | null,
): string {
  if (categoryId === null) return 'No category';
  const byId = new Map(categories.map((category) => [category.id, category]));
  const names: string[] = [];
  for (let id: string | null = categoryId; id !== null && names.length < 10;) {
    const category = byId.get(id);
    if (category === undefined) return 'Hidden category';
    names.unshift(category.name);
    id = category.parent_id;
  }
  return names.join(' › ');
}

/** What the browser's file picker tells us about a chosen file. */
export interface ChosenFile {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}

/**
 * Why the chosen files cannot be uploaded, or null when they can. The server checks again (and by
 * the files' own bytes, not the type the browser reports).
 */
export function uploadProblem(files: readonly ChosenFile[], currentCount: number): string | null {
  if (files.length === 0) return 'Choose at least one photo.';
  const room = MAX_PRODUCT_IMAGES - currentCount;
  if (files.length > room) {
    return room <= 0
      ? `A product can have at most ${String(MAX_PRODUCT_IMAGES)} photos. Remove one and save first.`
      : `Only ${String(room)} more photo${room === 1 ? '' : 's'} fit (at most ${String(MAX_PRODUCT_IMAGES)} per product).`;
  }
  const allowed: readonly string[] = PRODUCT_IMAGE_CONTENT_TYPES;
  const wrongType = files.find((file) => !allowed.includes(file.type));
  if (wrongType !== undefined) return `${wrongType.name} is not a JPEG, PNG or WebP image.`;
  const tooLarge = files.find((file) => file.size > MAX_PRODUCT_IMAGE_BYTES);
  if (tooLarge !== undefined) return `${tooLarge.name} is larger than 5 MB.`;
  return null;
}

/** The loaded pages with one product replaced by its updated view. */
export function replaceOwnProduct(
  pages: readonly VendorProductListResponseBody[],
  updated: VendorProductView,
): VendorProductListResponseBody[] {
  return pages.map((page) => ({
    ...page,
    products: page.products.map((product) => (product.id === updated.id ? updated : product)),
  }));
}

/** The URLs in `after` that `before` did not have (what an upload just added). */
export function addedUrls(before: readonly string[], after: readonly string[]): string[] {
  const known = new Set(before);
  return after.filter((url) => !known.has(url));
}

export function vendorProductErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'PRODUCT_NOT_FOUND':
        return 'This product no longer exists. The list has been refreshed.';
      case 'PRODUCT_NAME_TAKEN':
        return 'Your shop already has a product with this name.';
      case 'CATEGORY_UNAVAILABLE':
        return 'This category is no longer available. Choose another one.';
      case 'PRODUCT_IMAGE_LIMIT':
        return `A product can have at most ${String(MAX_PRODUCT_IMAGES)} photos.`;
      case 'FILE_TOO_LARGE':
        return 'Each photo may be at most 5 MB.';
      case 'UNSUPPORTED_MEDIA_TYPE':
        return 'Photos must be JPEG, PNG or WebP images.';
      case 'VENDOR_NOT_FOUND':
        return 'This account has no shop yet.';
      case 'FORBIDDEN':
        return 'This account is not a vendor.';
      case 'VALIDATION_FAILED':
      case 'MALFORMED_REQUEST':
        return 'The server refused these values. Check them and try again.';
      case 'NETWORK_ERROR':
        return 'The API cannot be reached. Try again.';
      default:
        break;
    }
  }
  return 'The change could not be saved. Try again.';
}
