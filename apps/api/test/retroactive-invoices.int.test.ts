import { auditLogs, invoices, invoiceSequences, orders, type Database } from '@hamro-pasal/db';
import { generateFiscalInvoice } from '@hamro-pasal/ledger';
import { taxIdentityResponseSchema } from '@hamro-pasal/shared-types';
import { and, eq, sql } from 'drizzle-orm';
import request from 'supertest';

import { createVendor, vendorUserIdOf } from './support/fixtures';
import { bearer, bodyOf, buildTestApp, type TestApp } from './support/http';
import { invoicesOf, issueInvoice, setPan, soldOrder } from './support/invoicing';

/**
 * Phase 32 on real PostgreSQL: the invoices that waited for a shop's PAN (SPEC core 10: a shop
 * swept for compliance still delivers its open orders, and "their invoices are issued when the
 * PAN arrives"). PUT /api/vendor/tax-identity issues them in its own transaction.
 */
describe('Retroactive invoices on PAN save', () => {
  let t: TestApp;
  let db: Database;

  beforeAll(() => {
    t = buildTestApp();
    db = t.container.db;
  });

  afterAll(async () => {
    await t.container.close();
  });

  async function shop(options: { swept?: boolean } = {}) {
    const vendorId = await createVendor(db, { businessName: 'Asan Masala & Snacks' });
    if (options.swept !== false) {
      await db.execute(
        sql`UPDATE vendors SET status = 'SUSPENDED_COMPLIANCE', status_before_compliance_suspension = status
            WHERE id = ${vendorId}`,
      );
    }
    const userId = await vendorUserIdOf(db, vendorId);
    return { vendorId, userId, token: bearer(userId, 'VENDOR') };
  }

  const save = (token: string, body: object = { tax_id: '302118845', is_vat_registered: true }) =>
    request(t.app).put('/api/vendor/tax-identity').set('authorization', token).send(body);

  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  const waitingAudit = (vendorId: string) =>
    db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.entity_id, vendorId), eq(auditLogs.action, 'WAITING_INVOICES_ISSUED')),
      );

  const counterOf = async (vendorId: string) =>
    (await db.select().from(invoiceSequences).where(eq(invoiceSequences.vendor_id, vendorId)))[0]
      ?.last_number;

  it('issues the waiting invoices in the order of delivery, in the transaction that saves the PAN', async () => {
    const { vendorId, userId, token } = await shop();
    // Created out of delivery order on purpose.
    const second = await soldOrder(db, vendorId, { deliveredAt: minutesAgo(20), prices: [300] });
    const third = await soldOrder(db, vendorId, { deliveredAt: minutesAgo(10), prices: [1130] });
    const first = await soldOrder(db, vendorId, {
      deliveredAt: minutesAgo(30),
      prices: [500, 250],
    });
    expect(await invoicesOf(db, vendorId)).toEqual([]);

    const res = await save(token, {
      tax_id: '302118845',
      is_vat_registered: true,
      legal_name: 'Asan Masala Pvt. Ltd.',
      registered_address: 'Asan Tole, Kathmandu-27',
    });

    expect(res.status).toBe(200);
    expect(bodyOf(taxIdentityResponseSchema, res)).toMatchObject({
      status: 'LIVE',
      compliance_suspension_lifted: true,
      waiting_invoices_issued: 3,
    });
    const issued = await invoicesOf(db, vendorId);
    expect(issued.map((invoice) => [invoice.bill_number, invoice.order_id])).toEqual([
      [1, first.id],
      [2, second.id],
      [3, third.id],
    ]);
    expect(await counterOf(vendorId)).toBe(3);
    // The seller is the shop as this save left it; the totals are what each customer paid.
    for (const invoice of issued) {
      expect(invoice).toMatchObject({
        seller_tax_id: '302118845',
        seller_is_vat_registered: true,
        seller_name: 'Asan Masala Pvt. Ltd.',
        seller_address: 'Asan Tole, Kathmandu-27',
      });
    }
    expect(issued.map((invoice) => invoice.grand_total_npr)).toEqual([800, 350, 1180]);
    expect(issued[2]).toMatchObject({ taxable_amount_npr: 1044.25, vat_amount_npr: 135.75 });
    // Numbered and dated when the PAN arrived, in delivery order.
    const times = issued.map((invoice) => invoice.issued_at.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(Math.min(...times)).toBeGreaterThan(minutesAgo(1).getTime());

    const [audit] = await waitingAudit(vendorId);
    expect(audit).toMatchObject({
      actor_user_id: userId,
      actor_role: 'VENDOR',
      vendor_id: vendorId,
      before_state: null,
      after_state: {
        issued_count: 3,
        first_invoice_sequence: issued[0]?.invoice_sequence,
        last_invoice_sequence: issued[2]?.invoice_sequence,
        refused_order_ids: [],
      },
    });
  });

  it('invoices only DELIVERED orders of this shop', async () => {
    const { vendorId, token } = await shop();
    const other = await shop();
    const delivered = await soldOrder(db, vendorId);
    await soldOrder(db, vendorId, { deliveredAt: null, state: 'PLACED' });
    await soldOrder(db, vendorId, { deliveredAt: null, state: 'PREPARING' });
    await soldOrder(db, vendorId, { deliveredAt: null, state: 'OUT_FOR_DELIVERY' });
    await soldOrder(db, vendorId, { deliveredAt: null, state: 'CANCELED' });
    await soldOrder(db, other.vendorId);

    const res = await save(token);

    expect(bodyOf(taxIdentityResponseSchema, res).waiting_invoices_issued).toBe(1);
    expect((await invoicesOf(db, vendorId)).map((invoice) => invoice.order_id)).toEqual([
      delivered.id,
    ]);
    expect(await invoicesOf(db, other.vendorId)).toEqual([]);
    // The others were never candidates: nothing was tried and refused for them.
    expect((await waitingAudit(vendorId))[0]?.after_state).toMatchObject({
      issued_count: 1,
      refused_order_ids: [],
    });
  });

  it('also serves a shop that was never swept: its first PAN issues what waited', async () => {
    const { vendorId, token } = await shop({ swept: false });
    await soldOrder(db, vendorId);

    const res = await save(token, { tax_id: '302118845', is_vat_registered: false });

    expect(bodyOf(taxIdentityResponseSchema, res)).toMatchObject({
      compliance_suspension_lifted: false,
      waiting_invoices_issued: 1,
    });
    // Not VAT registered: a PAN invoice with no VAT.
    expect((await invoicesOf(db, vendorId))[0]).toMatchObject({
      seller_is_vat_registered: false,
      vat_amount_npr: 0,
      exempt_amount_npr: 1050,
    });
  });

  it('issues nothing when no order waited, and records no audit entry for it', async () => {
    const { vendorId, token } = await shop();

    const res = await save(token);

    expect(bodyOf(taxIdentityResponseSchema, res)).toMatchObject({
      compliance_suspension_lifted: true,
      waiting_invoices_issued: 0,
    });
    expect(await waitingAudit(vendorId)).toEqual([]);
    expect(await counterOf(vendorId)).toBeUndefined();
  });

  it('issues once: a repeated save and a changed PAN issue nothing more', async () => {
    const { vendorId, token } = await shop();
    await soldOrder(db, vendorId);
    await soldOrder(db, vendorId);

    expect(bodyOf(taxIdentityResponseSchema, await save(token)).waiting_invoices_issued).toBe(2);
    expect(bodyOf(taxIdentityResponseSchema, await save(token)).waiting_invoices_issued).toBe(0);
    const changed = await save(token, { tax_id: '609998877', is_vat_registered: true });

    expect(bodyOf(taxIdentityResponseSchema, changed).waiting_invoices_issued).toBe(0);
    const issued = await invoicesOf(db, vendorId);
    expect(issued.map((invoice) => invoice.bill_number)).toEqual([1, 2]);
    // An issued invoice keeps the PAN it was issued with.
    expect(issued.map((invoice) => invoice.seller_tax_id)).toEqual(['302118845', '302118845']);
    expect(await waitingAudit(vendorId)).toHaveLength(1);
  });

  it('leaves alone an uninvoiced order of a shop that already had its PAN', async () => {
    const { vendorId, token } = await shop({ swept: false });
    await setPan(db, vendorId, '302118845');
    // Delivered before invoicing existed: not this save's to sweep in.
    await soldOrder(db, vendorId);

    const res = await save(token, { tax_id: '609998877', is_vat_registered: false });

    expect(bodyOf(taxIdentityResponseSchema, res).waiting_invoices_issued).toBe(0);
    expect(await invoicesOf(db, vendorId)).toEqual([]);
  });

  it('never invoices an order twice: one already invoiced is not counted again', async () => {
    const { vendorId, token } = await shop();
    await setPan(db, vendorId, '302118845');
    const invoiced = await soldOrder(db, vendorId, { deliveredAt: minutesAgo(30) });
    await issueInvoice(db, invoiced);
    await setPan(db, vendorId, null);
    const waiting = await soldOrder(db, vendorId, { deliveredAt: minutesAgo(5) });

    const res = await save(token);

    expect(bodyOf(taxIdentityResponseSchema, res).waiting_invoices_issued).toBe(1);
    expect(
      (await invoicesOf(db, vendorId)).map((invoice) => [invoice.bill_number, invoice.order_id]),
    ).toEqual([
      [1, invoiced.id],
      [2, waiting.id],
    ]);
  });

  it('saves the PAN although one order cannot be invoiced, names it, and leaves no gap', async () => {
    const { vendorId, token } = await shop();
    const first = await soldOrder(db, vendorId, { deliveredAt: minutesAgo(30) });
    // Its lines do not add up to what the customer paid.
    const broken = await soldOrder(db, vendorId, { deliveredAt: minutesAgo(20), withItems: false });
    const last = await soldOrder(db, vendorId, { deliveredAt: minutesAgo(10) });

    const res = await save(token);

    expect(res.status).toBe(200);
    expect(bodyOf(taxIdentityResponseSchema, res)).toMatchObject({
      status: 'LIVE',
      waiting_invoices_issued: 2,
    });
    expect(
      (await invoicesOf(db, vendorId)).map((invoice) => [invoice.bill_number, invoice.order_id]),
    ).toEqual([
      [1, first.id],
      [2, last.id],
    ]);
    expect(await counterOf(vendorId)).toBe(2);
    expect((await waitingAudit(vendorId))[0]?.after_state).toMatchObject({
      issued_count: 2,
      refused_order_ids: [broken.id],
    });
  });

  it('issues nothing when the PAN is refused', async () => {
    const { vendorId, token } = await shop();
    await soldOrder(db, vendorId);

    const res = await save(token, { tax_id: '12345', is_vat_registered: false });

    expect(res.status).toBe(400);
    expect(await invoicesOf(db, vendorId)).toEqual([]);
  });

  it('issues each invoice once under five simultaneous saves', async () => {
    const { vendorId, token } = await shop();
    for (let index = 0; index < 4; index += 1) {
      await soldOrder(db, vendorId, { deliveredAt: minutesAgo(40 - index) });
    }

    const responses = await Promise.all(Array.from({ length: 5 }, () => save(token)));

    expect(responses.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
    expect(
      responses.map((res) => bodyOf(taxIdentityResponseSchema, res).waiting_invoices_issued).sort(),
    ).toEqual([0, 0, 0, 0, 4]);
    expect((await invoicesOf(db, vendorId)).map((invoice) => invoice.bill_number)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(await waitingAudit(vendorId)).toHaveLength(1);
  });

  it('waits for a transaction that holds a waiting order, then invoices that order too', async () => {
    const { vendorId, token } = await shop();
    const held = await soldOrder(db, vendorId, { deliveredAt: minutesAgo(20) });
    await soldOrder(db, vendorId, { deliveredAt: minutesAgo(10) });

    let release: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // A review being submitted, say: the order row locked for a moment.
    const holder = db.transaction(async (tx) => {
      await tx.select().from(orders).where(eq(orders.id, held.id)).for('update');
      locked();
      await holding;
    });
    await isLocked;

    const saving = save(token).then((res) => res);
    const early = await Promise.race([
      saving.then(() => 'answered'),
      new Promise((resolve) => setTimeout(resolve, 300, 'waiting')),
    ]);
    release();
    await holder;
    const res = await saving;

    expect(early).toBe('waiting');
    expect(bodyOf(taxIdentityResponseSchema, res).waiting_invoices_issued).toBe(2);
    expect((await invoicesOf(db, vendorId)).map((invoice) => invoice.order_id)).toContain(held.id);
  });

  it('invoices an order whose delivery read "no PAN" just before the save and committed after it', async () => {
    const { vendorId, token } = await shop();
    const order = await soldOrder(db, vendorId, { deliveredAt: null, state: 'OUT_FOR_DELIVERY' });

    let finish: () => void = () => undefined;
    const finishing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let decided: (status: string) => void = () => undefined;
    const decision = new Promise<string>((resolve) => {
      decided = resolve;
    });
    // A handoff that posts no wallet journal. It finds no PAN, so it issues nothing, and is
    // still open when the PAN is saved: the save cannot see this delivery yet.
    const delivery = db.transaction(async (tx) => {
      await tx.select().from(orders).where(eq(orders.id, order.id)).for('update');
      const [delivered] = await tx
        .update(orders)
        .set({ state: 'DELIVERED', delivered_at: sql`now()` })
        .where(eq(orders.id, order.id))
        .returning();
      if (delivered === undefined) throw new Error('order vanished');
      decided((await generateFiscalInvoice(tx, delivered)).status);
      await finishing;
    });
    expect(await decision).toBe('SELLER_HAS_NO_PAN');

    const saving = save(token).then((res) => res);
    // The save waits for the delivery (the vendor row is share-locked by it) ...
    const early = await Promise.race([
      saving.then(() => 'answered'),
      new Promise((resolve) => setTimeout(resolve, 300, 'waiting')),
    ]);
    finish();
    await delivery;
    const res = await saving;

    // ... and so finds the delivered order and issues its invoice.
    expect(early).toBe('waiting');
    expect(bodyOf(taxIdentityResponseSchema, res).waiting_invoices_issued).toBe(1);
    expect((await invoicesOf(db, vendorId)).map((invoice) => invoice.order_id)).toEqual([order.id]);
  });

  it('leaves no order without an invoice when deliveries race the PAN save', async () => {
    for (let round = 0; round < 6; round += 1) {
      const { vendorId, token } = await shop();
      const before = [
        await soldOrder(db, vendorId, { deliveredAt: minutesAgo(30) }),
        await soldOrder(db, vendorId, { deliveredAt: minutesAgo(20) }),
      ];
      const racing = [];
      for (let index = 0; index < 4; index += 1) {
        racing.push(
          await soldOrder(db, vendorId, { deliveredAt: null, state: 'OUT_FOR_DELIVERY' }),
        );
      }
      // A handoff that posts no wallet journal: the order row, then straight to the invoice.
      const deliver = (orderId: string) =>
        db.transaction(async (tx) => {
          await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
          const [delivered] = await tx
            .update(orders)
            .set({ state: 'DELIVERED', delivered_at: sql`now()` })
            .where(eq(orders.id, orderId))
            .returning();
          if (delivered === undefined) throw new Error('order vanished');
          return generateFiscalInvoice(tx, delivered);
        });

      const [res] = await Promise.all([save(token), ...racing.map((order) => deliver(order.id))]);

      expect(res.status).toBe(200);
      const issued = await invoicesOf(db, vendorId);
      // Every delivered order has exactly one invoice, whoever issued it, with no gap.
      expect(issued.map((invoice) => invoice.order_id).sort()).toEqual(
        [...before, ...racing].map((order) => order.id).sort(),
      );
      expect(issued.map((invoice) => invoice.bill_number)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(await counterOf(vendorId)).toBe(6);
    }
  });

  it('refuses any later change to an invoice it issued', async () => {
    const { vendorId, token } = await shop();
    await soldOrder(db, vendorId);
    await save(token);
    const [issued] = await invoicesOf(db, vendorId);
    if (issued === undefined) throw new Error('no invoice');

    await expect(
      db.update(invoices).set({ seller_tax_id: '609998877' }).where(eq(invoices.id, issued.id)),
    ).rejects.toThrow();
  });
});
