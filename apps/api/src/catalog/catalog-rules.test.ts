import { assertInStock } from '../checkout/checkout-service';
import { InsufficientStockError } from '../inventory/errors';
import { prefixSearchQuery } from './product-service';
import { depthOf, heightOf, placementProblem, type TaxonomyNode } from './taxonomy-rules';

/*
 * groceries ─ dairy ─ milk
 *           └ snacks
 * electronics
 */
const TAXONOMY: readonly TaxonomyNode[] = [
  { id: 'groceries', parent_id: null },
  { id: 'dairy', parent_id: 'groceries' },
  { id: 'milk', parent_id: 'dairy' },
  { id: 'snacks', parent_id: 'groceries' },
  { id: 'electronics', parent_id: null },
];
const nodes = new Map(TAXONOMY.map((node) => [node.id, node]));

describe('taxonomy depth and height', () => {
  it('counts levels from the root down', () => {
    expect(depthOf(nodes, 'groceries')).toBe(1);
    expect(depthOf(nodes, 'dairy')).toBe(2);
    expect(depthOf(nodes, 'milk')).toBe(3);
  });

  it('counts the levels of a subtree', () => {
    expect(heightOf(nodes, 'milk')).toBe(1);
    expect(heightOf(nodes, 'dairy')).toBe(2);
    expect(heightOf(nodes, 'groceries')).toBe(3);
    expect(heightOf(nodes, 'electronics')).toBe(1);
  });

  it('terminates on stored bad data (a cycle)', () => {
    const loop = new Map<string, TaxonomyNode>([
      ['a', { id: 'a', parent_id: 'b' }],
      ['b', { id: 'b', parent_id: 'a' }],
    ]);

    expect(depthOf(loop, 'a')).toBeGreaterThan(0);
    expect(heightOf(loop, 'a')).toBe(2);
  });
});

describe('placementProblem', () => {
  it('lets a new category be a root or sit under a first or second level', () => {
    expect(placementProblem(TAXONOMY, null, null)).toBeNull();
    expect(placementProblem(TAXONOMY, null, 'electronics')).toBeNull();
    expect(placementProblem(TAXONOMY, null, 'dairy')).toBeNull();
  });

  it('refuses an unknown parent', () => {
    expect(placementProblem(TAXONOMY, null, 'nowhere')).toBe('PARENT_NOT_FOUND');
  });

  it('refuses a fourth level', () => {
    expect(placementProblem(TAXONOMY, null, 'milk')).toBe('TOO_DEEP');
  });

  it('refuses a category under itself or under any of its descendants', () => {
    expect(placementProblem(TAXONOMY, 'groceries', 'groceries')).toBe('CYCLE');
    expect(placementProblem(TAXONOMY, 'groceries', 'dairy')).toBe('CYCLE');
    expect(placementProblem(TAXONOMY, 'groceries', 'milk')).toBe('CYCLE');
  });

  it('counts the moved subtree against the depth limit', () => {
    // dairy carries milk: under a root it ends at level 3, under a second level at level 4.
    expect(placementProblem(TAXONOMY, 'dairy', 'electronics')).toBeNull();
    expect(placementProblem(TAXONOMY, 'dairy', 'snacks')).toBe('TOO_DEEP');
    // groceries is three levels tall: it fits only as a root.
    expect(placementProblem(TAXONOMY, 'groceries', 'electronics')).toBe('TOO_DEEP');
    expect(placementProblem(TAXONOMY, 'groceries', null)).toBeNull();
  });

  it('lets a leaf move anywhere above the limit, and a category keep its parent', () => {
    expect(placementProblem(TAXONOMY, 'milk', 'snacks')).toBeNull();
    expect(placementProblem(TAXONOMY, 'milk', null)).toBeNull();
    expect(placementProblem(TAXONOMY, 'dairy', 'groceries')).toBeNull();
  });
});

describe('prefixSearchQuery', () => {
  it('turns every word into a prefix term joined by AND', () => {
    expect(prefixSearchQuery('Wai  wai Noodles')).toBe('wai:* & wai:* & noodles:*');
    expect(prefixSearchQuery('basmati 5kg')).toBe('basmati:* & 5kg:*');
  });

  it('keeps Devanagari words whole (letters with their vowel signs)', () => {
    expect(prefixSearchQuery('जुजु धौ')).toBe('जुजु:* & धौ:*');
  });

  it('strips every tsquery operator, so none can be injected', () => {
    expect(prefixSearchQuery("tea' | !(rice) & <-> :*")).toBe('tea:* & rice:*');
  });

  it('is null when no word is left', () => {
    expect(prefixSearchQuery(' &|!() ')).toBeNull();
  });
});

describe('assertInStock (the checkout stock guard)', () => {
  const onHand = new Map([
    ['tea', { stock_quantity: 3 }],
    ['rice', { stock_quantity: 0 }],
  ]);

  it('passes when every line fits, exactly at the on-hand quantity too', () => {
    expect(() => {
      assertInStock(onHand, [{ productId: 'tea', quantity: 3 }]);
    }).not.toThrow();
  });

  it('reports every short line with what was asked and what is on hand', () => {
    let thrown: unknown;
    try {
      assertInStock(onHand, [
        { productId: 'tea', quantity: 4 },
        { productId: 'rice', quantity: 1 },
      ]);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InsufficientStockError);
    expect((thrown as InsufficientStockError).shortfalls).toEqual([
      { productId: 'tea', requested: 4, available: 3 },
      { productId: 'rice', requested: 1, available: 0 },
    ]);
  });
});
