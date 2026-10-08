import {
  adProducts,
  adPurchases,
  recordAuditLog,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import { releaseUnusedAdBudget, toNpr, toPaisa, type LedgerService } from '@hamro-pasal/ledger';
import {
  AD_PURCHASE_MAX_START_AHEAD_DAYS,
  AD_PURCHASE_START_GRACE_SECONDS,
  NO_AUDIT_CONTEXT,
  PREPAID_FIXED_RESERVE_NPR,
  type AdBillingModel,
  type AdPurchaseRequest,
  type AuditActor,
  type AuditContext,
  type SettlementModel,
} from '@hamro-pasal/shared-types';
import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { VendorAccountNotFoundError } from '../orders/vendor-order-service';
import { pendingEscrowOf } from '../wallet/vendor-wallet-service';
import { adFeesDuePaisa, collectAdFeesDue, postFlatFee } from './ad-fees';
import { AdProductNotFoundError } from './ad-product-service';

export type AdPurchaseRow = typeof adPurchases.$inferSelect;
export type AdProductRow = typeof adProducts.$inferSelect;

/** A purchase with the product it bought (the name and placement are the product's). */
export interface AdPurchaseWithProduct {
  readonly purchase: AdPurchaseRow;
  readonly product: Pick<AdProductRow, 'name' | 'slot'>;
}

export interface AdMarketplace {
  readonly settlementModel: SettlementModel;
  readonly availableForAdsNpr: number;
  readonly products: readonly {
    readonly product: AdProductRow;
    readonly rechargeRequiredNpr: number;
  }[];
}

export interface AdPurchaseResult extends AdPurchaseWithProduct {
  readonly availableForAdsNpr: number;
  readonly replayed: boolean;
}

export interface AdCancelResult extends AdPurchaseWithProduct {
  readonly availableForAdsNpr: number;
}

const MS_PER_DAY = 86_400_000;
/** The most a vendor's purchases list returns (newest first). */
const PURCHASE_LIST_LIMIT = 100;

/** Unknown, or another shop's: ids cannot be probed. */
export class AdPurchaseNotFoundError extends Error {
  constructor(readonly purchaseId: string) {
    super(`Ad purchase ${purchaseId} not found`);
    this.name = 'AdPurchaseNotFoundError';
  }
}

export class AdPurchaseKeyReusedError extends Error {
  constructor() {
    super('This idempotency key was already used for a different ad purchase');
    this.name = 'AdPurchaseKeyReusedError';
  }
}

/** A per-order ad needs a budget of at least one fee; a flat-rate ad takes none. */
export class AdBudgetInvalidError extends Error {
  constructor(
    readonly billingModel: AdBillingModel,
    readonly priceNpr: number,
  ) {
    super(
      billingModel === 'FLAT_RATE'
        ? 'A flat-rate ad has no budget'
        : 'A per-order ad needs a budget of at least its fee per order',
    );
    this.name = 'AdBudgetInvalidError';
  }
}

export class AdStartOutOfRangeError extends Error {
  constructor() {
    super(`An ad starts now or within the next ${String(AD_PURCHASE_MAX_START_AHEAD_DAYS)} days`);
    this.name = 'AdStartOutOfRangeError';
  }
}

/**
 * The Model B guard rail (SPEC core 8, decided 2026-10-07): the platform never sells a flat-rate
 * ad for more than it already holds for that vendor.
 */
export class AdExceedsPendingPayoutError extends Error {
  constructor(
    readonly adPriceNpr: number,
    readonly balanceNpr: number,
    readonly pendingEscrowNpr: number,
    readonly adFeesDueNpr: number,
  ) {
    super('Insufficient funds for this ad purchase.');
    this.name = 'AdExceedsPendingPayoutError';
  }
}

/** Models A and C: the ledger balance does not cover the price or the budget. */
export class LedgerRechargeRequiredError extends Error {
  constructor(readonly rechargeRequiredNpr: number) {
    super('Insufficient funds for this ad purchase.');
    this.name = 'LedgerRechargeRequiredError';
  }
}

/** STARTED: a flat-rate ad whose period began runs to its end. ENDED: nothing left to cancel. */
export class AdPurchaseNotCancellableError extends Error {
  constructor(readonly reason: 'STARTED' | 'ENDED') {
    super(
      reason === 'STARTED'
        ? 'A flat-rate ad can be cancelled only before it starts'
        : 'This ad has already ended',
    );
    this.name = 'AdPurchaseNotCancellableError';
  }
}

interface LockedVendor {
  readonly id: string;
  readonly balanceNpr: number;
  readonly settlementModel: SettlementModel;
  /** The database clock, so the start range and the cancellation rule share one clock. */
  readonly now: Date;
}

const vendorColumns = {
  id: vendors.id,
  balanceNpr: vendors.wallet_balance_npr,
  settlementModel: vendors.settlement_model,
  nowMs: sql<number>`(extract(epoch from now()) * 1000)::float8`.mapWith(Number),
};

/**
 * What a shop can spend on ads, in paisa (never negative). Model B: what the platform holds for
 * it (balance + pending escrow) less the flat fees it already owes. Model A: its balance; an ad is
 * never bought on credit. Model C: its balance above the Fixed Reserve.
 */
export function availableForAdsPaisa(
  settlementModel: SettlementModel,
  funds: { balancePaisa: number; pendingEscrowPaisa: number; feesDuePaisa: number },
): number {
  switch (settlementModel) {
    case 'PLATFORM_ESCROW':
      return Math.max(0, funds.balancePaisa + funds.pendingEscrowPaisa - funds.feesDuePaisa);
    case 'COD_CREDIT':
      return Math.max(0, funds.balancePaisa);
    case 'DIRECT_PREPAID':
      return Math.max(0, funds.balancePaisa - toPaisa(PREPAID_FIXED_RESERVE_NPR));
  }
}

function purchaseState(purchase: AdPurchaseRow, product: Pick<AdProductRow, 'name' | 'slot'>) {
  return {
    ad_product_id: purchase.ad_product_id,
    product_name: product.name,
    slot: product.slot,
    billing_model: purchase.billing_model,
    price_npr: purchase.price_npr,
    budget_npr: purchase.budget_npr,
    settlement_model: purchase.settlement_model,
    status: purchase.status,
    starts_at: purchase.starts_at.toISOString(),
    ends_at: purchase.ends_at.toISOString(),
    amount_paid_npr: purchase.amount_paid_npr,
    agreed_at: purchase.agreed_at.toISOString(),
  };
}

/**
 * The Ad Marketplace as a shop uses it (SPEC core 8).
 *
 * - **No unilateral billing.** A purchase is made by the shop's own account with an explicit
 *   agreement; nothing here lets anyone else create one, and the database refuses a row the
 *   vendor's user did not agree to (trigger of migration 0026).
 * - **Collection follows the settlement model**, fixed on the purchase row.
 *   - Models A and C: a flat price is taken from the ledger balance at purchase, and the whole
 *     budget of a per-order ad is held (AD_BUDGET_CLEARING). Refused if the balance does not
 *     cover it: 422 LEDGER_RECHARGE_REQUIRED.
 *   - Model B: a flat price is taken from the wallet as far as it goes; the rest stays due and is
 *     collected from the wallet before any payout (`collectAdFeesDue`). Refused when
 *     balance + pending escrow, less fees already due, is under the price:
 *     422 AD_EXCEEDS_PENDING_PAYOUT. A per-order ad holds nothing.
 * - **Locks.** Every write takes the vendor row first (`FOR UPDATE`: the lock a settlement model
 *   approval and a payout take), then the purchase row, then the ledger accounts.
 */
export class AdPurchaseService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
  ) {}

  /** The placements on sale and what this shop can spend on them. One snapshot. */
  marketplace(vendorUserId: string): Promise<AdMarketplace> {
    return this.db.transaction(
      async (tx) => {
        const vendor = await vendorOf(tx, vendorUserId, false);
        const availablePaisa = await availableOf(tx, vendor);
        const products = await tx
          .select()
          .from(adProducts)
          .where(eq(adProducts.is_active, true))
          .orderBy(asc(sql`lower(${adProducts.name})`), asc(adProducts.id));
        return {
          settlementModel: vendor.settlementModel,
          availableForAdsNpr: toNpr(availablePaisa),
          products: products.map((product) => ({
            product,
            // Model B is never asked to recharge: it buys against what the platform holds.
            rechargeRequiredNpr:
              vendor.settlementModel === 'PLATFORM_ESCROW'
                ? 0
                : toNpr(Math.max(0, toPaisa(product.price_npr) - availablePaisa)),
          })),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  /** The shop's own purchases, newest first. */
  async list(vendorUserId: string): Promise<AdPurchaseWithProduct[]> {
    return this.db
      .select({
        purchase: adPurchases,
        product: { name: adProducts.name, slot: adProducts.slot },
      })
      .from(adPurchases)
      .innerJoin(adProducts, eq(adProducts.id, adPurchases.ad_product_id))
      .innerJoin(vendors, eq(vendors.id, adPurchases.vendor_id))
      .where(eq(vendors.user_id, vendorUserId))
      .orderBy(desc(adPurchases.agreed_at), desc(adPurchases.id))
      .limit(PURCHASE_LIST_LIMIT);
  }

  /**
   * One transaction under the vendor row lock: the guard, the purchase row, the ledger postings
   * and the audit entry commit together or not at all. Concurrent purchases of one shop run one
   * after another, each against what the previous one left.
   */
  purchase(
    actor: AuditActor & { kind: 'USER' },
    input: AdPurchaseRequest,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<AdPurchaseResult> {
    const startsAt = new Date(input.starts_at);
    const budgetPaisa = input.budget_npr == null ? null : toPaisa(input.budget_npr);

    return this.db.transaction(async (tx) => {
      const vendor = await vendorOf(tx, actor.user_id, true);

      // A retried request buys nothing: it answers with the purchase it already made.
      const [existing] = await tx
        .select()
        .from(adPurchases)
        .where(
          and(
            eq(adPurchases.vendor_id, vendor.id),
            eq(adPurchases.idempotency_key, input.idempotency_key),
          ),
        );
      if (existing !== undefined) {
        const sameBudget =
          (existing.budget_npr === null ? null : toPaisa(existing.budget_npr)) === budgetPaisa;
        if (
          existing.ad_product_id !== input.ad_product_id ||
          existing.starts_at.getTime() !== startsAt.getTime() ||
          !sameBudget
        ) {
          throw new AdPurchaseKeyReusedError();
        }
        return {
          purchase: existing,
          product: await productOf(tx, existing.ad_product_id),
          availableForAdsNpr: toNpr(await availableOf(tx, vendor)),
          replayed: true,
        };
      }

      const [product] = await tx
        .select()
        .from(adProducts)
        .where(and(eq(adProducts.id, input.ad_product_id), eq(adProducts.is_active, true)));
      if (product === undefined) throw new AdProductNotFoundError(input.ad_product_id);

      const pricePaisa = toPaisa(product.price_npr);
      const perOrder = product.billing_model === 'PER_ORDER_PREMIUM';
      if (perOrder ? budgetPaisa === null || budgetPaisa < pricePaisa : budgetPaisa !== null) {
        throw new AdBudgetInvalidError(product.billing_model, product.price_npr);
      }
      const now = vendor.now.getTime();
      if (
        startsAt.getTime() < now - AD_PURCHASE_START_GRACE_SECONDS * 1000 ||
        startsAt.getTime() > now + AD_PURCHASE_MAX_START_AHEAD_DAYS * MS_PER_DAY
      ) {
        throw new AdStartOutOfRangeError();
      }

      // The guards, under the vendor row lock and before anything is written.
      const escrowBased = vendor.settlementModel === 'PLATFORM_ESCROW';
      const funds = await fundsOf(tx, vendor);
      const availablePaisa = availableForAdsPaisa(vendor.settlementModel, funds);
      if (escrowBased) {
        if (!perOrder && availablePaisa < pricePaisa) {
          throw new AdExceedsPendingPayoutError(
            product.price_npr,
            vendor.balanceNpr,
            toNpr(funds.pendingEscrowPaisa),
            toNpr(funds.feesDuePaisa),
          );
        }
      } else {
        // What leaves the ledger at once: the price, or the whole budget of a per-order ad.
        const costPaisa = budgetPaisa ?? pricePaisa;
        if (availablePaisa < costPaisa) {
          throw new LedgerRechargeRequiredError(toNpr(costPaisa - availablePaisa));
        }
      }

      const [created] = await tx
        .insert(adPurchases)
        .values({
          vendor_id: vendor.id,
          ad_product_id: product.id,
          billing_model: product.billing_model,
          price_npr: product.price_npr,
          budget_npr: budgetPaisa === null ? null : toNpr(budgetPaisa),
          settlement_model: vendor.settlementModel,
          starts_at: startsAt,
          ends_at: new Date(startsAt.getTime() + product.duration_days * MS_PER_DAY),
          agreed_by_user_id: actor.user_id,
          idempotency_key: input.idempotency_key,
        })
        .returning();
      if (created === undefined) throw new Error('The ad purchase was not stored');

      if (escrowBased) {
        // What the wallet covers now; the rest stays due and is taken before any payout.
        if (!perOrder) await collectAdFeesDue(tx, this.ledger, vendor.id);
      } else if (budgetPaisa === null) {
        await postFlatFee(tx, this.ledger, created, pricePaisa);
      } else {
        const line = { lineType: 'AD_BUDGET_HOLD', adPurchaseId: created.id } as const;
        await this.ledger.post(tx, {
          kind: 'AD_PURCHASE',
          idempotencyKey: `ad-budget-hold:${created.id}`,
          orderId: null,
          description: 'Ad purchase: per-order budget held',
          postings: [
            {
              account: { type: 'VENDOR_WALLET', vendorId: vendor.id },
              amountPaisa: -budgetPaisa,
              ...line,
            },
            { account: { type: 'AD_BUDGET_CLEARING' }, amountPaisa: budgetPaisa, ...line },
          ],
        });
      }

      const purchase = await reload(tx, created.id);
      await recordAuditLog(tx, {
        actor,
        action: 'AD_PURCHASED',
        entityId: purchase.id,
        vendorId: vendor.id,
        beforeState: null,
        afterState: purchaseState(purchase, product),
        context,
      });
      return {
        purchase,
        product,
        availableForAdsNpr: toNpr(await availableOf(tx, await vendorOf(tx, actor.user_id, false))),
        replayed: false,
      };
    });
  }

  /**
   * The vendor withdraws its ad; 200 also on repeat.
   *
   * - A flat-rate ad can be cancelled only before it starts: what was collected is returned and
   *   nothing stays due. Once its period began it runs to its end at the price agreed.
   * - A per-order ad can be cancelled at any time: the unused part of a held budget goes back.
   */
  cancel(
    actor: AuditActor & { kind: 'USER' },
    purchaseId: string,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<AdCancelResult> {
    return this.db.transaction(async (tx) => {
      const vendor = await vendorOf(tx, actor.user_id, true);
      const [before] = await tx
        .select()
        .from(adPurchases)
        .where(and(eq(adPurchases.id, purchaseId), eq(adPurchases.vendor_id, vendor.id)))
        .for('update');
      if (before === undefined) throw new AdPurchaseNotFoundError(purchaseId);
      const product = await productOf(tx, before.ad_product_id);

      if (before.status !== 'CANCELLED') {
        if (before.status === 'ENDED' || before.ends_at <= vendor.now) {
          throw new AdPurchaseNotCancellableError('ENDED');
        }
        const paidPaisa = toPaisa(before.amount_paid_npr);
        let returnedPaisa: number;
        if (before.billing_model === 'FLAT_RATE') {
          if (before.starts_at <= vendor.now) throw new AdPurchaseNotCancellableError('STARTED');
          returnedPaisa = paidPaisa;
          if (returnedPaisa > 0) {
            const line = { lineType: 'AD_FLAT_FEE', adPurchaseId: before.id } as const;
            await this.ledger.post(tx, {
              kind: 'AD_REFUND',
              idempotencyKey: `ad-refund:${before.id}`,
              orderId: null,
              description: 'Ad cancelled before it started: flat fee returned',
              postings: [
                { account: { type: 'AD_REVENUE' }, amountPaisa: -returnedPaisa, ...line },
                {
                  account: { type: 'VENDOR_WALLET', vendorId: vendor.id },
                  amountPaisa: returnedPaisa,
                  ...line,
                },
              ],
            });
          }
        } else {
          // What was held at purchase and not drawn by per-order fees (Models A and C).
          returnedPaisa = await releaseUnusedAdBudget(tx, this.ledger, before);
        }

        const [after] = await tx
          .update(adPurchases)
          .set({
            status: 'CANCELLED',
            ...(before.billing_model === 'FLAT_RATE' ? { amount_paid_npr: 0 } : {}),
          })
          .where(eq(adPurchases.id, before.id))
          .returning();
        if (after === undefined) throw new AdPurchaseNotFoundError(purchaseId);
        await recordAuditLog(tx, {
          actor,
          action: 'AD_CANCELLED',
          entityId: after.id,
          vendorId: vendor.id,
          beforeState: purchaseState(before, product),
          afterState: { ...purchaseState(after, product), returned_npr: toNpr(returnedPaisa) },
          context,
        });
      }

      return {
        purchase: await reload(tx, before.id),
        product,
        availableForAdsNpr: toNpr(await availableOf(tx, await vendorOf(tx, actor.user_id, false))),
      };
    });
  }
}

/** The caller's shop; `lock` takes its row lock, the first lock of every write here. */
async function vendorOf(
  tx: Transaction,
  vendorUserId: string,
  lock: boolean,
): Promise<LockedVendor> {
  const query = tx.select(vendorColumns).from(vendors).where(eq(vendors.user_id, vendorUserId));
  const [vendor] = await (lock ? query.for('update') : query);
  if (vendor === undefined) throw new VendorAccountNotFoundError(vendorUserId);
  return {
    id: vendor.id,
    balanceNpr: vendor.balanceNpr,
    settlementModel: vendor.settlementModel,
    now: new Date(vendor.nowMs),
  };
}

async function fundsOf(tx: Transaction, vendor: LockedVendor) {
  return {
    balancePaisa: toPaisa(vendor.balanceNpr),
    pendingEscrowPaisa: toPaisa((await pendingEscrowOf(tx, vendor.id)).totalNpr),
    feesDuePaisa: await adFeesDuePaisa(tx, vendor.id),
  };
}

async function availableOf(tx: Transaction, vendor: LockedVendor): Promise<number> {
  return availableForAdsPaisa(vendor.settlementModel, await fundsOf(tx, vendor));
}

async function productOf(
  tx: Transaction,
  productId: string,
): Promise<Pick<AdProductRow, 'name' | 'slot'>> {
  const [product] = await tx
    .select({ name: adProducts.name, slot: adProducts.slot })
    .from(adProducts)
    .where(eq(adProducts.id, productId));
  if (product === undefined) throw new AdProductNotFoundError(productId);
  return product;
}

async function reload(tx: Transaction, purchaseId: string): Promise<AdPurchaseRow> {
  const [purchase] = await tx.select().from(adPurchases).where(eq(adPurchases.id, purchaseId));
  if (purchase === undefined) throw new AdPurchaseNotFoundError(purchaseId);
  return purchase;
}
