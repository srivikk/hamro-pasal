import type {
  SellerSignupOptionsResponseBody,
  VendorFulfillmentMode,
} from '@hamro-pasal/shared-types';

/** The delivery choices of "Open your shop", in the order they are shown. */
export const SIGNUP_DELIVERY_MODES = ['SELF_DELIVERY', 'PLATFORM_FLEET'] as const;

/**
 * The delivery modes a new shop may pick (2026-10-20): only those the Super Admin has switched on
 * platform-wide. The server refuses the others (422 DELIVERY_MODE_DISABLED), so they are not
 * offered at all. Empty: registrations are paused.
 */
export function offeredDeliveryModes(
  options: SellerSignupOptionsResponseBody,
): VendorFulfillmentMode[] {
  return SIGNUP_DELIVERY_MODES.filter((mode) =>
    mode === 'SELF_DELIVERY' ? options.self_delivery_enabled : options.platform_fleet_enabled,
  );
}

/**
 * The mode the form sends: the vendor's choice while it is still offered, else the first offered
 * one (a mode switched off since the screen opened is never sent). Null when none is offered.
 */
export function effectiveDeliveryMode(
  offered: readonly VendorFulfillmentMode[],
  chosen: VendorFulfillmentMode | null,
): VendorFulfillmentMode | null {
  if (chosen !== null && offered.includes(chosen)) return chosen;
  return offered[0] ?? null;
}
