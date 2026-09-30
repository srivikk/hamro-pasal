import { orders, users, vendors, type Database } from '@hamro-pasal/db';
import { POST_DELIVERY_WINDOW_HOURS, type User, type UserRole } from '@hamro-pasal/shared-types';
import { eq, sql } from 'drizzle-orm';

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

/**
 * Who may take part in an order's dispute (SPEC customer journey 11 and Super Admin flow 3):
 * the order's customer and the vendor's own user while the 48 h post-delivery window is open, and
 * a SUPER_ADMIN at any time (arbitration). Everyone else is told the order does not exist, so ids
 * cannot be probed.
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
      })
      .from(orders)
      .innerJoin(vendors, eq(vendors.id, orders.vendor_id))
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
    return row.state === 'DELIVERED' && row.windowOpen
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
}
