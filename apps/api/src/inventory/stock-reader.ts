import { products, type Executor } from '@hamro-pasal/db';
import { and, eq, inArray } from 'drizzle-orm';

/** Source of truth for on-hand quantities: products.stock_quantity in PostgreSQL. */
export interface StockReader {
  /** On-hand stock of the vendor's active products; unknown/inactive ids are absent. */
  getStock(vendorId: string, productIds: readonly string[]): Promise<Map<string, number>>;
}

export class DrizzleStockReader implements StockReader {
  constructor(private readonly db: Executor) {}

  async getStock(vendorId: string, productIds: readonly string[]): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ id: products.id, stock: products.stock_quantity })
      .from(products)
      .where(
        and(
          eq(products.vendor_id, vendorId),
          eq(products.is_active, true),
          inArray(products.id, [...productIds]),
        ),
      );
    return new Map(rows.map((row) => [row.id, row.stock]));
  }
}
