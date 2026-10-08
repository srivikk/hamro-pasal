import type {
  InvoiceAccessAction,
  InvoiceDeliveryChargedBy,
  InvoiceLineItem,
} from '@hamro-pasal/shared-types';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { npr, primaryId } from './columns';
import { fiscalDocumentTypeEnum, paymentMethodEnum, userRoleEnum } from './enums';
import { orders } from './orders';
import { users } from './users';
import { vendors } from './vendors';

const FISCAL_YEAR_PATTERN = sql.raw(`'^[0-9]{4}/[0-9]{3}$'`);

/**
 * The gap-free Bill Number counter (SPEC core 10): one row per seller, Nepal fiscal year and
 * document type. The issuing transaction locks its row `FOR UPDATE` and raises `last_number` by
 * one; a rollback returns the number. Never a database SEQUENCE, which leaves gaps on rollback.
 * A trigger (migration 0029) allows nothing but that `+ 1`.
 */
export const invoiceSequences = pgTable(
  'invoice_sequences',
  {
    vendor_id: uuid()
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    /** "2082/083": the year starts on 1 Shrawan. */
    fiscal_year: text().notNull(),
    document_type: fiscalDocumentTypeEnum().notNull(),
    last_number: integer().notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.vendor_id, t.fiscal_year, t.document_type] }),
    check('invoice_sequences_fiscal_year_check', sql`${t.fiscal_year} ~ ${FISCAL_YEAR_PATTERN}`),
    check('invoice_sequences_last_number_check', sql`${t.last_number} >= 0`),
  ],
);

/**
 * A fiscal invoice (SPEC core 10): issued by the platform on the seller's behalf, sealed once
 * written. The database refuses UPDATE, DELETE and TRUNCATE (migration 0029).
 *
 * The row is the whole document (migration 0031): the seller's identity and PAN as they were at
 * issue, the buyer, the payment method, the itemised lines (`line_items`, a copy of names,
 * quantities and prices at the time of sale, each with its VAT split) and the totals. Catalogue
 * prices are VAT inclusive: `grand_total = taxable + VAT + exempt (+ a delivery charge the
 * platform collected)`, and equals what the customer paid.
 */
export const invoices = pgTable(
  'invoices',
  {
    id: primaryId(),
    document_type: fiscalDocumentTypeEnum().notNull().default('INVOICE'),
    vendor_id: uuid()
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    order_id: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    customer_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    fiscal_year: text().notNull(),
    /** The gap-free number within the seller, fiscal year and document type; starts at 1. */
    bill_number: integer().notNull(),
    /** The number as printed: "HP-2082-000142" (the fiscal year's first year, six digits). */
    invoice_sequence: text().notNull(),
    issued_at: timestamp({ withTimezone: true, mode: 'date' }).notNull(),
    /** The issue date in Bikram Sambat, Nepal Time: "2082-06-21". Stored, never re-derived. */
    issued_date_bs: text().notNull(),
    subtotal_npr: npr().notNull(),
    discount_npr: npr().notNull().default(0),
    delivery_charge_npr: npr().notNull().default(0),
    /** Must equal, to the paisa, what the customer paid for the order. */
    grand_total_npr: npr().notNull(),
    // The seller as it was at issue (SPEC core 10, "Header"). Copies, never re-read.
    seller_name: text().notNull(),
    seller_address: text().notNull(),
    seller_phone: text().notNull(),
    /** The seller's 9-digit PAN; a VAT-registered seller's VAT number is its PAN. */
    seller_tax_id: text().notNull(),
    seller_is_vat_registered: boolean().notNull(),
    buyer_name: text().notNull(),
    payment_method: paymentMethodEnum().notNull(),
    /** The sum of the taxed lines' taxable amounts; 0 for a seller that is not VAT registered. */
    taxable_amount_npr: npr().notNull(),
    /** 13, or 0 for a seller that is not VAT registered. */
    vat_rate_percent: npr().notNull(),
    vat_amount_npr: npr().notNull(),
    /** Sales carrying no VAT: everything a seller that is not VAT registered sells. */
    exempt_amount_npr: npr().notNull(),
    /** VENDOR: its own delivery, a taxed line. PLATFORM: fleet delivery, outside its sales. */
    delivery_charged_by: text().$type<InvoiceDeliveryChargedBy>().notNull(),
    /** "Rupees One Thousand One Hundred Eighty Only". */
    amount_in_words: text().notNull(),
    /** The lines as sold: `invoiceLineItemSchema[]` (shared-types). */
    line_items: jsonb().$type<InvoiceLineItem[]>().notNull(),
  },
  (t) => [
    unique('invoices_bill_number_key').on(
      t.vendor_id,
      t.document_type,
      t.fiscal_year,
      t.bill_number,
    ),
    // A delivered order has exactly one invoice (notes, later, are further documents of it).
    uniqueIndex('invoices_order_invoice_uidx')
      .on(t.order_id)
      .where(sql`${t.document_type} = 'INVOICE'`),
    index('invoices_order_id_idx').on(t.order_id),
    index('invoices_customer_id_idx').on(t.customer_id),
    index('invoices_vendor_list_idx').on(t.vendor_id, t.fiscal_year, t.issued_at, t.id),
    check('invoices_fiscal_year_check', sql`${t.fiscal_year} ~ ${FISCAL_YEAR_PATTERN}`),
    check('invoices_bill_number_check', sql`${t.bill_number} >= 1`),
    check('invoices_invoice_sequence_check', sql`btrim(${t.invoice_sequence}) <> ''`),
    check(
      'invoices_issued_date_bs_check',
      sql`${t.issued_date_bs} ~ ${sql.raw(`'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`)}`,
    ),
    check(
      'invoices_amounts_check',
      sql`${t.subtotal_npr} >= 0 AND ${t.discount_npr} >= 0 AND ${t.delivery_charge_npr} >= 0
            AND ${t.discount_npr} <= ${t.subtotal_npr}`,
    ),
    check('invoices_seller_tax_id_check', sql`${t.seller_tax_id} ~ ${sql.raw(`'^[0-9]{9}$'`)}`),
    check(
      'invoices_header_text_check',
      sql`btrim(${t.seller_name}) <> '' AND btrim(${t.seller_address}) <> ''
            AND btrim(${t.seller_phone}) <> '' AND btrim(${t.buyer_name}) <> ''
            AND btrim(${t.amount_in_words}) <> ''`,
    ),
    check(
      'invoices_delivery_charged_by_check',
      sql`${t.delivery_charged_by} IN ('VENDOR', 'PLATFORM')`,
    ),
    check(
      'invoices_line_items_check',
      sql`jsonb_typeof(${t.line_items}) = 'array' AND jsonb_array_length(${t.line_items}) >= 1`,
    ),
    check(
      'invoices_vat_amounts_check',
      sql`${t.taxable_amount_npr} >= 0 AND ${t.vat_amount_npr} >= 0 AND ${t.exempt_amount_npr} >= 0
            AND ${t.vat_rate_percent} IN (0, 13)
            AND (${t.seller_is_vat_registered}
              OR (${t.vat_amount_npr} = 0 AND ${t.taxable_amount_npr} = 0 AND ${t.vat_rate_percent} = 0))`,
    ),
    // The VAT split never changes what the customer paid.
    check(
      'invoices_vat_split_total_check',
      sql`${t.grand_total_npr} = ${t.taxable_amount_npr} + ${t.vat_amount_npr} + ${t.exempt_amount_npr}
            + CASE WHEN ${t.delivery_charged_by} = 'PLATFORM' THEN ${t.delivery_charge_npr} ELSE 0 END`,
    ),
    check(
      'invoices_grand_total_check',
      sql`${t.grand_total_npr} = ${t.subtotal_npr} - ${t.discount_npr} + ${t.delivery_charge_npr}`,
    ),
  ],
);

/**
 * Phase 32: every view, download and print of an invoice (SPEC core 10, "View and print
 * tracking"), with the user and the time. Append-only: the triggers of migration 0033 refuse
 * UPDATE, DELETE and TRUNCATE.
 *
 * A PRINT row carries its `copy_number`: 0 is the original, n is "Copy of Original (n)". The
 * number is the count of the invoice's earlier PRINT rows, taken under the invoice's row lock, so
 * two simultaneous prints never share one.
 */
export const invoiceAccessLog = pgTable(
  'invoice_access_log',
  {
    id: primaryId(),
    invoice_id: uuid()
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** The role the caller's access token carried. */
    actor_role: userRoleEnum().notNull(),
    action: text().$type<InvoiceAccessAction>().notNull(),
    /** PRINT only. */
    copy_number: integer(),
    occurred_at: timestamp({ withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
    ip_address: inet(),
    user_agent: text(),
  },
  (t) => [
    index('invoice_access_log_invoice_idx').on(t.invoice_id, t.occurred_at),
    index('invoice_access_log_user_idx').on(t.user_id),
    // One of each copy number per invoice, whatever the application does.
    uniqueIndex('invoice_access_log_copy_number_uidx')
      .on(t.invoice_id, t.copy_number)
      .where(sql`${t.action} = 'PRINT'`),
    check('invoice_access_log_action_check', sql`${t.action} IN ('VIEW', 'DOWNLOAD', 'PRINT')`),
    check(
      'invoice_access_log_copy_number_check',
      sql`(${t.action} = 'PRINT') = (${t.copy_number} IS NOT NULL)
            AND (${t.copy_number} IS NULL OR ${t.copy_number} >= 0)`,
    ),
  ],
);
