import { mmkvStateStorage } from '../storage/mmkv-state-storage';
import { InMemoryMmkv } from '../test/in-memory-mmkv';
import {
  CART_STORE_KEY,
  CART_STORE_VERSION,
  createCartStore,
  isOverStock,
  MAX_CART_LINES,
  MAX_LINE_QUANTITY,
  maxLineQuantity,
  selectCartTotal,
  selectHasOverStockLine,
  selectIsReplaceCartPromptVisible,
  selectItemCount,
  type CartStore,
} from './useCartStore';

const THAMEL = {
  id: 'vendor-thamel',
  name: 'Thamel Kirana Pasal',
  deliveryFeeNpr: 50,
  minOrderValueNpr: 500,
};
const PATAN = {
  id: 'vendor-patan',
  name: 'Patan Organic Store',
  deliveryFeeNpr: 80,
  minOrderValueNpr: 400,
};

const RICE = { id: 'p-rice', name: 'Jeera Masino Rice 5kg', unitPriceNpr: 120.5 };
const OIL = { id: 'p-oil', name: 'Mustard Oil 1L', unitPriceNpr: 99.99 };
const HONEY = { id: 'p-honey', name: 'Chitwan Honey', unitPriceNpr: 650 };

describe('cart store', () => {
  let engine: InMemoryMmkv;
  let store: CartStore;

  beforeEach(() => {
    engine = new InMemoryMmkv();
    store = createCartStore(mmkvStateStorage(engine));
  });

  describe('single-vendor enforcement (SPEC edge case 4)', () => {
    it('binds an empty cart to the vendor of the first item', () => {
      expect(store.getState().addItem(THAMEL, RICE)).toBe('added');

      expect(store.getState().vendor).toEqual(THAMEL);
      expect(store.getState().lines).toEqual([
        {
          productId: RICE.id,
          name: RICE.name,
          unitPriceNpr: RICE.unitPriceNpr,
          quantity: 1,
          availableStock: null,
        },
      ]);
    });

    it('rejects an item from a different vendor and leaves the cart untouched', () => {
      store.getState().addItem(THAMEL, RICE, 2);
      const before = { vendor: store.getState().vendor, lines: store.getState().lines };

      expect(store.getState().addItem(PATAN, HONEY)).toBe('vendor_conflict');

      expect(store.getState().vendor).toEqual(before.vendor);
      expect(store.getState().lines).toEqual(before.lines);
      expect(store.getState().lines.some((line) => line.productId === HONEY.id)).toBe(false);
    });

    it('raises the replace-cart prompt with the rejected item on a conflict', () => {
      store.getState().addItem(THAMEL, RICE);
      expect(selectIsReplaceCartPromptVisible(store.getState())).toBe(false);

      store.getState().addItem(PATAN, HONEY, 3);

      expect(selectIsReplaceCartPromptVisible(store.getState())).toBe(true);
      expect(store.getState().pendingAddition).toEqual({
        vendor: PATAN,
        product: HONEY,
        quantity: 3,
      });
    });

    it('keeps the current cart and drops the pending item when the prompt is dismissed', () => {
      store.getState().addItem(THAMEL, RICE);
      store.getState().addItem(PATAN, HONEY);

      store.getState().dismissReplaceCart();

      expect(store.getState().pendingAddition).toBeNull();
      expect(store.getState().vendor).toEqual(THAMEL);
      expect(store.getState().lines.map((line) => line.productId)).toEqual([RICE.id]);
    });

    it('clears the previous vendor and adds the pending item when the prompt is confirmed', () => {
      store.getState().addItem(THAMEL, RICE, 2);
      store.getState().addItem(THAMEL, OIL);
      store.getState().addItem(PATAN, HONEY, 3);

      store.getState().confirmReplaceCart();

      expect(store.getState().pendingAddition).toBeNull();
      expect(store.getState().vendor).toEqual(PATAN);
      expect(store.getState().lines).toEqual([
        {
          productId: HONEY.id,
          name: HONEY.name,
          unitPriceNpr: HONEY.unitPriceNpr,
          quantity: 3,
          availableStock: null,
        },
      ]);
    });

    it('ignores confirmReplaceCart when nothing is pending', () => {
      store.getState().addItem(THAMEL, RICE);

      store.getState().confirmReplaceCart();

      expect(store.getState().vendor).toEqual(THAMEL);
      expect(store.getState().lines).toHaveLength(1);
    });

    it('accepts another vendor without a prompt once the cart has been emptied', () => {
      store.getState().addItem(THAMEL, RICE);
      store.getState().removeItem(RICE.id);

      expect(store.getState().vendor).toBeNull();
      expect(store.getState().addItem(PATAN, HONEY)).toBe('added');
      expect(store.getState().vendor).toEqual(PATAN);
    });

    it('never mixes vendors across any sequence of additions', () => {
      const vendors = [THAMEL, PATAN];
      const products = [RICE, OIL, HONEY];
      for (let i = 0; i < 30; i += 1) {
        const vendor = vendors[i % 2] ?? THAMEL;
        const product = products[i % 3] ?? RICE;
        store.getState().addItem(vendor, product);
        if (i % 5 === 0) store.getState().confirmReplaceCart();
        else store.getState().dismissReplaceCart();

        const { vendor: cartVendor, lines } = store.getState();
        expect(cartVendor === null).toBe(lines.length === 0);
      }
    });
  });

  describe('cartTotal and itemCount', () => {
    it('are zero for an empty cart', () => {
      expect(selectCartTotal(store.getState())).toBe(0);
      expect(selectItemCount(store.getState())).toBe(0);
    });

    it('sums unit price x quantity across lines', () => {
      store.getState().addItem(THAMEL, RICE, 3); // 361.50
      store.getState().addItem(THAMEL, OIL, 2); // 199.98

      expect(selectCartTotal(store.getState())).toBe(561.48);
      expect(selectItemCount(store.getState())).toBe(5);
    });

    it('has no floating-point drift', () => {
      store.getState().addItem(THAMEL, { id: 'p-candy', name: 'Candy', unitPriceNpr: 0.1 }, 3);
      store.getState().addItem(THAMEL, { id: 'p-gum', name: 'Gum', unitPriceNpr: 0.2 });

      // In plain floats 0.1 * 3 + 0.2 = 0.5000000000000001.
      expect(selectCartTotal(store.getState())).toBe(0.5);
    });

    it('merges repeat additions of a product into one line', () => {
      store.getState().addItem(THAMEL, RICE, 2);
      store.getState().addItem(THAMEL, RICE, 3);

      expect(store.getState().lines).toHaveLength(1);
      expect(selectItemCount(store.getState())).toBe(5);
      expect(selectCartTotal(store.getState())).toBe(602.5);
    });

    it('reprices a line with the latest price on re-add', () => {
      store.getState().addItem(THAMEL, RICE);
      store.getState().addItem(THAMEL, { ...RICE, unitPriceNpr: 130 });

      expect(selectCartTotal(store.getState())).toBe(260);
    });

    it('updates after quantity changes and removals', () => {
      store.getState().addItem(THAMEL, RICE, 3);
      store.getState().addItem(THAMEL, OIL, 2);

      store.getState().setQuantity(RICE.id, 1);
      expect(selectCartTotal(store.getState())).toBe(320.48);

      store.getState().setQuantity(OIL.id, 0);
      expect(selectCartTotal(store.getState())).toBe(120.5);
      expect(selectItemCount(store.getState())).toBe(1);
    });

    it('does not count a pending (rejected) addition', () => {
      store.getState().addItem(THAMEL, RICE);
      store.getState().addItem(PATAN, HONEY, 4);

      expect(selectCartTotal(store.getState())).toBe(120.5);
      expect(selectItemCount(store.getState())).toBe(1);
    });
  });

  describe('limits and validation (checkout API: 1-99 per product, 50 products)', () => {
    it(`refuses to take a line past ${String(MAX_LINE_QUANTITY)}`, () => {
      store.getState().addItem(THAMEL, RICE, MAX_LINE_QUANTITY);

      expect(store.getState().addItem(THAMEL, RICE)).toBe('quantity_limit');
      expect(selectItemCount(store.getState())).toBe(MAX_LINE_QUANTITY);
    });

    it('caps setQuantity at the per-line maximum', () => {
      store.getState().addItem(THAMEL, RICE);

      store.getState().setQuantity(RICE.id, 500);

      expect(selectItemCount(store.getState())).toBe(MAX_LINE_QUANTITY);
    });

    it(`refuses a new product once the cart holds ${String(MAX_CART_LINES)}`, () => {
      for (let i = 0; i < MAX_CART_LINES; i += 1) {
        store
          .getState()
          .addItem(THAMEL, { id: `p-${String(i)}`, name: `Item ${String(i)}`, unitPriceNpr: 10 });
      }

      expect(store.getState().addItem(THAMEL, RICE)).toBe('cart_full');
      expect(
        store.getState().addItem(THAMEL, { id: 'p-0', name: 'Item 0', unitPriceNpr: 10 }),
      ).toBe('added');
    });

    it.each([0, -1, 1.5, Number.NaN])('rejects quantity %p', (quantity) => {
      expect(() => store.getState().addItem(THAMEL, RICE, quantity)).toThrow(RangeError);
      expect(store.getState().lines).toHaveLength(0);
    });

    it.each([0, -10, Number.POSITIVE_INFINITY])('rejects unit price %p', (unitPriceNpr) => {
      expect(() => store.getState().addItem(THAMEL, { ...RICE, unitPriceNpr })).toThrow(RangeError);
    });

    it('rejects a negative setQuantity', () => {
      store.getState().addItem(THAMEL, RICE);

      expect(() => {
        store.getState().setQuantity(RICE.id, -1);
      }).toThrow(RangeError);
    });

    it('clearCart empties lines, vendor and any pending prompt', () => {
      store.getState().addItem(THAMEL, RICE);
      store.getState().addItem(PATAN, HONEY);

      store.getState().clearCart();

      expect(store.getState()).toMatchObject({ vendor: null, lines: [], pendingAddition: null });
    });
  });

  describe('stock safeguards (Phase 18)', () => {
    const riceWithStock = (availableStock: number) => ({ ...RICE, availableStock });

    it('records the stock the product list reported on the line', () => {
      store.getState().addItem(THAMEL, riceWithStock(7), 2);

      expect(store.getState().lines[0]).toMatchObject({ quantity: 2, availableStock: 7 });
    });

    it('adds up to exactly the stock, and refuses one more', () => {
      expect(store.getState().addItem(THAMEL, riceWithStock(3), 3)).toBe('added');

      expect(store.getState().addItem(THAMEL, riceWithStock(3))).toBe('stock_limit');
      expect(selectItemCount(store.getState())).toBe(3);
    });

    it('refuses a first add above the stock and leaves the cart empty', () => {
      expect(store.getState().addItem(THAMEL, riceWithStock(2), 3)).toBe('stock_limit');

      expect(store.getState()).toMatchObject({ vendor: null, lines: [] });
    });

    it('refuses any add of a sold-out product', () => {
      expect(store.getState().addItem(THAMEL, riceWithStock(0))).toBe('stock_limit');
      expect(store.getState().lines).toHaveLength(0);
    });

    it('counts what the cart already holds against the stock', () => {
      store.getState().addItem(THAMEL, riceWithStock(5), 4);

      expect(store.getState().addItem(THAMEL, riceWithStock(5), 2)).toBe('stock_limit');
      expect(store.getState().addItem(THAMEL, riceWithStock(5), 1)).toBe('added');
    });

    it('takes the newest stock on a re-add (a restock lifts the limit)', () => {
      store.getState().addItem(THAMEL, riceWithStock(2), 2);

      expect(store.getState().addItem(THAMEL, riceWithStock(10), 3)).toBe('added');
      expect(store.getState().lines[0]).toMatchObject({ quantity: 5, availableStock: 10 });
    });

    it('keeps the known stock when a screen without a count (the vendor menu) adds', () => {
      store.getState().addItem(THAMEL, riceWithStock(2), 2);

      expect(store.getState().addItem(THAMEL, RICE)).toBe('stock_limit');
      expect(store.getState().lines[0]).toMatchObject({ quantity: 2, availableStock: 2 });
    });

    it('reports the per-line limit before the stock when both are passed', () => {
      store.getState().addItem(THAMEL, riceWithStock(500), MAX_LINE_QUANTITY);

      expect(store.getState().addItem(THAMEL, riceWithStock(500))).toBe('quantity_limit');
    });

    it('carries the stock through the replace-cart prompt', () => {
      store.getState().addItem(THAMEL, RICE);
      store.getState().addItem(PATAN, { ...HONEY, availableStock: 4 }, 2);

      store.getState().confirmReplaceCart();

      expect(store.getState().lines[0]).toMatchObject({ quantity: 2, availableStock: 4 });
    });

    it('clamps setQuantity to the known stock', () => {
      store.getState().addItem(THAMEL, riceWithStock(4), 1);

      store.getState().setQuantity(RICE.id, 9);

      expect(selectItemCount(store.getState())).toBe(4);
    });

    it('syncStock records what the server says is left without changing quantities', () => {
      store.getState().addItem(THAMEL, RICE, 5);
      store.getState().addItem(THAMEL, OIL, 2);

      store.getState().syncStock([{ productId: RICE.id, available: 2 }]);

      expect(store.getState().lines).toEqual([
        expect.objectContaining({ productId: RICE.id, quantity: 5, availableStock: 2 }),
        expect.objectContaining({ productId: OIL.id, quantity: 2, availableStock: null }),
      ]);
      expect(store.getState().lines.map(isOverStock)).toEqual([true, false]);
      expect(selectHasOverStockLine(store.getState())).toBe(true);
    });

    it('lets an over-stock line step down one at a time, but never back up', () => {
      store.getState().addItem(THAMEL, RICE, 5);
      store.getState().syncStock([{ productId: RICE.id, available: 2 }]);

      store.getState().setQuantity(RICE.id, 4);
      expect(selectItemCount(store.getState())).toBe(4);
      store.getState().setQuantity(RICE.id, 5);
      expect(selectItemCount(store.getState())).toBe(4);

      store.getState().setQuantity(RICE.id, 2);
      expect(selectHasOverStockLine(store.getState())).toBe(false);
      store.getState().setQuantity(RICE.id, 3);
      expect(selectItemCount(store.getState())).toBe(2);
    });

    it('flags a line whose product sold out, until it is removed', () => {
      store.getState().addItem(THAMEL, RICE, 1);
      store.getState().addItem(THAMEL, OIL, 1);

      store.getState().syncStock([{ productId: RICE.id, available: 0 }]);
      expect(selectHasOverStockLine(store.getState())).toBe(true);

      store.getState().setQuantity(RICE.id, 0);
      expect(selectHasOverStockLine(store.getState())).toBe(false);
      expect(store.getState().lines.map((line) => line.productId)).toEqual([OIL.id]);
    });

    it('ignores stock for products that are not in the cart', () => {
      store.getState().addItem(THAMEL, RICE, 1);
      const before = store.getState().lines;

      store.getState().syncStock([{ productId: HONEY.id, available: 0 }]);

      expect(store.getState().lines).toEqual(before);
    });

    it.each([-1, 1.5, Number.NaN])('rejects a stock of %p', (available) => {
      store.getState().addItem(THAMEL, RICE, 1);

      expect(() => {
        store.getState().syncStock([{ productId: RICE.id, available }]);
      }).toThrow(RangeError);
      expect(store.getState().lines[0]?.availableStock).toBeNull();
    });

    it('maxLineQuantity is the smaller of the stock and the per-line limit', () => {
      expect(maxLineQuantity(null)).toBe(MAX_LINE_QUANTITY);
      expect(maxLineQuantity(4)).toBe(4);
      expect(maxLineQuantity(0)).toBe(0);
      expect(maxLineQuantity(5000)).toBe(MAX_LINE_QUANTITY);
    });

    it('a line at exactly its stock is not over stock; unknown stock never is', () => {
      expect(isOverStock({ quantity: 3, availableStock: 3 })).toBe(false);
      expect(isOverStock({ quantity: 4, availableStock: 3 })).toBe(true);
      expect(isOverStock({ quantity: 99, availableStock: null })).toBe(false);
    });
  });

  describe('MMKV persistence', () => {
    it('persists vendor and lines but never the transient prompt', () => {
      store.getState().addItem(THAMEL, RICE, 2);
      store.getState().addItem(PATAN, HONEY);

      const raw = engine.getString(CART_STORE_KEY);
      expect(raw).toBeDefined();
      expect(JSON.parse(raw ?? '')).toEqual({
        state: {
          vendor: THAMEL,
          lines: [
            {
              productId: RICE.id,
              name: RICE.name,
              unitPriceNpr: 120.5,
              quantity: 2,
              availableStock: null,
            },
          ],
        },
        version: CART_STORE_VERSION,
      });
    });

    it('persists the known stock, so an over-stock line is still flagged after a relaunch', () => {
      store.getState().addItem(THAMEL, RICE, 5);
      store.getState().syncStock([{ productId: RICE.id, available: 2 }]);

      const relaunched = createCartStore(mmkvStateStorage(engine));

      expect(relaunched.getState().lines[0]).toMatchObject({ quantity: 5, availableStock: 2 });
      expect(selectHasOverStockLine(relaunched.getState())).toBe(true);
    });

    it('keeps a v2 cart (no stock on its lines), reading the stock as unknown', () => {
      engine.set(
        CART_STORE_KEY,
        JSON.stringify({
          state: {
            vendor: THAMEL,
            lines: [{ productId: RICE.id, name: RICE.name, unitPriceNpr: 120.5, quantity: 2 }],
          },
          version: 2,
        }),
      );

      const upgraded = createCartStore(mmkvStateStorage(engine));

      expect(upgraded.getState().vendor).toEqual(THAMEL);
      expect(upgraded.getState().lines).toEqual([
        {
          productId: RICE.id,
          name: RICE.name,
          unitPriceNpr: 120.5,
          quantity: 2,
          availableStock: null,
        },
      ]);
    });

    it('restores the cart after a relaunch', () => {
      store.getState().addItem(THAMEL, RICE, 3);
      store.getState().addItem(THAMEL, OIL, 2);

      const relaunched = createCartStore(mmkvStateStorage(engine));

      expect(relaunched.getState().vendor).toEqual(THAMEL);
      expect(selectCartTotal(relaunched.getState())).toBe(561.48);
      expect(relaunched.getState().pendingAddition).toBeNull();
    });

    it('starts empty from a v1 cart, whose vendor snapshot has no delivery fee or MOV', () => {
      engine.set(
        CART_STORE_KEY,
        JSON.stringify({
          state: {
            vendor: { id: 'vendor-thamel', name: 'Thamel Kirana Pasal' },
            lines: [{ productId: RICE.id, name: RICE.name, unitPriceNpr: 120.5, quantity: 2 }],
          },
          version: 1,
        }),
      );

      const upgraded = createCartStore(mmkvStateStorage(engine));

      expect(upgraded.getState()).toMatchObject({ vendor: null, lines: [] });
    });

    it.each([
      [
        'lines without a vendor',
        { vendor: null, lines: [{ productId: 'p', name: 'n', unitPriceNpr: 1, quantity: 1 }] },
      ],
      ['a vendor without lines', { vendor: THAMEL, lines: [] }],
      [
        'a negative price',
        { vendor: THAMEL, lines: [{ productId: 'p', name: 'n', unitPriceNpr: -1, quantity: 1 }] },
      ],
      [
        'an over-limit quantity',
        { vendor: THAMEL, lines: [{ productId: 'p', name: 'n', unitPriceNpr: 1, quantity: 100 }] },
      ],
      [
        'a negative stock',
        {
          vendor: THAMEL,
          lines: [{ productId: 'p', name: 'n', unitPriceNpr: 1, quantity: 1, availableStock: -1 }],
        },
      ],
      [
        'a smuggled pending prompt',
        {
          vendor: null,
          lines: [],
          pendingAddition: { vendor: PATAN, product: HONEY, quantity: 1 },
        },
      ],
    ])('discards a persisted cart with %s', (_label, state) => {
      engine.set(CART_STORE_KEY, JSON.stringify({ state, version: CART_STORE_VERSION }));

      const restored = createCartStore(mmkvStateStorage(engine));

      expect(restored.getState()).toMatchObject({ vendor: null, lines: [], pendingAddition: null });
    });
  });
});
