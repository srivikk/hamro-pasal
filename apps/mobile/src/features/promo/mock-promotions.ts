import type { FeedResponse } from '@hamro-pasal/shared-types';

import {
  NO_PROMOTIONS,
  NO_VENDOR_EXTRAS,
  type ExtrasSubject,
  type HomePromotions,
  type Promotion,
  type VendorExtras,
} from './promo-model';

/**
 * TEMPORARY MOCK DATA (STATE_HANDOFF §8Z.3, §8Z.4). The API serves no banners, offers, shop
 * covers, ratings, preparation times, costs or offer labels yet, so this file invents them. It is
 * the only place that does: delete it once `homePromotions` and `vendorExtras` can read real
 * responses.
 *
 * Invented ratings and offers must never reach customers, so the mocks exist in development
 * builds only. A preview or production build gets no promotions and no extras, and every screen
 * collapses to its plain layout.
 *
 * Phase 1: every offer here is a label. Nothing in the cart or at checkout applies a discount.
 */
export const PROMO_MOCKS_ENABLED = __DEV__;

const image = (seed: string, width: number, height: number): string =>
  `https://picsum.photos/seed/hamro-pasal-${seed}/${String(width)}/${String(height)}`;

/**
 * The shops of the development seed (packages/db/src/scripts/seed.ts and seed-showcase.ts), by
 * business name: the seed's ids are random per database, its names are not. Values are chosen so
 * every sort order and every offer label below has something to show.
 */
export const MOCK_SHOPS: Readonly<Record<string, Omit<VendorExtras, 'cover_image_url'>>> = {
  'Thamel Kirana Pasal': {
    rating_average: 4.4,
    prep_minutes: 15,
    average_cost_npr: 450,
    top_offer: '10% OFF',
    offer_tags: ['10% OFF'],
    is_sponsored: false,
    rating_count: 320,
    locality: 'Thamel',
  },
  'Asan Masala & Snacks': {
    rating_average: 4.7,
    prep_minutes: 10,
    average_cost_npr: 200,
    top_offer: '10% OFF',
    offer_tags: ['10% OFF', 'Dashain Sale'],
    is_sponsored: false,
    rating_count: 540,
    locality: 'Asan',
  },
  'New Road Electronics': {
    rating_average: 4.1,
    prep_minutes: 30,
    average_cost_npr: 1800,
    top_offer: 'Flat Rs. 200 OFF',
    offer_tags: ['Flat Rs. 200 OFF', 'Dashain Sale'],
    is_sponsored: true,
    rating_count: 210,
    locality: 'New Road',
  },
  'Himalayan Gadget Hub': {
    // A new shop: no rating yet.
    rating_average: null,
    prep_minutes: 40,
    average_cost_npr: 2100,
    top_offer: 'Free delivery',
    offer_tags: ['Free delivery'],
    is_sponsored: false,
    rating_count: null,
    locality: 'Putalisadak',
  },
  'Patan Organic Store': {
    rating_average: 4.6,
    prep_minutes: 25,
    average_cost_npr: 600,
    top_offer: 'Free delivery',
    offer_tags: ['Free delivery'],
    is_sponsored: false,
    rating_count: 180,
    locality: 'Patan Dhoka',
  },
  'Jawalakhel Dashain Bazaar': {
    rating_average: 4.5,
    prep_minutes: 20,
    average_cost_npr: 400,
    top_offer: 'Dashain Sale',
    offer_tags: ['Dashain Sale', '10% OFF'],
    is_sponsored: true,
    rating_count: 95,
    locality: 'Jawalakhel',
  },
  'Boudha Fresh Mart': {
    rating_average: 3.9,
    prep_minutes: 20,
    average_cost_npr: 150,
    top_offer: null,
    offer_tags: [],
    is_sponsored: false,
    rating_count: 64,
    locality: 'Boudha',
  },
  'Kirtipur Kirana Pasal': {
    rating_average: 4,
    prep_minutes: 15,
    average_cost_npr: 300,
    top_offer: null,
    offer_tags: [],
    is_sponsored: false,
    rating_count: 8,
    locality: 'Naya Bazaar',
  },
  'Bhaktapur Durbar Sweets': {
    rating_average: 4.8,
    prep_minutes: 15,
    average_cost_npr: 280,
    top_offer: 'Buy 1 Get 1',
    offer_tags: ['Buy 1 Get 1'],
    is_sponsored: false,
    rating_count: 1250,
    locality: 'Durbar Square',
  },
};

const FALLBACK_OFFERS = ['10% OFF', 'Free delivery', 'Dashain Sale'] as const;

/** A stable number per shop id, so a shop keeps its invented values between renders and runs. */
function seedOf(id: string): number {
  let seed = 0;
  for (let index = 0; index < id.length; index += 1) {
    seed = (seed * 31 + id.charCodeAt(index)) >>> 0;
  }
  return seed;
}

/**
 * The cover, rating, offer labels, preparation time and cost of a shop. A seeded shop gets its
 * curated values; any other shop gets values derived from its id. All unknown outside development.
 */
export function vendorExtras(vendor: ExtrasSubject): VendorExtras {
  if (!PROMO_MOCKS_ENABLED) return NO_VENDOR_EXTRAS;
  const seed = seedOf(vendor.id);
  const cover_image_url = image(`shop-${String(seed % 50)}`, 800, 400);
  const curated = MOCK_SHOPS[vendor.business_name];
  if (curated !== undefined) return { ...curated, cover_image_url };
  const offer = seed % 3 === 0 ? null : (FALLBACK_OFFERS[seed % FALLBACK_OFFERS.length] ?? null);
  return {
    cover_image_url,
    // One shop in five has no rating yet, to show the card without the pill.
    rating_average: seed % 5 === 0 ? null : 3.6 + (seed % 13) / 10,
    rating_count: seed % 5 === 0 ? null : 20 + (seed % 400),
    // Only the seeded shops have a known neighbourhood.
    locality: null,
    prep_minutes: 15 + (seed % 4) * 5,
    average_cost_npr: 200 + (seed % 9) * 100,
    top_offer: offer,
    offer_tags: offer === null ? [] : [offer],
    // Only the curated shops below are sponsored.
    is_sponsored: false,
  };
}

/**
 * A mock promotion before its target is final. A SHOP promotion names the seeded shop here and
 * gets that shop's real id from the feed (`target_value` must be a vendor id, like the API's).
 */
type MockPromotion = Omit<Promotion, 'target_type' | 'target_value'> &
  (
    | { target_type: 'SHOP'; shop_name: string }
    | { target_type: 'CATEGORY' | 'DISCOUNT_TAG'; target_value: string }
    | { target_type: null }
  );

const MOCK_BANNERS: readonly (MockPromotion & { placement: 'CAROUSEL'; image_url: string })[] = [
  {
    id: 'mock-banner-festive',
    placement: 'CAROUSEL',
    image_url: image('banner-1', 960, 420),
    title: 'Dashain offers are here',
    subtitle: 'Tika, sweets and gifts from shops near you',
    target_type: 'CATEGORY',
    target_value: 'festive',
  },
  {
    id: 'mock-banner-asan',
    placement: 'CAROUSEL',
    image_url: image('banner-2', 960, 420),
    title: 'Asan Masala & Snacks',
    subtitle: 'Titaura, dalmoth and more',
    target_type: 'SHOP',
    shop_name: 'Asan Masala & Snacks',
  },
  {
    id: 'mock-banner-ten',
    placement: 'CAROUSEL',
    image_url: image('banner-3', 960, 420),
    title: '10% OFF this week',
    subtitle: 'See the shops taking part',
    target_type: 'DISCOUNT_TAG',
    target_value: '10% OFF',
  },
  {
    // Artwork only: no text over it and nowhere to go.
    id: 'mock-banner-artwork',
    placement: 'CAROUSEL',
    image_url: image('banner-4', 960, 420),
    title: null,
    subtitle: null,
    target_type: null,
  },
];

const MOCK_OFFERS: readonly (MockPromotion & { placement: 'FEATURED'; title: string })[] = [
  {
    id: 'mock-offer-ten',
    placement: 'FEATURED',
    image_url: image('offer-1', 320, 320),
    title: '10% OFF',
    subtitle: 'Selected shops',
    target_type: 'DISCOUNT_TAG',
    target_value: '10% OFF',
  },
  {
    id: 'mock-offer-free-delivery',
    placement: 'FEATURED',
    image_url: null,
    title: 'Free delivery',
    subtitle: 'Selected shops',
    target_type: 'DISCOUNT_TAG',
    target_value: 'Free delivery',
  },
  {
    id: 'mock-offer-electronics',
    placement: 'FEATURED',
    image_url: image('offer-3', 320, 320),
    title: 'Electronics',
    subtitle: 'Chargers, earbuds, kettles',
    target_type: 'CATEGORY',
    target_value: 'electronics',
  },
  {
    id: 'mock-offer-snacks',
    placement: 'FEATURED',
    image_url: image('offer-4', 320, 320),
    title: 'Snacks',
    subtitle: 'Titaura to biscuits',
    target_type: 'CATEGORY',
    target_value: 'snacks',
  },
  {
    id: 'mock-offer-new-road',
    placement: 'FEATURED',
    image_url: image('offer-5', 320, 320),
    title: 'New Road Electronics',
    subtitle: 'Visit the shop',
    target_type: 'SHOP',
    shop_name: 'New Road Electronics',
  },
  {
    id: 'mock-offer-dashain',
    placement: 'FEATURED',
    image_url: image('offer-6', 320, 320),
    title: 'Dashain Sale',
    subtitle: 'Festive deals',
    target_type: 'DISCOUNT_TAG',
    target_value: 'Dashain Sale',
  },
];

/** The mock as the API would send it. Null: its shop is not in the feed, so it is not shown. */
function resolve<Mock extends MockPromotion>(
  mock: Mock,
  shopIds: ReadonlyMap<string, string>,
): (Promotion & Pick<Mock, 'placement' | 'image_url' | 'title'>) | null {
  const { id, placement, image_url, title, subtitle } = mock;
  const base = { id, placement, image_url, title, subtitle };
  if (mock.target_type === null) return { ...base, target_type: null, target_value: null };
  if (mock.target_type !== 'SHOP') {
    return { ...base, target_type: mock.target_type, target_value: mock.target_value };
  }
  const vendorId = shopIds.get(mock.shop_name);
  return vendorId === undefined ? null : { ...base, target_type: 'SHOP', target_value: vendorId };
}

/**
 * The Home banners and featured offers. Empty outside development: both rows then hide. The feed
 * is needed only to give the SHOP mocks a real vendor id; until it has loaded they are left out.
 */
export function homePromotions(feed: FeedResponse | undefined): HomePromotions {
  if (!PROMO_MOCKS_ENABLED) return NO_PROMOTIONS;
  const shopIds = new Map(
    [...(feed?.serviceable ?? []), ...(feed?.explore_further ?? [])].map(({ vendor }) => [
      vendor.business_name,
      vendor.id,
    ]),
  );
  const present = <Item>(item: Item | null): item is Item => item !== null;
  return {
    banners: MOCK_BANNERS.map((mock) => resolve(mock, shopIds)).filter(present),
    offers: MOCK_OFFERS.map((mock) => resolve(mock, shopIds)).filter(present),
  };
}

/**
 * DISPLAY ONLY. What a mock offer label would take off a cart subtotal, in paisa: "10% OFF" is
 * that share of the subtotal, "Flat Rs. 200 OFF" that amount (never more than the subtotal). Any
 * other label ("Free delivery", "Buy 1 Get 1", "Dashain Sale") takes nothing off the subtotal
 * ("Free delivery" waives the delivery fee instead, see mockFreeDelivery). The server knows
 * nothing of this: checkout still charges the full subtotal (STATE_HANDOFF §8Z.5).
 */
export function mockShopDiscountPaisa(offer: string | null, subtotalPaisa: number): number {
  if (!PROMO_MOCKS_ENABLED || offer === null || subtotalPaisa <= 0) return 0;
  const percent = /^(\d{1,3})% OFF\b/i.exec(offer);
  if (percent !== null) {
    return Math.round((subtotalPaisa * Math.min(Number(percent[1]), 100)) / 100);
  }
  const flat = /^Flat Rs\. (\d+) OFF\b/i.exec(offer);
  if (flat !== null) return Math.min(Number(flat[1]) * 100, subtotalPaisa);
  return 0;
}

/**
 * DISPLAY ONLY. Whether a mock offer label waives the delivery fee in the cart's bill: any label
 * containing "free delivery", whatever its case. Like the discount above, the server knows
 * nothing of it and still charges the shop's delivery fee.
 */
export function mockFreeDelivery(offer: string | null): boolean {
  return PROMO_MOCKS_ENABLED && (offer?.toLowerCase().includes('free delivery') ?? false);
}
