/**
 * The dashboard's sections; each is addressed by the URL hash `#/<id>`. Since the "Sajilo cha
 * hai" layout (2026-10-21) they sit in a sidebar, in these groups and this order; the Dashboard
 * overview opens first.
 */
export const TABS = [
  { id: 'dashboard', label: 'Dashboard', group: 'Overview', icon: '▦' },
  { id: 'vendors', label: 'Vendors', group: 'Shops', icon: '◫' },
  // Steps 7.7 / 7.8: shops onboarded by an admin, and their approval.
  { id: 'onboarding', label: 'Onboarding', group: 'Shops', icon: '＋' },
  { id: 'compliance', label: 'Compliance', group: 'Shops', icon: '✓' },
  { id: 'approvals', label: 'Vendor requests', group: 'Shops', icon: '⇄' },
  { id: 'categories', label: 'Categories', group: 'Catalogue', icon: '☰' },
  { id: 'products', label: 'Products', group: 'Catalogue', icon: '▣' },
  { id: 'campaigns', label: 'Campaigns', group: 'Marketing', icon: '✦' },
  { id: 'ad-products', label: 'Ad products', group: 'Marketing', icon: '◎' },
  { id: 'promotions', label: 'Promotions', group: 'Marketing', icon: '★' },
  { id: 'settlements', label: 'Settlements', group: 'Money', icon: '₨' },
  // Retired by decision (2026-10-07): vendor-requested payouts are replaced by Settlements. The
  // tab stays until the API serves the settlement routes, then it and its screen are deleted.
  { id: 'payouts', label: 'Payouts (legacy)', group: 'Money', icon: '↧' },
  { id: 'pricing-plans', label: 'Pricing plans', group: 'Money', icon: '%' },
  { id: 'logistics', label: 'Logistics', group: 'Platform', icon: '⛟' },
  // Step 7.5: push messages to chosen shops or to all customers.
  { id: 'notifications', label: 'Notifications', group: 'Platform', icon: '✉' },
  { id: 'tutorials', label: 'Tutorials', group: 'Platform', icon: '▶' },
  // Step 7.6: CSV data exports.
  { id: 'exports', label: 'Exports', group: 'Platform', icon: '⇩' },
  { id: 'dlq', label: 'Dead letters', group: 'Platform', icon: '⚠' },
  { id: 'audit-log', label: 'Audit log', group: 'Platform', icon: '⌕' },
] as const;

export type Tab = (typeof TABS)[number]['id'];

type TabEntry = (typeof TABS)[number];

/** The sidebar's groups, in order, each with its sections. */
export const TAB_GROUPS: readonly { name: string; tabs: readonly TabEntry[] }[] = [
  ...new Set(TABS.map((tab) => tab.group)),
].map((name) => ({ name, tabs: TABS.filter((tab) => tab.group === name) }));

/** `#/vendors` -> 'vendors'; anything unknown opens the Dashboard. */
export function tabFromHash(hash: string): Tab {
  return TABS.find((tab) => hash === `#/${tab.id}`)?.id ?? 'dashboard';
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
