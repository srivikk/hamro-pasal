import { act, fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Alert, type AlertButton } from 'react-native';

import VendorMarketingScreen from '../../../app/(vendor)/marketing';
import VendorOfferScreen from '../../../app/(vendor)/offer';
import { useAuthStore } from '../../store/useAuthStore';
import { useToastStore } from '../../store/useToastStore';
import { SEED_AD_PRODUCTS, useVendorMarketingStore } from '../../store/useVendorMarketingStore';
import { renderWithProviders } from '../../test/render';
import {
  adFundsAvailable,
  canBuyAd,
  validateOfferForm,
  type AdFunds,
  type AdProduct,
} from './marketing-rules';
import { useVendorFinanceStore } from './vendor-finance-mocks';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), navigate: jest.fn() },
}));

const marketing = () => useVendorMarketingStore.getState();
const toast = () => useToastStore.getState().toast;
const press = (testID: string): void => {
  fireEvent.press(screen.getByTestId(testID));
};
const type = (testID: string, text: string): void => {
  fireEvent.changeText(screen.getByTestId(testID), text);
};

let alert: jest.SpiedFunction<typeof Alert.alert>;
const lastAlert = (): { title: string; message: string; buttons: AlertButton[] } => {
  const call = alert.mock.calls.at(-1);
  if (call === undefined) throw new Error('No alert was shown');
  return { title: call[0], message: call[1] ?? '', buttons: call[2] ?? [] };
};
function pressAlertButton(label: string): void {
  const button = lastAlert().buttons.find((each) => each.text === label);
  if (button === undefined) throw new Error(`No alert button "${label}"`);
  // The button runs outside any event the test library wraps.
  act(() => {
    button.onPress?.();
  });
}

const adProduct = (id: string): AdProduct => {
  const product = SEED_AD_PRODUCTS.find((each) => each.id === id);
  if (product === undefined) throw new Error(`No ad product ${id}`);
  return product;
};
const FLAT_4000 = adProduct('ad-carousel-7');
const FLAT_15000 = adProduct('ad-carousel-30');
const PER_ORDER = adProduct('ad-search-14');

beforeEach(() => {
  marketing().reset();
  useAuthStore.getState().setLocale('en');
  useToastStore.setState({ toast: null });
  useVendorFinanceStore.setState({ settlementModel: 'PLATFORM_ESCROW' });
  jest.mocked(router.push).mockClear();
  jest.mocked(router.navigate).mockClear();
  alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
});

afterEach(() => {
  alert.mockRestore();
});

describe('offer rules (vendor_offers)', () => {
  it('takes a flat amount with a minimum order at least as large', () => {
    expect(validateOfferForm({ kind: 'FLAT', value: '100', minCart: '1000' })).toEqual({
      ok: true,
      details: { kind: 'FLAT', value: 100, minCartNpr: 1000 },
    });
    expect(validateOfferForm({ kind: 'FLAT', value: '100', minCart: '100' })).toMatchObject({
      ok: true,
    });
  });

  it('refuses a flat discount larger than its own minimum order (or with none)', () => {
    expect(validateOfferForm({ kind: 'FLAT', value: '200', minCart: '150' })).toEqual({
      ok: false,
      errors: { minCart: 'minBelowDiscount' },
    });
    expect(validateOfferForm({ kind: 'FLAT', value: '200', minCart: '' })).toEqual({
      ok: false,
      errors: { minCart: 'minBelowDiscount' },
    });
  });

  it('takes a percentage from above 0 to 100, with no minimum order needed', () => {
    expect(validateOfferForm({ kind: 'PERCENTAGE', value: '10', minCart: '' })).toEqual({
      ok: true,
      details: { kind: 'PERCENTAGE', value: 10, minCartNpr: 0 },
    });
    for (const value of ['0', '100.5', '', 'ten']) {
      expect(validateOfferForm({ kind: 'PERCENTAGE', value, minCart: '' })).toEqual({
        ok: false,
        errors: { value: 'percentValue' },
      });
    }
  });

  it('refuses a flat amount of 0 or nothing', () => {
    for (const value of ['', '0']) {
      expect(validateOfferForm({ kind: 'FLAT', value, minCart: '500' })).toEqual({
        ok: false,
        errors: { value: 'flatValue' },
      });
    }
  });
});

describe('ad purchase rules by settlement model', () => {
  const funds = (overrides: Partial<AdFunds> = {}): AdFunds => ({
    model: 'PLATFORM_ESCROW',
    balanceNpr: 8450,
    pendingEscrowNpr: 3200,
    committedNpr: 0,
    ...overrides,
  });

  it('Model B: a flat-rate ad needs balance + pending escrow to cover it', () => {
    expect(adFundsAvailable(funds())).toBe(11_650);
    expect(canBuyAd(funds(), FLAT_4000)).toBe(true);
    expect(canBuyAd(funds(), FLAT_15000)).toBe(false);
    // Exactly enough is enough; one rupee short is not.
    expect(canBuyAd(funds({ balanceNpr: 800, pendingEscrowNpr: 3200 }), FLAT_4000)).toBe(true);
    expect(canBuyAd(funds({ balanceNpr: 799, pendingEscrowNpr: 3200 }), FLAT_4000)).toBe(false);
  });

  it('Model B: money already committed to flat-rate ads is not counted twice', () => {
    expect(canBuyAd(funds({ committedNpr: 8000 }), FLAT_4000)).toBe(false);
  });

  it('Model B: a per-order ad is always allowed (it is paid out of each order)', () => {
    expect(canBuyAd(funds({ balanceNpr: -500, pendingEscrowNpr: 0 }), PER_ORDER)).toBe(true);
  });

  it('Model A: never on credit: the balance itself must cover the price or the whole budget', () => {
    const credit = (balanceNpr: number) => funds({ model: 'COD_CREDIT', balanceNpr });
    expect(canBuyAd(credit(-1200), FLAT_4000)).toBe(false);
    expect(canBuyAd(credit(4000), FLAT_4000)).toBe(true);
    expect(canBuyAd(credit(1499), PER_ORDER)).toBe(false);
    expect(canBuyAd(credit(1500), PER_ORDER)).toBe(true);
  });

  it('Model C: the balance must stay at or above the Rs. 5000 reserve', () => {
    const prepaid = (balanceNpr: number) => funds({ model: 'DIRECT_PREPAID', balanceNpr });
    expect(canBuyAd(prepaid(9000), FLAT_4000)).toBe(true);
    expect(canBuyAd(prepaid(8999), FLAT_4000)).toBe(false);
  });
});

describe('Marketing: My Offers', () => {
  it('opens on My Offers with the running offers and who pays for them', () => {
    renderWithProviders(<VendorMarketingScreen />);

    expect(screen.getByTestId('marketing-section-OFFERS')).toBeSelected();
    expect(screen.getByText('Flat Rs. 100 OFF')).toBeOnTheScreen();
    expect(screen.getByText('Minimum order Rs. 1000')).toBeOnTheScreen();
    expect(screen.getByText(/You fund these discounts yourself/)).toBeOnTheScreen();
    expect(screen.queryByTestId('marketing-campaigns')).not.toBeOnTheScreen();
  });

  it('opens the new-offer form from the button', () => {
    renderWithProviders(<VendorMarketingScreen />);
    press('offer-add');
    expect(router.push).toHaveBeenCalledWith('/offer');
  });

  it('ends an offer only after confirming', () => {
    renderWithProviders(<VendorMarketingScreen />);

    press('offer-end-offer-1');
    expect(lastAlert().title).toBe('End "Flat Rs. 100 OFF"?');
    pressAlertButton('Cancel');
    expect(marketing().offers).toHaveLength(1);

    press('offer-end-offer-1');
    pressAlertButton('End offer');
    expect(marketing().offers).toHaveLength(0);
    expect(screen.getByTestId('offers-empty')).toBeOnTheScreen();
    expect(toast()?.message).toBe('Offer ended.');
  });
});

describe('Marketing: the offer form', () => {
  it('creates a flat offer from type, amount and minimum order', () => {
    renderWithProviders(<VendorOfferScreen />);
    expect(screen.getByTestId('offer-kind-FLAT')).toBeSelected();

    type('offer-value', '200');
    type('offer-minCart', '1500');
    press('offer-save');

    expect(marketing().offers[0]).toMatchObject({ kind: 'FLAT', value: 200, minCartNpr: 1500 });
    expect(marketing().offers).toHaveLength(2);
    expect(toast()).toMatchObject({ message: 'Offer created.', tone: 'success' });
    expect(router.navigate).toHaveBeenCalledWith('/marketing');
  });

  it('creates a percentage offer', () => {
    renderWithProviders(<VendorOfferScreen />);

    press('offer-kind-PERCENTAGE');
    expect(screen.getByText('Discount (%)')).toBeOnTheScreen();
    type('offer-value', '१०');
    press('offer-save');

    expect(marketing().offers[0]).toMatchObject({ kind: 'PERCENTAGE', value: 10, minCartNpr: 0 });
  });

  it('saves nothing and explains while the offer breaks a rule', () => {
    renderWithProviders(<VendorOfferScreen />);

    press('offer-save');
    expect(screen.getByTestId('offer-value-error')).toHaveTextContent('Enter a discount above 0.');

    type('offer-value', '200');
    type('offer-minCart', '100');
    press('offer-save');
    expect(screen.getByTestId('offer-minCart-error')).toHaveTextContent(
      'The minimum order must be at least the discount.',
    );
    expect(marketing().offers).toHaveLength(1);
    expect(router.navigate).not.toHaveBeenCalled();
  });
});

describe('Marketing: Campaigns', () => {
  const openCampaigns = (): void => {
    renderWithProviders(<VendorMarketingScreen />);
    press('marketing-section-CAMPAIGNS');
  };

  it('lists the invites with their terms; none is on by default', () => {
    openCampaigns();

    expect(screen.getByText('Dashain 20% Mega Sale')).toBeOnTheScreen();
    expect(screen.getByText('20% OFF, up to Rs. 300 per order')).toBeOnTheScreen();
    expect(
      screen.getByText('You bear 50% of each discount; Hamro Pasal funds 50%'),
    ).toBeOnTheScreen();
    expect(screen.getByTestId('campaign-status-campaign-dashain')).toHaveTextContent('Invite');
    expect(marketing().campaigns.every((campaign) => campaign.optedInAt === null)).toBe(true);
  });

  it('Opt In asks to accept the terms, restated, and joins only on agreement', () => {
    openCampaigns();

    press('campaign-opt-in-campaign-dashain');
    const prompt = lastAlert();
    expect(prompt.title).toBe('Join "Dashain 20% Mega Sale"?');
    expect(prompt.message).toContain('20% OFF, up to Rs. 300 per order');
    expect(prompt.message).toContain('You bear 50% of each discount');
    expect(prompt.message).toContain('deducted from your payout');
    expect(prompt.buttons.map((button) => button.text)).toEqual(['Cancel', 'I agree, opt in']);

    pressAlertButton('Cancel');
    expect(marketing().campaigns[0]?.optedInAt).toBeNull();

    press('campaign-opt-in-campaign-dashain');
    pressAlertButton('I agree, opt in');

    expect(marketing().campaigns[0]?.optedInAt).not.toBeNull();
    expect(screen.getByTestId('campaign-status-campaign-dashain')).toHaveTextContent('Joined');
    expect(screen.getByTestId('campaign-joined-campaign-dashain')).toHaveTextContent(
      /You opted in on \d{4}-\d{2}-\d{2}\./,
    );
    expect(screen.queryByTestId('campaign-opt-in-campaign-dashain')).not.toBeOnTheScreen();
    // The other campaign is untouched.
    expect(screen.getByTestId('campaign-opt-in-campaign-tihar')).toBeOnTheScreen();
    expect(toast()?.message).toBe('You joined Dashain 20% Mega Sale.');
  });

  it('opts out again', () => {
    openCampaigns();
    press('campaign-opt-in-campaign-dashain');
    pressAlertButton('I agree, opt in');

    press('campaign-opt-out-campaign-dashain');

    expect(marketing().campaigns[0]?.optedInAt).toBeNull();
    expect(screen.getByTestId('campaign-opt-in-campaign-dashain')).toBeOnTheScreen();
  });
});

describe('Marketing: Ad Marketplace', () => {
  const openAds = (): void => {
    renderWithProviders(<VendorMarketingScreen />);
    press('marketing-section-ADS');
  };

  it('sells Carousel Placement and Sponsored Search, and shows what the shop can spend', () => {
    openAds();

    expect(screen.getAllByText('Carousel Placement')).toHaveLength(2);
    expect(screen.getByText('Sponsored Search')).toBeOnTheScreen();
    expect(screen.getByText('Rs. 4000 for 7 days (flat rate)')).toBeOnTheScreen();
    expect(screen.getByTestId('ad-funds')).toHaveTextContent('Rs. 11650');
  });

  it('Model B guard: a flat-rate ad above balance + pending escrow is refused with an error toast', () => {
    openAds();

    press('ad-buy-ad-carousel-30'); // Rs. 15,000 against Rs. 11,650

    expect(toast()).toEqual(
      expect.objectContaining({
        message: 'Insufficient funds for this ad purchase.',
        tone: 'error',
      }),
    );
    expect(alert).not.toHaveBeenCalled(); // no agreement is asked for an ad that cannot be bought
    expect(marketing().adPurchases).toHaveLength(0);
  });

  it('buys an affordable ad only after an explicit agreement that restates the cost', () => {
    openAds();

    press('ad-buy-ad-carousel-7');
    const prompt = lastAlert();
    expect(prompt.title).toBe('Buy Carousel Placement?');
    expect(prompt.message).toContain('Rs. 4000 for 7 days (flat rate)');
    expect(prompt.message).toContain('deducted from your balance and your upcoming payouts');
    pressAlertButton('Cancel');
    expect(marketing().adPurchases).toHaveLength(0);

    press('ad-buy-ad-carousel-7');
    pressAlertButton('I agree, buy');

    expect(marketing().adPurchases).toHaveLength(1);
    expect(screen.getByTestId('ad-active-ad-carousel-7')).toBeOnTheScreen();
    expect(screen.getByTestId('ad-funds')).toHaveTextContent('Rs. 7650');
    expect(toast()).toMatchObject({ message: 'Carousel Placement purchased.', tone: 'success' });
  });

  it('counts what earlier ads took: the third Rs. 4000 ad no longer fits', () => {
    openAds();
    for (let bought = 0; bought < 2; bought += 1) {
      press('ad-buy-ad-carousel-7');
      pressAlertButton('I agree, buy');
    }
    expect(screen.getByTestId('ad-funds')).toHaveTextContent('Rs. 3650');
    alert.mockClear();

    press('ad-buy-ad-carousel-7');

    expect(toast()?.message).toBe('Insufficient funds for this ad purchase.');
    expect(alert).not.toHaveBeenCalled();
    expect(marketing().adPurchases).toHaveLength(2);
  });

  it('lets a Model B shop buy a per-order ad whatever it holds', () => {
    openAds();

    press('ad-buy-ad-search-14');

    expect(lastAlert().title).toBe('Buy Sponsored Search?');
    expect(lastAlert().message).toContain('Rs. 15 per delivered order, up to Rs. 1500');
  });

  it('Model A: a shop that owes money cannot buy any ad', () => {
    useVendorFinanceStore.setState({ settlementModel: 'COD_CREDIT' });
    openAds();

    press('ad-buy-ad-carousel-7');
    expect(toast()?.message).toBe('Insufficient funds for this ad purchase.');
    press('ad-buy-ad-search-14');
    expect(alert).not.toHaveBeenCalled();
  });
});
