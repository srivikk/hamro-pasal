import type { DomainEvent } from '@hamro-pasal/shared-types';
import type { SmsMessage } from '@hamro-pasal/sms';

/*
 * Vendor SMS texts for the `notifications.broadcast` events (Phase 13). Plain ASCII so each text
 * is GSM-7 and fits one 160-character segment for realistic amounts (tested). Every text starts
 * with the brand, like the login code SMS.
 */

/** One GSM-7 segment. */
export const SINGLE_SMS_SEGMENT_LENGTH = 160;

/** The events this module writes an SMS for. */
export type VendorSmsEvent = Extract<
  DomainEvent,
  { event_type: 'vendor.suspended_for_debt' | 'vendor.restored' | 'vendor.escalation.required' }
>;

/** The SMS for an event, or null when the event is not one a vendor is texted about. */
export function vendorNotificationSms(event: DomainEvent): SmsMessage | null {
  switch (event.event_type) {
    case 'vendor.suspended_for_debt': {
      const { vendor_phone, wallet_balance_npr, suspension_limit_npr, restore_at_npr } =
        event.payload;
      // 2026-10-21, Model C: a prepaid shop is suspended below its Fixed Reserve and back online
      // once the balance is at the reserve again.
      if (restore_at_npr !== undefined && restore_at_npr > 0) {
        return {
          to: vendor_phone,
          text:
            `Hamro Pasal: your shop is offline. Your prepaid balance is ${formatNpr(wallet_balance_npr)}, ` +
            `below the ${formatNpr(suspension_limit_npr)} reserve. Recharge ` +
            `${formatNpr(restore_at_npr - wallet_balance_npr)} in the app to go back online.`,
        };
      }
      // A debt suspension is lifted once the balance is back to 0 or more (Phase 12.5), so the
      // top-up needed is exactly the dues.
      return {
        to: vendor_phone,
        text:
          `Hamro Pasal: your shop is offline. Your wallet is at ${formatNpr(wallet_balance_npr)}, ` +
          `below the ${formatNpr(suspension_limit_npr)} limit. Pay ${formatNpr(-wallet_balance_npr)} ` +
          `in the app's Wallet to go back online.`,
      };
    }
    case 'vendor.restored':
      // SPEC core 10 (amended 2026-10-20): clearing dues never makes a shop LIVE without a
      // verified PAN; it then lands in SUSPENDED_COMPLIANCE and must not be told it is online.
      return {
        to: event.payload.vendor_phone,
        text:
          event.payload.restored_status === 'SUSPENDED_COMPLIANCE'
            ? `Hamro Pasal: your dues are cleared. Your shop stays offline until Hamro Pasal ` +
              `verifies your PAN certificate. Wallet balance: ${formatNpr(event.payload.wallet_balance_npr)}.`
            : `Hamro Pasal: your dues are cleared and your shop is back online. ` +
              `Wallet balance: ${formatNpr(event.payload.wallet_balance_npr)}.`,
      };
    case 'vendor.escalation.required':
      return {
        to: event.payload.vendor_phone,
        text:
          `Hamro Pasal: order #${orderCode(event.payload.order_id)} has waited over ` +
          `${String(event.payload.sla_seconds)} seconds. Open the app now to accept or reject it.`,
      };
    default:
      return null;
  }
}

/** "Rs. 2,500", "Rs. -1,00,000.50": Nepali (lakh) grouping, paisa only when present. */
export function formatNpr(amount: number): string {
  return `Rs. ${amount.toLocaleString('en-IN', {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** The code the vendor dashboard shows for an order (VendorOrderCard): last 6 hex digits. */
export function orderCode(orderId: string): string {
  return orderId.replace(/-/g, '').slice(-6).toUpperCase();
}
