import {
  chatMessages,
  disputes,
  enqueueDomainEvent,
  orders,
  recordAuditLog,
  users,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import { enqueueOrderStateChanged } from '@hamro-pasal/ledger';
import {
  DISPUTE_WINDOW_HOURS,
  type AuditContext,
  type ChatMessage,
  type ChatMessageRow,
  type ConversationView,
  type Dispute,
  type DisputeStatus,
  type StoredChatAttachment,
  type User,
  type UserRole,
} from '@hamro-pasal/shared-types';
import { and, asc, eq, sql } from 'drizzle-orm';

import { OrderNotFoundError } from '../checkout/checkout-service';
import { publicChatMessage } from './chat-message-view';

export type DisputeAccess =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'ORDER_NOT_FOUND' | 'DISPUTE_WINDOW_CLOSED' };

/** The order's conversation is not open (or escalation is no longer possible). */
export class DisputeWindowClosedError extends Error {
  constructor(readonly orderId: string) {
    super(
      `Order ${orderId} has no open conversation (it is open from placement until ${String(DISPUTE_WINDOW_HOURS)} h after delivery)`,
    );
    this.name = 'DisputeWindowClosedError';
  }
}

/** A party already escalated this order (it can be escalated once). */
export class AlreadyEscalatedError extends Error {
  constructor(readonly orderId: string) {
    super(`Order ${orderId} was already escalated to Hamro Pasal`);
    this.name = 'AlreadyEscalatedError';
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
  /** true when this message opened the order's conversation. */
  readonly disputeOpened: boolean;
  /** true when the same sender had already stored this client_id (a retried send). */
  readonly replayed: boolean;
}

interface OrderParties {
  readonly customerId: string;
  readonly vendorUserId: string;
}

/** A conversation the Super Admin may read: escalated, or resolved after an escalation. */
const ADMIN_VISIBLE: ReadonlySet<DisputeStatus> = new Set([
  'ESCALATED',
  'RELEASED_TO_VENDOR',
  'REFUNDED_TO_CUSTOMER',
  'PARTIALLY_REFUNDED',
]);

/** Whether the caller is the order's customer or the vendor's own user (drivers never are). */
function isParty(participant: DisputeParticipant, order: OrderParties): boolean {
  switch (participant.role) {
    case 'CUSTOMER':
      return order.customerId === participant.userId;
    case 'VENDOR':
      return order.vendorUserId === participant.userId;
    case 'DRIVER':
    case 'SUPER_ADMIN':
      return false;
  }
}

/**
 * Step 7.3 (SPEC core 6): the conversation is open from placement until DISPUTE_WINDOW_HOURS after
 * delivery, on the database clock; never for an unpaid, cancelled or failed order.
 */
const WINDOW_OPEN = sql<boolean>`(${orders.state} NOT IN ('PENDING_PAYMENT', 'CANCELED', 'FAILED')
  AND (${orders.delivered_at} IS NULL
    OR clock_timestamp() < ${orders.delivered_at} + make_interval(hours => ${DISPUTE_WINDOW_HOURS})))`;

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

export function conversationView(dispute: Dispute, deliveredAt: Date | null): ConversationView {
  return {
    dispute_id: dispute.id,
    order_id: dispute.order_id,
    status: dispute.status,
    escalated_at: iso(dispute.escalated_at),
    escalation_reason: dispute.escalation_reason,
    window_ends_at:
      deliveredAt === null
        ? null
        : new Date(deliveredAt.getTime() + DISPUTE_WINDOW_HOURS * 3_600_000).toISOString(),
  };
}

/**
 * An order's Customer <-> Vendor conversation (SPEC core 6, step 7.3):
 *   - the order's customer and the vendor's own user chat from placement until 7 days after
 *     delivery, and for as long as an escalation is waiting for the Super Admin;
 *   - either of them may escalate it once inside that window;
 *   - a Super Admin can join and read it only once it was escalated.
 * Everyone else is told the order does not exist, so ids cannot be probed.
 */
export class DisputeService {
  constructor(private readonly db: Database) {}

  async access(participant: DisputeParticipant, orderId: string): Promise<DisputeAccess> {
    const [row] = await this.db
      .select({
        customerId: orders.customer_id,
        vendorUserId: vendors.user_id,
        windowOpen: WINDOW_OPEN.mapWith(Boolean),
        disputeStatus: disputes.status,
      })
      .from(orders)
      .innerJoin(vendors, eq(vendors.id, orders.vendor_id))
      .leftJoin(disputes, eq(disputes.order_id, orders.id))
      .where(eq(orders.id, orderId));
    if (row === undefined) return { ok: false, code: 'ORDER_NOT_FOUND' };

    if (participant.role === 'SUPER_ADMIN') {
      return row.disputeStatus !== null && ADMIN_VISIBLE.has(row.disputeStatus)
        ? { ok: true }
        : { ok: false, code: 'ORDER_NOT_FOUND' };
    }
    if (!isParty(participant, row)) return { ok: false, code: 'ORDER_NOT_FOUND' };
    return row.windowOpen || row.disputeStatus === 'ESCALATED'
      ? { ok: true }
      : { ok: false, code: 'DISPUTE_WINDOW_CLOSED' };
  }

  /** Throws the HTTP-mapped error when `participant` may not use the order's conversation. */
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
   * Persists one chat message, in one transaction:
   *   - if the order has no conversation yet, this message opens it (OPEN, opened_by = the
   *     sender). `ON CONFLICT (order_id) DO NOTHING`: of two simultaneous first messages exactly
   *     one opens it; the other waits for that commit and is stored under the same row;
   *   - the message is stored once per (dispute, sender, client_id): a retried send gets the stored
   *     message back instead of a duplicate.
   * The caller must already have checked `access`.
   */
  async recordMessage(input: ChatMessageInput): Promise<RecordedChatMessage> {
    return this.db.transaction(async (tx) => {
      const [opened] = await tx
        .insert(disputes)
        .values({ order_id: input.orderId, opened_by_user_id: input.senderUserId })
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

  /**
   * POST /api/orders/:id/escalate (the customer) and POST /api/vendors/orders/:id/escalate (its
   * vendor). Under the order row lock, the lock the day-8 release takes too (SPEC edge case 19):
   * an escalation committed first keeps the money held; after the window it is refused.
   *   - once per order (409 ALREADY_ESCALATED);
   *   - a DELIVERED order becomes DISPUTED (`order.state_changed`); an order not delivered yet
   *     keeps going, and its earnings stay held at delivery until the resolution;
   *   - audit DISPUTE_ESCALATED and outbox `dispute.escalated` (the other party is told).
   */
  async escalate(
    participant: DisputeParticipant,
    orderId: string,
    reason: string,
    context: AuditContext,
  ): Promise<ConversationView> {
    if (participant.role !== 'CUSTOMER' && participant.role !== 'VENDOR') {
      throw new OrderNotFoundError(orderId);
    }
    const escalatedBy = participant.role;
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          order: orders,
          vendorUserId: vendors.user_id,
          windowOpen: WINDOW_OPEN.mapWith(Boolean),
        })
        .from(orders)
        .innerJoin(vendors, eq(vendors.id, orders.vendor_id))
        .where(eq(orders.id, orderId))
        .for('update', { of: orders });
      if (
        row === undefined ||
        !isParty(participant, { customerId: row.order.customer_id, vendorUserId: row.vendorUserId })
      ) {
        throw new OrderNotFoundError(orderId);
      }
      const { order } = row;

      const [current] = await tx
        .select()
        .from(disputes)
        .where(eq(disputes.order_id, orderId))
        .for('update');
      if (
        current !== undefined &&
        (current.status === 'ESCALATED' || ADMIN_VISIBLE.has(current.status))
      ) {
        throw new AlreadyEscalatedError(orderId);
      }
      if (current?.status === 'CLOSED' || !row.windowOpen) {
        throw new DisputeWindowClosedError(orderId);
      }

      const escalation = {
        status: 'ESCALATED' as const,
        escalated_at: new Date(),
        escalated_by_user_id: participant.userId,
        escalation_reason: reason,
      };
      const [dispute] =
        current === undefined
          ? await tx
              .insert(disputes)
              .values({ order_id: orderId, opened_by_user_id: participant.userId, ...escalation })
              .returning()
          : await tx
              .update(disputes)
              .set(escalation)
              .where(eq(disputes.id, current.id))
              .returning();
      if (dispute === undefined) throw new Error(`Dispute of order ${orderId} was not stored`);

      if (order.state === 'DELIVERED') {
        const [disputed] = await tx
          .update(orders)
          .set({ state: 'DISPUTED' })
          .where(eq(orders.id, orderId))
          .returning();
        if (disputed === undefined) throw new OrderNotFoundError(orderId);
        await enqueueOrderStateChanged(tx, order.state, disputed);
      }

      await recordEscalation(
        tx,
        participant,
        dispute,
        current?.status ?? null,
        order.vendor_id,
        context,
      );
      await enqueueDomainEvent(tx, {
        type: 'dispute.escalated',
        aggregateId: orderId,
        payload: {
          dispute_id: dispute.id,
          order_id: orderId,
          vendor_id: order.vendor_id,
          customer_id: order.customer_id,
          escalated_by: escalatedBy,
          escalated_at: escalation.escalated_at.toISOString(),
        },
      });
      return conversationView(dispute, order.delivered_at);
    });
  }

  /**
   * GET /api/orders/:id/chat: the order's transcript, oldest first, each message built by
   * publicChatMessage (the same privacy filter as the /chat broadcast). Readable by the order's
   * customer and vendor at any time (it is their own conversation), and by a Super Admin only once
   * it was escalated (step 7.3); anyone else gets 404. Empty without a conversation.
   */
  async transcript(participant: DisputeParticipant, orderId: string): Promise<ChatMessage[]> {
    const [order] = await this.db
      .select({
        customerId: orders.customer_id,
        vendorUserId: vendors.user_id,
        disputeStatus: disputes.status,
      })
      .from(orders)
      .innerJoin(vendors, eq(vendors.id, orders.vendor_id))
      .leftJoin(disputes, eq(disputes.order_id, orders.id))
      .where(eq(orders.id, orderId));
    const allowed =
      order !== undefined &&
      (participant.role === 'SUPER_ADMIN'
        ? order.disputeStatus !== null && ADMIN_VISIBLE.has(order.disputeStatus)
        : isParty(participant, order));
    if (!allowed) throw new OrderNotFoundError(orderId);
    const rows = await this.db
      .select({ message: chatMessages, sender: users })
      .from(chatMessages)
      .innerJoin(disputes, eq(disputes.id, chatMessages.dispute_id))
      .innerJoin(users, eq(users.id, chatMessages.sender_user_id))
      .where(eq(disputes.order_id, orderId))
      .orderBy(asc(chatMessages.created_at), asc(chatMessages.id));
    return rows.map(({ message, sender }) => publicChatMessage(message, orderId, sender));
  }
}

async function recordEscalation(
  tx: Transaction,
  participant: DisputeParticipant,
  dispute: Dispute,
  statusBefore: DisputeStatus | null,
  vendorId: string,
  context: AuditContext,
): Promise<void> {
  await recordAuditLog(tx, {
    actor: { kind: 'USER', user_id: participant.userId, role: participant.role },
    action: 'DISPUTE_ESCALATED',
    entityId: dispute.id,
    vendorId,
    beforeState: { status: statusBefore },
    afterState: {
      status: dispute.status,
      order_id: dispute.order_id,
      escalation_reason: dispute.escalation_reason,
    },
    context,
  });
}
