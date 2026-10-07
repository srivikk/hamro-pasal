import type { CategoryView, MenuProduct } from '@hamro-pasal/shared-types';
import { useQuery } from '@tanstack/react-query';

import { scanProducts } from '../../api/catalog';
import { retryTransientFailures } from '../../api/query-client';

/** One subcategory of a shop's menu: its header and the products under it. */
export interface MenuSection {
  /** The category id, or OTHER_SECTION_KEY for products without a known category. */
  key: string;
  title: string;
  data: MenuProduct[];
}

export const OTHER_SECTION_KEY = 'other';

/** What the item detail sheet shows beyond the menu line itself. */
export interface MenuProductDetail {
  description: string | null;
  unit: string;
  /** The product's first photo. */
  imageUrl: string | null;
  /** All of its photos, in the vendor's order: what the full-screen viewer shows. */
  imageUrls: string[];
}

/** What the public product list knows about a shop's products and the menu does not. */
export interface MenuCatalog {
  /** product id → category id, for every product that has a category. */
  categoryOf: Record<string, string>;
  /** product id → description, unit and photo. */
  detailOf: Record<string, MenuProductDetail>;
}

export function menuCatalogQueryKey(vendorId: string) {
  return ['vendor-menu-catalog', vendorId] as const;
}

export async function fetchMenuCatalog(vendorId: string): Promise<MenuCatalog> {
  const products = await scanProducts({ vendorId });
  const catalog: MenuCatalog = { categoryOf: {}, detailOf: {} };
  for (const product of products) {
    if (product.category_id !== null) catalog.categoryOf[product.id] = product.category_id;
    catalog.detailOf[product.id] = {
      description: product.description,
      unit: product.unit,
      imageUrl: product.image_urls[0] ?? null,
      imageUrls: product.image_urls,
    };
  }
  return catalog;
}

/**
 * Each product's subcategory, description, unit and photo. The vendor menu
 * (`GET /api/vendors/:id/products`) carries none of them, so they are read from the public
 * product list (`GET /api/products?vendor_id=`) in one scan (STATE_HANDOFF §8Z, §8Z.3).
 */
export function useMenuCatalog(vendorId: string) {
  return useQuery({
    queryKey: menuCatalogQueryKey(vendorId),
    queryFn: () => fetchMenuCatalog(vendorId),
    staleTime: 60_000,
    retry: retryTransientFailures,
  });
}

/**
 * The menu lines whose name contains every word typed (case-insensitive). The menu is already on
 * the device, so the shop page's search is local. A blank search keeps everything.
 */
export function searchMenu(products: readonly MenuProduct[], text: string): MenuProduct[] {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length === 0) return [...products];
  return products.filter((product) => {
    const name = product.name.toLowerCase();
    return words.every((word) => name.includes(word));
  });
}

/**
 * Groups a menu by subcategory. Sections follow the taxonomy's own order, products keep the
 * menu's order inside each, and anything without a known (or still active) category goes into a
 * last section titled `otherTitle`. With no category known at all there is one section,
 * `allTitle`, so the page still lists everything while the mapping loads or if it fails.
 */
export function groupMenu(
  products: readonly MenuProduct[],
  categoryOfProduct: Readonly<Record<string, string>> | undefined,
  categories: readonly CategoryView[],
  titles: { all: string; other: string },
): MenuSection[] {
  if (products.length === 0) return [];
  const named = new Map(categories.map((category) => [category.id, category.name]));
  const groups = new Map<string, MenuProduct[]>();
  for (const product of products) {
    const categoryId = categoryOfProduct?.[product.id];
    const key = categoryId !== undefined && named.has(categoryId) ? categoryId : OTHER_SECTION_KEY;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [product]);
    else group.push(product);
  }
  const other = groups.get(OTHER_SECTION_KEY);
  if (other !== undefined && groups.size === 1) {
    return [{ key: OTHER_SECTION_KEY, title: titles.all, data: other }];
  }
  const sections: MenuSection[] = [];
  for (const category of categories) {
    const data = groups.get(category.id);
    if (data !== undefined) sections.push({ key: category.id, title: category.name, data });
  }
  if (other !== undefined)
    sections.push({ key: OTHER_SECTION_KEY, title: titles.other, data: other });
  return sections;
}
