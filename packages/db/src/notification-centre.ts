import type { NotificationAudience, NotificationSource } from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';

import type { Database, Transaction } from './client';
import { notificationMessages, notificationRecipients } from './schema';

/** What a service hands the notification centre (step 7.1, SPEC core 11). */
export interface NewNotificationMessage {
  readonly audience: NotificationAudience;
  readonly source: NotificationSource;
  readonly title: string;
  readonly body: string;
  readonly data?: Record<string, unknown>;
  /** The admin who sent it; omitted for a system message. */
  readonly createdByUserId?: string;
  /** A system write's key (`notice:<event_id>:<vendor_id>`): writing it again changes nothing. */
  readonly dedupeKey?: string;
  /** Who a VENDOR or CUSTOMER message is for. Must be empty for ALL_CUSTOMERS. */
  readonly recipientUserIds: readonly string[];
}

export interface StoredNotificationMessage {
  readonly id: string;
  /** False when the dedupe key was already taken: an earlier attempt stored this message. */
  readonly created: boolean;
}

/**
 * The one writer of notification centre messages: the message, then one recipient row per user,
 * on the given database or inside the caller's transaction. Idempotent per `dedupeKey`: a
 * redelivered event finds its message (and its recipients) already there.
 */
export async function recordNotificationMessage(
  db: Database | Transaction,
  message: NewNotificationMessage,
): Promise<StoredNotificationMessage> {
  if (message.audience === 'ALL_CUSTOMERS' && message.recipientUserIds.length > 0) {
    throw new RangeError('A broadcast to all customers names no recipients');
  }
  if (message.audience !== 'ALL_CUSTOMERS' && message.recipientUserIds.length === 0) {
    throw new RangeError('A targeted message needs at least one recipient');
  }

  const [inserted] = await db
    .insert(notificationMessages)
    .values({
      audience: message.audience,
      source: message.source,
      title: message.title.trim(),
      body: message.body.trim(),
      data: message.data ?? {},
      created_by_user_id: message.createdByUserId ?? null,
      dedupe_key: message.dedupeKey ?? null,
    })
    .onConflictDoNothing({ target: notificationMessages.dedupe_key })
    .returning({ id: notificationMessages.id });

  let id = inserted?.id;
  if (id === undefined) {
    // Only a taken dedupe key gets here (a message without one always inserts).
    const [existing] = await db
      .select({ id: notificationMessages.id })
      .from(notificationMessages)
      .where(eq(notificationMessages.dedupe_key, message.dedupeKey ?? ''));
    if (existing === undefined) throw new Error('Notification message vanished after a conflict');
    id = existing.id;
  }

  if (message.recipientUserIds.length > 0) {
    await db
      .insert(notificationRecipients)
      .values(
        [...new Set(message.recipientUserIds)].map((userId) => ({
          message_id: id,
          user_id: userId,
        })),
      )
      .onConflictDoNothing();
  }
  return { id, created: inserted !== undefined };
}
