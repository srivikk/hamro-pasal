import { enqueueDomainEvent, orders, outboxEvents, vendors, type Database } from '@hamro-pasal/db';
import {
  VENDOR_ACCEPTANCE_TIMEOUT_MS,
  type VendorAcceptanceTimeoutJobInput,
} from '@hamro-pasal/shared-types';
import { and, eq } from 'drizzle-orm';

/** What the 90 s timer found when it fired. */
export type VendorEscalationOutcome =
  /** Still PLACED: `vendor.escalation.required` was written to the outbox. */
  | 'ESCALATED'
  /** Still PLACED, but an earlier run (a retried job) already escalated it. */
  | 'ALREADY_ESCALATED'
  /** The vendor accepted or rejected in time, or the customer canceled: nothing to do. */
  | 'NOT_PENDING';

/**
 * The business action of the `vendor-acceptance-timeout` job (vendor flow step 6: "If 90s elapse
 * with no app interaction, backend triggers an automated IVR/SMS alert").
 *
 * In one transaction, holding the order row `FOR UPDATE` (the same lock the vendor's accept and
 * reject take, so a decision landing at 89.9 s and the timer never both win):
 *   - an order that has left PLACED is not escalated;
 *   - otherwise `vendor.escalation.required` is written to the outbox (topic
 *     `notifications.broadcast`), unless this order already has one: BullMQ may run a job again
 *     after a crash, and the vendor must not be called twice for one order (the partial unique
 *     index `outbox_events_vendor_escalation_uidx` backs this up in the database).
 * The IVR/SMS consumer of that event is a later phase.
 */
export class VendorEscalationService {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  escalateIfUnanswered(job: VendorAcceptanceTimeoutJobInput): Promise<VendorEscalationOutcome> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ order: orders, vendorPhone: vendors.phone })
        .from(orders)
        .innerJoin(vendors, eq(vendors.id, orders.vendor_id))
        .where(eq(orders.id, job.order_id))
        .for('update', { of: orders });
      if (row?.order.state !== 'PLACED') return 'NOT_PENDING';
      const { order, vendorPhone } = row;
      if (order.placed_at === null) {
        throw new Error(`Order ${order.id} is PLACED without placed_at`);
      }

      const [earlier] = await tx
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.aggregate_id, order.id),
            eq(outboxEvents.event_type, 'vendor.escalation.required'),
          ),
        )
        .limit(1);
      if (earlier !== undefined) return 'ALREADY_ESCALATED';

      const escalatedAt = this.now();
      await enqueueDomainEvent(tx, {
        type: 'vendor.escalation.required',
        aggregateId: order.id,
        occurredAt: escalatedAt,
        payload: {
          order_id: order.id,
          vendor_id: order.vendor_id,
          vendor_phone: vendorPhone,
          placed_at: order.placed_at.toISOString(),
          sla_seconds: VENDOR_ACCEPTANCE_TIMEOUT_MS / 1000,
          escalated_at: escalatedAt.toISOString(),
        },
      });
      return 'ESCALATED';
    });
  }
}
