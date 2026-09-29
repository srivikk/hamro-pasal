import { buildFeed, MOCK_VENDORS } from '../feed/mock-feed-api';
import type { CustomerLocation } from '../feed/serviceability';
import { vendorMenuSchema, type VendorMenu } from './menu-contract';

/*
 * MOCK catalog API, standing in for the server until a catalog endpoint exists. Product IDs are
 * fixed uuids that do not exist in the dev database (the seed generates random ones), so a live
 * checkout of these products is answered with 422 PRODUCT_UNAVAILABLE.
 */

interface MockProduct {
  id: string;
  name: string;
  price_npr: number;
  stock_quantity: number;
}

const product = (
  vendorSuffix: string,
  n: number,
  name: string,
  price: number,
  stock: number,
): MockProduct => ({
  id: `7a2b3c40-${vendorSuffix}-4000-8000-${String(n).padStart(12, '0')}`,
  name,
  price_npr: price,
  stock_quantity: stock,
});

export const MOCK_PRODUCTS_BY_VENDOR: Readonly<Record<string, readonly MockProduct[]>> = {
  // Thamel Kirana Pasal (seed products)
  '6f1c2a10-0000-4000-8000-000000000011': [
    product('0011', 1, 'Wai Wai Noodles (carton of 30)', 600, 40),
    product('0011', 2, 'Basmati Rice 5kg', 1150, 25),
    product('0011', 3, 'Ilam Tea 500g', 450, 60),
    product('0011', 4, 'Mustard Oil 1L', 320, 0),
  ],
  // Boudha Fresh Mart
  '6f1c2a10-0000-4000-8000-000000000014': [
    product('0014', 1, 'Fresh Tomatoes 1kg', 90, 50),
    product('0014', 2, 'Gundruk 250g', 180, 20),
    product('0014', 3, 'Chiura (Beaten Rice) 1kg', 140, 35),
  ],
  // New Road Electronics
  '6f1c2a10-0000-4000-8000-000000000015': [
    product('0015', 1, 'USB-C Charger 20W', 1450, 12),
    product('0015', 2, 'Power Bank 10000mAh', 2400, 8),
  ],
  // Pokhara Dhaka Topi Bhandar
  '6f1c2a10-0000-4000-8000-000000000016': [
    product('0016', 1, 'Dhaka Topi', 850, 30),
    product('0016', 2, 'Dhaka Shawl', 3200, 6),
  ],
  // Patan Organic Store (seed products)
  '6f1c2a10-0000-4000-8000-000000000012': [
    product('0012', 1, 'Organic Red Rice 2kg', 520, 18),
    product('0012', 2, 'Local Honey 500g', 900, 15),
  ],
  // Kirtipur Tarkari Pasal
  '6f1c2a10-0000-4000-8000-000000000017': [product('0017', 1, 'Seasonal Greens Bundle', 120, 25)],
};

export class VendorNotFoundError extends Error {
  constructor(readonly vendorId: string) {
    super(`Vendor ${vendorId} is not listed`);
    this.name = 'VendorNotFoundError';
  }
}

/** What the catalog endpoint would return: a LIVE vendor, its serviceability and its products. */
export function buildVendorMenu(vendorId: string, customer: CustomerLocation): VendorMenu {
  const feed = buildFeed(MOCK_VENDORS, customer);
  const entry = [...feed.serviceable, ...feed.explore_further].find(
    (candidate) => candidate.vendor.id === vendorId,
  );
  if (entry === undefined) throw new VendorNotFoundError(vendorId);

  return vendorMenuSchema.parse({
    vendor: entry.vendor,
    serviceable: entry.serviceable,
    products: (MOCK_PRODUCTS_BY_VENDOR[vendorId] ?? []).map(({ stock_quantity, ...rest }) => ({
      ...rest,
      in_stock: stock_quantity > 0,
    })),
  });
}

export async function fetchMockVendorMenu(
  vendorId: string,
  customer: CustomerLocation,
  { latencyMs = 400 }: { latencyMs?: number } = {},
): Promise<VendorMenu> {
  await new Promise((resolve) => setTimeout(resolve, latencyMs));
  return buildVendorMenu(vendorId, customer);
}
