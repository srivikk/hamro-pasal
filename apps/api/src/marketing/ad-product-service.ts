import { adProducts, recordAuditLog, type Database } from '@hamro-pasal/db';
import {
  NO_AUDIT_CONTEXT,
  type AdProductCreate,
  type AdProductUpdate,
  type AuditContext,
} from '@hamro-pasal/shared-types';
import { asc, eq, sql } from 'drizzle-orm';

export type AdProductRow = typeof adProducts.$inferSelect;

export class AdProductNotFoundError extends Error {
  constructor(readonly productId: string) {
    super(`Ad product ${productId} not found`);
    this.name = 'AdProductNotFoundError';
  }
}

function productState(product: AdProductRow) {
  return {
    name: product.name,
    slot: product.slot,
    billing_model: product.billing_model,
    price_npr: product.price_npr,
    duration_days: product.duration_days,
    is_active: product.is_active,
  };
}

/**
 * The Ad Marketplace price list (SPEC core 8). A price, never a charge: nothing here names a
 * vendor, and a vendor is billed only through a purchase its own account makes.
 *
 * A published product's placement, billing model, price and duration never change: `update` has
 * no parameter for them, the request schema refuses them, and a database trigger refuses them. A
 * new price is a new product; the old one is taken off sale with `is_active`.
 */
export class AdProductService {
  constructor(private readonly db: Database) {}

  /** Every product, retired ones included, by name. */
  list(): Promise<AdProductRow[]> {
    return this.db
      .select()
      .from(adProducts)
      .orderBy(asc(sql`lower(${adProducts.name})`), asc(adProducts.id));
  }

  create(
    adminUserId: string,
    input: AdProductCreate,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<AdProductRow> {
    return this.db.transaction(async (tx) => {
      const [product] = await tx
        .insert(adProducts)
        .values({
          name: input.name,
          slot: input.slot,
          billing_model: input.billing_model,
          price_npr: input.price_npr,
          duration_days: input.duration_days,
          is_active: input.is_active,
          created_by_user_id: adminUserId,
        })
        .returning();
      if (product === undefined) throw new Error('The ad product was not stored');
      await recordAuditLog(tx, {
        actor: { kind: 'USER', user_id: adminUserId, role: 'SUPER_ADMIN' },
        action: 'AD_PRODUCT_CREATED',
        entityId: product.id,
        vendorId: null,
        beforeState: null,
        afterState: productState(product),
        context,
      });
      return product;
    });
  }

  /** The name and whether it is on sale. Saving what is stored changes and records nothing. */
  update(
    adminUserId: string,
    productId: string,
    input: AdProductUpdate,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<AdProductRow> {
    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(adProducts)
        .where(eq(adProducts.id, productId))
        .for('update');
      if (before === undefined) throw new AdProductNotFoundError(productId);
      if (before.name === input.name && before.is_active === input.is_active) return before;

      const [after] = await tx
        .update(adProducts)
        .set({ name: input.name, is_active: input.is_active })
        .where(eq(adProducts.id, productId))
        .returning();
      if (after === undefined) throw new AdProductNotFoundError(productId);
      await recordAuditLog(tx, {
        actor: { kind: 'USER', user_id: adminUserId, role: 'SUPER_ADMIN' },
        action: 'AD_PRODUCT_UPDATED',
        entityId: productId,
        vendorId: null,
        beforeState: productState(before),
        afterState: productState(after),
        context,
      });
      return after;
    });
  }
}
