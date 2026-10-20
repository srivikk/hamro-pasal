import type { TaxIdentityView } from '@hamro-pasal/shared-types';

/** The `vendorShop.*` banner the dashboard shows, worst first. */
export type ComplianceReminder = 'panBanner' | 'documentBanner' | 'verificationBanner';

/**
 * What still keeps the shop from trading (SPEC core 10, amended 2026-10-20: a shop is offline until
 * Hamro Pasal verifies its PAN). It follows what the server holds, not what this phone once saved,
 * and shows nothing until that answer is in: then the missing PAN, the missing certificate, or the
 * verification still to come. A verified shop has nothing to be told.
 */
export function complianceReminder(
  identity: Pick<TaxIdentityView, 'tax_id' | 'has_pan_document' | 'pan_verified_at'> | undefined,
): ComplianceReminder | null {
  if (identity === undefined) return null;
  if (identity.pan_verified_at !== null) return null;
  if (identity.tax_id === null) return 'panBanner';
  if (!identity.has_pan_document) return 'documentBanner';
  return 'verificationBanner';
}
