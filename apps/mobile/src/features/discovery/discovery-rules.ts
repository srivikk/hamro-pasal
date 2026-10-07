import {
  MAX_LINE_QUANTITY,
  MAX_PRODUCT_SEARCH_LENGTH,
  type CategoryView,
} from '@hamro-pasal/shared-types';

/** How long the search field must rest before GET /api/products is asked. */
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * What is sent as `search`: trimmed, inner whitespace collapsed, cut to the API's limit. Null for
 * a blank field (the API refuses an empty search).
 */
export function toSearchTerm(input: string): string | null {
  const term = input.trim().replace(/\s+/g, ' ').slice(0, MAX_PRODUCT_SEARCH_LENGTH).trim();
  return term === '' ? null : term;
}

/** The root categories, in the order the server lists them (display order, then name). */
export function rootCategories(categories: readonly CategoryView[]): CategoryView[] {
  return categories.filter((category) => category.parent_id === null);
}

/**
 * How many more units of a product the cart can take: the stock (and the checkout's per-line
 * limit) minus what the cart already holds. Zero when sold out or when the cart has it all.
 */
export function maxAddable(stockQuantity: number, quantityInCart: number): number {
  return Math.max(0, Math.min(stockQuantity, MAX_LINE_QUANTITY) - quantityInCart);
}

/** The stepper's value: at least 1, at most `max` (1 is shown while nothing can be added). */
export function clampQuantity(selected: number, max: number): number {
  return Math.max(1, Math.min(selected, max));
}

/**
 * The category a promotion points at. Its `target_value` is the category's slug ("festive");
 * a name typed as shown ("Festive & Dashain") is accepted too. Case does not matter.
 */
export function findCategoryByTarget(
  categories: readonly CategoryView[],
  target: string,
): CategoryView | undefined {
  const wanted = target.trim().toLowerCase();
  return (
    categories.find((category) => category.slug === wanted) ??
    categories.find((category) => category.name.toLowerCase() === wanted)
  );
}
