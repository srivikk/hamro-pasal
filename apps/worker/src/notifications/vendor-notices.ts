import { vendors, type Database } from '@hamro-pasal/db';
import type { DomainEvent } from '@hamro-pasal/shared-types';
import { and, inArray, ne } from 'drizzle-orm';

import type { VendorNotice } from './notification-adapter';
import { formatNpr } from './vendor-sms';

/*
 * What a shop is told about its compliance standing, its ads and its campaigns (Phase 36). Every
 * text opens with the brand, says what happened and what to do next, and is plain ASCII so the
 * SMS is GSM-7 (a campaign's own name is the one part an admin may have typed otherwise). Amounts
 * use the Nepali grouping and dates are Nepal Time.
 */

/** The events this module words. Any other event on the topic is not a vendor notice. */
export type VendorNoticeEvent = Extract<
  DomainEvent,
  {
    event_type:
      | 'vendor.suspended_for_compliance'
      | 'vendor.compliance_restored'
      | 'marketing.ad_ended'
      | 'marketing.ad_paused'
      | 'marketing.campaign_terms_changed';
  }
>;

const NOTICE_EVENT_TYPES: ReadonlySet<string> = new Set<VendorNoticeEvent['event_type']>([
  'vendor.suspended_for_compliance',
  'vendor.compliance_restored',
  'marketing.ad_ended',
  'marketing.ad_paused',
  'marketing.campaign_terms_changed',
]);

export function isVendorNoticeEvent(event: DomainEvent): event is VendorNoticeEvent {
  return NOTICE_EVENT_TYPES.has(event.event_type);
}

export interface VendorContact {
  readonly vendorId: string;
  readonly phone: string;
}

/** Where a shop is reached, for an event that names shops by id only. */
export interface VendorContactReader {
  /** The shops that can still be told: a deactivated shop is left out. Unknown ids are skipped. */
  contacts(vendorIds: readonly string[]): Promise<VendorContact[]>;
}

export class DatabaseVendorContacts implements VendorContactReader {
  constructor(private readonly db: Database) {}

  async contacts(vendorIds: readonly string[]): Promise<VendorContact[]> {
    if (vendorIds.length === 0) return [];
    const rows = await this.db
      .select({ vendorId: vendors.id, phone: vendors.phone })
      .from(vendors)
      .where(and(inArray(vendors.id, [...vendorIds]), ne(vendors.status, 'DEACTIVATED')));
    // In the event's own order, so a retry walks the shops the same way.
    const byId = new Map(rows.map((row) => [row.vendorId, row]));
    return vendorIds.flatMap((id) => byId.get(id) ?? []);
  }
}

/** At most this much of a campaign's name is quoted, so the SMS stays short. */
export const MAX_QUOTED_CAMPAIGN_NAME = 40;

const NEPAL_OFFSET_MS = (5 * 60 + 45) * 60_000;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** "9 Oct 2026": the calendar day in Nepal Time (UTC+05:45, no daylight saving). */
export function nepalDate(iso: string): string {
  const local = new Date(new Date(iso).getTime() + NEPAL_OFFSET_MS);
  return `${String(local.getUTCDate())} ${MONTHS[local.getUTCMonth()] ?? ''} ${String(local.getUTCFullYear())}`;
}

function quotedCampaign(name: string): string {
  const trimmed = name.trim();
  return trimmed.length <= MAX_QUOTED_CAMPAIGN_NAME
    ? trimmed
    : `${trimmed.slice(0, MAX_QUOTED_CAMPAIGN_NAME - 3)}...`;
}

type Wording = Pick<VendorNotice, 'sms' | 'push'>;

function wordingOf(event: VendorNoticeEvent): Wording {
  switch (event.event_type) {
    case 'vendor.suspended_for_compliance':
      return {
        sms:
          'Hamro Pasal: your shop is offline because no PAN is on file. Please add your ' +
          '9-digit PAN in the app (Shop settings) and your shop goes back online at once.',
        push: {
          title: 'Your shop is offline',
          body: 'Please add your PAN in Shop settings. Your shop goes back online as soon as it is saved.',
        },
      };
    case 'vendor.compliance_restored':
      if (event.payload.status === 'LIVE') {
        return {
          sms:
            'Hamro Pasal: thank you, your PAN is saved and your shop is back online. Please ' +
            'upload your PAN certificate in the app so your payouts can be released.',
          push: {
            title: 'Your shop is back online',
            body: 'Thank you for adding your PAN. Please upload your PAN certificate so payouts can be released.',
          },
        };
      }
      if (event.payload.status === 'SUSPENDED') {
        return {
          sms:
            'Hamro Pasal: thank you, your PAN is saved. Your shop is still offline for another ' +
            'reason. Please check Wallet in the app or contact Hamro Pasal support.',
          push: {
            title: 'PAN saved',
            body: 'Your shop is still offline for another reason. Please check your Wallet or contact support.',
          },
        };
      }
      return {
        sms:
          'Hamro Pasal: thank you, your PAN is saved. Your shop is not live yet: we will let ' +
          'you know when it is. Please upload your PAN certificate in the app meanwhile.',
        push: {
          title: 'PAN saved',
          body: 'Your shop is not live yet. Please upload your PAN certificate in the app meanwhile.',
        },
      };
    case 'marketing.ad_ended': {
      const returned =
        event.payload.returned_npr > 0
          ? ` ${formatNpr(event.payload.returned_npr)} of unused budget is back in your wallet.`
          : '';
      return {
        sms:
          `Hamro Pasal: your ad ended on ${nepalDate(event.payload.ends_at)}.${returned} ` +
          'Open Marketing in the app to book your next ad. Thank you.',
        push: {
          title: 'Your ad has ended',
          body: `It ran until ${nepalDate(event.payload.ends_at)}.${returned} Open Marketing to book your next ad.`,
        },
      };
    }
    case 'marketing.ad_paused':
      return {
        sms:
          `Hamro Pasal: your per-order ad is paused. Its ${formatNpr(event.payload.budget_npr)} ` +
          `budget cannot cover another order (${formatNpr(event.payload.amount_paid_npr)} spent). ` +
          'Open Marketing in the app to book a new ad.',
        push: {
          title: 'Your ad is paused',
          body:
            `Its ${formatNpr(event.payload.budget_npr)} budget cannot cover another order. ` +
            'Open Marketing to book a new ad.',
        },
      };
    case 'marketing.campaign_terms_changed': {
      const name = quotedCampaign(event.payload.campaign_name);
      return {
        sms:
          `Hamro Pasal: the terms of the campaign "${name}" have changed, so your shop is no ` +
          'longer in it. Please review the new terms under Marketing in the app to opt in again.',
        push: {
          title: 'Campaign terms changed',
          body: `Your shop is no longer in "${name}". Please review the new terms under Marketing to opt in again.`,
        },
      };
    }
  }
}

/**
 * The notices of one event: one per shop it concerns. A campaign change names its shops by id,
 * so their numbers are read now (a shop deactivated since is not told); every other event carries
 * the one shop and its number.
 */
export async function vendorNoticesOf(
  event: VendorNoticeEvent,
  contacts: VendorContactReader,
): Promise<VendorNotice[]> {
  const wording = wordingOf(event);
  const recipients =
    event.event_type === 'marketing.campaign_terms_changed'
      ? await contacts.contacts(event.payload.voided_vendor_ids)
      : [{ vendorId: event.payload.vendor_id, phone: event.payload.vendor_phone }];
  return recipients.map((recipient) => ({
    eventId: event.event_id,
    eventType: event.event_type,
    vendorId: recipient.vendorId,
    phone: recipient.phone,
    ...wording,
  }));
}
