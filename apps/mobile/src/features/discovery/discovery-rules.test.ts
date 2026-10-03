import { category, ELECTRONICS_ID, GROCERIES_ID, TEA_COFFEE_ID } from '../../test/api-fixtures';
import {
  clampQuantity,
  maxAddable,
  rootCategories,
  SEARCH_DEBOUNCE_MS,
  toSearchTerm,
} from './discovery-rules';

describe('toSearchTerm', () => {
  it('trims and collapses whitespace', () => {
    expect(toSearchTerm('  wai   wai ')).toBe('wai wai');
  });

  it('is null for a blank field (the API refuses an empty search)', () => {
    expect(toSearchTerm('')).toBeNull();
    expect(toSearchTerm('   ')).toBeNull();
  });

  it('keeps Devanagari text', () => {
    expect(toSearchTerm(' चिया ')).toBe('चिया');
  });

  it('cuts to the 100 characters the API accepts', () => {
    expect(toSearchTerm('a'.repeat(150))).toHaveLength(100);
    expect(toSearchTerm(`${'a'.repeat(99)} b`)).toBe('a'.repeat(99));
  });
});

describe('rootCategories', () => {
  it('keeps the roots in the order the server sent them', () => {
    const roots = rootCategories([
      category({ id: GROCERIES_ID, name: 'Groceries' }),
      category({ id: TEA_COFFEE_ID, name: 'Tea & Coffee', parent_id: GROCERIES_ID }),
      category({ id: ELECTRONICS_ID, name: 'Electronics' }),
    ]);

    expect(roots.map((root) => root.id)).toEqual([GROCERIES_ID, ELECTRONICS_ID]);
  });

  it('is empty for an empty taxonomy', () => {
    expect(rootCategories([])).toEqual([]);
  });
});

describe('maxAddable (the quantity picker ceiling)', () => {
  it('is the stock when the cart has none of the product', () => {
    expect(maxAddable(12, 0)).toBe(12);
  });

  it('subtracts what the cart already holds', () => {
    expect(maxAddable(12, 5)).toBe(7);
    expect(maxAddable(12, 12)).toBe(0);
  });

  it('is zero for a sold-out product', () => {
    expect(maxAddable(0, 0)).toBe(0);
  });

  it('never goes negative when the cart holds more than is left', () => {
    expect(maxAddable(2, 5)).toBe(0);
  });

  it('is capped by the 99-per-line checkout limit', () => {
    expect(maxAddable(500, 0)).toBe(99);
    expect(maxAddable(500, 90)).toBe(9);
  });
});

describe('clampQuantity', () => {
  it('keeps a value inside the range', () => {
    expect(clampQuantity(3, 5)).toBe(3);
  });

  it('pulls a value above the ceiling down to it', () => {
    expect(clampQuantity(8, 5)).toBe(5);
  });

  it('shows 1 while nothing can be added', () => {
    expect(clampQuantity(4, 0)).toBe(1);
    expect(clampQuantity(0, 5)).toBe(1);
  });
});

it('debounces the search by 300 ms', () => {
  expect(SEARCH_DEBOUNCE_MS).toBe(300);
});
