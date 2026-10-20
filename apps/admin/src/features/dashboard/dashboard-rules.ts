import type { AdminVendorView } from '@hamro-pasal/shared-types';

/*
 * The Dashboard tab's figures ("Sajilo cha hai" admin layout, 2026-10-21). Every number is
 * counted from what the existing admin routes return (GET /api/admin/vendors and
 * GET /api/admin/finance/settlements); nothing is estimated. Platform revenue and order volume are
 * not shown: no admin route reports them yet.
 */

export interface DashboardStats {
  liveShops: number;
  /** SANDBOXED: signed up, waiting for a Super Admin's approval (vendor flow step 4). */
  awaitingApproval: number;
  /** Suspended for debt, by an admin, or for compliance (PAN). */
  suspended: number;
  totalShops: number;
}

export function dashboardStats(vendors: readonly AdminVendorView[]): DashboardStats {
  let liveShops = 0;
  let awaitingApproval = 0;
  let suspended = 0;
  for (const vendor of vendors) {
    if (vendor.status === 'LIVE') liveShops += 1;
    else if (vendor.status === 'SANDBOXED') awaitingApproval += 1;
    else if (vendor.status === 'SUSPENDED' || vendor.status === 'SUSPENDED_COMPLIANCE') {
      suspended += 1;
    }
  }
  return { liveShops, awaitingApproval, suspended, totalShops: vendors.length };
}

export interface BarDatum {
  label: string;
  value: number;
}

/**
 * Shops per municipality, most first, ties by name. Past `limit` the rest fold into one "Other"
 * bar, so a long tail never becomes a long chart.
 */
export function shopsByMunicipality(vendors: readonly AdminVendorView[], limit = 6): BarDatum[] {
  const counts = new Map<string, number>();
  for (const vendor of vendors) {
    counts.set(
      vendor.municipality_palika_string,
      (counts.get(vendor.municipality_palika_string) ?? 0) + 1,
    );
  }
  const sorted = [...counts.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  if (sorted.length <= limit) return sorted;
  const rest = sorted.slice(limit - 1).reduce((sum, bar) => sum + bar.value, 0);
  return [...sorted.slice(0, limit - 1), { label: 'Other', value: rest }];
}

const MONTH = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'Asia/Kathmandu' });
const MONTH_KEY = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  timeZone: 'Asia/Kathmandu',
});

/**
 * Shops that signed up in each of the last `months` calendar months (Nepal Time), oldest first,
 * the current month last. A month without a sign-up is a bar of 0, never left out.
 */
export function signupsPerMonth(
  vendors: readonly AdminVendorView[],
  now: Date,
  months = 6,
): BarDatum[] {
  const keys: { key: string; label: string }[] = [];
  for (let back = months - 1; back >= 0; back -= 1) {
    // The 15th is safe from time-zone edges whatever the day today.
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 15));
    keys.push({ key: MONTH_KEY.format(day), label: MONTH.format(day) });
  }
  const counts = new Map(keys.map(({ key }) => [key, 0]));
  for (const vendor of vendors) {
    const key = MONTH_KEY.format(new Date(vendor.created_at));
    const count = counts.get(key);
    if (count !== undefined) counts.set(key, count + 1);
  }
  return keys.map(({ key, label }) => ({ label, value: counts.get(key) ?? 0 }));
}

/** The shops waiting for approval, oldest sign-up first (they have waited longest). */
export function approvalQueue(vendors: readonly AdminVendorView[]): AdminVendorView[] {
  return vendors
    .filter((vendor) => vendor.status === 'SANDBOXED')
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}
