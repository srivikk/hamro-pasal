import { chatMessages, disputes, orders, users, vendors, type Database } from '@hamro-pasal/db';
import {
  POST_DELIVERY_WINDOW_HOURS,
  type ChatMessageRow,
  type Dispute,
  type StoredChatAttachment,
  type User,
  type UserRole,
} from '@hamro-pasal/shared-types';
import { and, eq, sql } from 'drizzle-orm';

import { OrderNotFoundError } from '../checkout/checkout-service';

export type DisputeAccess =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'ORDER_NOT_FOUND' | 'DISPUTE_WINDOW_CLOSED' };

/** The dispute chat (or evidence upload) is not open for this order. */
export class DisputeWindowClosedError extends Error {
  constructor(readonly orderId: string) {
    super(
      `Order ${orderId} has no open dispute window (it opens at delivery for ${String(POST_DELIVERY_WINDOW_HOURS)} h)`,
    );
    this.name = 'DisputeWindowClosedError';
  }
}

export interface DisputeParticipant {
  readonly userId: string;
  readonly role: UserRole;
}

export interface ChatMessageInput {
  readonly orderId: string;
  readonly senderUserId: string;
  readonly clientId: string;
  readonly body: string;
  readonly attachments: readonly StoredChatAttachment[];
}

export interface RecordedChatMessage {
  readonly message: ChatMessageRow;
  readonly dispute: Dispute;
  /** true when this message opened the order's dispute. */
  readonly disputeOpened: boolean;
  /** true when the same sender had already stored this client_id (a retried send). */
  readonly replayed: boolean;
}

/** The disputes.reason of a dispute opened by a message with `body` (never blank). */
export function disputeReason(body: string): string {
  const reason = body.trim();
  return reason === '' ? 'Photo evidence submitted' : reason;
}

/**
 * Who may take part in an order's dispute (SPEC customer journey 11 and Super Admin flow 3): the
 * order's customer and the vendor's own user while the 48 h post-delivery window is open (and,
 * after it, for as long as the order's dispute is still OPEN), and a SUPER_ADMIN at any time
 * (arbitration). Everyone else is told the order does not exist, so ids cannot be probed.
 *
 * It also keeps the chat transcript: the first message of an order opens its dispute.
 */
export class DisputeService {
  constructor(private readonly db: Database) {}

  async access(participant: DisputeParticipant, orderId: string): Promise<DisputeAccess> {
    const [row] = await this.db
      .select({
        customerId: orders.customer_id,
        vendorUserId: vendors.user_id,
        state: orders.state,
        windowOpen:
          sql<boolean>`${orders.delivered_at} IS NOT NULL AND clock_timestamp() < ${orders.delivered_at} + make_interval(hours => ${POST_DELIVERY_WINDOW_HOURS})`.mapWith(
            Boolean,
          ),
        disputeStatus: disputes.status,
      })
      .from(orders)
      .innerJoin(vendors, eq(vendors.id, orders.vendor_id))
      .leftJoin(disputes, eq(disputes.order_id, orders.id))
      .where(eq(orders.id, orderId));
    if (row === undefined) return { ok: false, code: 'ORDER_NOT_FOUND' };

    switch (participant.role) {
      case 'SUPER_ADMIN':
        return { ok: true };
      case 'CUSTOMER':
        if (row.customerId !== participant.userId) return { ok: false, code: 'ORDER_NOT_FOUND' };
        break;
      case 'VENDOR':
        if (row.vendorUserId !== participant.userId) return { ok: false, code: 'ORDER_NOT_FOUND' };
        break;
      case 'DRIVER':
        return { ok: false, code: 'ORDER_NOT_FOUND' };
    }
    // A dispute opened inside the window stays reachable until it is resolved.
    return row.state === 'DELIVERED' && (row.windowOpen || row.disputeStatus === 'OPEN')
      ? { ok: true }
      : { ok: false, code: 'DISPUTE_WINDOW_CLOSED' };
  }

  /** Throws the HTTP-mapped error when `participant` may not use the order's dispute. */
  async assertAccess(participant: DisputeParticipant, orderId: string): Promise<void> {
    const access = await this.access(participant, orderId);
    if (access.ok) return;
    throw access.code === 'ORDER_NOT_FOUND'
      ? new OrderNotFoundError(orderId)
      : new DisputeWindowClosedError(orderId);
  }

  /**
   * The sender's full users row. It carries last_name and phone: the chat's privacy filter
   * (sanitizeChatMessage) removes them before anything is broadcast.
   */
  async participantProfile(userId: string): Promise<User | null> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    return user ?? null;
  }

  /**
   * Persists one chat message (SPEC Super Admin flow 3: arbitration reviews the transcript), in
   * one transaction:
   *   - if the order has no dispute yet, this message opens it (opened_by = the sender, reason =
   *     the message). `ON CONFLICT (order_id) DO NOTHING`: of two simultaneous first messages exactly
   *     one opens it; the other waits for that commit and is stored under the same dispute;
   *   - the message is stored once per (dispute, sender, client_id): a retried send gets the stored
   *     message back instead of a duplicate.
   * The caller must already have checked `access`.
   */
  async recordMessage(input: ChatMessageInput): Promise<RecordedChatMessage> {
    return this.db.transaction(async (tx) => {
      const [opened] = await tx
        .insert(disputes)
        .values({
          order_id: input.orderId,
          opened_by_user_id: input.senderUserId,
          reason: disputeReason(input.body),
        })
        .onConflictDoNothing({ target: disputes.order_id })
        .returning();
      const dispute =
        opened ?? (await tx.select().from(disputes).where(eq(disputes.order_id, input.orderId)))[0];
      if (dispute === undefined) throw new Error(`Dispute of order ${input.orderId} not found`);

      const [inserted] = await tx
        .insert(chatMessages)
        .values({
          dispute_id: dispute.id,
          sender_user_id: input.senderUserId,
          client_id: input.clientId,
          body: input.body,
          attachments: [...input.attachments],
        })
        .onConflictDoNothing({
          target: [chatMessages.dispute_id, chatMessages.sender_user_id, chatMessages.client_id],
        })
        .returning();
      const message =
        inserted ??
        (
          await tx
            .select()
            .from(chatMessages)
            .where(
              and(
                eq(chatMessages.dispute_id, dispute.id),
                eq(chatMessages.sender_user_id, input.senderUserId),
                eq(chatMessages.client_id, input.clientId),
              ),
            )
        )[0];
      if (message === undefined) throw new Error(`Chat message ${input.clientId} was not stored`);

      return {
        message,
        dispute,
        disputeOpened: opened !== undefined,
        replayed: inserted === undefined,
      };
    });
  }
}
