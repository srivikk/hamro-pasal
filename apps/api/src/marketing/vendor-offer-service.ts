import { recordAuditLog, vendorOffers, vendors, type Database } from '@hamro-pasal/db';
import {
  MAX_LIVE_VENDOR_OFFERS,
  NO_AUDIT_CONTEXT,
  vendorOfferLabel,
  type AuditActor,
  type AuditContext,
  type VendorOfferCreateRequest,
} from '@hamro-pasal/shared-types';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { VendorAccountNotFoundError } from '../orders/vendor-order-service';

export type VendorOfferRow = typeof vendorOffers.$inferSelect;

/** Unknown, or another shop's: the two are not told apart. */
export class VendorOfferNotFoundError extends Error {
  constructor(readonly offerId: string) {
    super(`Offer ${offerId} not found`);
    this.name = 'VendorOfferNotFoundError';
  }
}

/** The shop already has as many running or scheduled offers as it may. */
export class VendorOfferLimitError extends Error {
  constructor(readonly max: number) {
    super(`A shop may have at most ${String(max)} offers running at once`);
    this.name = 'VendorOfferLimitError';
  }
}

/** `ends_at` is not in the future. */
export class VendorOfferEndInPastError extends Error {
  constructor() {
    super('An offer must end in the future');
    this.name = 'VendorOfferEndInPastError';
  }
}

export interface ListedVendorOffers {
  readonly offers: VendorOfferRow[];
  /** The database clock of the read: what "ended" is judged against. */
  readonly now: Date;
}

const VENDOR_OFFER_LIST_LIMIT = 100;

/**
 * A vendor's own offers (Phase 32, SPEC core 7). Only the shop's own account creates or ends one,
 * each in one transaction with its audit entry; the database refuses anyone else and any edit of
 * a rule (migration 0034). No order is priced with an offer yet.
 *
 * Both writes take the vendor row `FOR UPDATE` first, then (ending) the offer row: a shop's offer
 * changes run one after another, and the limit is counted under the lock.
 */
export class VendorOfferService {
  constructor(private readonly db: Database) {}

  /** Every offer of the shop, newest first. */
  async list(vendorUserId: string): Promise<ListedVendorOffers> {
    const [vendor] = await this.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(eq(vendors.user_id, vendorUserId));
    if (vendor === undefined) throw new VendorAccountNotFoundError(vendorUserId);
    const offers = await this.db
      .select()
      .from(vendorOffers)
      .where(eq(vendorOffers.vendor_id, vendor.id))
      .orderBy(desc(vendorOffers.created_at), desc(vendorOffers.id))
      .limit(VENDOR_OFFER_LIST_LIMIT);
    return { offers, now: await databaseClock(this.db) };
  }

  create(
    actor: AuditActor & { kind: 'USER' },
    input: VendorOfferCreateRequest,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<{ offer: VendorOfferRow; now: Date }> {
    return this.db.transaction(async (tx) => {
      const [vendor] = await tx
        .select({ id: vendors.id })
        .from(vendors)
        .where(eq(vendors.user_id, actor.user_id))
        .for('update');
      if (vendor === undefined) throw new VendorAccountNotFoundError(actor.user_id);

      const now = await databaseClock(tx);
      const endsAt = input.ends_at === null ? null : new Date(input.ends_at);
      if (endsAt !== null && endsAt.getTime() <= now.getTime()) {
        throw new VendorOfferEndInPastError();
      }

      const [live] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(vendorOffers)
        .where(
          and(
            eq(vendorOffers.vendor_id, vendor.id),
            isNull(vendorOffers.ended_at),
            sql`(${vendorOffers.ends_at} IS NULL OR ${vendorOffers.ends_at} > now())`,
          ),
        );
      if ((live?.count ?? 0) >= MAX_LIVE_VENDOR_OFFERS) {
        throw new VendorOfferLimitError(MAX_LIVE_VENDOR_OFFERS);
      }

      const [offer] = await tx
        .insert(vendorOffers)
        .values({
          vendor_id: vendor.id,
          kind: input.kind,
          value: input.value,
          max_discount_npr: input.max_discount_npr,
          min_cart_npr: input.min_cart_npr,
          label: vendorOfferLabel(input),
          starts_at: now,
          ends_at: endsAt,
          created_by_user_id: actor.user_id,
        })
        .returning();
      if (offer === undefined) throw new Error('The offer was not stored');

      await recordAuditLog(tx, {
        actor,
        action: 'VENDOR_OFFER_CREATED',
        entityId: offer.id,
        vendorId: vendor.id,
        beforeState: null,
        afterState: offerState(offer),
        context,
      });
      return { offer, now };
    });
  }

  /** Ends the offer for future orders. A repeat answers with the same row and records nothing. */
  end(
    actor: AuditActor & { kind: 'USER' },
    offerId: string,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<{ offer: VendorOfferRow; now: Date }> {
    return this.db.transaction(async (tx) => {
      const [vendor] = await tx
        .select({ id: vendors.id })
        .from(vendors)
        .where(eq(vendors.user_id, actor.user_id))
        .for('update');
      if (vendor === undefined) throw new VendorAccountNotFoundError(actor.user_id);

      const [before] = await tx
        .select()
        .from(vendorOffers)
        .where(and(eq(vendorOffers.id, offerId), eq(vendorOffers.vendor_id, vendor.id)))
        .for('update');
      if (before === undefined) throw new VendorOfferNotFoundError(offerId);
      const now = await databaseClock(tx);
      if (before.ended_at !== null) return { offer: before, now };

      const [ended] = await tx
        .update(vendorOffers)
        .set({ ended_at: now, ended_by_user_id: actor.user_id })
        .where(and(eq(vendorOffers.id, before.id), isNull(vendorOffers.ended_at)))
        .returning();
      if (ended === undefined) throw new Error(`Offer ${before.id} vanished`);

      await recordAuditLog(tx, {
        actor,
        action: 'VENDOR_OFFER_ENDED',
        entityId: ended.id,
        vendorId: vendor.id,
        beforeState: offerState(before),
        afterState: offerState(ended),
        context,
      });
      return { offer: ended, now };
    });
  }
}

function offerState(offer: VendorOfferRow) {
  return {
    kind: offer.kind,
    value: offer.value,
    max_discount_npr: offer.max_discount_npr,
    min_cart_npr: offer.min_cart_npr,
    label: offer.label,
    starts_at: offer.starts_at.toISOString(),
    ends_at: offer.ends_at?.toISOString() ?? null,
    ended_at: offer.ended_at?.toISOString() ?? null,
  };
}

async function databaseClock(db: Pick<Database, 'execute'>): Promise<Date> {
  const result = await db.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`);
  const now = result.rows[0]?.now;
  if (now === undefined) throw new Error('The database clock did not answer');
  return new Date(now);
}
