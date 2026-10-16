import type { Executor } from '@hamro-pasal/db';
import type { ExportKind, ExportParams, UserRole } from '@hamro-pasal/shared-types';
import { sql, type SQL } from 'drizzle-orm';

import type { CsvValue } from './csv';
import { bsDate, nepalDateTime, nepalDayRange } from './time';

/** Rows read from the database per page: an export never holds a whole table in memory. */
export const EXPORT_PAGE_SIZE = 1000;

/** Who asked, which decides the scope: a vendor's export is always its own shop's. */
export interface ExportScope {
  readonly role: Extract<UserRole, 'VENDOR' | 'SUPER_ADMIN'>;
  /** The vendor's own shop (VENDOR), or an admin's optional filter. */
  readonly vendorId?: string | undefined;
}

type Row = Record<string, unknown>;

interface Dataset {
  readonly header: readonly string[];
  /** FROM … (joins), with the row's sort key `ts` and unique `id` among the selected columns. */
  readonly from: SQL;
  readonly where: SQL;
  readonly ts: SQL;
  readonly id: SQL;
  readonly select: SQL;
  readonly toCells: (row: Row) => CsvValue[];
}

export class ExportScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportScopeError';
  }
}

const date = (value: unknown): Date | null =>
  value === null || value === undefined ? null : new Date(value as string | Date);
const text = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : JSON.stringify(value);
};
const num = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

/** The rows of one export kind for one requester. Throws when the scope does not allow it. */
function datasetOf(kind: ExportKind, params: ExportParams, scope: ExportScope): Dataset {
  const { start, end } = nepalDayRange(params.from, params.to);
  const vendorOnly = scope.role === 'VENDOR';
  if (vendorOnly && scope.vendorId === undefined) {
    throw new ExportScopeError('A vendor export needs the vendor’s shop');
  }
  const adminOnly = (allowed: boolean) => {
    if (!allowed) throw new ExportScopeError(`${kind} is not exported for ${scope.role}`);
  };
  const vendorFilter = (column: SQL): SQL =>
    scope.vendorId === undefined ? sql`true` : sql`${column} = ${scope.vendorId}`;
  const inRange = (column: SQL): SQL => sql`${column} >= ${start} AND ${column} < ${end}`;

  switch (kind) {
    case 'STATEMENT': {
      adminOnly(vendorOnly);
      return {
        header: [
          'date_npt',
          'date_bs',
          'account',
          'transaction',
          'line',
          'order_id',
          'amount_npr',
          'description',
        ],
        from: sql`ledger_entries e
          JOIN ledger_accounts a ON a.id = e.account_id
          JOIN ledger_transactions t ON t.id = e.transaction_id`,
        where: sql`(a.vendor_id = ${scope.vendorId} OR a.hold_vendor_id = ${scope.vendorId})
          AND ${inRange(sql`e.created_at`)}`,
        ts: sql`e.created_at`,
        id: sql`e.id`,
        select: sql`CASE WHEN a.hold_vendor_id IS NOT NULL THEN 'DISPUTE_HOLD' ELSE 'WALLET' END AS account,
          t.kind::text AS kind, e.line_type::text AS line, t.order_id, e.amount_npr, t.description`,
        toCells: (r) => [
          nepalDateTime(date(r.__ts)),
          bsDate(date(r.__ts)),
          text(r.account),
          text(r.kind),
          text(r.line),
          text(r.order_id),
          num(r.amount_npr),
          text(r.description),
        ],
      };
    }
    case 'ORDERS': {
      // A vendor sees its own orders and never the customer's identity.
      return {
        header: [
          'order_id',
          ...(vendorOnly ? [] : ['vendor_code', 'business_name', 'customer_id']),
          'created_npt',
          'placed_npt',
          'delivered_npt',
          'state',
          'payment_method',
          'payment_status',
          'fulfillment',
          'subtotal_npr',
          'vendor_offer_discount_npr',
          'platform_discount_npr',
          'delivery_fee_npr',
          'commission_npr',
          'total_npr',
        ],
        from: sql`orders o JOIN vendors v ON v.id = o.vendor_id`,
        where: sql`${vendorFilter(sql`o.vendor_id`)} AND ${inRange(sql`o.created_at`)}`,
        ts: sql`o.created_at`,
        id: sql`o.id`,
        select: sql`o.id AS order_id, v.vendor_code, v.business_name, o.customer_id,
          o.placed_at, o.delivered_at, o.state::text AS state,
          o.payment_method::text AS payment_method, o.payment_status::text AS payment_status,
          o.fulfillment_locked::text AS fulfillment, o.subtotal, o.vendor_offer_discount_npr,
          o.platform_promo_discount_npr, o.delivery_fee, o.platform_commission_amount,
          o.subtotal - o.vendor_offer_discount_npr - o.platform_promo_discount_npr + o.delivery_fee AS total`,
        toCells: (r) => [
          text(r.order_id),
          ...(vendorOnly ? [] : [text(r.vendor_code), text(r.business_name), text(r.customer_id)]),
          nepalDateTime(date(r.__ts)),
          nepalDateTime(date(r.placed_at)),
          nepalDateTime(date(r.delivered_at)),
          text(r.state),
          text(r.payment_method),
          text(r.payment_status),
          text(r.fulfillment),
          num(r.subtotal),
          num(r.vendor_offer_discount_npr),
          num(r.platform_promo_discount_npr),
          num(r.delivery_fee),
          num(r.platform_commission_amount),
          num(r.total),
        ],
      };
    }
    case 'INVOICES': {
      adminOnly(vendorOnly);
      return {
        header: [
          'document_type',
          'invoice_number',
          'fiscal_year',
          'issued_npt',
          'issued_bs',
          'order_id',
          'buyer_name',
          'subtotal_npr',
          'discount_npr',
          'delivery_charge_npr',
          'taxable_npr',
          'vat_npr',
          'exempt_npr',
          'grand_total_npr',
        ],
        from: sql`invoices i`,
        where: sql`i.vendor_id = ${scope.vendorId} AND ${inRange(sql`i.issued_at`)}`,
        ts: sql`i.issued_at`,
        id: sql`i.id`,
        select: sql`i.document_type::text AS document_type, i.invoice_sequence, i.fiscal_year,
          i.issued_date_bs, i.order_id, i.buyer_name, i.subtotal_npr, i.discount_npr,
          i.delivery_charge_npr, i.taxable_amount_npr, i.vat_amount_npr, i.exempt_amount_npr,
          i.grand_total_npr`,
        toCells: (r) => [
          text(r.document_type),
          text(r.invoice_sequence),
          text(r.fiscal_year),
          nepalDateTime(date(r.__ts)),
          text(r.issued_date_bs),
          text(r.order_id),
          text(r.buyer_name),
          num(r.subtotal_npr),
          num(r.discount_npr),
          num(r.delivery_charge_npr),
          num(r.taxable_amount_npr),
          num(r.vat_amount_npr),
          num(r.exempt_amount_npr),
          num(r.grand_total_npr),
        ],
      };
    }
    case 'VENDORS': {
      adminOnly(!vendorOnly);
      return {
        header: [
          'vendor_code',
          'business_name',
          'status',
          'phone',
          'palika',
          'delivery_scope',
          'fulfillment_mode',
          'pricing_model',
          'settlement_model',
          'wallet_balance_npr',
          'pan',
          'created_npt',
        ],
        from: sql`vendors v`,
        where: inRange(sql`v.created_at`),
        ts: sql`v.created_at`,
        id: sql`v.id`,
        select: sql`v.vendor_code, v.business_name, v.status::text AS status, v.phone,
          v.municipality_palika_string, v.delivery_scope::text AS delivery_scope,
          v.fulfillment_mode::text AS fulfillment_mode, v.pricing_model::text AS pricing_model,
          v.settlement_model::text AS settlement_model, v.wallet_balance_npr, v.tax_id`,
        toCells: (r) => [
          text(r.vendor_code),
          text(r.business_name),
          text(r.status),
          text(r.phone),
          text(r.municipality_palika_string),
          text(r.delivery_scope),
          text(r.fulfillment_mode),
          text(r.pricing_model),
          text(r.settlement_model),
          num(r.wallet_balance_npr),
          text(r.tax_id),
          nepalDateTime(date(r.__ts)),
        ],
      };
    }
    case 'CUSTOMERS': {
      // Customer personal data: a Super Admin only (SPEC core 11).
      adminOnly(!vendorOnly);
      return {
        header: [
          'user_id',
          'phone',
          'first_name',
          'last_name',
          'email',
          'language',
          'account_status',
          'created_npt',
        ],
        from: sql`users u`,
        where: sql`u.role = 'CUSTOMER' AND ${inRange(sql`u.created_at`)}`,
        ts: sql`u.created_at`,
        id: sql`u.id`,
        select: sql`u.phone, u.first_name, u.last_name, u.email,
          u.language_preference::text AS language, u.account_status::text AS account_status`,
        toCells: (r) => [
          text(r.__id),
          text(r.phone),
          text(r.first_name),
          text(r.last_name),
          text(r.email),
          text(r.language),
          text(r.account_status),
          nepalDateTime(date(r.__ts)),
        ],
      };
    }
    case 'PAYOUTS': {
      adminOnly(!vendorOnly);
      return {
        header: [
          'payout_id',
          'vendor_code',
          'business_name',
          'amount_npr',
          'status',
          'bank_reference',
          'requested_npt',
          'decided_npt',
        ],
        from: sql`payout_requests p JOIN vendors v ON v.id = p.vendor_id`,
        where: sql`${vendorFilter(sql`p.vendor_id`)} AND ${inRange(sql`p.created_at`)}`,
        ts: sql`p.created_at`,
        id: sql`p.id`,
        select: sql`v.vendor_code, v.business_name, p.amount_npr, p.status::text AS status,
          p.bank_reference, p.decided_at`,
        toCells: (r) => [
          text(r.__id),
          text(r.vendor_code),
          text(r.business_name),
          num(r.amount_npr),
          text(r.status),
          text(r.bank_reference),
          nepalDateTime(date(r.__ts)),
          nepalDateTime(date(r.decided_at)),
        ],
      };
    }
    case 'AUDIT_LOG': {
      adminOnly(!vendorOnly);
      return {
        header: [
          'occurred_npt',
          'action',
          'entity_type',
          'entity_id',
          'actor_role',
          'actor_user_id',
          'system_actor',
          'vendor_id',
          'before_state',
          'after_state',
        ],
        from: sql`audit_logs l`,
        where: sql`${vendorFilter(sql`l.vendor_id`)} AND ${inRange(sql`l.occurred_at`)}`,
        ts: sql`l.occurred_at`,
        id: sql`l.id`,
        select: sql`l.action, l.entity_type, l.entity_id, l.actor_role::text AS actor_role,
          l.actor_user_id, l.system_actor, l.vendor_id, l.before_state::text AS before_state,
          l.after_state::text AS after_state`,
        toCells: (r) => [
          nepalDateTime(date(r.__ts)),
          text(r.action),
          text(r.entity_type),
          text(r.entity_id),
          text(r.actor_role),
          text(r.actor_user_id),
          text(r.system_actor),
          text(r.vendor_id),
          text(r.before_state),
          text(r.after_state),
        ],
      };
    }
  }
}

/** The column names of an export, its first CSV line. */
export function exportHeader(kind: ExportKind, params: ExportParams, scope: ExportScope): string[] {
  return [...datasetOf(kind, params, scope).header];
}

/** How many rows the export has: the API decides from this whether to send it at once. */
export async function countExportRows(
  db: Executor,
  kind: ExportKind,
  params: ExportParams,
  scope: ExportScope,
): Promise<number> {
  const set = datasetOf(kind, params, scope);
  const { rows } = await db.execute<{ count: string }>(
    sql`SELECT count(*) AS count FROM ${set.from} WHERE ${set.where}`,
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * The export's rows as CSV cells, a page at a time in (time, id) order, so a large export is
 * read with a cursor and never held whole. Stops after `maxRows` when given.
 */
export async function* exportRows(
  db: Executor,
  kind: ExportKind,
  params: ExportParams,
  scope: ExportScope,
  options: { readonly pageSize?: number; readonly maxRows?: number } = {},
): AsyncGenerator<CsvValue[]> {
  const set = datasetOf(kind, params, scope);
  const pageSize = options.pageSize ?? EXPORT_PAGE_SIZE;
  let after: { ts: unknown; id: unknown } | null = null;
  let emitted = 0;
  for (;;) {
    const cursor: SQL =
      after === null
        ? sql`true`
        : sql`(${set.ts}, ${set.id}) > (${after.ts}::timestamptz, ${after.id}::uuid)`;
    const { rows } = await db.execute<Row>(
      // __cursor keeps the time to the microsecond (a JS Date would cut it to milliseconds).
      sql`SELECT ${set.ts} AS __ts, ${set.ts}::text AS __cursor, ${set.id} AS __id, ${set.select}
            FROM ${set.from}
           WHERE ${set.where} AND ${cursor}
           ORDER BY ${set.ts}, ${set.id}
           LIMIT ${pageSize}`,
    );
    for (const row of rows) {
      if (options.maxRows !== undefined && emitted >= options.maxRows) return;
      emitted += 1;
      yield set.toCells(row);
    }
    const last = rows.at(-1);
    if (last === undefined || rows.length < pageSize) return;
    after = { ts: last.__cursor, id: last.__id };
  }
}
