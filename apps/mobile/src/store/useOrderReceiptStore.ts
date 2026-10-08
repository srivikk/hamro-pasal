import { z } from 'zod';
import { create, type Mutate, type StoreApi, type UseBoundStore } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

import { getAppStorage } from '../storage/app-mmkv';
import { mmkvStateStorage } from '../storage/mmkv-state-storage';

export const ORDER_RECEIPT_STORE_KEY = 'hamro-pasal.order-receipts';
export const ORDER_RECEIPT_STORE_VERSION = 1;
/** As many as useOrderStore tracks. */
export const MAX_ORDER_RECEIPTS = 20;

/**
 * What this phone knew about an order when it was placed: the shop, the items and the bill.
 * The order history shows it, and "Reorder" refills the cart from it.
 *
 * It exists because the API has no order list and its order detail carries no shop name. It is
 * the device's own record: an order placed on another phone has none. Money actually charged is
 * always the server's `total_npr` (useOrderStore); nothing here is sent back to the API.
 */
const receiptSchema = z.object({
  orderId: z.string().min(1),
  placedAtMs: z.number().int().nonnegative(),
  /** The shop as the cart knew it: enough to start the same cart again. */
  vendor: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    deliveryFeeNpr: z.number().nonnegative(),
    minOrderValueNpr: z.number().nonnegative(),
  }),
  /** "Thamel, Kathmandu Metropolitan City". Null when the device did not know it. */
  vendorLocation: z.string().min(1).nullable(),
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        name: z.string().min(1),
        unitPriceNpr: z.number().positive(),
        quantity: z.number().int().positive(),
      }),
    )
    .min(1),
  /** As the server priced the order at checkout. */
  subtotalNpr: z.number().nonnegative(),
  deliveryFeeNpr: z.number().nonnegative(),
  platformFeeNpr: z.number().nonnegative(),
  /**
   * The discounts the server applied to the order (its `vendor_offer_discount_npr` and
   * `platform_promo_discount_npr`), with the labels the quote showed for them. 0 / null on an
   * order without one, and on receipts saved before the server priced discounts (those carried a
   * development-only mock figure, which is dropped on load).
   */
  vendorOfferDiscountNpr: z.number().nonnegative().default(0),
  vendorOfferLabel: z.string().min(1).nullable().default(null),
  platformPromoDiscountNpr: z.number().nonnegative().default(0),
  platformPromoLabel: z.string().min(1).nullable().default(null),
  /** Where it was delivered, as one line ("Near …, Thamel, Kathmandu Metropolitan City-26, Kathmandu"). */
  deliveryAddress: z.string().min(1).nullable(),
});

export type OrderReceipt = z.infer<typeof receiptSchema>;
/** What the cart hands over: fields with a default may be left out. */
export type OrderReceiptInput = z.input<typeof receiptSchema>;

export interface OrderReceiptState {
  receipts: Record<string, OrderReceipt>;
  /** Adds or replaces the receipt of one order; the oldest go once there are more than 20. */
  saveReceipt: (receipt: OrderReceiptInput) => void;
  resetReceipts: () => void;
}

export type PersistedOrderReceiptState = Pick<OrderReceiptState, 'receipts'>;

export type OrderReceiptStore = UseBoundStore<
  Mutate<StoreApi<OrderReceiptState>, [['zustand/persist', PersistedOrderReceiptState]]>
>;

function newestFirst(receipts: readonly OrderReceipt[]): Record<string, OrderReceipt> {
  const kept = [...receipts]
    .sort((a, b) => b.placedAtMs - a.placedAtMs)
    .slice(0, MAX_ORDER_RECEIPTS);
  return Object.fromEntries(kept.map((receipt) => [receipt.orderId, receipt]));
}

/** Anything stored that no longer passes the schema is dropped, never repaired. */
function toPersistedReceipts(value: unknown): PersistedOrderReceiptState {
  const stored: unknown =
    typeof value === 'object' && value !== null ? Reflect.get(value, 'receipts') : null;
  if (typeof stored !== 'object' || stored === null) return { receipts: {} };
  const valid: OrderReceipt[] = [];
  for (const entry of Object.values(stored)) {
    const parsed = receiptSchema.safeParse(entry);
    if (parsed.success) valid.push(parsed.data);
  }
  return { receipts: newestFirst(valid) };
}

export function createOrderReceiptStore(storage: StateStorage<void>): OrderReceiptStore {
  return create<OrderReceiptState>()(
    persist<OrderReceiptState, [], [], PersistedOrderReceiptState>(
      (set) => ({
        receipts: {},
        saveReceipt: (receipt) => {
          const parsed = receiptSchema.parse(receipt);
          set((state) => ({
            receipts: newestFirst([
              ...Object.values(state.receipts).filter((kept) => kept.orderId !== parsed.orderId),
              parsed,
            ]),
          }));
        },
        resetReceipts: () => {
          set({ receipts: {} });
        },
      }),
      {
        name: ORDER_RECEIPT_STORE_KEY,
        version: ORDER_RECEIPT_STORE_VERSION,
        storage: createJSONStorage<PersistedOrderReceiptState>(() => storage),
        partialize: ({ receipts }): PersistedOrderReceiptState => ({ receipts }),
        migrate: (persisted) => toPersistedReceipts(persisted),
        merge: (persisted, current) => ({ ...current, ...toPersistedReceipts(persisted) }),
      },
    ),
  );
}

export const useOrderReceiptStore: OrderReceiptStore = createOrderReceiptStore(
  mmkvStateStorage(getAppStorage()),
);
