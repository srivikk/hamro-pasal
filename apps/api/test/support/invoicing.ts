import { inflateSync } from 'node:zlib';

import { invoices, orderItems, orders, vendors, type Database } from '@hamro-pasal/db';
import { generateFiscalInvoice, type InvoiceRow } from '@hamro-pasal/ledger';
import type { Order, OrderState } from '@hamro-pasal/shared-types';
import { asc, eq } from 'drizzle-orm';

import { createOrder, createProduct, createUser } from './fixtures';

export interface SoldOrder {
  /** Line prices; each is sold once. Their sum is the order's subtotal. */
  prices?: readonly number[];
  deliveryFee?: number;
  /** Null leaves the order undelivered in `state`. */
  deliveredAt?: Date | null;
  state?: OrderState;
  /** False: an order whose lines do not add up to its subtotal (no invoice can be issued). */
  withItems?: boolean;
}

/** An order of the shop with its item lines, DELIVERED unless told otherwise. */
export async function soldOrder(
  db: Database,
  vendorId: string,
  options: SoldOrder = {},
): Promise<Order> {
  const prices = options.prices ?? [500, 500];
  const created = await createOrder(db, {
    vendorId,
    customerId: await createUser(db),
    subtotal: prices.reduce((sum, price) => sum + Math.round(price * 100), 0) / 100,
    deliveryFee: options.deliveryFee ?? 50,
    commission: 0,
  });
  if (options.withItems !== false) {
    for (const [index, price] of prices.entries()) {
      await db.insert(orderItems).values({
        order_id: created.id,
        product_id: await createProduct(db, vendorId, 10, price),
        product_name: `Item ${String(index + 1)}`,
        unit_price_npr: price,
        quantity: 1,
        created_at: new Date(Date.now() + index),
      });
    }
  }
  const delivered = options.deliveredAt === undefined ? new Date() : options.deliveredAt;
  const state = options.state ?? (delivered === null ? 'PLACED' : 'DELIVERED');
  const [row] = await db
    .update(orders)
    .set({ state, placed_at: new Date(), delivered_at: delivered })
    .where(eq(orders.id, created.id))
    .returning();
  if (row === undefined) throw new Error('order vanished');
  return row;
}

export async function setPan(db: Database, vendorId: string, pan: string | null = '302118845') {
  await db.update(vendors).set({ tax_id: pan }).where(eq(vendors.id, vendorId));
}

/** As a delivery would: the order row locked, then its invoice, in one transaction. */
export async function issueInvoice(db: Database, order: Order, at?: Date): Promise<InvoiceRow> {
  const result = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(orders).where(eq(orders.id, order.id)).for('update');
    if (locked === undefined) throw new Error('order vanished');
    return generateFiscalInvoice(tx, locked, at);
  });
  if (result.invoice === null) throw new Error('no invoice was issued');
  return result.invoice;
}

export function invoicesOf(db: Database, vendorId: string): Promise<InvoiceRow[]> {
  return db
    .select()
    .from(invoices)
    .where(eq(invoices.vendor_id, vendorId))
    .orderBy(asc(invoices.fiscal_year), asc(invoices.bill_number));
}

/**
 * The text a PDF draws, one entry per text run, in drawing order. Page streams are inflated when
 * the file was written compressed (as the API serves it).
 */
export function pdfTextRuns(pdf: Buffer): string[] {
  const raw = pdf.toString('latin1');
  let content = '';
  for (const stream of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    const bytes = Buffer.from(stream[1] ?? '', 'latin1');
    try {
      content += inflateSync(bytes).toString('latin1');
    } catch {
      content += bytes.toString('latin1');
    }
  }
  const runs: string[] = [];
  for (const run of content.matchAll(/\[((?:<[0-9a-f]*>|[-0-9. ]+)+)\] TJ/g)) {
    runs.push(
      [...(run[1] ?? '').matchAll(/<([0-9a-f]*)>/g)]
        .map((piece) => Buffer.from(piece[1] ?? '', 'hex').toString('latin1'))
        .join(''),
    );
  }
  return runs;
}
