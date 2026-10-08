import { create } from 'zustand';

import type { OfferDetails, VendorOffer } from '../features/vendor/marketing-rules';

/**
 * TEMPORARY: My Offers on the device, until vendor offers have a backend (STATE_HANDOFF.md
 * §8Z.5, BACKEND_CHECKLIST.md section 5 step 2). Development builds only. Nothing here reaches
 * the server and no discount is applied to any order; it is gone on relaunch. Campaigns and Ads
 * left this store for their real routes (§8Z.28).
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

const seeded = () => ({
  offers: VENDOR_MARKETING_MOCKS_ENABLED ? [...SEED_OFFERS] : [],
  nextId: 1,
});

export interface VendorMarketingState {
  /** The shop's running offers, newest first. An ended offer leaves the list. */
  offers: VendorOffer[];
  nextId: number;
  createOffer: (details: OfferDetails, nowMs: number) => void;
  /** Offers are never edited: this switches one off for future orders. */
  endOffer: (id: string) => void;
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
  reset: () => {
    set(seeded());
  },
}));
