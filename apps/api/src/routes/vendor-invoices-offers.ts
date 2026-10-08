import {
  INVOICE_COPY_NUMBER_HEADER,
  idParamSchema,
  vendorInvoiceListQuerySchema,
  vendorOfferCreateRequestSchema,
  vendorOfferStatusOf,
  type AuditActor,
  type VendorInvoiceListResponseBody,
  type VendorInvoiceSummary,
  type VendorOfferListResponseBody,
  type VendorOfferResponseBody,
  type VendorOfferView,
} from '@hamro-pasal/shared-types';
import { Router, type Request } from 'express';

import { auditActorOf, auditContextOf } from '../http/request-context';
import { parseInput } from '../http/validate';
import type { ListedInvoice, VendorInvoiceService } from '../invoices/vendor-invoice-service';
import type { VendorOfferRow, VendorOfferService } from '../marketing/vendor-offer-service';

/** The signed-in vendor as the actor of a recorded action (the routers sit behind requireAuth). */
function vendorActor(req: Request): AuditActor & { kind: 'USER' } {
  const actor = auditActorOf(req);
  if (actor.kind !== 'USER') throw new Error('A signed-in caller is always a user');
  return actor;
}

export function vendorInvoiceSummary({ invoice, printCount }: ListedInvoice): VendorInvoiceSummary {
  return {
    id: invoice.id,
    document_type: invoice.document_type,
    order_id: invoice.order_id,
    fiscal_year: invoice.fiscal_year,
    bill_number: invoice.bill_number,
    invoice_sequence: invoice.invoice_sequence,
    issued_at: invoice.issued_at.toISOString(),
    issued_date_bs: invoice.issued_date_bs,
    buyer_name: invoice.buyer_name,
    payment_method: invoice.payment_method,
    grand_total_npr: invoice.grand_total_npr,
    print_count: printCount,
  };
}

export function vendorOfferView(offer: VendorOfferRow, now: Date): VendorOfferView {
  return {
    id: offer.id,
    kind: offer.kind,
    value: offer.value,
    max_discount_npr: offer.max_discount_npr,
    min_cart_npr: offer.min_cart_npr,
    label: offer.label,
    starts_at: offer.starts_at.toISOString(),
    ends_at: offer.ends_at?.toISOString() ?? null,
    status: vendorOfferStatusOf(offer, now),
    created_at: offer.created_at.toISOString(),
    ended_at: offer.ended_at?.toISOString() ?? null,
  };
}

/**
 * Mounted at /api/vendor/invoices behind requireAuth(VENDOR) (Phase 32, SPEC core 10). Any vendor
 * status may use it: a suspended shop still owes its customers their invoices.
 */
export function vendorInvoicesRouter(invoices: VendorInvoiceService): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/', async (req, res) => {
    const query = parseInput(vendorInvoiceListQuerySchema, { ...req.query });
    const page = await invoices.list(vendorActor(req).user_id, query);
    const body: VendorInvoiceListResponseBody = {
      invoices: page.invoices.map(vendorInvoiceSummary),
      next_cursor: page.nextCursor,
    };
    res.json(body);
  });

  /**
   * The printed invoice, rendered by the server. Every request is one print: it is logged and
   * numbered, the first as the ORIGINAL and each later one as a numbered copy, so the answer is
   * never cached and a repeat is a further copy.
   */
  router.get('/:id/pdf', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const printed = await invoices.print(vendorActor(req), id, auditContextOf(req, res));
    res
      .status(200)
      .set({
        'Content-Type': 'application/pdf',
        'Content-Length': String(printed.pdf.length),
        'Content-Disposition': `inline; filename="${printed.invoice.invoice_sequence}.pdf"`,
        'X-Content-Type-Options': 'nosniff',
        [INVOICE_COPY_NUMBER_HEADER]: String(printed.copyNumber),
      })
      .end(printed.pdf);
  });

  return router;
}

/**
 * Mounted at /api/vendor/offers behind requireAuth(VENDOR) (Phase 32, SPEC core 7). The shop's
 * own offers: no body names a vendor, and no other role can create or end one.
 */
export function vendorOffersRouter(offers: VendorOfferService): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/', async (req, res) => {
    const { offers: rows, now } = await offers.list(vendorActor(req).user_id);
    const body: VendorOfferListResponseBody = {
      offers: rows.map((offer) => vendorOfferView(offer, now)),
    };
    res.json(body);
  });

  router.post('/', async (req, res) => {
    const input = parseInput(vendorOfferCreateRequestSchema, req.body);
    const { offer, now } = await offers.create(vendorActor(req), input, auditContextOf(req, res));
    const body: VendorOfferResponseBody = { offer: vendorOfferView(offer, now) };
    res.status(201).json(body);
  });

  /** Stops the offer applying to future orders; 200 also on repeat. */
  router.post('/:id/end', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const { offer, now } = await offers.end(vendorActor(req), id, auditContextOf(req, res));
    const body: VendorOfferResponseBody = { offer: vendorOfferView(offer, now) };
    res.json(body);
  });

  return router;
}
