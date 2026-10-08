import { invoiceAccessLog, invoices, users, type Database } from '@hamro-pasal/db';
import {
  INVOICE_PLATFORM_DISCLAIMER,
  vendorInvoiceListResponseSchema,
  type UserRole,
  type VendorInvoiceListResponseBody,
} from '@hamro-pasal/shared-types';
import { asc, eq } from 'drizzle-orm';
import request, { type Response } from 'supertest';

import { createUser, createVendor, vendorUserIdOf } from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';
import { issueInvoice, pdfTextRuns, setPan, soldOrder } from './support/invoicing';

/**
 * Phase 32 on real PostgreSQL: a shop's invoices. GET /api/vendor/invoices lists them; GET
 * /api/vendor/invoices/:id/pdf answers the document the server rendered, numbers the print and
 * logs it in invoice_access_log (SPEC core 10, "View and print tracking").
 */
describe('Vendor invoices API', () => {
  let t: TestApp;
  let db: Database;
  // Two fiscal years: 22 Ashwin 2082 (2082/083) and 1 Shrawan 2083 (2083/084).
  const IN_2082 = new Date('2025-10-08T06:00:00.000Z');
  const IN_2083 = new Date('2026-07-17T06:00:00.000Z');

  beforeAll(() => {
    t = buildTestApp();
    db = t.container.db;
  });

  afterAll(async () => {
    await t.container.close();
  });

  async function shop() {
    const vendorId = await createVendor(db, { businessName: 'Thamel Kirana Pasal' });
    await setPan(db, vendorId);
    const userId = await vendorUserIdOf(db, vendorId);
    return { vendorId, userId, token: bearer(userId, 'VENDOR') };
  }

  /** An invoice of the shop, issued at `at`; a second apart keeps the list order certain. */
  const invoiceAt = async (vendorId: string, at: Date, prices: readonly number[] = [1130]) =>
    issueInvoice(db, await soldOrder(db, vendorId, { prices }), at);

  const list = (token: string, query: Record<string, string> = {}) =>
    request(t.app).get('/api/vendor/invoices').query(query).set('authorization', token);

  const pdf = (token: string, invoiceId: string) =>
    request(t.app)
      .get(`/api/vendor/invoices/${invoiceId}/pdf`)
      .set('authorization', token)
      .set('user-agent', 'HamroPasalVendor/1.0')
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          done(null, Buffer.concat(chunks));
        });
      });

  const pdfOf = (res: Response): Buffer => {
    if (!Buffer.isBuffer(res.body)) throw new Error('the body is not a file');
    return res.body;
  };

  const logOf = (invoiceId: string) =>
    db
      .select()
      .from(invoiceAccessLog)
      .where(eq(invoiceAccessLog.invoice_id, invoiceId))
      .orderBy(asc(invoiceAccessLog.copy_number));

  describe('GET /api/vendor/invoices', () => {
    it("lists the shop's invoices newest first, each as its header", async () => {
      const { vendorId, token } = await shop();
      const older = await invoiceAt(vendorId, IN_2082);
      const newer = await invoiceAt(vendorId, new Date(IN_2082.getTime() + 1000), [500, 250]);

      const res = await list(token);

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = bodyOf(vendorInvoiceListResponseSchema, res);
      expect(body.next_cursor).toBeNull();
      expect(body.invoices).toEqual([
        {
          id: newer.id,
          document_type: 'INVOICE',
          order_id: newer.order_id,
          fiscal_year: '2082/083',
          bill_number: 2,
          invoice_sequence: 'HP-2082-000002',
          issued_at: newer.issued_at.toISOString(),
          issued_date_bs: '2082-06-22',
          buyer_name: 'Test',
          payment_method: 'COD',
          grand_total_npr: 800,
          print_count: 0,
        },
        expect.objectContaining({ id: older.id, bill_number: 1, grand_total_npr: 1180 }),
      ]);
    });

    it("never lists another shop's invoices, and an invoice-less shop gets an empty list", async () => {
      const mine = await shop();
      const other = await shop();
      const own = await invoiceAt(mine.vendorId, IN_2082);
      await invoiceAt(other.vendorId, IN_2082);
      const none = await shop();

      expect(bodyOf(vendorInvoiceListResponseSchema, await list(mine.token)).invoices).toEqual([
        expect.objectContaining({ id: own.id }),
      ]);
      expect(bodyOf(vendorInvoiceListResponseSchema, await list(none.token))).toEqual({
        invoices: [],
        next_cursor: null,
      });
    });

    it('filters by fiscal year and by document type', async () => {
      const { vendorId, token } = await shop();
      const in2082 = await invoiceAt(vendorId, IN_2082);
      const in2083 = await invoiceAt(vendorId, IN_2083);

      const ids = async (query: Record<string, string>) =>
        bodyOf(vendorInvoiceListResponseSchema, await list(token, query)).invoices.map(
          (invoice) => invoice.id,
        );

      expect(await ids({})).toEqual([in2083.id, in2082.id]);
      expect(await ids({ fiscal_year: '2082/083' })).toEqual([in2082.id]);
      expect(await ids({ fiscal_year: '2083/084' })).toEqual([in2083.id]);
      expect(await ids({ fiscal_year: '2084/085' })).toEqual([]);
      expect(await ids({ document_type: 'INVOICE' })).toEqual([in2083.id, in2082.id]);
      expect(await ids({ document_type: 'CREDIT_NOTE' })).toEqual([]);
      // Each fiscal year starts its own numbering.
      expect([in2082.bill_number, in2083.bill_number]).toEqual([1, 1]);
    });

    it('pages 2 / 2 / 1 by cursor without a gap or a repeat', async () => {
      const { vendorId, token } = await shop();
      const issued = [];
      for (let index = 0; index < 5; index += 1) {
        issued.push(await invoiceAt(vendorId, new Date(IN_2082.getTime() + index * 1000)));
      }

      const seen: string[] = [];
      const sizes: number[] = [];
      let cursor: string | null = null;
      do {
        const query: Record<string, string> =
          cursor === null ? { limit: '2' } : { limit: '2', cursor };
        const page: VendorInvoiceListResponseBody = bodyOf(
          vendorInvoiceListResponseSchema,
          await list(token, query),
        );
        sizes.push(page.invoices.length);
        seen.push(...page.invoices.map((invoice) => invoice.id));
        cursor = page.next_cursor;
      } while (cursor !== null);

      expect(sizes).toEqual([2, 2, 1]);
      expect(seen).toEqual(issued.map((invoice) => invoice.id).reverse());
    });

    it("refuses a cursor that is not this shop's invoice, and malformed queries", async () => {
      const { vendorId, token } = await shop();
      await invoiceAt(vendorId, IN_2082);
      const other = await shop();
      const foreign = await invoiceAt(other.vendorId, IN_2082);

      for (const cursor of [foreign.id, '00000000-0000-4000-8000-000000000000']) {
        const res = await list(token, { cursor });
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('INVALID_CURSOR');
      }
      for (const query of [
        { limit: '0' },
        { limit: '51' },
        { cursor: 'abc' },
        { fiscal_year: '2082' },
        { document_type: 'RECEIPT' },
        { vendor_id: other.vendorId },
      ]) {
        const res = await list(token, query);
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
    });
  });

  describe('GET /api/vendor/invoices/:id/pdf', () => {
    it('answers the invoice as a PDF the server rendered, marked ORIGINAL', async () => {
      const { vendorId, token } = await shop();
      const invoice = await invoiceAt(vendorId, IN_2082);

      const res = await pdf(token, invoice.id);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-disposition']).toBe('inline; filename="HP-2082-000001.pdf"');
      expect(res.headers['x-invoice-copy-number']).toBe('0');
      const file = pdfOf(res);
      expect(res.headers['content-length']).toBe(String(file.length));
      expect(file.subarray(0, 5).toString('latin1')).toBe('%PDF-');

      const runs = pdfTextRuns(file);
      // The IRD header, the itemised table and the amount in words, from the stored row.
      expect(runs).toEqual(
        expect.arrayContaining([
          'ORIGINAL',
          'Thamel Kirana Pasal',
          'PAN: 302118845',
          'INVOICE',
          'Test',
          'HP-2082-000001',
          '2082/083',
          '2082-06-22',
          '2025-10-08 11:45 NPT',
          'Qty',
          'Rate',
          'Taxable',
          'VAT',
          'Item 1',
          '1,130.00',
          'Delivery charge',
          '1,180.00',
          invoice.amount_in_words,
        ]),
      );
      expect(runs.at(-1)).toContain(INVOICE_PLATFORM_DISCLAIMER);
    });

    it('logs every print with who, when and its copy number', async () => {
      const { vendorId, userId, token } = await shop();
      const invoice = await invoiceAt(vendorId, IN_2082);
      const started = Date.now() - 5_000;

      const first = await pdf(token, invoice.id);
      const second = await pdf(token, invoice.id);
      const third = await pdf(token, invoice.id);

      expect([first, second, third].map((res) => res.headers['x-invoice-copy-number'])).toEqual([
        '0',
        '1',
        '2',
      ]);
      expect(pdfTextRuns(pdfOf(first))[0]).toBe('ORIGINAL');
      expect(pdfTextRuns(pdfOf(second))[0]).toBe('COPY OF ORIGINAL (1)');
      expect(pdfTextRuns(pdfOf(third))[0]).toBe('COPY OF ORIGINAL (2)');
      // A copy says so everywhere: the word ORIGINAL alone is on the first print only.
      expect(pdfTextRuns(pdfOf(second))).not.toContain('ORIGINAL');

      const log = await logOf(invoice.id);
      expect(log).toHaveLength(3);
      expect(log.map((row) => row.copy_number)).toEqual([0, 1, 2]);
      for (const row of log) {
        expect(row).toMatchObject({
          invoice_id: invoice.id,
          user_id: userId,
          actor_role: 'VENDOR',
          action: 'PRINT',
          user_agent: 'HamroPasalVendor/1.0',
        });
        expect(row.occurred_at.getTime()).toBeGreaterThan(started);
      }
      const times = log.map((row) => row.occurred_at.getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);

      // The list shows how often it was printed.
      expect(
        bodyOf(vendorInvoiceListResponseSchema, await list(token)).invoices[0]?.print_count,
      ).toBe(3);
    });

    it('gives five simultaneous prints five different copy numbers, one of them the original', async () => {
      const { vendorId, token } = await shop();
      const invoice = await invoiceAt(vendorId, IN_2082);

      const responses = await Promise.all(Array.from({ length: 5 }, () => pdf(token, invoice.id)));

      expect(responses.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
      expect(responses.map((res) => Number(res.headers['x-invoice-copy-number'])).sort()).toEqual([
        0, 1, 2, 3, 4,
      ]);
      // Each file carries the number it was logged with.
      for (const res of responses) {
        const copy = Number(res.headers['x-invoice-copy-number']);
        expect(pdfTextRuns(pdfOf(res))[0]).toBe(
          copy === 0 ? 'ORIGINAL' : `COPY OF ORIGINAL (${String(copy)})`,
        );
      }
      expect((await logOf(invoice.id)).map((row) => row.copy_number)).toEqual([0, 1, 2, 3, 4]);
    });

    it('prints the stored document: later edits of the shop do not reach it', async () => {
      const { vendorId, token } = await shop();
      const invoice = await invoiceAt(vendorId, IN_2082);
      await setPan(db, vendorId, '609998877');

      const runs = pdfTextRuns(pdfOf(await pdf(token, invoice.id)));

      expect(runs).toContain('PAN: 302118845');
      expect(runs).not.toContain('PAN: 609998877');
      // Printing writes nothing to the sealed row.
      const [stored] = await db.select().from(invoices).where(eq(invoices.id, invoice.id));
      expect(stored).toEqual(invoice);
    });

    it("hides another shop's invoice and an unknown one, and logs nothing for them", async () => {
      const mine = await shop();
      const other = await shop();
      const foreign = await invoiceAt(other.vendorId, IN_2082);

      const stolen = await request(t.app)
        .get(`/api/vendor/invoices/${foreign.id}/pdf`)
        .set('authorization', mine.token);
      const unknown = await request(t.app)
        .get('/api/vendor/invoices/00000000-0000-4000-8000-000000000000/pdf')
        .set('authorization', mine.token);
      const malformed = await request(t.app)
        .get('/api/vendor/invoices/not-an-id/pdf')
        .set('authorization', mine.token);

      expect([stolen.status, unknown.status, malformed.status]).toEqual([404, 404, 400]);
      expect(errorOf(stolen).code).toBe('INVOICE_NOT_FOUND');
      expect(errorOf(unknown).code).toBe('INVOICE_NOT_FOUND');
      expect(errorOf(malformed).code).toBe('VALIDATION_FAILED');
      expect(stolen.headers['content-type']).toContain('application/json');
      expect(await logOf(foreign.id)).toEqual([]);
      // The owner's first print is still the original.
      expect((await pdf(other.token, foreign.id)).headers['x-invoice-copy-number']).toBe('0');
    });
  });

  describe('access', () => {
    it('needs a vendor token on both routes', async () => {
      const { vendorId } = await shop();
      const invoice = await invoiceAt(vendorId, IN_2082);
      const paths = ['/api/vendor/invoices', `/api/vendor/invoices/${invoice.id}/pdf`];

      for (const path of paths) {
        expect((await request(t.app).get(path)).status).toBe(401);
        for (const role of ['CUSTOMER', 'DRIVER', 'SUPER_ADMIN'] satisfies UserRole[]) {
          const res = await request(t.app)
            .get(path)
            .set('authorization', bearer(await createUser(db, role), role));
          expect(res.status).toBe(403);
        }
      }
      expect(await logOf(invoice.id)).toEqual([]);
    });

    it('answers 404 VENDOR_NOT_FOUND for a vendor account without a shop', async () => {
      const shopless = bearer(await createUser(db, 'VENDOR'), 'VENDOR');

      const res = await list(shopless);
      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('VENDOR_NOT_FOUND');
    });

    it('serves no route that writes or removes an invoice', async () => {
      const { vendorId, token } = await shop();
      const invoice = await invoiceAt(vendorId, IN_2082);

      for (const method of ['put', 'patch', 'delete', 'post'] as const) {
        const res = await request(t.app)
          [method](`/api/vendor/invoices/${invoice.id}`)
          .set('authorization', token)
          .send({ grand_total_npr: 1 });
        expect(res.status).toBe(404);
      }
      // A user with prints in the log cannot be removed from under it.
      await pdf(token, invoice.id);
      await expect(
        db.delete(users).where(eq(users.id, await vendorUserIdOf(db, vendorId))),
      ).rejects.toThrow();
    });
  });
});
