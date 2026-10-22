import { orderableStock, productListed, products, type Executor } from '@hamro-pasal/db';
import { and, eq, inArray } from 'drizzle-orm';

/** Source of truth for on-hand quantities: products.stock_quantity in PostgreSQL. */
export interface StockReader {
  /**
   * Orderable stock of the vendor's listed products (2026-10-21: 0 while switched out of stock);
   * unknown, hidden or removed ids are absent.
   */
  getStock(vendorId: string, productIds: readonly string[]): Promise<Map<string, number>>;
}

export class DrizzleStockReader implements StockReader {
  constructor(private readonly db: Executor) {}

  async getStock(vendorId: string, productIds: readonly string[]): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ id: products.id, stock: orderableStock() })
      .from(products)
      .where(
        and(
          eq(products.vendor_id, vendorId),
          productListed(),
          inArray(products.id, [...productIds]),
        ),
      );
    return new Map(rows.map((row) => [row.id, row.stock]));
  }
}
