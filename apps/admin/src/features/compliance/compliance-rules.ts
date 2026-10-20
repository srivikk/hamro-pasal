import {
  complianceVendorViewSchema,
  PAN_STANDINGS,
  panStandingOf,
  type AdminComplianceVendorListResponseBody,
  type ComplianceVendorView,
  type PanStanding,
} from '@hamro-pasal/shared-types';

import { ApiError } from '../../api/client';
import { formatDateTime } from '../../lib/format';

/**
 * The contract of GET /api/admin/compliance/vendors and POST /api/admin/vendors/:id/pan-verification
 * lives in `@hamro-pasal/shared-types` (`api/admin-governance.ts`) since the API serves them
 * (Phase 26). Its refinements are only what the database guarantees: in particular a vendor may be
 * LIVE without a PAN until the compliance sweep reaches it, and such a row is shown as "PAN
 * missing", not refused. Re-exported so the screen and its tests keep one import.
 */
export { complianceVendorViewSchema, PAN_STANDINGS, panStandingOf };
export type { ComplianceVendorView, PanStanding };

export const PAN_STANDING_LABELS: Readonly<Record<PanStanding, string>> = {
  SUSPENDED: 'Suspended: no PAN',
  MISSING: 'PAN missing',
  UNVERIFIED: 'Awaiting verification',
  VERIFIED: 'Verified',
};

/** The filter chips; the screen opens on the shops that are offline for compliance. */
export const COMPLIANCE_FILTERS: readonly {
  readonly label: string;
  readonly standing: PanStanding | undefined;
}[] = [
  { label: 'Suspended for compliance', standing: 'SUSPENDED' },
  { label: 'PAN missing', standing: 'MISSING' },
  { label: 'Awaiting verification', standing: 'UNVERIFIED' },
  { label: 'Verified', standing: 'VERIFIED' },
  { label: 'All', standing: undefined },
];

export function countByStanding(
  vendors: readonly ComplianceVendorView[],
): Readonly<Record<PanStanding, number>> {
  const counts: Record<PanStanding, number> = {
    SUSPENDED: 0,
    MISSING: 0,
    UNVERIFIED: 0,
    VERIFIED: 0,
  };
  for (const vendor of vendors) counts[panStandingOf(vendor)] += 1;
  return counts;
}

/**
 * The rows of one filter, worst standing first; among suspended shops the longest offline first,
 * otherwise by name.
 */
export function complianceRows(
  vendors: readonly ComplianceVendorView[],
  standing: PanStanding | undefined,
  search: string,
): ComplianceVendorView[] {
  const needle = search.trim().toLowerCase();
  return vendors
    .filter((vendor) => standing === undefined || panStandingOf(vendor) === standing)
    .filter(
      (vendor) =>
        needle === '' ||
        [
          vendor.business_name,
          vendor.legal_name ?? '',
          vendor.phone,
          vendor.municipality_palika_string,
          vendor.tax_id ?? '',
        ].some((field) => field.toLowerCase().includes(needle)),
    )
    .sort((a, b) => {
      const rank =
        PAN_STANDINGS.indexOf(panStandingOf(a)) - PAN_STANDINGS.indexOf(panStandingOf(b));
      if (rank !== 0) return rank;
      const since = (a.compliance_suspended_at ?? '').localeCompare(
        b.compliance_suspended_at ?? '',
      );
      return since !== 0 ? since : a.business_name.localeCompare(b.business_name);
    });
}

export interface VerifyButton {
  readonly label: string;
  readonly enabled: boolean;
  /** Why there is nothing to verify, or what verifying does. */
  readonly note: string | null;
}

/**
 * The "Verify document" button of one row. Only a PAN that is on file, unchecked and backed by
 * an uploaded document can be verified (Phase 35: the server answers 422 DOCUMENT_MISSING
 * otherwise; an admin verifies a document, never a bare number).
 *
 * SPEC core 10 (amended 2026-10-20): the verification is what lets a shop trade. A shop suspended
 * for compliance comes back only through this button, once its PAN and certificate are on file.
 */
export function verifyButton(vendor: ComplianceVendorView): VerifyButton {
  switch (panStandingOf(vendor)) {
    case 'SUSPENDED': {
      const restoresTo = vendor.restore_status ?? 'its previous status';
      if (vendor.tax_id === null) {
        return {
          label: 'Verify document',
          enabled: false,
          note: `Offline: no PAN on file. The vendor adds its PAN and certificate in the Vendor App; verifying them restores the shop to ${restoresTo}.`,
        };
      }
      if (!vendor.has_pan_document) {
        return {
          label: 'Verify document',
          enabled: false,
          note: `Offline: no certificate uploaded for this PAN yet. Verifying it, once uploaded, restores the shop to ${restoresTo}.`,
        };
      }
      return {
        label: 'Verify document',
        enabled: true,
        note: `Offline until verified. Verifying restores the shop to ${restoresTo} and issues its waiting invoices.`,
      };
    }
    case 'MISSING':
      return {
        label: 'Verify document',
        enabled: false,
        note:
          vendor.status === 'SUSPENDED'
            ? 'No PAN on file. When this suspension is lifted the shop moves to SUSPENDED_COMPLIANCE, not LIVE.'
            : vendor.status === 'LIVE'
              ? 'No PAN on file. The compliance sweep takes this shop offline until its PAN is verified.'
              : 'No PAN on file. The shop cannot go LIVE without a verified PAN.',
      };
    case 'UNVERIFIED':
      if (!vendor.has_pan_document) {
        return {
          label: 'Verify document',
          enabled: false,
          note: 'No document uploaded. The vendor uploads its PAN certificate in the Vendor App; there is nothing to verify until then. The shop cannot go LIVE and its payouts are held.',
        };
      }
      return {
        label: 'Verify document',
        enabled: true,
        note:
          vendor.status === 'LIVE'
            ? 'LIVE without a verified PAN: the compliance sweep takes it offline. Verify to keep it trading.'
            : 'The shop cannot go LIVE, and its payouts are held, until the PAN is verified.',
      };
    case 'VERIFIED':
      return {
        label: 'Verified',
        enabled: false,
        note:
          vendor.pan_verified_at === null
            ? null
            : `Checked ${formatDateTime(vendor.pan_verified_at)}.`,
      };
  }
}

/** The cached list with one vendor replaced by the server's answer to its verification. */
export function replaceComplianceVendor(
  list: AdminComplianceVendorListResponseBody,
  vendor: ComplianceVendorView,
): AdminComplianceVendorListResponseBody {
  return {
    ...list,
    vendors: list.vendors.map((current) => (current.id === vendor.id ? vendor : current)),
  };
}

export function verifyErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'PAN_MISSING':
        return 'This vendor has no PAN on file any more. The list has been refreshed.';
      case 'DOCUMENT_MISSING':
        return 'This vendor has no PAN document on file (a changed PAN number removes the old one). The list has been refreshed.';
      case 'VENDOR_NOT_FOUND':
        return 'This vendor no longer exists.';
      case 'NETWORK_ERROR':
        return 'The API cannot be reached. Try again.';
      default:
        break;
    }
  }
  return 'The verification could not be saved. Try again.';
}

/** What to tell the admin when a vendor's PAN document cannot be shown. */
export function panDocumentErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'PAN_DOCUMENT_NOT_FOUND':
        return 'This vendor has no document on file any more. Refresh the list.';
      case 'VENDOR_NOT_FOUND':
        return 'This vendor no longer exists.';
      case 'NETWORK_ERROR':
        return 'The API cannot be reached. Try again.';
      default:
        break;
    }
  }
  return 'The document could not be loaded. Try again.';
}
