import {
  recordAuditLog,
  settlementModelChangeRequests,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import {
  modelChangeBlockersOf,
  NO_AUDIT_CONTEXT,
  type AuditActor,
  type AuditContext,
  type ModelChangeBlocker,
  type SettlementModel,
  type SettlementModelRequestStatus,
} from '@hamro-pasal/shared-types';
import { and, eq, sql } from 'drizzle-orm';

import { VendorAccountNotFoundError } from '../orders/vendor-order-service';

export type ModelChangeRequestRow = typeof settlementModelChangeRequests.$inferSelect;

/** A request with its shop and what stands in the way of the change, as the database sees it now. */
export interface ModelChangeRequestWithShop {
  readonly request: ModelChangeRequestRow;
  readonly businessName: string;
  readonly phone: string;
  readonly currentModel: SettlementModel;
  readonly openOrderCount: number;
  readonly ledgerBalanceNpr: number;
  readonly activeAdCount: number;
}

export class SettlementModelRequestNotFoundError extends Error {
  constructor(readonly requestId: string) {
    super(`Settlement model request ${requestId} not found`);
    this.name = 'SettlementModelRequestNotFoundError';
  }
}

/** Model C (DIRECT_PREPAID) cannot be selected before Phase 3 (SPEC core 5). */
export class SettlementModelUnavailableError extends Error {
  constructor(readonly model: SettlementModel) {
    super(`Settlement model ${model} cannot be selected yet`);
    this.name = 'SettlementModelUnavailableError';
  }
}

export class SettlementModelUnchangedError extends Error {
  constructor(readonly model: SettlementModel) {
    super(`The shop is already on ${model}`);
    this.name = 'SettlementModelUnchangedError';
  }
}

export class SettlementModelRequestPendingError extends Error {
  constructor(readonly requestId: string) {
    super('The shop already has a settlement model request waiting for a decision');
    this.name = 'SettlementModelRequestPendingError';
  }
}

export class SettlementChangeBlockedError extends Error {
  constructor(readonly blockers: readonly ModelChangeBlocker[]) {
    super(`The settlement model cannot change yet: ${blockers.join(', ')}`);
    this.name = 'SettlementChangeBlockedError';
  }
}

export class SettlementModelRequestDecidedError extends Error {
  constructor(readonly status: SettlementModelRequestStatus) {
    super(`The request was already ${status.toLowerCase()}`);
    this.name = 'SettlementModelRequestDecidedError';
  }
}

/**
 * An open order: placed and not yet delivered, cancelled or failed. An unpaid checkout counts
 * only while its 600-second inventory lock can still be claimed; after that it can never be
 * placed, and nothing moves it out of PENDING_PAYMENT, so counting it would block a shop forever.
 */
const openOrderCount = sql<number>`(SELECT count(*) FROM orders o
    WHERE o.vendor_id = "vendors"."id"
      AND (o.state IN ('PLACED', 'PREPARING', 'OUT_FOR_DELIVERY', 'DISPUTED')
        OR (o.state = 'PENDING_PAYMENT' AND o.created_at > now() - interval '600 seconds')))::int`;

/** An ad that has not finished: running, or paused on its budget. */
const activeAdCount = sql<number>`(SELECT count(*) FROM ad_purchases p
    WHERE p.vendor_id = "vendors"."id" AND p.status IN ('ACTIVE', 'PAUSED'))::int`;

const withShop = {
  request: settlementModelChangeRequests,
  businessName: vendors.business_name,
  phone: vendors.phone,
  currentModel: vendors.settlement_model,
  openOrderCount,
  ledgerBalanceNpr: vendors.wallet_balance_npr,
  activeAdCount,
};

function requestState(request: ModelChangeRequestRow) {
  return {
    from_model: request.from_model,
    requested_model: request.requested_model,
    status: request.status,
    rejection_reason: request.rejection_reason,
  };
}

/**
 * Settlement model change requests (SPEC core 5).
 *
 * - **The vendor asks; an admin decides the request as asked.** `request` is the shop's own
 *   account (the database refuses any other requester); `approve` and `reject` take no model.
 * - **One PENDING request per shop**, serialised by the vendor row lock and backed by a partial
 *   unique index.
 * - **An approval takes effect only on a clear shop:** no open order, a ledger at 0 or above and
 *   no ad running, all read under the vendor row lock (the lock an order's insert, a wallet
 *   journal and a payout wait for). It sets `vendors.settlement_model`, closes the request and
 *   writes the audit entry in that one transaction.
 * - **Model C cannot be requested or approved** before Phase 3.
 */
export class SettlementModelRequestService {
  constructor(private readonly db: Database) {}

  /** POST /api/vendor/ledger/settlement-model: the shop's own account files a request. */
  request(
    actor: AuditActor & { kind: 'USER' },
    model: SettlementModel,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<ModelChangeRequestRow> {
    return this.db.transaction(async (tx) => {
      const [vendor] = await tx
        .select({ id: vendors.id, settlement_model: vendors.settlement_model })
        .from(vendors)
        .where(eq(vendors.user_id, actor.user_id))
        .for('update');
      if (vendor === undefined) throw new VendorAccountNotFoundError(actor.user_id);
      if (model === 'DIRECT_PREPAID') throw new SettlementModelUnavailableError(model);
      if (model === vendor.settlement_model) throw new SettlementModelUnchangedError(model);

      const [pending] = await tx
        .select({ id: settlementModelChangeRequests.id })
        .from(settlementModelChangeRequests)
        .where(
          and(
            eq(settlementModelChangeRequests.vendor_id, vendor.id),
            eq(settlementModelChangeRequests.status, 'PENDING'),
          ),
        );
      if (pending !== undefined) throw new SettlementModelRequestPendingError(pending.id);

      const [created] = await tx
        .insert(settlementModelChangeRequests)
        .values({
          vendor_id: vendor.id,
          from_model: vendor.settlement_model,
          requested_model: model,
          requested_by_user_id: actor.user_id,
        })
        .returning();
      if (created === undefined) throw new Error('The request was not stored');

      await recordAuditLog(tx, {
        actor,
        action: 'SETTLEMENT_MODEL_CHANGE_REQUESTED',
        entityId: created.id,
        vendorId: vendor.id,
        beforeState: null,
        afterState: requestState(created),
        context,
      });
      return created;
    });
  }

  /** Pending requests first, the longest waiting first; then the decided ones, latest first. */
  async list(status?: SettlementModelRequestStatus): Promise<ModelChangeRequestWithShop[]> {
    const rows = await this.db
      .select(withShop)
      .from(settlementModelChangeRequests)
      .innerJoin(vendors, eq(vendors.id, settlementModelChangeRequests.vendor_id))
      .where(status === undefined ? undefined : eq(settlementModelChangeRequests.status, status));
    const time = (date: Date | null) => date?.getTime() ?? 0;
    return rows.sort((a, b) => {
      const pending =
        Number(b.request.status === 'PENDING') - Number(a.request.status === 'PENDING');
      if (pending !== 0) return pending;
      return a.request.status === 'PENDING'
        ? time(a.request.requested_at) - time(b.request.requested_at)
        : time(b.request.decided_at) - time(a.request.decided_at);
    });
  }

  /** The request with its shop inside `tx`; `lock` takes the request row FOR UPDATE. */
  private async read(
    tx: Transaction,
    requestId: string,
    lock: boolean,
  ): Promise<ModelChangeRequestWithShop> {
    if (lock) {
      await tx
        .select({ id: settlementModelChangeRequests.id })
        .from(settlementModelChangeRequests)
        .where(eq(settlementModelChangeRequests.id, requestId))
        .for('update');
    }
    const [row] = await tx
      .select(withShop)
      .from(settlementModelChangeRequests)
      .innerJoin(vendors, eq(vendors.id, settlementModelChangeRequests.vendor_id))
      .where(eq(settlementModelChangeRequests.id, requestId));
    if (row === undefined) throw new SettlementModelRequestNotFoundError(requestId);
    return row;
  }

  /**
   * Moves the shop to the model it asked for. One transaction: the vendor row lock, then the
   * request row lock, the guardrails read under both, the two updates and the audit entry.
   * Approving an approved request again answers it unchanged.
   */
  approve(
    actor: AuditActor & { kind: 'USER' },
    requestId: string,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<ModelChangeRequestWithShop> {
    return this.db.transaction(async (tx) => {
      const found = await this.read(tx, requestId, false);
      await tx
        .select({ id: vendors.id })
        .from(vendors)
        .where(eq(vendors.id, found.request.vendor_id))
        .for('update');
      const locked = await this.read(tx, requestId, true);
      const { request } = locked;

      if (request.status === 'APPROVED') return locked;
      if (request.status === 'REJECTED') throw new SettlementModelRequestDecidedError('REJECTED');
      if (request.requested_model === 'DIRECT_PREPAID') {
        throw new SettlementModelUnavailableError(request.requested_model);
      }
      const blockers = modelChangeBlockersOf({
        open_order_count: locked.openOrderCount,
        ledger_balance_npr: locked.ledgerBalanceNpr,
        active_ad_count: locked.activeAdCount,
      });
      if (blockers.length > 0) throw new SettlementChangeBlockedError(blockers);

      await tx
        .update(vendors)
        .set({ settlement_model: request.requested_model })
        .where(eq(vendors.id, request.vendor_id));
      await tx
        .update(settlementModelChangeRequests)
        .set({ status: 'APPROVED', decided_by_user_id: actor.user_id, decided_at: sql`now()` })
        .where(eq(settlementModelChangeRequests.id, requestId));

      await recordAuditLog(tx, {
        actor,
        action: 'SETTLEMENT_MODEL_CHANGED',
        entityId: request.vendor_id,
        vendorId: request.vendor_id,
        beforeState: { settlement_model: locked.currentModel },
        afterState: { settlement_model: request.requested_model, request_id: request.id },
        context,
      });
      return this.read(tx, requestId, false);
    });
  }

  /** Leaves the shop on its model. Rejecting a rejected request again answers it unchanged. */
  reject(
    actor: AuditActor & { kind: 'USER' },
    requestId: string,
    reason: string | null,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<ModelChangeRequestWithShop> {
    return this.db.transaction(async (tx) => {
      // The same lock order as `approve` (vendor, then request): the audit entry's foreign key
      // reads the vendor row, which an approval running at the same moment holds.
      const found = await this.read(tx, requestId, false);
      await tx
        .select({ id: vendors.id })
        .from(vendors)
        .where(eq(vendors.id, found.request.vendor_id))
        .for('update');
      const locked = await this.read(tx, requestId, true);
      const { request } = locked;
      if (request.status === 'REJECTED') return locked;
      if (request.status === 'APPROVED') throw new SettlementModelRequestDecidedError('APPROVED');

      const [rejected] = await tx
        .update(settlementModelChangeRequests)
        .set({
          status: 'REJECTED',
          decided_by_user_id: actor.user_id,
          decided_at: sql`now()`,
          rejection_reason: reason,
        })
        .where(eq(settlementModelChangeRequests.id, requestId))
        .returning();
      if (rejected === undefined) throw new SettlementModelRequestNotFoundError(requestId);

      await recordAuditLog(tx, {
        actor,
        action: 'SETTLEMENT_MODEL_CHANGE_REJECTED',
        entityId: request.id,
        vendorId: request.vendor_id,
        beforeState: requestState(request),
        afterState: requestState(rejected),
        context,
      });
      return { ...locked, request: rejected };
    });
  }
}
