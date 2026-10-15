import {
  products,
  shopOpenAlerts,
  stockAlerts,
  users,
  vendorClosedReason,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import { MAX_ALERTS_PER_USER, type AlertListResponseBody } from '@hamro-pasal/shared-types';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { enabledModes, modeEnabled, VendorNotFoundError } from '../catalog/catalog-service';
import { ProductNotFoundError } from '../catalog/product-service';
import { HttpError } from '../http/errors';

/** What the signed-in customer is waiting for on one menu (step 7.4). */
export interface MenuAlerts {
  readonly shop: boolean;
  readonly productIds: ReadonlySet<string>;
}

/**
 * Step 7.4 (SPEC core 11): Notify Me requests. A customer waits for an out-of-stock product of a
 * LIVE shop, or for a LIVE shop that takes no order now (its hours, its switch, Auto-Pause or a
 * switched-off delivery mode). Asking again is a no-op; asking for something available now is
 * refused (`422 ALREADY_AVAILABLE`) so a request never waits for a change that already happened.
 * At most MAX_ALERTS_PER_USER requests wait per customer, products and shops together, counted
 * under the customer's row lock so two taps at once cannot pass the limit.
 *
 * The worker uses the requests up (deletes them) when it writes the notice.
 */
export class AlertService {
  constructor(private readonly db: Database) {}

  /** PUT /api/me/alerts/products/:id. */
  async addProduct(userId: string, productId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await lockUser(tx, userId);
      const [product] = await tx
        .select({ stock: products.stock_quantity })
        .from(products)
        .innerJoin(vendors, eq(vendors.id, products.vendor_id))
        .where(
          and(eq(products.id, productId), eq(products.is_active, true), eq(vendors.status, 'LIVE')),
        );
      if (product === undefined) throw new ProductNotFoundError(productId);
      const [existing] = await tx
        .select({ id: stockAlerts.product_id })
        .from(stockAlerts)
        .where(and(eq(stockAlerts.user_id, userId), eq(stockAlerts.product_id, productId)));
      if (existing !== undefined) return;
      if (product.stock > 0) throw alreadyAvailable('This product is in stock');
      await assertBelowLimit(tx, userId);
      await tx.insert(stockAlerts).values({ user_id: userId, product_id: productId });
    });
  }

  /** PUT /api/me/alerts/shops/:id. */
  async addShop(userId: string, vendorId: string): Promise<void> {
    const modes = await enabledModes(this.db);
    await this.db.transaction(async (tx) => {
      await lockUser(tx, userId);
      const [shop] = await tx
        .select({
          closed: sql<boolean>`(${vendorClosedReason()} IS NOT NULL OR NOT ${modeEnabled(modes)})`,
        })
        .from(vendors)
        .where(and(eq(vendors.id, vendorId), eq(vendors.status, 'LIVE')));
      if (shop === undefined) throw new VendorNotFoundError(vendorId);
      const [existing] = await tx
        .select({ id: shopOpenAlerts.vendor_id })
        .from(shopOpenAlerts)
        .where(and(eq(shopOpenAlerts.user_id, userId), eq(shopOpenAlerts.vendor_id, vendorId)));
      if (existing !== undefined) return;
      if (!shop.closed) throw alreadyAvailable('This shop is open');
      await assertBelowLimit(tx, userId);
      await tx.insert(shopOpenAlerts).values({ user_id: userId, vendor_id: vendorId });
    });
  }

  /** DELETE /api/me/alerts/products/:id. Removing a request that is not there changes nothing. */
  async removeProduct(userId: string, productId: string): Promise<void> {
    await this.db
      .delete(stockAlerts)
      .where(and(eq(stockAlerts.user_id, userId), eq(stockAlerts.product_id, productId)));
  }

  /** DELETE /api/me/alerts/shops/:id. */
  async removeShop(userId: string, vendorId: string): Promise<void> {
    await this.db
      .delete(shopOpenAlerts)
      .where(and(eq(shopOpenAlerts.user_id, userId), eq(shopOpenAlerts.vendor_id, vendorId)));
  }

  /** GET /api/me/alerts: newest first. */
  async list(userId: string): Promise<AlertListResponseBody> {
    const productRows = await this.db
      .select({
        product_id: stockAlerts.product_id,
        product_name: products.name,
        vendor_id: vendors.id,
        business_name: vendors.business_name,
        created_at: stockAlerts.created_at,
      })
      .from(stockAlerts)
      .innerJoin(products, eq(products.id, stockAlerts.product_id))
      .innerJoin(vendors, eq(vendors.id, products.vendor_id))
      .where(eq(stockAlerts.user_id, userId))
      .orderBy(desc(stockAlerts.created_at), desc(stockAlerts.product_id));
    const shopRows = await this.db
      .select({
        vendor_id: shopOpenAlerts.vendor_id,
        business_name: vendors.business_name,
        created_at: shopOpenAlerts.created_at,
      })
      .from(shopOpenAlerts)
      .innerJoin(vendors, eq(vendors.id, shopOpenAlerts.vendor_id))
      .where(eq(shopOpenAlerts.user_id, userId))
      .orderBy(desc(shopOpenAlerts.created_at), desc(shopOpenAlerts.vendor_id));
    return {
      products: productRows.map((row) => ({ ...row, created_at: row.created_at.toISOString() })),
      shops: shopRows.map((row) => ({ ...row, created_at: row.created_at.toISOString() })),
    };
  }

  /** The menu's `is_alerted` flags for a signed-in customer. */
  async forMenu(
    userId: string,
    vendorId: string,
    productIds: readonly string[],
  ): Promise<MenuAlerts> {
    const [shop] = await this.db
      .select({ id: shopOpenAlerts.vendor_id })
      .from(shopOpenAlerts)
      .where(and(eq(shopOpenAlerts.user_id, userId), eq(shopOpenAlerts.vendor_id, vendorId)));
    const rows =
      productIds.length === 0
        ? []
        : await this.db
            .select({ id: stockAlerts.product_id })
            .from(stockAlerts)
            .where(
              and(
                eq(stockAlerts.user_id, userId),
                inArray(stockAlerts.product_id, [...productIds]),
              ),
            );
    return { shop: shop !== undefined, productIds: new Set(rows.map((row) => row.id)) };
  }
}

async function lockUser(tx: Transaction, userId: string): Promise<void> {
  const [user] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .for('update');
  if (user === undefined) throw new HttpError(401, 'UNAUTHENTICATED', 'Account not found');
}

async function assertBelowLimit(tx: Transaction, userId: string): Promise<void> {
  const { rows } = await tx.execute<{ waiting: string }>(sql`
    SELECT (SELECT count(*) FROM stock_alerts WHERE user_id = ${userId})
         + (SELECT count(*) FROM shop_open_alerts WHERE user_id = ${userId}) AS waiting`);
  const [row] = rows;
  if (Number(row?.waiting ?? 0) >= MAX_ALERTS_PER_USER) {
    throw new HttpError(
      422,
      'ALERT_LIMIT_REACHED',
      `You can wait for at most ${String(MAX_ALERTS_PER_USER)} products and shops at once`,
    );
  }
}

function alreadyAvailable(message: string): HttpError {
  return new HttpError(422, 'ALREADY_AVAILABLE', message);
}
