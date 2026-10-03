import { and, eq, isNull } from 'drizzle-orm';

import { createDatabase, type Database } from '../client';
import { categories, customerAddresses, products, users, vendors } from '../schema';
import { describeDatabaseUrl, requireDatabaseUrl } from './database-url';

/*
 * Development fixtures for the Kathmandu valley. Re-runnable: the users, vendors and products are
 * skipped if the marker user already exists; the category taxonomy (Phase 17) is added to any
 * database that lacks it. Never runs when NODE_ENV=production.
 */

const MARKER_PHONE = '+9779800000001';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Phase 17: a small Master Category Taxonomy, and which seeded product belongs where. */
const SEED_ROOT = { name: 'Groceries', slug: 'groceries' };
const SEED_SUBCATEGORIES = [
  { name: 'Rice, Flour & Pulses', slug: 'rice-flour-pulses', product: 'Basmati Rice 5kg' },
  { name: 'Noodles & Snacks', slug: 'noodles-snacks', product: 'Wai Wai Noodles (pack of 30)' },
  { name: 'Tea & Coffee', slug: 'tea-coffee', product: 'Ilam Tea 500g' },
  { name: 'Dairy', slug: 'dairy', product: 'Juju Dhau (clay pot)' },
  { name: 'Fresh Vegetables', slug: 'fresh-vegetables', product: 'Organic Rayo ko Saag (bunch)' },
  { name: 'Honey & Spreads', slug: 'honey-spreads', product: 'Local Honey 500g' },
] as const;

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
        .where(and(eq(products.name, sub.product), isNull(products.category_id)));
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
      await seedTaxonomy(db);
      console.info(
        `[db] ${describeDatabaseUrl(url)} already seeded; category taxonomy ensured, nothing else to do`,
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

    await seedTaxonomy(db);
    console.info(`[db] seeded development fixtures into ${describeDatabaseUrl(url)}`);
  } finally {
    await db.$client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
