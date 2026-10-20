import type { VendorStatus } from './enums';

/**
 * SPEC core 10, "PAN verification" (amended 2026-10-20): a shop trades only on a PAN a Super Admin
 * has verified. An unverified PAN printed on a tax invoice makes the invoice legally invalid, so
 * a saved number is no longer enough: until `pan_verified_at` is set the shop is
 * SUSPENDED_COMPLIANCE, hidden from customers and unable to accept orders.
 *
 * `pan_verified_at` is the whole test. The database already ties it to a PAN on file
 * (`vendors_pan_verification_check`), verifying needs an uploaded document, and replacing the
 * document or the number clears it.
 */
export function isPanVerified(vendor: { readonly pan_verified_at: Date | string | null }): boolean {
  return vendor.pan_verified_at !== null;
}

/** The status columns a transition writes once the PAN gate has been applied. */
export type GatedStanding =
  | { readonly status: VendorStatus; readonly status_before_compliance_suspension?: never }
  | {
      readonly status: 'SUSPENDED_COMPLIANCE';
      readonly status_before_compliance_suspension: 'LIVE';
    };

/**
 * Where a transition aiming at `target` actually lands. Every path that can make a shop LIVE (a
 * debt or admin restore, a reopening) goes through this: LIVE without a verified PAN becomes
 * SUSPENDED_COMPLIANCE remembering LIVE, so the verification brings it back. Any other target is
 * returned as it is, and leaves `status_before_compliance_suspension` alone.
 */
export function panGatedStanding(target: VendorStatus, panVerified: boolean): GatedStanding {
  if (target === 'LIVE' && !panVerified) {
    return { status: 'SUSPENDED_COMPLIANCE', status_before_compliance_suspension: 'LIVE' };
  }
  return { status: target };
}
