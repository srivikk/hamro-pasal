import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { createDatabase, type Database } from '../client';
import { categories, customerAddresses, products, users, vendors } from '../schema';
import { describeDatabaseUrl, requireDatabaseUrl } from '../database-url';
import { seedShowcase } from './seed-showcase';

/*
 * Development fixtures for the Kathmandu valley. Re-runnable: the users, vendors and products are
 * skipped if the marker user already exists; the category taxonomy (Phase 17), the Thamel
 * shop's five-product catalogue and the showcase shops (seed-showcase.ts) are added to any
 * database that lacks them. Never runs when NODE_ENV=production.
 *
 * There are no passwords: every account signs in with a +977 OTP (SPEC), which SMS_PROVIDER=MOCK
 * prints to the API log.
 */

const MARKER_PHONE = '+9779800000001';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Phase 17: a small Master Category Taxonomy, and which seeded product belongs where. */
const SEED_ROOT = { name: 'Groceries', slug: 'groceries' };
const SEED_SUBCATEGORIES = [
  {
    name: 'Rice, Flour & Pulses',
    slug: 'rice-flour-pulses',
    products: ['Basmati Rice 5kg', 'Masoor Dal 1kg'],
  },
  { name: 'Noodles & Snacks', slug: 'noodles-snacks', products: ['Wai Wai Noodles (pack of 30)'] },
  { name: 'Tea & Coffee', slug: 'tea-coffee', products: ['Ilam Tea 500g'] },
  { name: 'Dairy', slug: 'dairy', products: ['Juju Dhau (clay pot)', 'DDC Ghee 500ml'] },
  {
    name: 'Fresh Vegetables',
    slug: 'fresh-vegetables',
    products: ['Organic Rayo ko Saag (bunch)'],
  },
  { name: 'Honey & Spreads', slug: 'honey-spreads', products: ['Local Honey 500g'] },
] as const;

/** The shop a full local run orders from: it ends up with five products in stock. */
const THAMEL_VENDOR_PHONE = '+9779800000011';
const THAMEL_EXTRA_PRODUCTS = [
  { name: 'Masoor Dal 1kg', price_npr: 220, stock_quantity: 50 },
  { name: 'DDC Ghee 500ml', price_npr: 750, stock_quantity: 20 },
] as const;

/** Idempotent: a product the shop already has (by name) is left as it is. */
async function seedThamelCatalogue(db: Database): Promise<void> {
  const [thamel] = await db
    .select({ id: vendors.id })
    .from(vendors)
    .where(eq(vendors.phone, THAMEL_VENDOR_PHONE));
  if (thamel === undefined) return;
  await db
    .insert(products)
    .values(THAMEL_EXTRA_PRODUCTS.map((product) => ({ ...product, vendor_id: thamel.id })))
    .onConflictDoNothing({ target: [products.vendor_id, products.name] });
}

/**
 * Idempotent: categories are matched by slug, and only seeded products that have no category yet
 * are mapped (an admin's later changes are never overwritten).
 */
async function seedTaxonomy(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(categories).values(SEED_ROOT).onConflictDoNothing({ target: categories.slug });
    const [root] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.slug, SEED_ROOT.slug));
    if (root === undefined) throw new Error('Seed root category was not created');

    for (const [index, sub] of SEED_SUBCATEGORIES.entries()) {
      await tx
        .insert(categories)
        .values({ name: sub.name, slug: sub.slug, parent_id: root.id, display_order: index + 1 })
        .onConflictDoNothing({ target: categories.slug });
      const [category] = await tx
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.slug, sub.slug));
      if (category === undefined) throw new Error(`Seed category ${sub.slug} was not created`);
      await tx
        .update(products)
        .set({ category_id: category.id })
        .where(and(inArray(products.name, [...sub.products]), isNull(products.category_id)));
    }
  });
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed development fixtures with NODE_ENV=production');
  }

  const url = requireDatabaseUrl();
  const db = createDatabase(url);

  try {
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.phone, MARKER_PHONE));
    if (existing.length > 0) {
      await seedThamelCatalogue(db);
      await seedTaxonomy(db);
      await seedShowcase(db);
      await seedTaxIdentities(db);
      await seedDefaultPricingPlan(db);
      console.info(
        `[db] ${describeDatabaseUrl(url)} already seeded; taxonomy, the Thamel catalogue and the showcase shops ensured, nothing else to do`,
      );
      return;
    }

    await db.transaction(async (tx) => {
      const [aarav, sita, ram, maya, hari] = await tx
        .insert(users)
        .values([
          { phone: MARKER_PHONE, role: 'CUSTOMER', first_name: 'Aarav', last_name: 'Shrestha' },
          { phone: '+9779800000002', role: 'CUSTOMER', first_name: 'Sita', last_name: 'Gurung' },
          { phone: '+9779800000011', role: 'VENDOR', first_name: 'Ram', last_name: 'Maharjan' },
          { phone: '+9779800000012', role: 'VENDOR', first_name: 'Maya', last_name: 'Shakya' },
          { phone: '+9779800000013', role: 'VENDOR', first_name: 'Hari', last_name: 'Thapa' },
          { phone: '+9779800000021', role: 'DRIVER', first_name: 'Bikash', last_name: 'Tamang' },
          { phone: '+9779800000099', role: 'SUPER_ADMIN', first_name: 'Platform', last_name: null },
        ])
        .returning();
      if (!aarav || !sita || !ram || !maya || !hari) {
        throw new Error('Seed users were not created');
      }

      await tx.insert(customerAddresses).values([
        {
          user_id: aarav.id,
          province_id: 3,
          district_string: 'Kathmandu',
          municipality_palika_string: 'Kathmandu Metropolitan City',
          ward_number: 26,
          tole_locality: 'Thamel',
          landmark: 'Near Kathmandu Guest House',
          exact_lat: 27.7149,
          exact_lng: 85.3106,
        },
        {
          user_id: sita.id,
          province_id: 3,
          district_string: 'Lalitpur',
          municipality_palika_string: 'Lalitpur Metropolitan City',
          ward_number: 16,
          tole_locality: 'Pulchowk',
          landmark: 'Opposite Pulchowk Engineering Campus',
          exact_lat: 27.6784,
          exact_lng: 85.3188,
        },
      ]);

      const [thamel, patan, bhaktapur] = await tx
        .insert(vendors)
        .values([
          {
            user_id: ram.id,
            business_name: 'Thamel Kirana Pasal',
            phone: ram.phone,
            status: 'LIVE',
            pricing_model: 'COMMISSION',
            commission_rate: 0.1,
            delivery_scope: 'RADIUS_BOUND',
            fulfillment_mode: 'SELF_DELIVERY',
            radius_km: 5,
            municipality_palika_string: 'Kathmandu Metropolitan City',
            min_order_value: 500,
            base_delivery_fee_npr: 50,
            location: { x: 85.3123, y: 27.7154 },
          },
          {
            user_id: maya.id,
            business_name: 'Patan Organic Store',
            phone: maya.phone,
            status: 'LIVE',
            pricing_model: 'SUBSCRIPTION',
            lock_in_expiry: new Date(Date.now() + 90 * DAY_MS),
            commission_rate: 0,
            delivery_scope: 'CITY_WIDE',
            fulfillment_mode: 'PLATFORM_FLEET',
            radius_km: 8,
            municipality_palika_string: 'Lalitpur Metropolitan City',
            min_order_value: 800,
            base_delivery_fee_npr: 80,
            location: { x: 85.3253, y: 27.6727 },
          },
          {
            user_id: hari.id,
            business_name: 'Bhaktapur Juju Dhau Bhandar',
            phone: hari.phone,
            status: 'APPROVED',
            pricing_model: null,
            commission_rate: 0.08,
            delivery_scope: 'NATION_WIDE',
            fulfillment_mode: 'SELF_DELIVERY',
            radius_km: 10,
            municipality_palika_string: 'Bhaktapur Municipality',
            min_order_value: 300,
            base_delivery_fee_npr: 150,
            location: { x: 85.4298, y: 27.671 },
          },
        ])
        .returning();
      if (!thamel || !patan || !bhaktapur) {
        throw new Error('Seed vendors were not created');
      }

      await tx.insert(products).values([
        {
          vendor_id: thamel.id,
          name: 'Wai Wai Noodles (pack of 30)',
          price_npr: 600,
          stock_quantity: 40,
        },
        { vendor_id: thamel.id, name: 'Basmati Rice 5kg', price_npr: 1150, stock_quantity: 25 },
        { vendor_id: thamel.id, name: 'Ilam Tea 500g', price_npr: 450, stock_quantity: 60 },
        {
          vendor_id: patan.id,
          name: 'Organic Rayo ko Saag (bunch)',
          price_npr: 60,
          stock_quantity: 80,
        },
        { vendor_id: patan.id, name: 'Local Honey 500g', price_npr: 900, stock_quantity: 15 },
        {
          vendor_id: bhaktapur.id,
          name: 'Juju Dhau (clay pot)',
          price_npr: 250,
          stock_quantity: 30,
        },
      ]);
    });

    await seedThamelCatalogue(db);
    await seedTaxonomy(db);
    await seedShowcase(db);
    await seedTaxIdentities(db);
    await seedDefaultPricingPlan(db);
    console.info(`[db] seeded development fixtures into ${describeDatabaseUrl(url)}`);
  } finally {
    await db.$client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

/**
 * Phase 25: every seeded LIVE shop gets a dummy PAN, verified by the seeded Super Admin, so the
 * nightly VENDOR_COMPLIANCE_SWEEP leaves it LIVE and it can receive payouts. Idempotent: only a
 * LIVE vendor without a PAN is touched (so a PAN typed in the app is never overwritten), and it
 * runs on an already seeded database too. The PAN is "9" + the last eight digits of the shop's
 * phone: nine digits, unique per seeded shop, and obviously not a real number.
 */
async function seedTaxIdentities(db: Database): Promise<void> {
  await db.execute(sql`
    UPDATE vendors
       SET tax_id = '9' || right(vendors.phone, 8),
           pan_verified_at = now(),
           pan_verified_by_user_id = admin.id
      FROM users AS admin
     WHERE admin.phone = '+9779800000099'
       AND vendors.status = 'LIVE'
       AND vendors.tax_id IS NULL`);
}

/**
 * The default pricing plan a new shop takes (2026-10-20): admin approval makes a shop LIVE, and a
 * LIVE shop needs a pricing model, which it takes from the one default Commission plan. Without it
 * a freshly wiped database could approve no shop. 10%, like the seeded Thamel shop. Idempotent:
 * nothing is written while any plan is the default (a Super Admin may have published another).
 */
async function seedDefaultPricingPlan(db: Database): Promise<void> {
  await db.execute(sql`
    INSERT INTO pricing_plans (name, model, commission_rate, is_offered, is_default, created_by_user_id)
    SELECT 'Standard Commission', 'COMMISSION', 10, true, true, admin.id
      FROM users AS admin
     WHERE admin.phone = '+9779800000099'
       AND NOT EXISTS (SELECT 1 FROM pricing_plans WHERE is_default)`);
}
