import {
  categories,
  homePromotions,
  recordAuditLog,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import {
  NO_AUDIT_CONTEXT,
  type AuditContext,
  type PromotionTargetType,
  type PromotionWrite,
} from '@hamro-pasal/shared-types';
import { and, asc, eq } from 'drizzle-orm';

export type PromotionRow = typeof homePromotions.$inferSelect;

export class PromotionNotFoundError extends Error {
  constructor(readonly promotionId: string) {
    super(`Promotion ${promotionId} not found`);
    this.name = 'PromotionNotFoundError';
  }
}

/** The shop is not LIVE (or unknown), or the category is hidden (or unknown). */
export class PromotionTargetNotFoundError extends Error {
  constructor(readonly targetType: PromotionTargetType) {
    super(
      targetType === 'SHOP'
        ? 'The promotion targets a shop that is not live'
        : 'The promotion targets a category that is not active',
    );
    this.name = 'PromotionTargetNotFoundError';
  }
}

/** The named ad purchase does not exist, so the promotion cannot be an ad. */
export class AdPurchaseMismatchError extends Error {
  constructor(readonly adPurchaseId: string) {
    super('No such ad purchase: a promotion is sponsored only through a vendor’s own purchase');
    this.name = 'AdPurchaseMismatchError';
  }
}

function promotionState(promotion: PromotionRow) {
  return {
    placement: promotion.placement,
    image_url: promotion.image_url,
    title: promotion.title,
    subtitle: promotion.subtitle,
    target_type: promotion.target_type,
    target_value: promotion.target_value,
    display_order: promotion.display_order,
    is_active: promotion.is_active,
    starts_at: promotion.starts_at?.toISOString() ?? null,
    ends_at: promotion.ends_at?.toISOString() ?? null,
    is_sponsored: promotion.is_sponsored,
    ad_purchase_id: promotion.ad_purchase_id,
  };
}

function columnsOf(input: PromotionWrite) {
  return {
    placement: input.placement,
    image_url: input.image_url,
    title: input.title,
    subtitle: input.subtitle,
    target_type: input.target_type,
    // An offer label is stored without the spaces around it (it is matched as a whole).
    target_value: input.target_value === null ? null : input.target_value.trim(),
    display_order: input.display_order,
    is_active: input.is_active,
    starts_at: input.starts_at === null ? null : new Date(input.starts_at),
    ends_at: input.ends_at === null ? null : new Date(input.ends_at),
    is_sponsored: input.is_sponsored,
    ad_purchase_id: input.ad_purchase_id,
  };
}

/**
 * The Home screen's banners and Featured Offers tiles (STATE_HANDOFF §8Z.4). A promotion
 * navigates or filters; it never changes a price.
 *
 * The shape of `target_value` is the request schema's (a uuid for SHOP, a slug for CATEGORY, a
 * label of at most 40 characters for DISCOUNT_TAG). This service checks what a shape cannot: the
 * shop is LIVE, and the category and all its ancestors are active.
 *
 * No promotion can be sponsored yet: `ad_purchases` does not exist, so any purchase id names
 * nothing (422 AD_PURCHASE_MISMATCH), and the database refuses one too.
 */
export class PromotionService {
  constructor(private readonly db: Database) {}

  /** Every promotion, hidden and ended ones included: the carousel first, each by its order. */
  list(): Promise<PromotionRow[]> {
    return this.db
      .select()
      .from(homePromotions)
      .orderBy(
        asc(homePromotions.placement),
        asc(homePromotions.display_order),
        asc(homePromotions.created_at),
        asc(homePromotions.id),
      );
  }

  create(
    adminUserId: string,
    input: PromotionWrite,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<PromotionRow> {
    return this.db.transaction(async (tx) => {
      await assertWritable(tx, input);
      const [promotion] = await tx
        .insert(homePromotions)
        .values({ ...columnsOf(input), created_by_user_id: adminUserId })
        .returning();
      if (promotion === undefined) throw new Error('The promotion was not stored');
      await recordAuditLog(tx, {
        actor: { kind: 'USER', user_id: adminUserId, role: 'SUPER_ADMIN' },
        action: 'PROMOTION_CREATED',
        entityId: promotion.id,
        vendorId: null,
        beforeState: null,
        afterState: promotionState(promotion),
        context,
      });
      return promotion;
    });
  }

  /** Replaces every field. */
  update(
    adminUserId: string,
    promotionId: string,
    input: PromotionWrite,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<PromotionRow> {
    return this.db.transaction(async (tx) => {
      const before = await lockPromotion(tx, promotionId);
      await assertWritable(tx, input);
      const [after] = await tx
        .update(homePromotions)
        .set(columnsOf(input))
        .where(eq(homePromotions.id, promotionId))
        .returning();
      if (after === undefined) throw new PromotionNotFoundError(promotionId);
      const [was, is] = [promotionState(before), promotionState(after)];
      if (JSON.stringify(was) !== JSON.stringify(is)) {
        await recordAuditLog(tx, {
          actor: { kind: 'USER', user_id: adminUserId, role: 'SUPER_ADMIN' },
          action: 'PROMOTION_UPDATED',
          entityId: promotionId,
          vendorId: null,
          beforeState: was,
          afterState: is,
          context,
        });
      }
      return after;
    });
  }

  /** Removes the promotion; its audit entry keeps what it was. */
  remove(
    adminUserId: string,
    promotionId: string,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<void> {
    return this.db.transaction(async (tx) => {
      const before = await lockPromotion(tx, promotionId);
      await tx.delete(homePromotions).where(eq(homePromotions.id, promotionId));
      await recordAuditLog(tx, {
        actor: { kind: 'USER', user_id: adminUserId, role: 'SUPER_ADMIN' },
        action: 'PROMOTION_DELETED',
        entityId: promotionId,
        vendorId: null,
        beforeState: promotionState(before),
        afterState: { deleted: true },
        context,
      });
    });
  }
}

async function lockPromotion(tx: Transaction, promotionId: string): Promise<PromotionRow> {
  const [promotion] = await tx
    .select()
    .from(homePromotions)
    .where(eq(homePromotions.id, promotionId))
    .for('update');
  if (promotion === undefined) throw new PromotionNotFoundError(promotionId);
  return promotion;
}

async function assertWritable(tx: Transaction, input: PromotionWrite): Promise<void> {
  if (input.ad_purchase_id !== null) throw new AdPurchaseMismatchError(input.ad_purchase_id);
  if (input.target_type === 'SHOP' && input.target_value !== null) {
    const [shop] = await tx
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(eq(vendors.id, input.target_value), eq(vendors.status, 'LIVE')));
    if (shop === undefined) throw new PromotionTargetNotFoundError('SHOP');
  }
  if (input.target_type === 'CATEGORY' && input.target_value !== null) {
    if (!(await categoryIsActive(tx, input.target_value))) {
      throw new PromotionTargetNotFoundError('CATEGORY');
    }
  }
}

/** Active itself and under active ancestors only: what the public taxonomy shows. */
async function categoryIsActive(tx: Transaction, slug: string): Promise<boolean> {
  const [first] = await tx
    .select({ isActive: categories.is_active, parentId: categories.parent_id })
    .from(categories)
    .where(eq(categories.slug, slug));
  let current = first;
  // The taxonomy is at most three levels deep; the bound also stops a malformed cycle.
  for (let depth = 0; depth < 10; depth += 1) {
    if (!current?.isActive) return false;
    if (current.parentId === null) return true;
    [current] = await tx
      .select({ isActive: categories.is_active, parentId: categories.parent_id })
      .from(categories)
      .where(eq(categories.id, current.parentId));
  }
  return false;
}
