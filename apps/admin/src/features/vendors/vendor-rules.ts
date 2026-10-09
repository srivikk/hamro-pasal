import type { AdminVendorSuspension, AdminVendorView } from '@hamro-pasal/shared-types';

import { ApiError } from '../../api/client';
import { formatNpr } from '../../lib/format';

export const SUSPENSION_LABELS: Readonly<Record<AdminVendorSuspension, string>> = {
  NONE: 'Active',
  DEBT: 'Suspended: wallet debt',
  ADMIN: 'Suspended by admin',
  UNSPECIFIED: 'Suspended: no reason recorded',
};

export interface VendorActionButton {
  readonly action: 'SUSPEND' | 'RESTORE';
  readonly enabled: boolean;
  /** Why the button is disabled, or what a Restore will do. */
  readonly note: string | null;
}

/**
 * Which override a vendor row offers, mirroring the server's rules (WalletService) so the admin
 * sees why before pressing: the server still decides and answers 409 if the row is stale.
 */
export function vendorAction(
  vendor: AdminVendorView,
  suspensionLimitNpr: number,
): VendorActionButton {
  // Phase 36: a shop its vendor closed has no standing to suspend, and nothing restores it.
  if (vendor.status === 'DEACTIVATED') {
    return {
      action: 'SUSPEND',
      enabled: false,
      note: 'The vendor closed this shop. Its records are kept; it cannot be suspended or restored.',
    };
  }
  if (vendor.status !== 'SUSPENDED') {
    return { action: 'SUSPEND', enabled: true, note: null };
  }
  if (vendor.restore_status === null) {
    return {
      action: 'RESTORE',
      enabled: false,
      note: 'No earlier status was recorded, so it cannot be restored from here.',
    };
  }
  if (vendor.wallet_balance_npr < suspensionLimitNpr) {
    return {
      action: 'RESTORE',
      enabled: false,
      note: `Wallet is ${formatNpr(vendor.wallet_balance_npr)}, below the ${formatNpr(suspensionLimitNpr)} limit: the vendor must pay dues first.`,
    };
  }
  return { action: 'RESTORE', enabled: true, note: `Restores to ${vendor.restore_status}.` };
}

export function overrideErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'VENDOR_STATUS_CONFLICT':
        return 'The vendor changed meanwhile. The list has been refreshed.';
      case 'WALLET_BELOW_SUSPENSION_LIMIT':
        return 'The wallet is below the suspension limit: the vendor must pay dues first.';
      case 'RESTORE_STATUS_UNKNOWN':
        return 'No earlier status was recorded for this vendor.';
      case 'VENDOR_NOT_FOUND':
        return 'This vendor no longer exists.';
      case 'NETWORK_ERROR':
        return 'The API cannot be reached. Try again.';
      default:
        break;
    }
  }
  return 'The change could not be saved. Try again.';
}

/** Case-insensitive match on the business name, phone or Palika. */
export function matchesSearch(vendor: AdminVendorView, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return [vendor.business_name, vendor.phone, vendor.municipality_palika_string].some((field) =>
    field.toLowerCase().includes(needle),
  );
}
