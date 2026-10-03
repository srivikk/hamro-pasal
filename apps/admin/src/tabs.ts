/** The dashboard's sections; each is addressed by the URL hash `#/<id>`. */
export const TABS = [
  { id: 'dlq', label: 'Dead letters' },
  { id: 'vendors', label: 'Vendors' },
  { id: 'categories', label: 'Categories' },
  { id: 'products', label: 'Products' },
] as const;

export type Tab = (typeof TABS)[number]['id'];

/** `#/vendors` -> 'vendors'; anything unknown opens the first tab. */
export function tabFromHash(hash: string): Tab {
  return TABS.find((tab) => hash === `#/${tab.id}`)?.id ?? 'dlq';
}
