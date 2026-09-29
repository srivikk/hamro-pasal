import { checkoutRequestSchema } from '@hamro-pasal/shared-types';

import { THAMEL_ADDRESS } from '../../test/api-fixtures';
import { MOCK_CUSTOMER_LOCATION, MOCK_VENDORS } from '../feed/mock-feed-api';
import {
  buildVendorMenu,
  fetchMockVendorMenu,
  MOCK_PRODUCTS_BY_VENDOR,
  VendorNotFoundError,
} from './mock-menu-api';

const THAMEL = '6f1c2a10-0000-4000-8000-000000000011';
const PATAN = '6f1c2a10-0000-4000-8000-000000000012';
const BHAKTAPUR_NOT_LIVE = '6f1c2a10-0000-4000-8000-000000000013';

describe('mock menu API', () => {
  it('returns the vendor, its serviceability and its products', () => {
    const menu = buildVendorMenu(THAMEL, MOCK_CUSTOMER_LOCATION);

    expect(menu.vendor.business_name).toBe('Thamel Kirana Pasal');
    expect(menu.serviceable).toBe(true);
    expect(menu.products.map((product) => product.name)).toEqual([
      'Wai Wai Noodles (carton of 30)',
      'Basmati Rice 5kg',
      'Ilam Tea 500g',
      'Mustard Oil 1L',
    ]);
  });

  it('maps zero stock to in_stock: false', () => {
    const menu = buildVendorMenu(THAMEL, MOCK_CUSTOMER_LOCATION);

    expect(menu.products.find((product) => product.name === 'Mustard Oil 1L')?.in_stock).toBe(
      false,
    );
    expect(menu.products.find((product) => product.name === 'Ilam Tea 500g')?.in_stock).toBe(true);
  });

  it('marks an Explore Further vendor as not serviceable', () => {
    expect(buildVendorMenu(PATAN, MOCK_CUSTOMER_LOCATION).serviceable).toBe(false);
  });

  it.each([
    ['a vendor that is not LIVE', BHAKTAPUR_NOT_LIVE],
    ['an unknown vendor', 'nope'],
  ])('refuses %s', (_label, vendorId) => {
    expect(() => buildVendorMenu(vendorId, MOCK_CUSTOMER_LOCATION)).toThrow(VendorNotFoundError);
  });

  it('uses vendor and product IDs the checkout contract accepts', () => {
    for (const vendor of MOCK_VENDORS) {
      const products = MOCK_PRODUCTS_BY_VENDOR[vendor.id] ?? [];
      const request = {
        idempotency_key: 'test-key-123',
        vendor_id: vendor.id,
        payment_method: 'COD',
        items: products.map((product) => ({ product_id: product.id, quantity: 1 })),
        delivery_address: THAMEL_ADDRESS,
      };
      if (products.length > 0) expect(checkoutRequestSchema.safeParse(request).success).toBe(true);
    }
  });

  it('gives every product a unique ID', () => {
    const ids = Object.values(MOCK_PRODUCTS_BY_VENDOR).flatMap((products) =>
      products.map((product) => product.id),
    );

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolves asynchronously like a network call', async () => {
    await expect(
      fetchMockVendorMenu(THAMEL, MOCK_CUSTOMER_LOCATION, { latencyMs: 0 }),
    ).resolves.toEqual(buildVendorMenu(THAMEL, MOCK_CUSTOMER_LOCATION));
  });
});
