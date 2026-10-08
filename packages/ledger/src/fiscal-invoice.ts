import {
  invoiceSequences,
  invoices,
  orderItems,
  users,
  vendors,
  type Transaction,
} from '@hamro-pasal/db';
import { computeInvoiceAmounts, type InvoiceLineItem, type Order } from '@hamro-pasal/shared-types';
import { and, asc, eq, sql } from 'drizzle-orm';

import { bsDateOf, fiscalYearOf, type BsDate } from './bs-calendar';
import { toNpr, toPaisa } from './money';
import { orderDiscountPaisa, orderTotalPaisa } from './settlement-plan';

export type InvoiceRow = typeof invoices.$inferSelect;

/** The platform's prefix on a printed invoice number. */
export const INVOICE_SEQUENCE_PREFIX = 'HP';
/** The buyer on an invoice whose customer has given no name. */
export const UNNAMED_BUYER = 'Customer';

/** An invoice is issued for a delivered order only (SPEC core 10). */
export class InvoiceNotIssuableError extends Error {
  constructor(
    readonly orderId: string,
    reason: string,
  ) {
    super(`No invoice can be issued for order ${orderId}: ${reason}`);
    this.name = 'InvoiceNotIssuableError';
  }
}

/** The number as printed: "HP-2082-000142" for bill 142 of fiscal year 2082/083. */
export function invoiceSequenceOf(fiscalYear: string, billNumber: number): string {
  const startYear = fiscalYear.slice(0, 4);
  return `${INVOICE_SEQUENCE_PREFIX}-${startYear}-${String(billNumber).padStart(6, '0')}`;
}

/** "2082-06-21". */
export function formatBsDate({ year, month, day }: BsDate): string {
  return `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export type FiscalInvoiceResult =
  | {
      readonly status: 'ISSUED' | 'REPLAYED';
      readonly invoice: InvoiceRow;
      /** true when the order already had its invoice: nothing was written, no number taken. */
      readonly replayed: boolean;
    }
  /**
   * The seller has no PAN on file (a shop swept for compliance still delivers its open orders,
   * SPEC core 10): no invoice can name it, so none is issued and no number is taken.
   */
  | { readonly status: 'SELLER_HAS_NO_PAN'; readonly invoice: null; readonly replayed: false };

/**
 * Issues the fiscal invoice of a delivered order (SPEC core 10), inside the caller's transaction:
 * the one that delivers the order, so a delivered order has exactly one invoice and a delivery
 * that rolls back consumes no number.
 *
 * - **The Bill Number** is gap-free per seller and Nepal fiscal year. It comes from the seller's
 *   `invoice_sequences` row, locked `FOR UPDATE` here and raised by one; two orders of one shop
 *   delivered at the same moment queue on that row and get consecutive numbers. The fiscal year is
 *   decided by the issue time in Nepal Time, so the first invoice after 1 Shrawan is number 1.
 * - **The seller and the lines are copies** taken now: the shop's name, address, phone, PAN and
 *   VAT registration, and each `order_items` line as it was sold.
 * - **VAT** (catalogue prices are VAT inclusive): for a VAT-registered seller each line, after its
 *   share of the discount, is split into taxable amount and 13% VAT; the header is the sum of the
 *   lines. A seller that is not VAT registered issues a PAN invoice with no VAT. The discount
 *   lowers the taxable amount (decided 2026-10-07), the platform-funded share included.
 * - **The Grand Total must equal what the customer paid** (the order total), to the paisa. A
 *   mismatch throws, which aborts the delivery: it is a bug, never a rounding allowance.
 *
 * Locks: a delivery holds the order row, and by then usually the vendor row, the ledger accounts
 * and the ad purchase row (settlement, ad premium). This takes the vendor row `FOR SHARE` (never
 * stronger than what a wallet journal already holds), then the sequence row **last**, and nothing
 * after it: a transaction holding a sequence row never waits for another lock. The PAN save, which
 * issues a shop's waiting invoices, follows the same order: vendor row, then sequence rows; it
 * locks no order row.
 *
 * `issuedAt` defaults to the database clock; tests pass it to cross a fiscal year.
 */
export async function generateFiscalInvoice(
  tx: Transaction,
  order: Order,
  issuedAt?: Date,
): Promise<FiscalInvoiceResult> {
  if (order.state !== 'DELIVERED') {
    throw new InvoiceNotIssuableError(order.id, `it is ${order.state}, not DELIVERED`);
  }

  const [seller] = await tx
    .select({
      business_name: vendors.business_name,
      legal_name: vendors.legal_name,
      registered_address: vendors.registered_address,
      municipality: vendors.municipality_palika_string,
      phone: vendors.phone,
      tax_id: vendors.tax_id,
      is_vat_registered: vendors.is_vat_registered,
    })
    .from(vendors)
    .where(eq(vendors.id, order.vendor_id))
    // Read under a share lock: a PAN being saved at this moment (which holds the row FOR UPDATE
    // and issues the shop's waiting invoices) is either seen here, or sees this delivery. Without
    // it, a delivery that posts no wallet journal could read "no PAN" while the save, not yet
    // seeing the delivery, skips it: an order with no invoice from either side.
    .for('share');
  if (seller === undefined) throw new InvoiceNotIssuableError(order.id, 'its vendor is gone');
  if (seller.tax_id === null)
    return { status: 'SELLER_HAS_NO_PAN', invoice: null, replayed: false };

  const at = issuedAt ?? (await databaseClock(tx));
  const fiscalYear = fiscalYearOf(at);
  const sequenceKey = and(
    eq(invoiceSequences.vendor_id, order.vendor_id),
    eq(invoiceSequences.fiscal_year, fiscalYear),
    eq(invoiceSequences.document_type, 'INVOICE'),
  );

  // The first invoice of a seller's fiscal year opens its counter at 0. Two such transactions
  // meet on the primary key: the second waits, then finds the row.
  await tx
    .insert(invoiceSequences)
    .values({ vendor_id: order.vendor_id, fiscal_year: fiscalYear, document_type: 'INVOICE' })
    .onConflictDoNothing();
  const [sequence] = await tx.select().from(invoiceSequences).where(sequenceKey).for('update');
  if (sequence === undefined) throw new Error(`Invoice sequence of ${order.vendor_id} vanished`);

  // Under the lock: an order invoiced meanwhile (a retried delivery) takes no second number.
  const [existing] = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.order_id, order.id), eq(invoices.document_type, 'INVOICE')));
  if (existing !== undefined) return { status: 'REPLAYED', invoice: existing, replayed: true };

  // Everything that can fail is computed before the number is taken.
  const items = await tx
    .select()
    .from(orderItems)
    .where(eq(orderItems.order_id, order.id))
    .orderBy(asc(orderItems.created_at), asc(orderItems.id));
  if (items.length === 0) throw new InvoiceNotIssuableError(order.id, 'it has no items');
  const [buyer] = await tx
    .select({ first_name: users.first_name, last_name: users.last_name })
    .from(users)
    .where(eq(users.id, order.customer_id));
  const buyerName = [buyer?.first_name, buyer?.last_name]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(' ');

  // The shop's own delivery is its sale (a taxed line); a fleet delivery is the platform's.
  const deliveryChargedBy = order.fulfillment_locked === 'SELF_DELIVERY' ? 'VENDOR' : 'PLATFORM';
  // Every discount lowers the taxable amount (decided 2026-10-07): the vendor's own offer and the
  // whole campaign discount.
  const discountNpr = toNpr(orderDiscountPaisa(order));
  const amounts = computeInvoiceAmounts({
    seller_is_vat_registered: seller.is_vat_registered,
    items: items.map((item) => ({
      product_name: item.product_name,
      hs_code: null,
      quantity: item.quantity,
      unit_price_npr: item.unit_price_npr,
    })),
    discount_npr: discountNpr,
    delivery_charge_npr: order.delivery_fee,
    delivery_charged_by: deliveryChargedBy,
  });
  if (
    toPaisa(amounts.subtotal_npr) !== toPaisa(order.subtotal) ||
    toPaisa(amounts.grand_total_npr) !== orderTotalPaisa(order)
  ) {
    throw new InvoiceNotIssuableError(
      order.id,
      `its lines give ${String(amounts.grand_total_npr)} NPR, the customer paid ${String(toNpr(orderTotalPaisa(order)))} NPR`,
    );
  }
  // Item lines come first, in the items' order; a DELIVERY line (no product) follows them.
  const lineItems: InvoiceLineItem[] = amounts.lines.map((line, index) => ({
    ...line,
    product_id: line.line_type === 'ITEM' ? (items[index]?.product_id ?? null) : null,
  }));

  const [counted] = await tx
    .update(invoiceSequences)
    .set({ last_number: sql`${invoiceSequences.last_number} + 1` })
    .where(sequenceKey)
    .returning({ billNumber: invoiceSequences.last_number });
  if (counted === undefined) throw new Error(`Invoice sequence of ${order.vendor_id} vanished`);

  const [invoice] = await tx
    .insert(invoices)
    .values({
      document_type: 'INVOICE',
      vendor_id: order.vendor_id,
      order_id: order.id,
      customer_id: order.customer_id,
      fiscal_year: fiscalYear,
      bill_number: counted.billNumber,
      invoice_sequence: invoiceSequenceOf(fiscalYear, counted.billNumber),
      issued_at: at,
      issued_date_bs: formatBsDate(bsDateOf(at)),
      subtotal_npr: amounts.subtotal_npr,
      discount_npr: discountNpr,
      delivery_charge_npr: order.delivery_fee,
      grand_total_npr: amounts.grand_total_npr,
      seller_name: seller.legal_name ?? seller.business_name,
      seller_address: seller.registered_address ?? seller.municipality,
      seller_phone: seller.phone,
      seller_tax_id: seller.tax_id,
      seller_is_vat_registered: seller.is_vat_registered,
      buyer_name: buyerName === '' ? UNNAMED_BUYER : buyerName,
      payment_method: order.payment_method,
      taxable_amount_npr: amounts.taxable_amount_npr,
      vat_rate_percent: amounts.vat_rate_percent,
      vat_amount_npr: amounts.vat_amount_npr,
      exempt_amount_npr: amounts.exempt_amount_npr,
      delivery_charged_by: deliveryChargedBy,
      amount_in_words: amounts.amount_in_words,
      line_items: lineItems,
    })
    .returning();
  if (invoice === undefined) throw new Error(`The invoice of order ${order.id} was not stored`);
  return { status: 'ISSUED', invoice, replayed: false };
}

async function databaseClock(tx: Transaction): Promise<Date> {
  const result = await tx.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`);
  const now = result.rows[0]?.now;
  if (now === undefined) throw new Error('The database clock did not answer');
  return new Date(now);
}
