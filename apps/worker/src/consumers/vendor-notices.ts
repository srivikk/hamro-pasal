import { KAFKA_TOPICS } from '@hamro-pasal/shared-types';

import type { NotificationAdapter, VendorNotice } from '../notifications/notification-adapter';
import {
  isVendorNoticeEvent,
  vendorNoticesOf,
  type VendorContactReader,
} from '../notifications/vendor-notices';
import { parseDomainEventMessage, type EventDeduplicator } from './order-state-fanout';
import type { KafkaConsumerDefinition } from './types';

/** Redis prefix of the per-shop claims: `<prefix><event_id>:<vendor_id>`. */
export const VENDOR_NOTICE_DEDUPE_PREFIX = 'notifications:notice:seen:';

/**
 * After this many refusals in a row within one event the rest of its shops wait for the retry.
 * A provider that times out costs up to 10 s per SMS; without the bound, one campaign change
 * naming hundreds of shops would hold the partition past Kafka's poll interval.
 */
export const VENDOR_NOTICE_MAX_CONSECUTIVE_FAILURES = 3;

export interface VendorNoticeDeps {
  /** Where notices leave the worker: the SMS / push providers, or the logger under MOCK_SERVICES. */
  readonly notifications: NotificationAdapter;
  /** Default VENDOR_NOTICE_MAX_CONSECUTIVE_FAILURES. */
  readonly maxConsecutiveFailures?: number;
  /** Phone numbers of the shops a campaign change names by id. */
  readonly contacts: VendorContactReader;
  readonly deduplicator: EventDeduplicator;
  /** Called after the adapter accepted a notice (default: one JSON log line, no phone or text). */
  readonly onSent?: (notice: VendorNotice, adapter: string) => void;
}

/**
 * Kafka `notifications.broadcast` → vendor notices (Phase 36):
 *   vendor.suspended_for_compliance   → "your shop is offline until your PAN is verified"
 *   vendor.compliance_restored        → "PAN verified, your shop is back online"
 *   vendor.deactivated                → "your shop account is closed" (Phase 38)
 *   vendor.reactivated                → "your shop has been reopened" (Phase 38)
 *   marketing.ad_ended                → "your ad ended" (+ the budget returned)
 *   marketing.ad_paused               → "your ad is paused, its budget is used up"
 *   marketing.campaign_terms_changed  → one notice per shop whose opt-in was voided
 *
 * **Idempotent per shop.** Delivery is at-least-once, so before each notice the pair
 * (event_id, vendor_id) is claimed in Redis; a redelivered event skips every shop already told.
 * If the adapter refuses a shop, that shop's claim alone is released, the remaining shops are
 * still attempted, and the handler then throws: the retry (and a later replay from the dead
 * letter table) repeats only the shops that were not told.
 *
 * It shares the topic with `vendor-notifications` (debt and escalation SMS). The two act on
 * disjoint event types, and an unparseable envelope is left to that consumer, which dead-letters
 * it: one poison message must not be stored twice.
 */
export function vendorNoticeConsumer(deps: VendorNoticeDeps): KafkaConsumerDefinition {
  const onSent =
    deps.onSent ??
    ((notice: VendorNotice, adapter: string) => {
      console.info(
        JSON.stringify({
          notification: 'notice.sent',
          event_type: notice.eventType,
          event_id: notice.eventId,
          vendor_id: notice.vendorId,
          adapter,
        }),
      );
    });

  const maxConsecutiveFailures =
    deps.maxConsecutiveFailures ?? VENDOR_NOTICE_MAX_CONSECUTIVE_FAILURES;

  return {
    topic: KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
    handle: async ({ message }) => {
      const event = parseDomainEventMessage(message.value);
      if (event === null || !isVendorNoticeEvent(event)) return;

      const failures: unknown[] = [];
      let failuresInARow = 0;
      for (const notice of await vendorNoticesOf(event, deps.contacts)) {
        // The provider is down or timing out, not one number: stop here. The shops not reached
        // were never claimed, so the retry (after its backoff) starts with them.
        if (failuresInARow >= maxConsecutiveFailures) break;
        const claim = `${notice.eventId}:${notice.vendorId}`;
        if (!(await deps.deduplicator.claim(claim))) continue;
        try {
          await deps.notifications.send(notice);
        } catch (error: unknown) {
          await deps.deduplicator.release(claim).catch(() => undefined);
          failures.push(error);
          failuresInARow += 1;
          continue;
        }
        failuresInARow = 0;
        onSent(notice, deps.notifications.name);
      }
      if (failures.length === 1) {
        throw failures[0] instanceof Error ? failures[0] : new Error(String(failures[0]));
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, `${String(failures.length)} vendor notices failed`);
      }
    },
  };
}
