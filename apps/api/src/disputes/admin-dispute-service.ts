import {
  disputes,
  enqueueDomainEvent,
  orders,
  recordAuditLog,
  users,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import {
  enqueueOrderStateChanged,
  heldForOrderPaisa,
  orderTotalPaisa,
  settleDisputeHold,
  toNpr,
  toPaisa,
  type LedgerService,
} from '@hamro-pasal/ledger';
import type {
  AdminDisputeListQuery,
  AdminDisputeView,
  AuditContext,
  Dispute,
  DisputeStatus,
  Order,
  ResolutionOutcome,
  ResolutionRequest,
} from '@hamro-pasal/shared-types';
import { and, asc, eq, gt, inArray, or, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { HttpError } from '../http/errors';

const RESOLVED: readonly DisputeStatus[] = [
  'RELEASED_TO_VENDOR',
  'REFUNDED_TO_CUSTOMER',
  'PARTIALLY_REFUNDED',
];

const STATUS_OF: Record<ResolutionOutcome, DisputeStatus> = {
  RELEASE: 'RELEASED_TO_VENDOR',
  REFUND: 'REFUNDED_TO_CUSTOMER',
  PARTIAL_REFUND: 'PARTIALLY_REFUNDED',
};

const escalator = alias(users, 'escalator');
const customer = alias(users, 'customer');

interface ListRow {
  dispute: Dispute;
  order: Order;
  businessName: string;
  customerFirstName: string | null;
  escalatorRole: string | null;
}

export interface AdminDisputePage {
  readonly disputes: readonly AdminDisputeView[];
  readonly nextCursor: string | null;
}

/**
 * Step 7.3 (SPEC core 6, Super Admin flow 9): escalated order conversations and their resolution.
 * Refunds are recorded, not paid: they wait in REFUND_CLEARING for the platform to pay them by
 * hand from the eSewa / Khalti merchant dashboards (decided 2026-10-15).
 */
export class AdminDisputeService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
  ) {}

  /** GET /api/admin/disputes: escalated (oldest first) or resolved ones, keyset on the id. */
  async list(query: AdminDisputeListQuery): Promise<AdminDisputePage> {
    const statusIn: SQL =
      query.status === 'ESCALATED'
        ? eq(disputes.status, 'ESCALATED')
        : inArray(disputes.status, [...RESOLVED]);
    let after: SQL | undefined;
    if (query.cursor !== undefined) {
      const [cursor] = await this.db
        .select({ at: disputes.escalated_at, id: disputes.id })
        .from(disputes)
        .where(eq(disputes.id, query.cursor));
      if (cursor?.at == null) {
        throw new HttpError(400, 'INVALID_CURSOR', 'The cursor is not an escalated conversation');
      }
      after = or(
        gt(disputes.escalated_at, cursor.at),
        and(eq(disputes.escalated_at, cursor.at), gt(disputes.id, cursor.id)),
      );
    }
    const rows = await this.db.transaction(async (tx) => {
      const found = await this.rows(tx, and(statusIn, after), query.limit + 1);
      return Promise.all(found.map((row) => this.view(tx, row)));
    });
    const shown = rows.slice(0, query.limit);
    return {
      disputes: shown,
      nextCursor: rows.length > query.limit ? (shown.at(-1)?.dispute_id ?? null) : null,
    };
  }

  /**
   * POST /api/admin/disputes/:id/resolve. Under the order row lock (as every other move of the
   * order's money): the order's held amount is released to the vendor, refunded (recorded in
   * REFUND_CLEARING, owed to the customer), or split; a refund the hold cannot cover is debited
   * from the vendor's wallet (all of it for a cash order: the vendor has the cash). The order
   * returns to DELIVERED; audited; `dispute.resolved` tells both parties. Exactly once.
   */
  async resolve(
    adminUserId: string,
    disputeId: string,
    request: ResolutionRequest,
    context: AuditContext,
  ): Promise<AdminDisputeView> {
    return this.db.transaction(async (tx) => {
      const [ref] = await tx
        .select({ orderId: disputes.order_id })
        .from(disputes)
        .where(eq(disputes.id, disputeId));
      if (ref === undefined) throw notFound(disputeId);
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, ref.orderId))
        .for('update');
      const [dispute] = await tx
        .select()
        .from(disputes)
        .where(eq(disputes.id, disputeId))
        .for('update');
      if (order === undefined || dispute === undefined) throw notFound(disputeId);
      if (RESOLVED.includes(dispute.status)) {
        throw new HttpError(409, 'ALREADY_RESOLVED', 'This conversation was already resolved');
      }
      if (dispute.status !== 'ESCALATED') {
        throw new HttpError(409, 'NOT_ESCALATED', 'Only an escalated conversation is resolved');
      }
      if (order.state !== 'DELIVERED' && order.state !== 'DISPUTED') {
        throw new HttpError(
          409,
          'ORDER_NOT_DELIVERED',
          `The order is ${order.state}: it is resolved once it was delivered`,
        );
      }

      const paid = orderTotalPaisa(order);
      const refundPaisa =
        request.outcome === 'RELEASE'
          ? 0
          : request.outcome === 'REFUND'
            ? paid
            : toPaisa(request.refund_npr ?? 0);
      if (request.outcome === 'PARTIAL_REFUND' && refundPaisa >= paid) {
        throw new HttpError(
          422,
          'REFUND_EXCEEDS_PAYMENT',
          `A partial refund is less than the ${String(toNpr(paid))} NPR the customer paid`,
          { paid_npr: toNpr(paid) },
        );
      }

      const money = await settleDisputeHold(tx, this.ledger, {
        orderId: order.id,
        vendorId: order.vendor_id,
        refundPaisa,
      });

      if (order.state === 'DISPUTED') {
        const [delivered] = await tx
          .update(orders)
          .set({ state: 'DELIVERED' })
          .where(eq(orders.id, order.id))
          .returning();
        if (delivered === undefined) throw notFound(disputeId);
        await enqueueOrderStateChanged(tx, order.state, delivered);
      }

      const resolvedAt = new Date();
      const [resolved] = await tx
        .update(disputes)
        .set({
          status: STATUS_OF[request.outcome],
          refund_npr: toNpr(refundPaisa),
          resolution_note: request.note,
          resolved_by_user_id: adminUserId,
          resolved_at: resolvedAt,
          hold_release_transaction_id: money.releaseTransactionId ?? money.refundTransactionId,
        })
        .where(eq(disputes.id, dispute.id))
        .returning();
      if (resolved === undefined) throw notFound(disputeId);

      await recordAuditLog(tx, {
        actor: { kind: 'USER', user_id: adminUserId, role: 'SUPER_ADMIN' },
        action: 'DISPUTE_RESOLVED',
        entityId: dispute.id,
        vendorId: order.vendor_id,
        beforeState: { status: dispute.status, order_state: order.state },
        afterState: {
          status: resolved.status,
          outcome: request.outcome,
          refund_npr: toNpr(refundPaisa),
          released_npr: toNpr(money.split.releasePaisa),
          refund_from_hold_npr: toNpr(money.split.refundFromHoldPaisa),
          refund_from_wallet_npr: toNpr(money.split.refundFromWalletPaisa),
          note: request.note,
        },
        context,
      });
      await enqueueDomainEvent(tx, {
        type: 'dispute.resolved',
        aggregateId: order.id,
        payload: {
          dispute_id: dispute.id,
          order_id: order.id,
          vendor_id: order.vendor_id,
          customer_id: order.customer_id,
          outcome: request.outcome,
          refund_npr: toNpr(refundPaisa),
          resolved_at: resolvedAt.toISOString(),
        },
      });

      const [row] = await this.rows(tx, eq(disputes.id, dispute.id), 1);
      if (row === undefined) throw notFound(disputeId);
      return this.view(tx, row);
    });
  }

  private rows(tx: Transaction, where: SQL | undefined, limit: number): Promise<ListRow[]> {
    return tx
      .select({
        dispute: disputes,
        order: orders,
        businessName: vendors.business_name,
        customerFirstName: customer.first_name,
        escalatorRole: escalator.role,
      })
      .from(disputes)
      .innerJoin(orders, eq(orders.id, disputes.order_id))
      .innerJoin(vendors, eq(vendors.id, orders.vendor_id))
      .innerJoin(customer, eq(customer.id, orders.customer_id))
      .leftJoin(escalator, eq(escalator.id, disputes.escalated_by_user_id))
      .where(where)
      .orderBy(asc(disputes.escalated_at), asc(disputes.id))
      .limit(limit);
  }

  private async view(tx: Transaction, row: ListRow): Promise<AdminDisputeView> {
    const { dispute, order } = row;
    const held = await heldForOrderPaisa(tx, order.id, order.vendor_id);
    return {
      dispute_id: dispute.id,
      order_id: order.id,
      order_state: order.state,
      payment_method: order.payment_method,
      status: dispute.status,
      vendor_id: order.vendor_id,
      business_name: row.businessName,
      customer_first_name: row.customerFirstName,
      order_total_npr: toNpr(orderTotalPaisa(order)),
      held_npr: toNpr(held),
      escalated_by:
        row.escalatorRole === 'CUSTOMER' || row.escalatorRole === 'VENDOR'
          ? row.escalatorRole
          : null,
      escalation_reason: dispute.escalation_reason,
      escalated_at: dispute.escalated_at?.toISOString() ?? null,
      delivered_at: order.delivered_at?.toISOString() ?? null,
      refund_npr: dispute.refund_npr,
      resolution_note: dispute.resolution_note,
      resolved_at: dispute.resolved_at?.toISOString() ?? null,
    };
  }
}

function notFound(disputeId: string): HttpError {
  return new HttpError(404, 'DISPUTE_NOT_FOUND', `Conversation ${disputeId} not found`);
}
