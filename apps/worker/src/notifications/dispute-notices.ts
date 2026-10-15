import {
  deviceTokens,
  recordNotificationMessage,
  users,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import type {
  DisputeEscalatedEvent,
  DisputeResolvedEvent,
  LanguagePreference,
} from '@hamro-pasal/shared-types';
import { eq, inArray } from 'drizzle-orm';

import type { ExpoPushMessage, PushGateway } from '../push/expo-push';
import { EXPO_DEVICE_NOT_REGISTERED } from '../push/expo-push';

interface NoticeText {
  readonly title: string;
  readonly body: string;
}

interface Recipient {
  readonly userId: string;
  readonly audience: 'CUSTOMER' | 'VENDOR';
}

const shortOrder = (orderId: string): string => orderId.slice(0, 8).toUpperCase();

export function escalatedText(language: LanguagePreference, orderId: string): NoticeText {
  return language === 'ne'
    ? {
        title: 'अर्डर हाम्रो पसलमा पठाइयो',
        body: `अर्डर ${shortOrder(orderId)} को कुराकानी हाम्रो पसलले हेर्नेछ।`,
      }
    : {
        title: 'Order escalated to Hamro Pasal',
        body: `Order ${shortOrder(orderId)} was escalated. Hamro Pasal will review the conversation.`,
      };
}

export function resolvedText(
  language: LanguagePreference,
  event: DisputeResolvedEvent,
): NoticeText {
  const order = shortOrder(event.payload.order_id);
  const refund = event.payload.refund_npr;
  if (language === 'ne') {
    return {
      title: 'अर्डरको निर्णय भयो',
      body:
        refund > 0
          ? `अर्डर ${order}: रु. ${String(refund)} ग्राहकलाई फिर्ता गरिनेछ।`
          : `अर्डर ${order}: रकम पसललाई दिइयो।`,
    };
  }
  return {
    title: 'Order decision',
    body:
      refund > 0
        ? `Order ${order}: Hamro Pasal decided a refund of Rs. ${String(refund)} to the customer.`
        : `Order ${order}: Hamro Pasal released the amount to the shop.`,
  };
}

/**
 * Step 7.3 (SPEC core 6): tells the parties of an order conversation. An escalation is told to the
 * other party; a resolution to both. Each notice is a notification centre message (deduplicated
 * per event and person, so a redelivered event stores nothing twice) and a best-effort push.
 */
export class DisputeNoticeService {
  constructor(
    private readonly db: Database,
    private readonly push: PushGateway,
  ) {}

  async escalated(event: DisputeEscalatedEvent): Promise<number> {
    const { customer_id: customerId, vendor_id: vendorId, escalated_by: by } = event.payload;
    const recipients =
      by === 'CUSTOMER'
        ? await this.vendorRecipient(vendorId)
        : [{ userId: customerId, audience: 'CUSTOMER' as const }];
    return this.tell(
      event.event_id,
      recipients,
      (language) => escalatedText(language, event.payload.order_id),
      { kind: 'DISPUTE_ESCALATED', order_id: event.payload.order_id },
    );
  }

  async resolved(event: DisputeResolvedEvent): Promise<number> {
    const recipients: Recipient[] = [
      { userId: event.payload.customer_id, audience: 'CUSTOMER' },
      ...(await this.vendorRecipient(event.payload.vendor_id)),
    ];
    return this.tell(event.event_id, recipients, (language) => resolvedText(language, event), {
      kind: 'DISPUTE_RESOLVED',
      order_id: event.payload.order_id,
      outcome: event.payload.outcome,
    });
  }

  private async vendorRecipient(vendorId: string): Promise<Recipient[]> {
    const [vendor] = await this.db
      .select({ userId: vendors.user_id })
      .from(vendors)
      .where(eq(vendors.id, vendorId));
    return vendor === undefined ? [] : [{ userId: vendor.userId, audience: 'VENDOR' }];
  }

  private async tell(
    eventId: string,
    recipients: readonly Recipient[],
    textOf: (language: LanguagePreference) => NoticeText,
    data: Record<string, unknown>,
  ): Promise<number> {
    if (recipients.length === 0) return 0;
    const languages = new Map(
      (
        await this.db
          .select({ id: users.id, language: users.language_preference })
          .from(users)
          .where(
            inArray(
              users.id,
              recipients.map((r) => r.userId),
            ),
          )
      ).map((row) => [row.id, row.language]),
    );
    const messages: ExpoPushMessage[] = [];
    for (const recipient of recipients) {
      const text = textOf(languages.get(recipient.userId) ?? 'en');
      const stored = await recordNotificationMessage(this.db, {
        audience: recipient.audience,
        source: 'SYSTEM',
        title: text.title,
        body: text.body,
        data,
        dedupeKey: `dispute:${eventId}:${recipient.userId}`,
        recipientUserIds: [recipient.userId],
      });
      // Already told by an earlier delivery of this event: no second push.
      if (!stored.created) continue;
      const tokens = await this.db
        .select({ token: deviceTokens.token })
        .from(deviceTokens)
        .where(eq(deviceTokens.user_id, recipient.userId));
      messages.push(
        ...tokens.map(({ token }) => ({
          to: token,
          title: text.title,
          body: text.body,
          sound: 'default' as const,
          priority: 'high' as const,
          data,
        })),
      );
    }
    if (messages.length > 0) {
      try {
        const tickets = await this.push.send(messages);
        const gone = tickets.flatMap((ticket) =>
          ticket.status === 'error' && ticket.error === EXPO_DEVICE_NOT_REGISTERED
            ? [ticket.token]
            : [],
        );
        if (gone.length > 0)
          await this.db.delete(deviceTokens).where(inArray(deviceTokens.token, gone));
      } catch (error: unknown) {
        // The notification centre has it; the push is best effort.
        console.error(
          JSON.stringify({
            notification: 'dispute_notice.push_failed',
            event_id: eventId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    return recipients.length;
  }
}
