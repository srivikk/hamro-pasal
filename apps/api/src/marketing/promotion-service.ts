import {
  adProducts,
  adPurchases,
  categories,
  homePromotions,
  recordAuditLog,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import {
  NO_AUDIT_CONTEXT,
  type AdPurchaseMismatchReason,
  type AuditContext,
  type PromotionTargetType,
  type PromotionWrite,
} from '@hamro-pasal/shared-types';
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';

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

const MISMATCH_MESSAGES: Readonly<Record<AdPurchaseMismatchReason, string>> = {
  NOT_FOUND: 'No such ad purchase: a promotion is sponsored only through a vendor’s own purchase',
  NOT_RUNNING: 'This ad purchase is not running: it was cancelled, is paused or has ended',
  SLOT: 'This ad purchase bought another placement than the promotion’s',
  SHOP: 'A sponsored promotion targets the shop that bought the ad',
  DATES: 'A sponsored promotion runs inside the period its ad purchase paid for',
};

/** The named ad purchase cannot make this promotion an ad (SPEC core 8, "No unilateral billing"). */
export class AdPurchaseMismatchError extends Error {
  constructor(
    readonly adPurchaseId: string,
    readonly reason: AdPurchaseMismatchReason,
  ) {
    super(MISMATCH_MESSAGES[reason]);
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
 * A promotion is sponsored only through the purchase of the vendor who bought the placement
 * (`assertSponsorship`): a running purchase of a carousel ad, by the shop the promotion targets,
 * covering the promotion's dates. Anything else is 422 AD_PURCHASE_MISMATCH with `details.reason`.
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

  /**
   * What the customer app shows now (GET /api/home/promotions): switched on, inside its dates on
   * the database clock, by `display_order`. A promotion whose target went stale after it was
   * saved is left out, so the app is never handed a dead link: a SHOP that is no longer LIVE, a
   * CATEGORY that is hidden (or under a hidden parent) or gone, and a sponsored promotion whose
   * ad purchase is no longer running (cancelled, paused or over). One read-only snapshot.
   */
  listPublic(): Promise<PromotionRow[]> {
    return this.db.transaction(
      async (tx) => {
        const rows = await tx
          .select()
          .from(homePromotions)
          .where(
            and(
              eq(homePromotions.is_active, true),
              or(isNull(homePromotions.starts_at), lte(homePromotions.starts_at, sql`now()`)),
              or(isNull(homePromotions.ends_at), gt(homePromotions.ends_at, sql`now()`)),
            ),
          )
          .orderBy(
            asc(homePromotions.display_order),
            asc(homePromotions.created_at),
            asc(homePromotions.id),
          );
        const valuesOf = (type: PromotionTargetType) => [
          ...new Set(
            rows.flatMap((row) =>
              row.target_type === type && row.target_value !== null ? [row.target_value] : [],
            ),
          ),
        ];

        const shopIds = valuesOf('SHOP');
        const liveShops = new Set(
          shopIds.length === 0
            ? []
            : (
                await tx
                  .select({ id: vendors.id })
                  .from(vendors)
                  .where(and(inArray(vendors.id, shopIds), eq(vendors.status, 'LIVE')))
              ).map((shop) => shop.id),
        );
        const activeCategories = new Set<string>();
        for (const slug of valuesOf('CATEGORY')) {
          if (await categoryIsActive(tx, slug)) activeCategories.add(slug);
        }
        const purchaseIds = rows.flatMap((row) =>
          row.ad_purchase_id === null ? [] : [row.ad_purchase_id],
        );
        const runningPurchases = new Set(
          purchaseIds.length === 0
            ? []
            : (
                await tx
                  .select({ id: adPurchases.id })
                  .from(adPurchases)
                  .where(
                    and(
                      inArray(adPurchases.id, purchaseIds),
                      eq(adPurchases.status, 'ACTIVE'),
                      lte(adPurchases.starts_at, sql`now()`),
                      gt(adPurchases.ends_at, sql`now()`),
                    ),
                  )
              ).map((purchase) => purchase.id),
        );

        return rows.filter((row) => {
          if (row.ad_purchase_id !== null && !runningPurchases.has(row.ad_purchase_id)) {
            return false;
          }
          if (row.target_type === 'SHOP') return liveShops.has(row.target_value ?? '');
          if (row.target_type === 'CATEGORY') return activeCategories.has(row.target_value ?? '');
          return true;
        });
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
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
  if (input.ad_purchase_id !== null) await assertSponsorship(tx, input, input.ad_purchase_id);
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

/**
 * The purchase must be able to carry this promotion:
 *  - it is running: ACTIVE and its paid period is not over;
 *  - it bought the promotion's placement. Only the Home carousel is sold as a promotion slot
 *    (a FEED_LISTING ad needs no promotion row, and no product sells a Featured Offers tile);
 *  - the promotion targets the shop that bought it;
 *  - the promotion's dates lie inside the purchase's, so no banner runs on days nobody paid for.
 *    A sponsored promotion therefore needs an end date.
 *
 * Locks, vendor row first: the buyer's row (`FOR SHARE`), then the purchase row (`FOR SHARE`). A
 * cancellation takes the same two in the same order, so it either finishes before this read or
 * waits for this promotion to commit.
 */
async function assertSponsorship(
  tx: Transaction,
  input: PromotionWrite,
  adPurchaseId: string,
): Promise<void> {
  const refuse = (reason: AdPurchaseMismatchReason) =>
    new AdPurchaseMismatchError(adPurchaseId, reason);

  const [found] = await tx
    .select({ vendorId: adPurchases.vendor_id })
    .from(adPurchases)
    .where(eq(adPurchases.id, adPurchaseId));
  if (found === undefined) throw refuse('NOT_FOUND');
  await tx
    .select({ id: vendors.id })
    .from(vendors)
    .where(eq(vendors.id, found.vendorId))
    .for('share');
  const [purchase] = await tx
    .select()
    .from(adPurchases)
    .where(eq(adPurchases.id, adPurchaseId))
    .for('share');
  if (purchase === undefined) throw refuse('NOT_FOUND');
  const [clock] = await tx
    .select({
      slot: adProducts.slot,
      nowMs: sql<number>`(extract(epoch from now()) * 1000)::float8`.mapWith(Number),
    })
    .from(adProducts)
    .where(eq(adProducts.id, purchase.ad_product_id));
  if (clock === undefined) throw refuse('NOT_FOUND');
  const now = new Date(clock.nowMs);

  if (purchase.status !== 'ACTIVE' || purchase.ends_at <= now) throw refuse('NOT_RUNNING');
  if (input.placement !== 'CAROUSEL' || clock.slot !== 'CAROUSEL') throw refuse('SLOT');
  if (input.target_type !== 'SHOP' || input.target_value !== purchase.vendor_id) {
    throw refuse('SHOP');
  }
  const startsAt = input.starts_at === null ? now : new Date(input.starts_at);
  const endsAt = input.ends_at === null ? null : new Date(input.ends_at);
  if (endsAt === null || startsAt < purchase.starts_at || endsAt > purchase.ends_at) {
    throw refuse('DATES');
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
