/** The dashboard's sections; each is addressed by the URL hash `#/<id>`. */
export const TABS = [
  { id: 'dlq', label: 'Dead letters' },
  { id: 'vendors', label: 'Vendors' },
  { id: 'categories', label: 'Categories' },
  { id: 'products', label: 'Products' },
  { id: 'payouts', label: 'Payouts' },
] as const;

export type Tab = (typeof TABS)[number]['id'];

/** `#/vendors` -> 'vendors'; anything unknown opens the first tab. */
export function tabFromHash(hash: string): Tab {
  return TABS.find((tab) => hash === `#/${tab.id}`)?.id ?? 'dlq';
}

/** Phase 22: the Vendor Portal's sections, addressed the same way. */
export const VENDOR_TABS = [
  { id: 'my-products', label: 'My products' },
  { id: 'earnings', label: 'Earnings' },
] as const;

export type VendorTab = (typeof VENDOR_TABS)[number]['id'];

export function vendorTabFromHash(hash: string): VendorTab {
  return VENDOR_TABS.find((tab) => hash === `#/${tab.id}`)?.id ?? 'my-products';
}
