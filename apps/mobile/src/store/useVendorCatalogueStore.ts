import { create } from 'zustand';

import type { ProductDetails } from '../features/vendor/product-form';

/**
 * TEMPORARY: the vendor's catalogue on the device, so the Catalogue screens can be built and tried
 * before they are wired to the API that already exists (`/api/vendor/products`, Phases 17 and 19).
 * Development builds only; nothing here reaches the server and it is gone on relaunch.
 */
export const VENDOR_CATALOGUE_MOCKS_ENABLED = __DEV__;

export interface CatalogueProduct extends ProductDetails {
  id: string;
  /**
   * The row's In Stock / Out of Stock switch (`products.is_available`, STATE_HANDOFF.md §8Z.14).
   * Switching a product out of stock keeps its stock count.
   */
  isAvailable: boolean;
  imageUrls: string[];
}

/** The seeded Thamel shop's five products (packages/db seed). */
const SEED: readonly Omit<CatalogueProduct, 'imageUrls'>[] = [
  {
    id: 'seed-1',
    name: 'Basmati Rice 5kg',
    priceNpr: 1150,
    categoryId: 'rice-flour-pulses',
    stockQuantity: 12,
    isAvailable: true,
  },
  {
    id: 'seed-2',
    name: 'DDC Ghee 500ml',
    priceNpr: 750,
    categoryId: 'dairy',
    stockQuantity: 8,
    isAvailable: false,
  },
  {
    id: 'seed-3',
    name: 'Ilam Tea 500g',
    priceNpr: 450,
    categoryId: 'tea-coffee',
    stockQuantity: 30,
    isAvailable: true,
  },
  {
    id: 'seed-4',
    name: 'Masoor Dal 1kg',
    priceNpr: 220,
    categoryId: 'rice-flour-pulses',
    stockQuantity: 45,
    isAvailable: true,
  },
  {
    id: 'seed-5',
    name: 'Wai Wai Noodles (pack of 30)',
    priceNpr: 600,
    categoryId: 'noodles-snacks',
    stockQuantity: 0,
    isAvailable: true,
  },
];

const seedProducts = (): CatalogueProduct[] =>
  VENDOR_CATALOGUE_MOCKS_ENABLED ? SEED.map((product) => ({ ...product, imageUrls: [] })) : [];

const byName = (a: CatalogueProduct, b: CatalogueProduct): number => a.name.localeCompare(b.name);

export interface VendorCatalogueState {
  /** By name, as the API lists them. */
  products: CatalogueProduct[];
  nextId: number;
  /** Adds a product and returns its id. */
  addProduct: (details: ProductDetails) => string;
  updateProduct: (id: string, details: ProductDetails) => void;
  /** The row's switch: sets the availability flag and leaves the stock count as it is. */
  setAvailable: (id: string, isAvailable: boolean) => void;
  reset: () => void;
}

export const useVendorCatalogueStore = create<VendorCatalogueState>()((set, get) => ({
  products: seedProducts(),
  nextId: 1,
  addProduct: (details) => {
    const id = `local-${String(get().nextId)}`;
    set(({ products, nextId }) => ({
      products: [...products, { ...details, id, isAvailable: true, imageUrls: [] }].sort(byName),
      nextId: nextId + 1,
    }));
    return id;
  },
  updateProduct: (id, details) => {
    set(({ products }) => ({
      products: products
        .map((product) => (product.id === id ? { ...product, ...details } : product))
        .sort(byName),
    }));
  },
  setAvailable: (id, isAvailable) => {
    set(({ products }) => ({
      products: products.map((product) =>
        product.id === id ? { ...product, isAvailable } : product,
      ),
    }));
  },
  reset: () => {
    set({ products: seedProducts(), nextId: 1 });
  },
}));
