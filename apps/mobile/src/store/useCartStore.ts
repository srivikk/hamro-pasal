import { z } from 'zod';
import { create, type Mutate, type StoreApi, type UseBoundStore } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

import { toNpr, toPaisa } from '../lib/money';
import { getAppStorage } from '../storage/app-mmkv';
import { mmkvStateStorage } from '../storage/mmkv-state-storage';

export const CART_STORE_KEY = 'hamro-pasal.cart';
export const CART_STORE_VERSION = 1;

/** The checkout API accepts 1-99 of each product and at most 50 distinct products per order. */
export const MAX_LINE_QUANTITY = 99;
export const MAX_CART_LINES = 50;

const cartVendorSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
});

const cartLineSchema = z.strictObject({
  productId: z.string().min(1),
  name: z.string().min(1),
  /** Display price only. The server re-prices every line from the database at checkout. */
  unitPriceNpr: z.number().positive(),
  quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
});

const persistedCartSchema = z.union([
  z.strictObject({ vendor: z.null(), lines: z.array(cartLineSchema).length(0) }),
  z.strictObject({
    vendor: cartVendorSchema,
    lines: z.array(cartLineSchema).min(1).max(MAX_CART_LINES),
  }),
]);

export type CartVendor = z.infer<typeof cartVendorSchema>;
export type CartLine = z.infer<typeof cartLineSchema>;

export interface CartProduct {
  id: string;
  name: string;
  unitPriceNpr: number;
}

/** An addition held back because it comes from a different vendor than the current cart. */
export interface PendingCartAddition {
  vendor: CartVendor;
  product: CartProduct;
  quantity: number;
}

export type AddItemResult =
  /** Added, or merged into the existing line for that product. */
  | 'added'
  /** Cart holds another vendor's items. Nothing changed; `pendingAddition` is set for the prompt. */
  | 'vendor_conflict'
  /** The line would exceed MAX_LINE_QUANTITY. Nothing changed. */
  | 'quantity_limit'
  /** The cart already holds MAX_CART_LINES products. Nothing changed. */
  | 'cart_full';

export interface CartState {
  /** The single vendor every line belongs to (SPEC edge case 4). Null exactly when the cart is empty. */
  vendor: CartVendor | null;
  lines: CartLine[];
  /** Set when an add was refused for being from another vendor; drives the replace-cart modal. */
  pendingAddition: PendingCartAddition | null;
  addItem: (vendor: CartVendor, product: CartProduct, quantity?: number) => AddItemResult;
  /** Sets a line's quantity, capped at MAX_LINE_QUANTITY. Zero removes the line. */
  setQuantity: (productId: string, quantity: number) => void;
  removeItem: (productId: string) => void;
  clearCart: () => void;
  /** User accepted the prompt: empty the cart, then add the pending item from the new vendor. */
  confirmReplaceCart: () => void;
  /** User declined the prompt: keep the current cart and drop the pending item. */
  dismissReplaceCart: () => void;
}

export type PersistedCartState = Pick<CartState, 'vendor' | 'lines'>;

export type CartStore = UseBoundStore<
  Mutate<StoreApi<CartState>, [['zustand/persist', PersistedCartState]]>
>;

const EMPTY_CART: PersistedCartState = { vendor: null, lines: [] };

function assertQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new RangeError(`Quantity must be a positive integer, got ${String(quantity)}`);
  }
}

function assertProduct(product: CartProduct): void {
  if (!Number.isFinite(product.unitPriceNpr) || product.unitPriceNpr <= 0) {
    throw new RangeError(`Invalid price ${String(product.unitPriceNpr)} for product ${product.id}`);
  }
}

/** Anything on disk that is not a valid single-vendor cart is dropped, never half-trusted. */
function toPersistedCartState(value: unknown): PersistedCartState {
  const parsed = persistedCartSchema.safeParse(value);
  return parsed.success ? parsed.data : EMPTY_CART;
}

/** Sum of line totals (unit price x quantity) in NPR. Delivery fee and final pricing come from the server. */
export function selectCartTotal(state: Pick<CartState, 'lines'>): number {
  return toNpr(
    state.lines.reduce((sum, line) => sum + toPaisa(line.unitPriceNpr) * line.quantity, 0),
  );
}

/** Total units across all lines (3 x rice + 2 x oil = 5). */
export function selectItemCount(state: Pick<CartState, 'lines'>): number {
  return state.lines.reduce((sum, line) => sum + line.quantity, 0);
}

export function selectIsReplaceCartPromptVisible(
  state: Pick<CartState, 'pendingAddition'>,
): boolean {
  return state.pendingAddition !== null;
}

export function createCartStore(storage: StateStorage<void>): CartStore {
  return create<CartState>()(
    persist<CartState, [], [], PersistedCartState>(
      (set, get) => ({
        ...EMPTY_CART,
        pendingAddition: null,

        addItem: (vendor, product, quantity = 1) => {
          assertQuantity(quantity);
          assertProduct(product);
          const { vendor: current, lines } = get();

          if (current !== null && current.id !== vendor.id) {
            set({ pendingAddition: { vendor, product, quantity } });
            return 'vendor_conflict';
          }

          const existing = lines.find((line) => line.productId === product.id);
          if (existing === undefined && lines.length >= MAX_CART_LINES) return 'cart_full';
          const nextQuantity = (existing?.quantity ?? 0) + quantity;
          if (nextQuantity > MAX_LINE_QUANTITY) return 'quantity_limit';

          // The latest name and price win, so a re-add refreshes a stale snapshot.
          const line: CartLine = {
            productId: product.id,
            name: product.name,
            unitPriceNpr: product.unitPriceNpr,
            quantity: nextQuantity,
          };
          set({
            vendor,
            lines:
              existing === undefined
                ? [...lines, line]
                : lines.map((l) => (l.productId === product.id ? line : l)),
            pendingAddition: null,
          });
          return 'added';
        },

        setQuantity: (productId, quantity) => {
          if (!Number.isInteger(quantity) || quantity < 0) {
            throw new RangeError(
              `Quantity must be a non-negative integer, got ${String(quantity)}`,
            );
          }
          if (quantity === 0) {
            get().removeItem(productId);
            return;
          }
          const capped = Math.min(quantity, MAX_LINE_QUANTITY);
          set(({ lines }) => ({
            lines: lines.map((line) =>
              line.productId === productId ? { ...line, quantity: capped } : line,
            ),
          }));
        },

        removeItem: (productId) => {
          set(({ vendor, lines }) => {
            const remaining = lines.filter((line) => line.productId !== productId);
            return { lines: remaining, vendor: remaining.length === 0 ? null : vendor };
          });
        },

        clearCart: () => {
          set({ ...EMPTY_CART, pendingAddition: null });
        },

        confirmReplaceCart: () => {
          const pending = get().pendingAddition;
          if (pending === null) return;
          set({ ...EMPTY_CART, pendingAddition: null });
          get().addItem(pending.vendor, pending.product, pending.quantity);
        },

        dismissReplaceCart: () => {
          set({ pendingAddition: null });
        },
      }),
      {
        name: CART_STORE_KEY,
        version: CART_STORE_VERSION,
        storage: createJSONStorage<PersistedCartState>(() => storage),
        // The pending addition is a transient UI prompt; it is never restored after a relaunch.
        partialize: ({ vendor, lines }): PersistedCartState => ({ vendor, lines }),
        migrate: (persisted) => toPersistedCartState(persisted),
        merge: (persisted, current) => ({ ...current, ...toPersistedCartState(persisted) }),
      },
    ),
  );
}

export const useCartStore: CartStore = createCartStore(mmkvStateStorage(getAppStorage()));

export function useCartTotal(): number {
  return useCartStore(selectCartTotal);
}

export function useItemCount(): number {
  return useCartStore(selectItemCount);
}
