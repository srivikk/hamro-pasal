import {
  campaignOptIns,
  invoiceSequences,
  invoices,
  orderItems,
  orders,
  platformCampaigns,
  users,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import {
  generateFiscalInvoice,
  InvoiceNotIssuableError,
  type InvoiceRow,
} from '@hamro-pasal/ledger';
import {
  invoiceLineItemSchema,
  type FulfillmentMode,
  type Order,
  type PaymentMethod,
} from '@hamro-pasal/shared-types';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import {
  createOrder,
  createProduct,
  createUser,
  createVendor,
  markDelivered,
  testDatabase,
  vendorUserIdOf,
} from './support/fixtures';

const paisa = (npr: number) => Math.round(npr * 100);

/**
 * Phase 31 on real PostgreSQL: generateFiscalInvoice, the whole IRD document (SPEC core 10, edge
 * cases 10 and 11, verification 12). Its wiring into the delivery is tested through the API in
 * discounts-and-invoicing.int.test.ts.
 */
describe('generateFiscalInvoice (real PostgreSQL)', () => {
  let db: Database;
  let adminId: string;
  // Wednesday 8 October 2025 in Nepal: 22 Ashwin 2082, fiscal year 2082/083.
  const IN_2082 = new Date('2025-10-08T06:00:00.000Z');

  beforeAll(async () => {
    db = testDatabase();
    adminId = await createUser(db, 'SUPER_ADMIN');
  });

  afterAll(async () => {
    await db.$client.end();
  });

  /** A shop with a PAN on file; VAT registered unless told otherwise. */
  async function seller(options: { vat?: boolean; pan?: string | null } = {}): Promise<string> {
    const vendorId = await createVendor(db, { businessName: 'Thamel Kirana Pasal' });
    await db
      .update(vendors)
      .set({
        tax_id: options.pan === undefined ? '302118845' : options.pan,
        is_vat_registered: options.vat ?? true,
        legal_name: 'Thamel Kirana Pasal Pvt. Ltd.',
        registered_address: 'Thamel Marg, Kathmandu-26',
      })
      .where(eq(vendors.id, vendorId));
    return vendorId;
  }

  interface OrderOptions {
    lines?: readonly { price: number; quantity: number; name?: string }[];
    deliveryFee?: number;
    fulfillment?: FulfillmentMode;
    paymentMethod?: PaymentMethod;
    /** A platform campaign discount, with the part the vendor bears. */
    discount?: { total: number; vendorShare: number };
    delivered?: boolean;
  }

  /** A delivered order with its item lines, as checkout and the handoff would have left it. */
  async function order(vendorId: string, options: OrderOptions = {}): Promise<Order> {
    const lines = options.lines ?? [{ price: 500, quantity: 2 }];
    const subtotal = lines.reduce((sum, line) => sum + paisa(line.price) * line.quantity, 0) / 100;
    const fulfillment = options.fulfillment ?? 'SELF_DELIVERY';
    const created = await createOrder(db, {
      vendorId,
      customerId: await createUser(db),
      subtotal,
      deliveryFee: options.deliveryFee ?? 50,
      commission: 0,
      fulfillment,
      ...(options.paymentMethod === undefined ? {} : { paymentMethod: options.paymentMethod }),
    });
    for (const [index, line] of lines.entries()) {
      const productId = await createProduct(db, vendorId, 10, line.price);
      await db.insert(orderItems).values({
        order_id: created.id,
        product_id: productId,
        product_name: line.name ?? `Item ${String(index + 1)}`,
        unit_price_npr: line.price,
        quantity: line.quantity,
        // Lines are read back in the order they were sold.
        created_at: new Date(Date.now() + index),
      });
    }
    if (options.discount !== undefined) {
      const [campaign] = await db
        .insert(platformCampaigns)
        .values({
          name: 'Dashain 10%',
          kind: 'FLAT',
          value: options.discount.total,
          vendor_share_percent: 50,
          starts_at: new Date(Date.now() - 3_600_000),
          ends_at: new Date(Date.now() + 3_600_000),
          created_by_user_id: adminId,
        })
        .returning({ id: platformCampaigns.id });
      if (campaign === undefined) throw new Error('campaign not created');
      const [optIn] = await db
        .insert(campaignOptIns)
        .values({
          campaign_id: campaign.id,
          vendor_id: vendorId,
          opt_in_terms_version: 1,
          terms_snapshot: { kind: 'FLAT', value: options.discount.total },
          opted_in_by_user_id: await vendorUserIdOf(db, vendorId),
        })
        .returning({ id: campaignOptIns.id });
      if (optIn === undefined) throw new Error('opt-in not created');
      await db
        .update(orders)
        .set({
          platform_promo_discount_npr: options.discount.total,
          platform_promo_vendor_share_npr: options.discount.vendorShare,
          campaign_opt_in_id: optIn.id,
          discount_snapshot: { campaign_id: campaign.id },
        })
        .where(eq(orders.id, created.id));
    }
    if (options.delivered !== false) {
      await markDelivered(
        db,
        created.id,
        fulfillment === 'SELF_DELIVERY' ? null : await createUser(db, 'DRIVER'),
      );
    }
    const [row] = await db.select().from(orders).where(eq(orders.id, created.id));
    if (row === undefined) throw new Error('order vanished');
    return row;
  }

  /** As a delivery would: the order row locked, then the invoice, in one transaction. */
  const result = (target: Order, at: Date | null = IN_2082) =>
    db.transaction(async (tx) => {
      const [locked] = await tx.select().from(orders).where(eq(orders.id, target.id)).for('update');
      if (locked === undefined) throw new Error('order vanished');
      return generateFiscalInvoice(tx, locked, at ?? undefined);
    });

  const issue = async (target: Order, at: Date | null = IN_2082): Promise<InvoiceRow> => {
    const { invoice } = await result(target, at);
    if (invoice === null) throw new Error('no invoice was issued');
    return invoice;
  };

  const invoicesOf = (vendorId: string) =>
    db
      .select()
      .from(invoices)
      .where(eq(invoices.vendor_id, vendorId))
      .orderBy(asc(invoices.fiscal_year), asc(invoices.bill_number));

  const counterOf = async (vendorId: string, fiscalYear: string) =>
    (
      await db
        .select()
        .from(invoiceSequences)
        .where(
          and(
            eq(invoiceSequences.vendor_id, vendorId),
            eq(invoiceSequences.fiscal_year, fiscalYear),
          ),
        )
    )[0]?.last_number;

  const refusal = (attempt: Promise<unknown>) =>
    attempt.then(
      () => 'accepted',
      (error: unknown) => String((error as { cause?: unknown }).cause ?? error),
    );

  /** The header's split is the sum of its lines, and the split adds up to what was paid. */
  function expectConsistent(invoice: InvoiceRow, paidNpr: number): void {
    const lines = z.array(invoiceLineItemSchema).parse(invoice.line_items);
    const taxed = lines.filter((line) => line.vat_rate_percent > 0);
    const untaxed = lines.filter((line) => line.vat_rate_percent === 0);
    const sum = (values: readonly number[]) => values.reduce((total, v) => total + paisa(v), 0);
    expect(paisa(invoice.taxable_amount_npr)).toBe(sum(taxed.map((l) => l.taxable_amount_npr)));
    expect(paisa(invoice.vat_amount_npr)).toBe(sum(lines.map((l) => l.vat_amount_npr)));
    expect(paisa(invoice.exempt_amount_npr)).toBe(sum(untaxed.map((l) => l.line_total_npr)));
    expect(paisa(invoice.discount_npr)).toBe(sum(lines.map((l) => l.line_discount_npr)));
    for (const line of taxed) {
      expect(paisa(line.taxable_amount_npr) + paisa(line.vat_amount_npr)).toBe(
        paisa(line.line_total_npr),
      );
    }
    const platformDelivery =
      invoice.delivery_charged_by === 'PLATFORM' ? paisa(invoice.delivery_charge_npr) : 0;
    expect(
      paisa(invoice.taxable_amount_npr) +
        paisa(invoice.vat_amount_npr) +
        paisa(invoice.exempt_amount_npr) +
        platformDelivery,
    ).toBe(paisa(paidNpr));
    expect(invoice.grand_total_npr).toBe(paidNpr);
  }

  describe('the document', () => {
    it('splits 1130 NPR of goods from a VAT-registered seller into 1000.00 taxable and 130.00 VAT', async () => {
      const vendorId = await seller();
      const target = await order(vendorId, {
        lines: [{ price: 565, quantity: 2, name: 'Basmati Rice 5kg' }],
        deliveryFee: 0,
        paymentMethod: 'ESEWA',
      });

      const invoice = await issue(target);

      expect(invoice).toMatchObject({
        document_type: 'INVOICE',
        vendor_id: vendorId,
        order_id: target.id,
        customer_id: target.customer_id,
        fiscal_year: '2082/083',
        bill_number: 1,
        invoice_sequence: 'HP-2082-000001',
        issued_date_bs: '2082-06-22',
        seller_name: 'Thamel Kirana Pasal Pvt. Ltd.',
        seller_address: 'Thamel Marg, Kathmandu-26',
        seller_phone: '+9779800000000',
        seller_tax_id: '302118845',
        seller_is_vat_registered: true,
        buyer_name: 'Test',
        payment_method: 'ESEWA',
        subtotal_npr: 1130,
        discount_npr: 0,
        taxable_amount_npr: 1000,
        vat_rate_percent: 13,
        vat_amount_npr: 130,
        exempt_amount_npr: 0,
        delivery_charge_npr: 0,
        delivery_charged_by: 'VENDOR',
        grand_total_npr: 1130,
        amount_in_words: 'Rupees One Thousand One Hundred Thirty Only',
      });
      expect(invoice.issued_at.toISOString()).toBe(IN_2082.toISOString());
      expect(invoice.line_items).toEqual([
        {
          line_number: 1,
          line_type: 'ITEM',
          product_id: expect.any(String) as string,
          product_name: 'Basmati Rice 5kg',
          hs_code: null,
          quantity: 2,
          unit_price_npr: 565,
          line_discount_npr: 0,
          taxable_amount_npr: 1000,
          vat_rate_percent: 13,
          vat_amount_npr: 130,
          line_total_npr: 1130,
        },
      ]);
      expectConsistent(invoice, 1130);
    });

    it('taxes the shop’s own delivery charge as a line of its own', async () => {
      const vendorId = await seller();
      const target = await order(vendorId, {
        lines: [{ price: 565, quantity: 2 }],
        deliveryFee: 50,
      });

      const invoice = await issue(target);

      // 50.00 inclusive: 44.25 taxable + 5.75 VAT (44.2477… rounds half-up to 44.25).
      expect(invoice).toMatchObject({
        taxable_amount_npr: 1044.25,
        vat_amount_npr: 135.75,
        delivery_charge_npr: 50,
        delivery_charged_by: 'VENDOR',
        grand_total_npr: 1180,
        amount_in_words: 'Rupees One Thousand One Hundred Eighty Only',
      });
      expect(invoice.line_items[1]).toMatchObject({
        line_number: 2,
        line_type: 'DELIVERY',
        product_id: null,
        taxable_amount_npr: 44.25,
        vat_amount_npr: 5.75,
        line_total_npr: 50,
      });
      expectConsistent(invoice, 1180);
    });

    it('keeps a fleet delivery charge outside the seller’s taxable sales, and inside the total', async () => {
      const vendorId = await seller();
      const target = await order(vendorId, {
        lines: [{ price: 565, quantity: 2 }],
        deliveryFee: 50,
        fulfillment: 'PLATFORM_FLEET',
      });

      const invoice = await issue(target);

      expect(invoice).toMatchObject({
        taxable_amount_npr: 1000,
        vat_amount_npr: 130,
        delivery_charge_npr: 50,
        delivery_charged_by: 'PLATFORM',
        grand_total_npr: 1180,
      });
      expect(invoice.line_items).toHaveLength(1);
      expectConsistent(invoice, 1180);
    });

    it('issues a PAN invoice with no VAT for a seller that is not VAT registered', async () => {
      const vendorId = await seller({ vat: false });
      const target = await order(vendorId, { lines: [{ price: 565, quantity: 2 }] });

      const invoice = await issue(target);

      expect(invoice).toMatchObject({
        seller_is_vat_registered: false,
        seller_tax_id: '302118845',
        taxable_amount_npr: 0,
        vat_rate_percent: 0,
        vat_amount_npr: 0,
        exempt_amount_npr: 1180,
        grand_total_npr: 1180,
      });
      expect(invoice.line_items.every((line) => line.vat_amount_npr === 0)).toBe(true);
      expectConsistent(invoice, 1180);
    });

    it('lowers the taxable amount by the whole campaign discount: 1000 − 190 + 50 = 860', async () => {
      const vendorId = await seller();
      const target = await order(vendorId, {
        lines: [{ price: 1000, quantity: 1 }],
        deliveryFee: 50,
        discount: { total: 190, vendorShare: 145 },
      });

      const invoice = await issue(target);

      // Goods 810.00 inclusive: 716.81 + 93.19. Delivery 50.00: 44.25 + 5.75.
      expect(invoice).toMatchObject({
        subtotal_npr: 1000,
        discount_npr: 190,
        taxable_amount_npr: 761.06,
        vat_amount_npr: 98.94,
        grand_total_npr: 860,
        amount_in_words: 'Rupees Eight Hundred Sixty Only',
      });
      expectConsistent(invoice, 860);
    });

    it('adds up to the paisa where the lines and the discount do not divide evenly', async () => {
      const vendorId = await seller();
      const target = await order(vendorId, {
        lines: [
          { price: 33.33, quantity: 1 },
          { price: 33.33, quantity: 1 },
          { price: 33.34, quantity: 1 },
          { price: 0.07, quantity: 3 },
        ],
        deliveryFee: 17.77,
        discount: { total: 10, vendorShare: 5 },
      });
      const paid = (paisa(100.21) - paisa(10) + paisa(17.77)) / 100;

      const invoice = await issue(target);

      // The discount is spread in whole paisa and none is lost.
      expect(invoice.line_items.reduce((sum, line) => sum + paisa(line.line_discount_npr), 0)).toBe(
        1000,
      );
      expectConsistent(invoice, paid);
      // The header is the sum of the lines; splitting the total once can differ by a paisa or two.
      const once = Math.round((paisa(paid) * 100) / 113);
      expect(Math.abs(paisa(invoice.taxable_amount_npr) - once)).toBeLessThanOrEqual(
        invoice.line_items.length,
      );
      expect(invoice.amount_in_words).toBe('Rupees One Hundred Seven and Paisa Ninety Eight Only');
    });

    it('is a copy: a renamed product, a new PAN and a new address do not reach it', async () => {
      const vendorId = await seller();
      const target = await order(vendorId, {
        lines: [{ price: 300, quantity: 1, name: 'Ilam Tea' }],
      });
      const invoice = await issue(target);

      await db
        .update(vendors)
        .set({ tax_id: '609987712', legal_name: 'Another Name', is_vat_registered: false })
        .where(eq(vendors.id, vendorId));
      await db
        .update(orderItems)
        .set({ product_name: 'Renamed' })
        .where(eq(orderItems.order_id, target.id));

      const [stored] = await db.select().from(invoices).where(eq(invoices.id, invoice.id));
      expect(stored).toEqual(invoice);
      expect(stored?.line_items[0]?.product_name).toBe('Ilam Tea');
      // The same order again answers with that invoice, not a new one under the new PAN.
      expect((await result(target)).status).toBe('REPLAYED');
    });

    it('names an unnamed customer "Customer"', async () => {
      const vendorId = await seller();
      const target = await order(vendorId);
      await db.update(users).set({ first_name: null }).where(eq(users.id, target.customer_id));

      expect((await issue(target)).buyer_name).toBe('Customer');
    });
  });

  describe('when no invoice is issued', () => {
    it('issues none for a seller without a PAN, and takes no number', async () => {
      const vendorId = await seller({ pan: null });
      const target = await order(vendorId);

      expect(await result(target)).toEqual({
        status: 'SELLER_HAS_NO_PAN',
        invoice: null,
        replayed: false,
      });
      expect(await invoicesOf(vendorId)).toEqual([]);
      expect(await counterOf(vendorId, '2082/083')).toBeUndefined();
    });

    it('issues none for an order that is not DELIVERED', async () => {
      const vendorId = await seller();
      const target = await order(vendorId, { delivered: false });

      await expect(result(target)).rejects.toBeInstanceOf(InvoiceNotIssuableError);
      expect(await invoicesOf(vendorId)).toEqual([]);
      expect(await counterOf(vendorId, '2082/083')).toBeUndefined();
    });

    it('refuses an order whose lines do not add up to what the customer paid, and burns no number', async () => {
      const vendorId = await seller();
      await issue(await order(vendorId));
      const target = await order(vendorId, { lines: [{ price: 500, quantity: 2 }] });
      // The order says 1000 of goods; its lines now say 1200.
      await db
        .update(orderItems)
        .set({ unit_price_npr: 600 })
        .where(eq(orderItems.order_id, target.id));

      await expect(result(target)).rejects.toThrow(/customer paid/);

      expect(await counterOf(vendorId, '2082/083')).toBe(1);
      expect((await issue(await order(vendorId))).bill_number).toBe(2);
    });
  });

  describe('the Bill Number', () => {
    it('answers a second call for the same order with the same invoice and takes no number', async () => {
      const vendorId = await seller();
      const target = await order(vendorId);
      const first = await issue(target);

      const again = await Promise.all([result(target), result(target), result(target)]);

      for (const replay of again) {
        expect(replay).toMatchObject({ status: 'REPLAYED', replayed: true });
        expect(replay.invoice?.id).toBe(first.id);
      }
      expect(await invoicesOf(vendorId)).toHaveLength(1);
      expect(await counterOf(vendorId, '2082/083')).toBe(1);
    });

    it('issues one invoice when the same order is invoiced five times at once without the order lock', async () => {
      const vendorId = await seller();
      // The seller's counter already exists, so nothing but its row lock can serialise the five.
      await issue(await order(vendorId));
      const target = await order(vendorId);

      const results = await Promise.all(
        [1, 2, 3, 4, 5].map(() =>
          db.transaction((tx) => generateFiscalInvoice(tx, target, IN_2082)),
        ),
      );

      expect(results.filter((one) => one.status === 'ISSUED')).toHaveLength(1);
      expect(new Set(results.map((one) => one.invoice?.id)).size).toBe(1);
      expect(results[0]?.invoice?.bill_number).toBe(2);
      expect(await invoicesOf(vendorId)).toHaveLength(2);
      expect(await counterOf(vendorId, '2082/083')).toBe(2);
    });

    it('gives 20 simultaneous deliveries of one shop the numbers 1 to 20, with no gap or duplicate', async () => {
      const vendorId = await seller();
      const delivered: Order[] = [];
      for (let i = 0; i < 20; i += 1) delivered.push(await order(vendorId));

      const issued = await Promise.all(delivered.map((target) => issue(target)));

      const numbers = issued.map((invoice) => invoice.bill_number).sort((a, b) => a - b);
      expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      expect(new Set(issued.map((invoice) => invoice.invoice_sequence)).size).toBe(20);
      expect((await invoicesOf(vendorId)).map((invoice) => invoice.bill_number)).toEqual(numbers);
      expect(await counterOf(vendorId, '2082/083')).toBe(20);
    });

    it('a delivery that rolls back consumes no number', async () => {
      const vendorId = await seller();
      await issue(await order(vendorId));
      const lost = await order(vendorId);

      await expect(
        db.transaction(async (tx) => {
          const { invoice } = await generateFiscalInvoice(tx, lost, IN_2082);
          expect(invoice?.bill_number).toBe(2);
          throw new Error('the delivery failed after its invoice');
        }),
      ).rejects.toThrow('the delivery failed');

      expect(await counterOf(vendorId, '2082/083')).toBe(1);
      expect((await issue(await order(vendorId))).bill_number).toBe(2);
      expect((await invoicesOf(vendorId)).map((invoice) => invoice.bill_number)).toEqual([1, 2]);
    });

    it('numbers each seller on its own', async () => {
      const [first, second] = [await seller(), await seller()];

      await issue(await order(first));
      await issue(await order(first));
      const other = await issue(await order(second));

      expect(other.bill_number).toBe(1);
      expect(await counterOf(first, '2082/083')).toBe(2);
      expect(await counterOf(second, '2082/083')).toBe(1);
    });

    it('starts again at 1 on 1 Shrawan, decided by the issue time in Nepal Time', async () => {
      const vendorId = await seller();
      // 1 Shrawan 2082 is 17 July 2025: it begins at 18:15 UTC on the 16th.
      const lastMinuteOfAshadh = new Date('2025-07-16T18:14:00.000Z');
      const firstMinuteOfShrawan = new Date('2025-07-16T18:15:00.000Z');

      await issue(await order(vendorId), new Date('2025-07-10T06:00:00.000Z'));
      const old = await issue(await order(vendorId), lastMinuteOfAshadh);
      const fresh = await issue(await order(vendorId), firstMinuteOfShrawan);

      expect(old).toMatchObject({
        fiscal_year: '2081/082',
        bill_number: 2,
        invoice_sequence: 'HP-2081-000002',
        issued_date_bs: '2082-03-32',
      });
      expect(fresh).toMatchObject({
        fiscal_year: '2082/083',
        bill_number: 1,
        invoice_sequence: 'HP-2082-000001',
        issued_date_bs: '2082-04-01',
      });
    });

    it('stamps the database clock when no issue time is given', async () => {
      const vendorId = await seller();
      const before = Date.now();

      const invoice = await issue(await order(vendorId), null);

      expect(Math.abs(invoice.issued_at.getTime() - before)).toBeLessThan(60_000);
      expect(invoice.invoice_sequence).toMatch(/^HP-\d{4}-000001$/);
    });
  });

  describe('sealed by the database', () => {
    it('refuses UPDATE, DELETE and TRUNCATE on invoices', async () => {
      const vendorId = await seller();
      const invoice = await issue(await order(vendorId));

      for (const column of [
        { grand_total_npr: 1 },
        { bill_number: 99 },
        { seller_tax_id: '609987712' },
        { amount_in_words: 'Rupees One Only' },
        { line_items: [] },
      ]) {
        expect(
          await refusal(db.update(invoices).set(column).where(eq(invoices.id, invoice.id))),
        ).toContain('invoices are immutable (UPDATE rejected)');
      }
      expect(await refusal(db.delete(invoices).where(eq(invoices.id, invoice.id)))).toContain(
        'invoices are immutable (DELETE rejected)',
      );
      expect(await refusal(db.execute(sql`TRUNCATE invoices`))).toContain(
        'invoices are immutable (TRUNCATE rejected)',
      );
      const [stored] = await db.select().from(invoices).where(eq(invoices.id, invoice.id));
      expect(stored).toEqual(invoice);
    });

    it('lets the counter do nothing but count up by one', async () => {
      const vendorId = await seller();
      await issue(await order(vendorId));
      const mine = and(
        eq(invoiceSequences.vendor_id, vendorId),
        eq(invoiceSequences.fiscal_year, '2082/083'),
      );

      for (const last_number of [0, 1, 3, 50]) {
        expect(
          await refusal(db.update(invoiceSequences).set({ last_number }).where(mine)),
        ).toContain('only counts up by one');
      }
      expect(await refusal(db.delete(invoiceSequences).where(mine))).toContain(
        'only counts up by one',
      );
      expect(await refusal(db.execute(sql`TRUNCATE invoice_sequences`))).toContain(
        'only counts up by one',
      );
      expect(
        await refusal(
          db.insert(invoiceSequences).values({
            vendor_id: await seller(),
            fiscal_year: '2082/083',
            document_type: 'INVOICE',
            last_number: 41,
          }),
        ),
      ).toContain('starts at 0');
      expect(await counterOf(vendorId, '2082/083')).toBe(1);
    });

    it('refuses a row whose VAT split, seller or number does not hold', async () => {
      const vendorId = await seller();
      const invoice = await issue(await order(vendorId));
      const other = await order(vendorId);
      const row = {
        ...invoice,
        id: undefined,
        order_id: other.id,
        customer_id: other.customer_id,
        bill_number: 7,
        invoice_sequence: 'HP-2082-000007',
      };
      const insert = (change: Partial<InvoiceRow>) =>
        refusal(db.insert(invoices).values({ ...row, ...change, id: undefined }));

      expect(await insert({ order_id: invoice.order_id })).toContain('invoices_order_invoice_uidx');
      expect(await insert({ bill_number: invoice.bill_number })).toContain(
        'invoices_bill_number_key',
      );
      // One paisa of VAT that the total does not contain.
      expect(await insert({ vat_amount_npr: invoice.vat_amount_npr + 0.01 })).toContain(
        'invoices_vat_split_total_check',
      );
      expect(await insert({ grand_total_npr: invoice.grand_total_npr - 0.01 })).toContain(
        'invoices_',
      );
      // A seller that is not VAT registered cannot show VAT.
      expect(await insert({ seller_is_vat_registered: false })).toContain(
        'invoices_vat_amounts_check',
      );
      expect(await insert({ seller_tax_id: '12345' })).toContain('invoices_seller_tax_id_check');
      expect(await insert({ line_items: [] })).toContain('invoices_line_items_check');
      expect(await insert({ amount_in_words: ' ' })).toContain('invoices_header_text_check');
      expect(await insert({ delivery_charged_by: 'RIDER' as never })).toContain(
        'invoices_delivery_charged_by_check',
      );
      // And the row itself, untouched, is acceptable: the refusals above were the changes.
      expect(await insert({})).toBe('accepted');
    });
  });
});
