import {
  adPurchaseRequestSchema,
  adPurchaseViewSchema,
  vendorAdProductListResponseSchema,
  vendorCampaignViewSchema,
  type AdPurchaseView,
  type VendorAdProductListResponseBody,
  type VendorCampaignView,
} from '@hamro-pasal/shared-types';
import { act, configure, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';
import { Alert, Share, type AlertButton } from 'react-native';

import VendorMarketingScreen from '../../../app/(vendor)/marketing';
import { VENDOR_AD_PRODUCTS_PATH, VENDOR_AD_PURCHASES_PATH } from '../../api/vendor-ads';
import { VENDOR_CAMPAIGNS_PATH } from '../../api/vendor-campaigns';
import { useToastStore } from '../../store/useToastStore';
import { errorBody } from '../../test/api-fixtures';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import { canAffordAd, canCancelAd, parseAdBudget, shortAdId } from './VendorAdsSection';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), navigate: jest.fn() },
}));

setupApiTestEnvironment();
// Each purchase test waits on several requests in a row: in the parallel full run the default
// five seconds per wait is not always enough.
jest.setTimeout(60_000);
configure({ asyncUtilTimeout: 20_000 });

/**
 * The Marketing tab's Campaigns and Ads sections over msw, through the real apiRequest, the
 * shared-types contracts and TanStack Query (SPEC core 7 and 8, vendor flow steps 10, 11 and 21).
 */

const DAY_MS = 86_400_000;
const CAMPAIGN_ID = '7b0f4c1e-2a57-4a0b-9c57-1d2c3e4f5a61';
const FLAT_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c41';
const PER_ORDER_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c42';
const PURCHASE_ID = '5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e81';

const campaign = (overrides: Partial<VendorCampaignView> = {}): VendorCampaignView =>
  vendorCampaignViewSchema.parse({
    id: CAMPAIGN_ID,
    name: 'Dashain Mega Sale',
    kind: 'PERCENTAGE',
    value: 20,
    max_discount_npr: 300,
    min_cart_npr: 1000,
    vendor_share_percent: 50,
    terms_version: 1,
    starts_at: '2026-10-10T00:00:00.000Z',
    ends_at: '2026-10-25T00:00:00.000Z',
    opt_in_status: null,
    opt_in_terms_version: null,
    opted_in_at: null,
    ...overrides,
  });

const market = (
  overrides: Partial<VendorAdProductListResponseBody> = {},
): VendorAdProductListResponseBody =>
  vendorAdProductListResponseSchema.parse({
    settlement_model: 'PLATFORM_ESCROW',
    available_for_ads_npr: 5000,
    products: [
      {
        id: FLAT_ID,
        name: 'Carousel Placement',
        slot: 'CAROUSEL',
        billing_model: 'FLAT_RATE',
        price_npr: 4000,
        duration_days: 7,
        collection: 'PAYOUT_DEDUCTION',
        recharge_required_npr: 0,
      },
      {
        id: PER_ORDER_ID,
        name: 'Sponsored Search',
        slot: 'FEED_LISTING',
        billing_model: 'PER_ORDER_PREMIUM',
        price_npr: 25,
        duration_days: 14,
        collection: 'PAYOUT_DEDUCTION',
        recharge_required_npr: 0,
      },
    ],
    ...overrides,
  });

const purchase = (overrides: Partial<AdPurchaseView> = {}): AdPurchaseView =>
  adPurchaseViewSchema.parse({
    id: PURCHASE_ID,
    ad_product_id: FLAT_ID,
    product_name: 'Carousel Placement',
    slot: 'CAROUSEL',
    billing_model: 'FLAT_RATE',
    price_npr: 4000,
    budget_npr: null,
    settlement_model: 'PLATFORM_ESCROW',
    status: 'ACTIVE',
    starts_at: new Date(Date.now() - DAY_MS).toISOString(),
    ends_at: new Date(Date.now() + 6 * DAY_MS).toISOString(),
    amount_paid_npr: 1000,
    amount_due_npr: 3000,
    agreed_at: new Date(Date.now() - DAY_MS).toISOString(),
    ...overrides,
  });

const toast = () => useToastStore.getState().toast;
const press = (testID: string): void => {
  fireEvent.press(screen.getByTestId(testID));
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
  act(() => {
    button.onPress?.();
  });
}

beforeEach(() => {
  useToastStore.setState({ toast: null });
  alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
});

afterEach(() => {
  alert.mockRestore();
});

async function open(section: 'CAMPAIGNS' | 'ADS', ready: string): Promise<void> {
  renderWithProviders(<VendorMarketingScreen />);
  press(`marketing-section-${section}`);
  await screen.findByTestId(ready);
}

describe('Marketing: Campaigns (live)', () => {
  /** The list as the server holds it; a handler may replace it before the refetch. */
  let listed: VendorCampaignView[];
  const optIns: unknown[] = [];

  beforeEach(() => {
    listed = [campaign()];
    optIns.length = 0;
    server.use(
      http.get(apiUrl(VENDOR_CAMPAIGNS_PATH), () => HttpResponse.json({ campaigns: listed })),
    );
  });

  const optInAnswer = (status: 'ACTIVE' | 'OPTED_OUT', version = 1) => ({
    opt_in: {
      id: PURCHASE_ID,
      campaign_id: CAMPAIGN_ID,
      vendor_id: FLAT_ID,
      opt_in_terms_version: version,
      terms: {},
      status,
      opted_in_at: '2026-10-08T06:00:00.000Z',
    },
  });

  it('lists the invites with the server’s terms; none is on by default', async () => {
    await open('CAMPAIGNS', `campaign-${CAMPAIGN_ID}`);

    expect(screen.getByText('Dashain Mega Sale')).toBeOnTheScreen();
    expect(screen.getByText('20% OFF, up to Rs. 300 per order')).toBeOnTheScreen();
    expect(
      screen.getByText('You bear 50% of each discount; Hamro Pasal funds 50%'),
    ).toBeOnTheScreen();
    expect(screen.getByTestId(`campaign-status-${CAMPAIGN_ID}`)).toHaveTextContent('Invite');
    expect(screen.queryByTestId(`campaign-opt-out-${CAMPAIGN_ID}`)).toBeNull();
  });

  it('opts in only after the terms are confirmed, sending the version that was shown', async () => {
    server.use(
      http.post(apiUrl(`${VENDOR_CAMPAIGNS_PATH}/${CAMPAIGN_ID}/opt-in`), async ({ request }) => {
        optIns.push(await request.json());
        listed = [
          campaign({
            opt_in_status: 'ACTIVE',
            opt_in_terms_version: 1,
            opted_in_at: '2026-10-08T06:00:00.000Z',
          }),
        ];
        return HttpResponse.json(optInAnswer('ACTIVE'), { status: 201 });
      }),
    );
    await open('CAMPAIGNS', `campaign-${CAMPAIGN_ID}`);

    press(`campaign-opt-in-${CAMPAIGN_ID}`);
    expect(lastAlert().message).toContain('You bear 50% of each discount');
    expect(optIns).toHaveLength(0);
    pressAlertButton('Cancel');
    expect(optIns).toHaveLength(0);

    press(`campaign-opt-in-${CAMPAIGN_ID}`);
    pressAlertButton('I agree, opt in');

    await waitFor(() => {
      expect(screen.getByTestId(`campaign-status-${CAMPAIGN_ID}`)).toHaveTextContent('Joined');
    });
    expect(optIns).toEqual([{ terms_version: 1 }]);
    expect(toast()).toMatchObject({ message: 'You joined Dashain Mega Sale.' });
    expect(screen.getByTestId(`campaign-opt-out-${CAMPAIGN_ID}`)).toBeOnTheScreen();
  });

  it('shows the new terms when they changed meanwhile, and joins only on a second agreement', async () => {
    server.use(
      http.post(apiUrl(`${VENDOR_CAMPAIGNS_PATH}/${CAMPAIGN_ID}/opt-in`), async ({ request }) => {
        const body = (await request.json()) as { terms_version: number };
        optIns.push(body);
        if (body.terms_version !== 2) {
          // The admin raised the vendor's share after the list was loaded.
          listed = [campaign({ terms_version: 2, vendor_share_percent: 80 })];
          return HttpResponse.json(errorBody('CAMPAIGN_TERMS_CHANGED', { terms_version: 2 }), {
            status: 409,
          });
        }
        listed = [
          campaign({
            terms_version: 2,
            vendor_share_percent: 80,
            opt_in_status: 'ACTIVE',
            opt_in_terms_version: 2,
            opted_in_at: '2026-10-08T06:00:00.000Z',
          }),
        ];
        return HttpResponse.json(optInAnswer('ACTIVE', 2), { status: 201 });
      }),
    );
    await open('CAMPAIGNS', `campaign-${CAMPAIGN_ID}`);

    press(`campaign-opt-in-${CAMPAIGN_ID}`);
    pressAlertButton('I agree, opt in');

    // Refused: the card now carries the notice and the terms as they stand, still not joined.
    expect(await screen.findByTestId(`campaign-terms-changed-${CAMPAIGN_ID}`)).toBeOnTheScreen();
    await screen.findByText('You bear 80% of each discount; Hamro Pasal funds 20%');
    expect(screen.getByTestId(`campaign-status-${CAMPAIGN_ID}`)).toHaveTextContent('Invite');
    expect(toast()).toMatchObject({ message: 'The campaign terms changed. Review the new terms.' });

    // The second confirmation restates the new terms and sends the new version.
    press(`campaign-opt-in-${CAMPAIGN_ID}`);
    expect(lastAlert().message).toContain('You bear 80% of each discount');
    pressAlertButton('I agree, opt in');

    await waitFor(() => {
      expect(screen.getByTestId(`campaign-status-${CAMPAIGN_ID}`)).toHaveTextContent('Joined');
    });
    expect(optIns).toEqual([{ terms_version: 1 }, { terms_version: 2 }]);
    expect(screen.queryByTestId(`campaign-terms-changed-${CAMPAIGN_ID}`)).toBeNull();
  });

  it('marks a campaign whose terms changed after the shop joined, and opts out of a joined one', async () => {
    listed = [campaign({ opt_in_status: 'VOIDED', opt_in_terms_version: 1, terms_version: 2 })];
    let optOuts = 0;
    server.use(
      http.post(apiUrl(`${VENDOR_CAMPAIGNS_PATH}/${CAMPAIGN_ID}/opt-out`), () => {
        optOuts += 1;
        listed = [campaign({ opt_in_status: 'OPTED_OUT', opt_in_terms_version: 1 })];
        return HttpResponse.json(optInAnswer('OPTED_OUT'));
      }),
    );
    const view = renderWithProviders(<VendorMarketingScreen />);
    press('marketing-section-CAMPAIGNS');
    expect(await screen.findByTestId(`campaign-terms-changed-${CAMPAIGN_ID}`)).toBeOnTheScreen();
    expect(screen.getByTestId(`campaign-opt-in-${CAMPAIGN_ID}`)).toBeOnTheScreen();
    view.unmount();

    listed = [
      campaign({
        opt_in_status: 'ACTIVE',
        opt_in_terms_version: 1,
        opted_in_at: '2026-10-08T06:00:00.000Z',
      }),
    ];
    await open('CAMPAIGNS', `campaign-opt-out-${CAMPAIGN_ID}`);
    press(`campaign-opt-out-${CAMPAIGN_ID}`);

    await waitFor(() => {
      expect(screen.getByTestId(`campaign-status-${CAMPAIGN_ID}`)).toHaveTextContent('Invite');
    });
    expect(optOuts).toBe(1);
    expect(toast()).toMatchObject({
      message: 'You opted out. New orders will not get this discount.',
    });
  });

  it('offers a retry when the list cannot be loaded', async () => {
    server.use(http.get(apiUrl(VENDOR_CAMPAIGNS_PATH), () => HttpResponse.error()));
    renderWithProviders(<VendorMarketingScreen />);
    press('marketing-section-CAMPAIGNS');
    expect(await screen.findByTestId('campaigns-error', {}, { timeout: 10_000 })).toBeOnTheScreen();
  });
});

describe('ad rules', () => {
  const [flat, perOrder] = market().products;
  if (flat === undefined || perOrder === undefined) throw new Error('fixture');

  it('lets Model B buy a flat-rate ad against what the platform holds, to the rupee', () => {
    expect(canAffordAd(flat, 4000)).toBe(true);
    expect(canAffordAd(flat, 3999.99)).toBe(false);
    expect(canAffordAd(perOrder, 0)).toBe(true);
  });

  it('asks a ledger-funded shop for a recharge first', () => {
    const ledger = { ...flat, collection: 'LEDGER_BALANCE' } as const;
    expect(canAffordAd({ ...ledger, recharge_required_npr: 0 }, 0)).toBe(true);
    expect(canAffordAd({ ...ledger, recharge_required_npr: 150 }, 99_999)).toBe(false);
  });

  it('takes a budget of at least one fee, in whole paisa', () => {
    expect(parseAdBudget('500', 25)).toBe(500);
    expect(parseAdBudget('25', 25)).toBe(25);
    expect(parseAdBudget('24.99', 25)).toBeNull();
    expect(parseAdBudget('', 25)).toBeNull();
    expect(parseAdBudget('10.005', 5)).toBeNull();
    expect(parseAdBudget('1000001', 25)).toBeNull();
  });

  it('cancels a per-order ad at any time and a flat-rate one only before it starts', () => {
    const now = Date.now();
    const future = new Date(now + DAY_MS).toISOString();
    expect(canCancelAd(purchase(), now)).toBe(false);
    expect(canCancelAd(purchase({ starts_at: future }), now)).toBe(true);
    const running = purchase({ billing_model: 'PER_ORDER_PREMIUM', budget_npr: 500 });
    expect(canCancelAd(running, now)).toBe(true);
    expect(canCancelAd({ ...running, status: 'PAUSED' }, now)).toBe(true);
    for (const status of ['ENDED', 'CANCELLED'] as const) {
      expect(canCancelAd({ ...running, status }, now)).toBe(false);
    }
  });
});

describe('Marketing: Ad Marketplace (live)', () => {
  let funds: VendorAdProductListResponseBody;
  let bought: AdPurchaseView[];
  let requests: unknown[];

  beforeEach(() => {
    funds = market();
    bought = [];
    requests = [];
    server.use(
      http.get(apiUrl(VENDOR_AD_PRODUCTS_PATH), () => HttpResponse.json(funds)),
      http.get(apiUrl(VENDOR_AD_PURCHASES_PATH), () => HttpResponse.json({ purchases: bought })),
    );
  });

  const answerPurchases = (answer: (body: unknown, attempt: number) => Response) => {
    server.use(
      http.post(apiUrl(VENDOR_AD_PURCHASES_PATH), async ({ request }) => {
        const body = await request.json();
        requests.push(body);
        return answer(body, requests.length);
      }),
    );
  };
  const sold = (view: AdPurchaseView) =>
    HttpResponse.json(
      { purchase: view, available_for_ads_npr: 1000, replayed: false },
      { status: 201 },
    );

  it('shows the server’s funds and placements, and that nothing is bought yet', async () => {
    await open('ADS', `ad-${FLAT_ID}`);

    expect(screen.getByTestId('ad-funds')).toHaveTextContent('Rs. 5000');
    expect(screen.getByText('Rs. 4000 for 7 days (flat rate)')).toBeOnTheScreen();
    expect(screen.getByText('Rs. 25 per delivered order, for 14 days')).toBeOnTheScreen();
    expect(await screen.findByTestId('ad-purchases-empty')).toBeOnTheScreen();
  });

  it('refuses an ad the shop cannot pay for before any agreement is asked', async () => {
    funds = market({ available_for_ads_npr: 3999 });
    answerPurchases(() => sold(purchase()));
    await open('ADS', `ad-${FLAT_ID}`);

    press(`ad-buy-${FLAT_ID}`);

    expect(toast()).toMatchObject({ message: 'Insufficient funds for this ad purchase.' });
    expect(screen.queryByTestId('ad-purchase-form')).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it('buys a flat-rate ad only on the explicit agreement, with a start and no budget', async () => {
    answerPurchases(() => {
      bought = [purchase({ starts_at: new Date(Date.now() + 3 * DAY_MS).toISOString() })];
      return sold(bought[0] ?? purchase());
    });
    await open('ADS', `ad-${FLAT_ID}`);

    press(`ad-buy-${FLAT_ID}`);
    expect(screen.getByTestId('ad-purchase-form')).toBeOnTheScreen();
    expect(
      screen.getByText('It is deducted from your balance and your upcoming payouts.'),
    ).toBeOnTheScreen();
    expect(screen.queryByTestId('ad-budget')).toBeNull();
    expect(requests).toHaveLength(0);

    const before = Date.now();
    press('ad-start-3');
    press('ad-purchase-confirm');

    await waitFor(() => {
      expect(screen.queryByTestId('ad-purchase-form')).toBeNull();
    });
    expect(requests).toHaveLength(1);
    const sent = adPurchaseRequestSchema.parse(requests[0]);
    expect(sent).toMatchObject({ ad_product_id: FLAT_ID, agreed: true });
    expect(sent.budget_npr).toBeUndefined();
    const startsIn = Date.parse(sent.starts_at) - before;
    expect(startsIn).toBeGreaterThanOrEqual(3 * DAY_MS);
    expect(startsIn).toBeLessThan(3 * DAY_MS + 60_000);
    expect(toast()).toMatchObject({ message: 'Carousel Placement purchased.' });
    expect(await screen.findByTestId(`ad-purchase-${PURCHASE_ID}`)).toBeOnTheScreen();
  });

  it('asks a budget for a per-order ad and holds the request until it covers one fee', async () => {
    answerPurchases(() =>
      sold(
        purchase({
          ad_product_id: PER_ORDER_ID,
          billing_model: 'PER_ORDER_PREMIUM',
          price_npr: 25,
          budget_npr: 500,
          amount_paid_npr: 0,
          amount_due_npr: 0,
        }),
      ),
    );
    await open('ADS', `ad-${PER_ORDER_ID}`);

    press(`ad-buy-${PER_ORDER_ID}`);
    expect(screen.getByTestId('ad-budget')).toBeOnTheScreen();
    press('ad-purchase-confirm');
    expect(screen.getByTestId('ad-budget-error')).toBeOnTheScreen();
    fireEvent.changeText(screen.getByTestId('ad-budget'), '24');
    press('ad-purchase-confirm');
    expect(screen.getByTestId('ad-budget-error')).toBeOnTheScreen();
    expect(requests).toHaveLength(0);

    fireEvent.changeText(screen.getByTestId('ad-budget'), '500');
    press('ad-purchase-confirm');

    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(adPurchaseRequestSchema.parse(requests[0])).toMatchObject({
      ad_product_id: PER_ORDER_ID,
      budget_npr: 500,
    });
  });

  it('keeps one idempotency key across retries of a form, and makes a new one when it reopens', async () => {
    answerPurchases((_body, attempt) =>
      attempt === 1
        ? HttpResponse.json(errorBody('INTERNAL_SERVER_ERROR'), { status: 500 })
        : sold(purchase()),
    );
    await open('ADS', `ad-${FLAT_ID}`);
    const keyOf = (index: number) => adPurchaseRequestSchema.parse(requests[index]).idempotency_key;

    press(`ad-buy-${FLAT_ID}`);
    press('ad-purchase-confirm');
    await waitFor(() => {
      expect(toast()).toMatchObject({ message: "That didn't go through. Try again." });
    });
    // The form stayed open: pressing again resends the same purchase.
    expect(screen.getByTestId('ad-purchase-form')).toBeOnTheScreen();
    press('ad-purchase-confirm');
    await waitFor(() => {
      expect(screen.queryByTestId('ad-purchase-form')).toBeNull();
    });
    expect(keyOf(1)).toBe(keyOf(0));

    press(`ad-buy-${FLAT_ID}`);
    press('ad-purchase-confirm');
    await waitFor(() => {
      expect(requests).toHaveLength(3);
    });
    expect(keyOf(2)).not.toBe(keyOf(0));
  });

  it.each(['AD_EXCEEDS_PENDING_PAYOUT', 'LEDGER_RECHARGE_REQUIRED'])(
    'words the server’s %s as insufficient funds and closes the form',
    async (code) => {
      answerPurchases(() => HttpResponse.json(errorBody(code), { status: 422 }));
      await open('ADS', `ad-${FLAT_ID}`);

      press(`ad-buy-${FLAT_ID}`);
      press('ad-purchase-confirm');

      await waitFor(() => {
        expect(toast()).toMatchObject({ message: 'Insufficient funds for this ad purchase.' });
      });
      expect(screen.queryByTestId('ad-purchase-form')).toBeNull();
    },
  );

  it('hides Cancel on a flat-rate ad that has started, and says why', async () => {
    bought = [purchase()];
    await open('ADS', `ad-purchase-${PURCHASE_ID}`);

    expect(screen.queryByTestId(`ad-cancel-${PURCHASE_ID}`)).toBeNull();
    expect(screen.getByTestId(`ad-not-cancellable-${PURCHASE_ID}`)).toHaveTextContent(
      'A flat-rate ad that has started runs to its end and cannot be cancelled.',
    );
    expect(screen.getByTestId(`ad-purchase-due-${PURCHASE_ID}`)).toHaveTextContent(
      'Rs. 3000 will be deducted from your payouts.',
    );
  });

  it('cancels an ad that may be cancelled and shows the server’s answer', async () => {
    const perOrder = purchase({
      billing_model: 'PER_ORDER_PREMIUM',
      price_npr: 25,
      budget_npr: 500,
      amount_paid_npr: 0,
      amount_due_npr: 0,
    });
    bought = [perOrder];
    let cancels = 0;
    server.use(
      http.post(apiUrl(`${VENDOR_AD_PURCHASES_PATH}/${PURCHASE_ID}/cancel`), () => {
        cancels += 1;
        bought = [{ ...perOrder, status: 'CANCELLED' }];
        return HttpResponse.json({ purchase: bought[0], available_for_ads_npr: 5000 });
      }),
    );
    await open('ADS', `ad-cancel-${PURCHASE_ID}`);

    press(`ad-cancel-${PURCHASE_ID}`);

    await waitFor(() => {
      expect(screen.getByTestId(`ad-purchase-status-${PURCHASE_ID}`)).toHaveTextContent(
        'Cancelled',
      );
    });
    expect(cancels).toBe(1);
    expect(toast()).toMatchObject({ message: 'Ad cancelled.' });
    expect(screen.queryByTestId(`ad-cancel-${PURCHASE_ID}`)).toBeNull();
  });

  it('shows the warning when the server refuses a cancellation the phone thought possible', async () => {
    // The phone's clock is behind: it still offers Cancel on an ad the server says has started.
    bought = [purchase({ starts_at: new Date(Date.now() + 60_000).toISOString() })];
    server.use(
      http.post(apiUrl(`${VENDOR_AD_PURCHASES_PATH}/${PURCHASE_ID}/cancel`), () =>
        HttpResponse.json(errorBody('AD_PURCHASE_NOT_CANCELLABLE', { reason: 'STARTED' }), {
          status: 409,
        }),
      ),
    );
    await open('ADS', `ad-cancel-${PURCHASE_ID}`);

    press(`ad-cancel-${PURCHASE_ID}`);

    await waitFor(() => {
      expect(toast()).toMatchObject({
        message: 'A flat-rate ad that has started runs to its end and cannot be cancelled.',
      });
    });
  });
});

describe('Marketing: the purchase id', () => {
  it('shows a short id on every purchase and hands the whole id to the share sheet on a tap', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    server.use(
      http.get(apiUrl(VENDOR_AD_PRODUCTS_PATH), () => HttpResponse.json(market())),
      http.get(apiUrl(VENDOR_AD_PURCHASES_PATH), () =>
        HttpResponse.json({ purchases: [purchase()] }),
      ),
    );
    await open('ADS', `ad-purchase-${PURCHASE_ID}`);

    expect(shortAdId(PURCHASE_ID)).toBe('5C6D7E8F');
    expect(screen.getByTestId(`ad-id-${PURCHASE_ID}`)).toHaveTextContent(/Ad ID: 5C6D7E8F/);
    expect(screen.getByTestId(`ad-id-${PURCHASE_ID}`)).toHaveTextContent(/Tap to copy/);
    expect(share).not.toHaveBeenCalled();

    press(`ad-id-${PURCHASE_ID}`);

    expect(share).toHaveBeenCalledWith({ message: PURCHASE_ID });
    share.mockRestore();
  });
});
