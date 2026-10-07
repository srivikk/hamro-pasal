import { create } from 'zustand';

import type {
  AdProduct,
  AdPurchase,
  CampaignInvite,
  OfferDetails,
  VendorOffer,
} from '../features/vendor/marketing-rules';

/**
 * TEMPORARY: the Marketing tab's data on the device, so My Offers, Campaign Invites and the Ad
 * Marketplace can be built and tried before any of their backend exists (STATE_HANDOFF.md §8Z.5).
 * Development builds only. Nothing here reaches the server, no discount is applied to any order
 * and no ad is charged; it is gone on relaunch.
 */
export const VENDOR_MARKETING_MOCKS_ENABLED = __DEV__;

const SEED_OFFERS: readonly VendorOffer[] = [
  {
    id: 'offer-1',
    kind: 'FLAT',
    value: 100,
    minCartNpr: 1000,
    startsAt: '2026-10-01T04:15:00.000Z',
  },
];

const SEED_CAMPAIGNS: readonly CampaignInvite[] = [
  {
    id: 'campaign-dashain',
    name: 'Dashain 20% Mega Sale',
    kind: 'PERCENTAGE',
    value: 20,
    maxDiscountNpr: 300,
    minCartNpr: 1000,
    vendorSharePercent: 50,
    termsVersion: 1,
    startsAt: '2026-10-10T18:15:00.000Z',
    endsAt: '2026-10-25T18:14:00.000Z',
    optedInAt: null,
  },
  {
    id: 'campaign-tihar',
    name: 'Tihar 10% Festive Offer',
    kind: 'PERCENTAGE',
    value: 10,
    maxDiscountNpr: null,
    minCartNpr: 500,
    vendorSharePercent: 30,
    termsVersion: 1,
    startsAt: '2026-11-06T18:15:00.000Z',
    endsAt: '2026-11-11T18:14:00.000Z',
    optedInAt: null,
  },
];

/** The placements on sale. The 30-day carousel costs more than the sample Model B shop holds. */
export const SEED_AD_PRODUCTS: readonly AdProduct[] = [
  {
    id: 'ad-carousel-7',
    slot: 'CAROUSEL',
    billingModel: 'FLAT_RATE',
    priceNpr: 4000,
    durationDays: 7,
    budgetNpr: null,
  },
  {
    id: 'ad-carousel-30',
    slot: 'CAROUSEL',
    billingModel: 'FLAT_RATE',
    priceNpr: 15_000,
    durationDays: 30,
    budgetNpr: null,
  },
  {
    id: 'ad-search-14',
    slot: 'FEED_LISTING',
    billingModel: 'PER_ORDER_PREMIUM',
    priceNpr: 15,
    durationDays: 14,
    budgetNpr: 1500,
  },
];

const seeded = () => ({
  offers: VENDOR_MARKETING_MOCKS_ENABLED ? [...SEED_OFFERS] : [],
  campaigns: VENDOR_MARKETING_MOCKS_ENABLED ? [...SEED_CAMPAIGNS] : [],
  adProducts: VENDOR_MARKETING_MOCKS_ENABLED ? [...SEED_AD_PRODUCTS] : [],
  adPurchases: [] as AdPurchase[],
  nextId: 1,
});

export interface VendorMarketingState {
  /** The shop's running offers, newest first. An ended offer leaves the list. */
  offers: VendorOffer[];
  campaigns: CampaignInvite[];
  adProducts: AdProduct[];
  adPurchases: AdPurchase[];
  nextId: number;
  createOffer: (details: OfferDetails, nowMs: number) => void;
  /** Offers are never edited: this switches one off for future orders. */
  endOffer: (id: string) => void;
  optIn: (campaignId: string, nowMs: number) => void;
  optOut: (campaignId: string) => void;
  purchaseAd: (adProductId: string, nowMs: number) => void;
  reset: () => void;
}

export const useVendorMarketingStore = create<VendorMarketingState>()((set) => ({
  ...seeded(),
  createOffer: (details, nowMs) => {
    set(({ offers, nextId }) => ({
      offers: [
        {
          ...details,
          id: `offer-local-${String(nextId)}`,
          startsAt: new Date(nowMs).toISOString(),
        },
        ...offers,
      ],
      nextId: nextId + 1,
    }));
  },
  endOffer: (id) => {
    set(({ offers }) => ({ offers: offers.filter((offer) => offer.id !== id) }));
  },
  optIn: (campaignId, nowMs) => {
    set(({ campaigns }) => ({
      campaigns: campaigns.map((campaign) =>
        campaign.id === campaignId && campaign.optedInAt === null
          ? { ...campaign, optedInAt: new Date(nowMs).toISOString() }
          : campaign,
      ),
    }));
  },
  optOut: (campaignId) => {
    set(({ campaigns }) => ({
      campaigns: campaigns.map((campaign) =>
        campaign.id === campaignId ? { ...campaign, optedInAt: null } : campaign,
      ),
    }));
  },
  purchaseAd: (adProductId, nowMs) => {
    set(({ adPurchases, nextId }) => ({
      adPurchases: [
        ...adPurchases,
        {
          id: `ad-purchase-${String(nextId)}`,
          adProductId,
          purchasedAt: new Date(nowMs).toISOString(),
        },
      ],
      nextId: nextId + 1,
    }));
  },
  reset: () => {
    set(seeded());
  },
}));
