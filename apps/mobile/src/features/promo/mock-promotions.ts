import { NO_VENDOR_EXTRAS, type ExtrasSubject, type VendorExtras } from './promo-model';

/**
 * TEMPORARY MOCK DATA (STATE_HANDOFF §8Z.3, §8Z.4). The API serves no shop covers, ratings,
 * preparation times, costs or offer labels yet, so this file invents them for the seeded shops. It
 * is the only place that does: delete it once `vendorExtras` can read real responses.
 *
 * The Home banners and Featured Offers are no longer invented here (2026-10-20): they come only
 * from GET /api/home/promotions (useHomePromotions), so an empty database shows none.
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
  return { ...mockExtras(vendor), ...ratingOf(vendor) };
}

/**
 * 2026-10-21 (Task 5): a shop's rating is always the server's (the average of its published
 * customer ratings), never a mock one; a shop without one shows no rating.
 */
function ratingOf(vendor: ExtrasSubject): Pick<VendorExtras, 'rating_average' | 'rating_count'> {
  const count = vendor.rating_count ?? 0;
  return count > 0 && vendor.rating_average != null
    ? { rating_average: vendor.rating_average, rating_count: count }
    : { rating_average: null, rating_count: null };
}

function mockExtras(vendor: ExtrasSubject): VendorExtras {
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
