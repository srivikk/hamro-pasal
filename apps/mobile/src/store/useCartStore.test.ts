import { mmkvStateStorage } from '../storage/mmkv-state-storage';
import { InMemoryMmkv } from '../test/in-memory-mmkv';
import {
  CART_STORE_KEY,
  CART_STORE_VERSION,
  createCartStore,
  MAX_CART_LINES,
  MAX_LINE_QUANTITY,
  selectCartTotal,
  selectIsReplaceCartPromptVisible,
  selectItemCount,
  type CartStore,
} from './useCartStore';

const THAMEL = { id: 'vendor-thamel', name: 'Thamel Kirana Pasal' };
const PATAN = { id: 'vendor-patan', name: 'Patan Organic Store' };

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
        { productId: RICE.id, name: RICE.name, unitPriceNpr: RICE.unitPriceNpr, quantity: 1 },
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
        { productId: HONEY.id, name: HONEY.name, unitPriceNpr: HONEY.unitPriceNpr, quantity: 3 },
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

  describe('MMKV persistence', () => {
    it('persists vendor and lines but never the transient prompt', () => {
      store.getState().addItem(THAMEL, RICE, 2);
      store.getState().addItem(PATAN, HONEY);

      const raw = engine.getString(CART_STORE_KEY);
      expect(raw).toBeDefined();
      expect(JSON.parse(raw ?? '')).toEqual({
        state: {
          vendor: THAMEL,
          lines: [{ productId: RICE.id, name: RICE.name, unitPriceNpr: 120.5, quantity: 2 }],
        },
        version: CART_STORE_VERSION,
      });
    });

    it('restores the cart after a relaunch', () => {
      store.getState().addItem(THAMEL, RICE, 3);
      store.getState().addItem(THAMEL, OIL, 2);

      const relaunched = createCartStore(mmkvStateStorage(engine));

      expect(relaunched.getState().vendor).toEqual(THAMEL);
      expect(selectCartTotal(relaunched.getState())).toBe(561.48);
      expect(relaunched.getState().pendingAddition).toBeNull();
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
