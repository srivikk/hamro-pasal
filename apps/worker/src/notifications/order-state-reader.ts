import { orders, type Database } from '@hamro-pasal/db';
import type { OrderState } from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';

/** Reads an order's current state at the moment a notification is about to go out. */
export interface OrderStateReader {
  /** null when no such order exists. */
  currentState(orderId: string): Promise<OrderState | null>;
}

export class DatabaseOrderStateReader implements OrderStateReader {
  constructor(private readonly db: Database) {}

  async currentState(orderId: string): Promise<OrderState | null> {
    const [row] = await this.db
      .select({ state: orders.state })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    return row?.state ?? null;
  }
}
