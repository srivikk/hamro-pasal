import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { fetchVendorMenu, VENDOR_NOT_FOUND } from '../../api/catalog';
import { ApiError } from '../../api/http';
import { useAddressStore } from '../../store/useAddressStore';
import { customerLocationFrom } from '../location/customer-location';
import { vendorMenuQueryKey } from '../menu/useVendorMenuQuery';

/**
 * - `serviceable`: the shop delivers to the delivery address;
 * - `not_serviceable`: it does not (SPEC §2: outside its radius, another Palika for a CITY_WIDE
 *   shop). Checkout must not be sent;
 * - `unknown`: the answer could not be fetched (no connection). Checkout is not sent either.
 */
export type DeliveryAreaVerdict = 'serviceable' | 'not_serviceable' | 'unknown';

/**
 * Asks the server whether `vendorId` delivers to the selected delivery address: the vendor menu
 * endpoint evaluates SPEC §2 for the coordinates and Palika it is given, so the rule is not
 * copied onto the device. Always a fresh request (the address or the shop's scope may have
 * changed since the menu was browsed, possibly from another location).
 *
 * A shop that is gone (404) or has no address to check counts as `serviceable` here: checkout
 * itself reports those (VENDOR_UNAVAILABLE, the missing-address notice).
 */
export async function checkDeliveryArea(
  queryClient: QueryClient,
  vendorId: string,
): Promise<DeliveryAreaVerdict> {
  const address = useAddressStore.getState().address;
  if (address === null) return 'serviceable';
  const location = customerLocationFrom(address);
  try {
    const menu = await fetchVendorMenu(vendorId, location);
    // The menu screen for this location shows the same answer without asking again.
    queryClient.setQueryData(vendorMenuQueryKey(vendorId, location), menu);
    return menu.serviceable ? 'serviceable' : 'not_serviceable';
  } catch (error) {
    if (error instanceof ApiError && error.code === VENDOR_NOT_FOUND) return 'serviceable';
    return 'unknown';
  }
}

/** The check as a mutation, so the cart can show it in flight and never runs it twice at once. */
export function useDeliveryAreaCheck() {
  const queryClient = useQueryClient();
  return useMutation<DeliveryAreaVerdict, never, string>({
    mutationKey: ['checkout', 'delivery-area'],
    mutationFn: (vendorId) => checkDeliveryArea(queryClient, vendorId),
  });
}
