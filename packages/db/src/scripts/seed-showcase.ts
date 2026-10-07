import { eq, inArray } from 'drizzle-orm';

import type { Database, Executor } from '../client';
import { categories, products, users, vendors } from '../schema';

/*
 * More shops for the customer app's Home screen: seven LIVE vendors across the Kathmandu valley
 * (Kathmandu, Lalitpur, Bhaktapur, Kirtipur) at different distances and with every delivery
 * scope, plus three more category trees, so the feed's delivery rules, the category filter, the
 * sort sheet and the promotion targets have something to work on.
 *
 * Idempotent and additive: categories are matched by slug, accounts and shops by phone, products
 * by (shop, name). Nothing that already exists is changed.
 */

interface ShowcaseCategory {
  name: string;
  slug: string;
  display_order: number;
  children: readonly { name: string; slug: string }[];
}

/** Roots beside the Phase 17 "Groceries" (display order 0). */
export const SHOWCASE_CATEGORIES: readonly ShowcaseCategory[] = [
  {
    name: 'Electronics',
    slug: 'electronics',
    display_order: 1,
    children: [
      { name: 'Mobile Accessories', slug: 'mobile-accessories' },
      { name: 'Home Appliances', slug: 'home-appliances' },
    ],
  },
  {
    name: 'Festive & Dashain',
    slug: 'festive',
    display_order: 2,
    children: [
      { name: 'Puja Samagri', slug: 'puja-samagri' },
      { name: 'Gifts & Sweets', slug: 'gifts-sweets' },
    ],
  },
  {
    name: 'Snacks',
    slug: 'snacks',
    display_order: 3,
    children: [
      { name: 'Chips & Namkeen', slug: 'chips-namkeen' },
      { name: 'Biscuits & Cookies', slug: 'biscuits-cookies' },
    ],
  },
];

interface ShowcaseProduct {
  name: string;
  /** The slug of a showcase category or of a Phase 17 grocery subcategory. */
  category: string;
  price_npr: number;
  stock_quantity: number;
  unit?: string;
  description: string;
}

interface ShowcaseVendor {
  phone: string;
  owner: { first_name: string; last_name: string };
  business_name: string;
  delivery_scope: 'RADIUS_BOUND' | 'CITY_WIDE' | 'NATION_WIDE';
  fulfillment_mode: 'SELF_DELIVERY' | 'PLATFORM_FLEET';
  radius_km: number;
  municipality_palika_string: string;
  commission_rate: number;
  min_order_value: number;
  base_delivery_fee_npr: number;
  /** x = longitude, y = latitude. */
  location: { x: number; y: number };
  products: readonly ShowcaseProduct[];
}

/**
 * Distances are from the seeded customer in Thamel (27.7149, 85.3106). Seen from there, with the
 * 10% GPS buffer of SPEC §2: New Road, Asan and Putalisadak deliver; Boudha (about 5.1 km on a
 * 4 km radius) and Kirtipur (about 5.2 km on 2 km) do not; Jawalakhel is city-wide in Lalitpur and
 * Bhaktapur is about 12 km away on a 6 km radius, so both are "Explore Further". From the seeded
 * Lalitpur customer (Pulchowk) the picture flips.
 */
export const SHOWCASE_VENDORS: readonly ShowcaseVendor[] = [
  {
    phone: '+9779800000014',
    owner: { first_name: 'Suresh', last_name: 'Tuladhar' },
    business_name: 'New Road Electronics',
    delivery_scope: 'RADIUS_BOUND',
    fulfillment_mode: 'PLATFORM_FLEET',
    radius_km: 8,
    municipality_palika_string: 'Kathmandu Metropolitan City',
    commission_rate: 0.08,
    min_order_value: 1000,
    base_delivery_fee_npr: 100,
    location: { x: 85.3105, y: 27.704 },
    products: [
      {
        name: 'USB-C Fast Charger 25W',
        category: 'mobile-accessories',
        price_npr: 1200,
        stock_quantity: 35,
        description: 'Wall charger with a 1 m USB-C cable.',
      },
      {
        name: 'Tempered Glass Screen Guard',
        category: 'mobile-accessories',
        price_npr: 250,
        stock_quantity: 120,
        description: 'Fitted in the shop on request; say your phone model in the order.',
      },
      {
        name: 'Wireless Earbuds',
        category: 'mobile-accessories',
        price_npr: 3200,
        stock_quantity: 18,
        unit: 'pair',
        description: 'Bluetooth 5.3 earbuds with a charging case.',
      },
      {
        name: 'Electric Kettle 1.5L',
        category: 'home-appliances',
        price_npr: 1850,
        stock_quantity: 22,
        description: 'Stainless steel, cuts off when the water boils.',
      },
      {
        name: 'Rice Cooker 1.8L',
        category: 'home-appliances',
        price_npr: 3400,
        stock_quantity: 0,
        description: 'Cooks for a family of five. Back in stock soon.',
      },
    ],
  },
  {
    phone: '+9779800000015',
    owner: { first_name: 'Laxmi', last_name: 'Manandhar' },
    business_name: 'Asan Masala & Snacks',
    delivery_scope: 'RADIUS_BOUND',
    fulfillment_mode: 'SELF_DELIVERY',
    radius_km: 3,
    municipality_palika_string: 'Kathmandu Metropolitan City',
    commission_rate: 0.1,
    min_order_value: 300,
    base_delivery_fee_npr: 40,
    location: { x: 85.312, y: 27.7075 },
    products: [
      {
        name: 'Titaura Mix 200g',
        category: 'chips-namkeen',
        price_npr: 180,
        stock_quantity: 90,
        unit: 'pack',
        description: 'Sweet, sour and spicy lapsi titaura.',
      },
      {
        name: 'Dalmoth 400g',
        category: 'chips-namkeen',
        price_npr: 220,
        stock_quantity: 70,
        unit: 'pack',
        description: 'Crunchy lentil and peanut mix.',
      },
      {
        name: 'Lapsi Candy 250g',
        category: 'chips-namkeen',
        price_npr: 150,
        stock_quantity: 60,
        unit: 'pack',
        description: 'Hog plum candy from Kavre.',
      },
      {
        name: 'Digestive Biscuits (pack of 6)',
        category: 'biscuits-cookies',
        price_npr: 360,
        stock_quantity: 45,
        unit: 'pack',
        description: 'Six rolls of wheat digestive biscuits.',
      },
      {
        name: 'Chiura (Beaten Rice) 1kg',
        category: 'rice-flour-pulses',
        price_npr: 140,
        stock_quantity: 100,
        unit: 'kg',
        description: 'Thin beaten rice for khaja and Dashain feasts.',
      },
    ],
  },
  {
    phone: '+9779800000016',
    owner: { first_name: 'Pemba', last_name: 'Sherpa' },
    business_name: 'Boudha Fresh Mart',
    delivery_scope: 'RADIUS_BOUND',
    fulfillment_mode: 'SELF_DELIVERY',
    radius_km: 4,
    municipality_palika_string: 'Kathmandu Metropolitan City',
    commission_rate: 0.1,
    min_order_value: 400,
    base_delivery_fee_npr: 60,
    location: { x: 85.362, y: 27.7215 },
    products: [
      {
        name: 'Fresh Tomatoes 1kg',
        category: 'fresh-vegetables',
        price_npr: 90,
        stock_quantity: 150,
        unit: 'kg',
        description: 'Local tomatoes, picked this week.',
      },
      {
        name: 'Cauliflower',
        category: 'fresh-vegetables',
        price_npr: 80,
        stock_quantity: 60,
        description: 'One medium head.',
      },
      {
        name: 'Buffalo Milk 1L',
        category: 'dairy',
        price_npr: 130,
        stock_quantity: 40,
        unit: 'litre',
        description: 'Fresh every morning from Sankhu.',
      },
      {
        name: 'Paneer 200g',
        category: 'dairy',
        price_npr: 190,
        stock_quantity: 30,
        unit: 'pack',
        description: 'Soft cottage cheese.',
      },
      {
        name: 'Sel Roti (pack of 5)',
        category: 'gifts-sweets',
        price_npr: 150,
        stock_quantity: 25,
        unit: 'pack',
        description: 'Rice-flour rings, fried the same morning.',
      },
    ],
  },
  {
    phone: '+9779800000017',
    owner: { first_name: 'Anita', last_name: 'Bajracharya' },
    business_name: 'Jawalakhel Dashain Bazaar',
    delivery_scope: 'CITY_WIDE',
    fulfillment_mode: 'PLATFORM_FLEET',
    radius_km: 6,
    municipality_palika_string: 'Lalitpur Metropolitan City',
    commission_rate: 0.1,
    min_order_value: 500,
    base_delivery_fee_npr: 70,
    location: { x: 85.313, y: 27.673 },
    products: [
      {
        name: 'Dashain Tika & Jamara Set',
        category: 'puja-samagri',
        price_npr: 350,
        stock_quantity: 80,
        unit: 'set',
        description: 'Red tika, fresh jamara and a small brass plate.',
      },
      {
        name: 'Incense Sticks (box of 12)',
        category: 'puja-samagri',
        price_npr: 120,
        stock_quantity: 200,
        unit: 'box',
        description: 'Sandalwood incense, twelve packets.',
      },
      {
        name: 'Brass Diyo',
        category: 'puja-samagri',
        price_npr: 480,
        stock_quantity: 40,
        description: 'Hand-cast oil lamp from Patan.',
      },
      {
        name: 'Dry Fruits Gift Box 500g',
        category: 'gifts-sweets',
        price_npr: 1450,
        stock_quantity: 30,
        unit: 'box',
        description: 'Cashew, almond, raisin and walnut in a gift box.',
      },
      {
        name: 'Changa (Kite) with Lattai',
        category: 'gifts-sweets',
        price_npr: 300,
        stock_quantity: 55,
        unit: 'set',
        description: 'A paper kite with a wooden spool and thread.',
      },
    ],
  },
  {
    phone: '+9779800000018',
    owner: { first_name: 'Krishna', last_name: 'Prajapati' },
    business_name: 'Bhaktapur Durbar Sweets',
    delivery_scope: 'RADIUS_BOUND',
    fulfillment_mode: 'SELF_DELIVERY',
    radius_km: 6,
    municipality_palika_string: 'Bhaktapur Municipality',
    commission_rate: 0.1,
    min_order_value: 300,
    base_delivery_fee_npr: 60,
    location: { x: 85.428, y: 27.672 },
    products: [
      {
        name: 'Lakhamari (box of 6)',
        category: 'gifts-sweets',
        price_npr: 420,
        stock_quantity: 35,
        unit: 'box',
        description: 'Crisp Newari festive sweet with a sugar glaze.',
      },
      {
        name: 'Peda 250g',
        category: 'gifts-sweets',
        price_npr: 280,
        stock_quantity: 50,
        unit: 'box',
        description: 'Milk sweet made with khuwa.',
      },
      {
        name: 'Juju Dhau (small pot)',
        category: 'dairy',
        price_npr: 150,
        stock_quantity: 45,
        unit: 'pot',
        description: 'The king of curds, set in a clay pot.',
      },
      {
        name: 'Bhuja Mix 300g',
        category: 'chips-namkeen',
        price_npr: 160,
        stock_quantity: 65,
        unit: 'pack',
        description: 'Puffed rice with peanuts and spices.',
      },
    ],
  },
  {
    phone: '+9779800000019',
    owner: { first_name: 'Rohan', last_name: 'Adhikari' },
    business_name: 'Himalayan Gadget Hub',
    delivery_scope: 'NATION_WIDE',
    fulfillment_mode: 'PLATFORM_FLEET',
    radius_km: 10,
    municipality_palika_string: 'Kathmandu Metropolitan City',
    commission_rate: 0.07,
    min_order_value: 1500,
    base_delivery_fee_npr: 150,
    location: { x: 85.323, y: 27.705 },
    products: [
      {
        name: 'Power Bank 10000mAh',
        category: 'mobile-accessories',
        price_npr: 2100,
        stock_quantity: 28,
        description: 'Two USB ports, charges a phone about twice.',
      },
      {
        name: 'Bluetooth Speaker',
        category: 'mobile-accessories',
        price_npr: 2800,
        stock_quantity: 14,
        description: 'Splash-proof, about ten hours of battery.',
      },
      {
        name: 'LED Emergency Bulb 12W',
        category: 'home-appliances',
        price_npr: 450,
        stock_quantity: 90,
        description: 'Stays lit for three hours when the power goes.',
      },
      {
        name: 'Extension Cord 4 Socket',
        category: 'home-appliances',
        price_npr: 650,
        stock_quantity: 40,
        description: 'Three metres, with a fuse and a switch.',
      },
    ],
  },
  {
    phone: '+9779800000020',
    owner: { first_name: 'Gita', last_name: 'Maharjan' },
    business_name: 'Kirtipur Kirana Pasal',
    delivery_scope: 'RADIUS_BOUND',
    fulfillment_mode: 'SELF_DELIVERY',
    radius_km: 2,
    municipality_palika_string: 'Kirtipur Municipality',
    commission_rate: 0.1,
    min_order_value: 200,
    base_delivery_fee_npr: 30,
    location: { x: 85.2775, y: 27.678 },
    products: [
      {
        name: 'Jeera Masino Rice 5kg',
        category: 'rice-flour-pulses',
        price_npr: 780,
        stock_quantity: 35,
        unit: 'bag',
        description: 'Fine-grain everyday rice.',
      },
      {
        name: 'Milk Tea Premix 500g',
        category: 'tea-coffee',
        price_npr: 380,
        stock_quantity: 40,
        unit: 'pack',
        description: 'Tea, milk powder and sugar: add hot water.',
      },
      {
        name: 'Potato Chips (pack of 10)',
        category: 'chips-namkeen',
        price_npr: 250,
        stock_quantity: 75,
        unit: 'pack',
        description: 'Ten small packets, salted.',
      },
      {
        name: 'Glucose Biscuits (pack of 12)',
        category: 'biscuits-cookies',
        price_npr: 240,
        stock_quantity: 85,
        unit: 'pack',
        description: 'The tea-time classic.',
      },
    ],
  },
];

async function ensureCategories(db: Executor): Promise<Map<string, string>> {
  for (const root of SHOWCASE_CATEGORIES) {
    await db
      .insert(categories)
      .values({ name: root.name, slug: root.slug, display_order: root.display_order })
      .onConflictDoNothing({ target: categories.slug });
    const [parent] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.slug, root.slug));
    if (parent === undefined) throw new Error(`Seed category ${root.slug} was not created`);
    for (const [index, child] of root.children.entries()) {
      await db
        .insert(categories)
        .values({ ...child, parent_id: parent.id, display_order: index + 1 })
        .onConflictDoNothing({ target: categories.slug });
    }
  }

  const slugs = [...new Set(SHOWCASE_VENDORS.flatMap((v) => v.products.map((p) => p.category)))];
  const rows = await db
    .select({ id: categories.id, slug: categories.slug })
    .from(categories)
    .where(inArray(categories.slug, slugs));
  const bySlug = new Map(rows.map((row) => [row.slug, row.id]));
  for (const slug of slugs) {
    if (!bySlug.has(slug)) throw new Error(`Seed products need the category ${slug}`);
  }
  return bySlug;
}

/** Call after the base seed and its taxonomy: the grocery subcategories must already exist. */
export async function seedShowcase(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    const categoryIds = await ensureCategories(tx);

    for (const shop of SHOWCASE_VENDORS) {
      await tx
        .insert(users)
        .values({ phone: shop.phone, role: 'VENDOR', ...shop.owner })
        .onConflictDoNothing({ target: users.phone });
      const [owner] = await tx
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(eq(users.phone, shop.phone));
      // The number belongs to someone who signed up as a customer meanwhile: leave them alone.
      if (owner?.role !== 'VENDOR') continue;

      await tx
        .insert(vendors)
        .values({
          user_id: owner.id,
          business_name: shop.business_name,
          phone: shop.phone,
          status: 'LIVE',
          pricing_model: 'COMMISSION',
          commission_rate: shop.commission_rate,
          delivery_scope: shop.delivery_scope,
          fulfillment_mode: shop.fulfillment_mode,
          radius_km: shop.radius_km,
          municipality_palika_string: shop.municipality_palika_string,
          min_order_value: shop.min_order_value,
          base_delivery_fee_npr: shop.base_delivery_fee_npr,
          location: shop.location,
        })
        .onConflictDoNothing({ target: vendors.user_id });
      const [vendor] = await tx
        .select({ id: vendors.id })
        .from(vendors)
        .where(eq(vendors.user_id, owner.id));
      if (vendor === undefined) throw new Error(`Seed shop ${shop.business_name} was not created`);

      await tx
        .insert(products)
        .values(
          shop.products.map(({ category, ...product }) => ({
            ...product,
            vendor_id: vendor.id,
            category_id: categoryIds.get(category),
          })),
        )
        .onConflictDoNothing({ target: [products.vendor_id, products.name] });
    }
  });
}
