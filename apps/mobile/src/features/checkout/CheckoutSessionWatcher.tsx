import { useLockStatus } from '../../api/queries';

/**
 * Mounted once at the root, so the reservation keeps being checked (and a lapsed one purges the
 * cart) whichever screen the customer is on.
 */
export function CheckoutSessionWatcher() {
  useLockStatus();
  return null;
}
