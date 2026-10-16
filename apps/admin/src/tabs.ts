/**
 * The dashboard's sections; each is addressed by the URL hash `#/<id>`. The order is the order of
 * the tab bar: operations, vendors, catalogue, commercial terms, money, audit.
 */
export const TABS = [
  { id: 'dlq', label: 'Dead letters' },
  { id: 'vendors', label: 'Vendors' },
  { id: 'compliance', label: 'Compliance' },
  { id: 'categories', label: 'Categories' },
  { id: 'products', label: 'Products' },
  { id: 'pricing-plans', label: 'Pricing plans' },
  { id: 'campaigns', label: 'Campaigns' },
  { id: 'ad-products', label: 'Ad products' },
  { id: 'promotions', label: 'Promotions' },
  { id: 'logistics', label: 'Logistics' },
  // Retired by decision (2026-10-07): vendor-requested payouts are replaced by Settlements. The
  // tab stays until the API serves the settlement routes, then it and its screen are deleted.
  { id: 'payouts', label: 'Payouts (legacy)' },
  { id: 'settlements', label: 'Settlements' },
  { id: 'approvals', label: 'Vendor requests' },
  // Step 7.5: push messages to chosen shops or to all customers.
  { id: 'notifications', label: 'Notifications' },
  // Step 7.6: CSV data exports.
  { id: 'exports', label: 'Exports' },
  { id: 'audit-log', label: 'Audit log' },
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
