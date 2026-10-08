import {
  vendorOfferCreateRequestSchema,
  vendorOfferViewSchema,
  type VendorOfferView,
} from '@hamro-pasal/shared-types';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { http, HttpResponse } from 'msw';
import { Alert, type AlertButton } from 'react-native';

import VendorMarketingScreen from '../../../app/(vendor)/marketing';
import VendorOfferScreen from '../../../app/(vendor)/offer';
import { VENDOR_OFFERS_PATH } from '../../api/vendor-offers';
import { useToastStore } from '../../store/useToastStore';
import { errorBody } from '../../test/api-fixtures';
import {
  apiUrl,
  capture,
  server,
  setupApiTestEnvironment,
  type CapturedRequest,
} from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import { validateOfferForm } from './marketing-rules';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), navigate: jest.fn() },
}));

setupApiTestEnvironment();

/**
 * My Offers over msw, through the real apiRequest, the shared-types contracts and TanStack Query
 * (SPEC core 7, vendor flow steps 10 and 21): GET / POST /api/vendor/offers, POST …/:id/end.
 */

const FLAT_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c61';
const ENDED_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c62';
const CANCELLED_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c63';

const offer = (overrides: Partial<VendorOfferView> = {}): VendorOfferView =>
  vendorOfferViewSchema.parse({
    id: FLAT_ID,
    kind: 'FLAT',
    value: 100,
    max_discount_npr: null,
    min_cart_npr: 1000,
    label: 'Flat Rs. 100 OFF',
    starts_at: '2026-10-01T04:15:00.000Z',
    ends_at: null,
    status: 'ACTIVE',
    created_at: '2026-10-01T04:15:00.000Z',
    ended_at: null,
    ...overrides,
  });

/** A small in-memory /api/vendor/offers: lists, creates and ends, and records what it was sent. */
function offersApi(initial: VendorOfferView[]) {
  const state = { offers: [...initial], received: [] as CapturedRequest[] };
  server.use(
    http.get(apiUrl(VENDOR_OFFERS_PATH), () => HttpResponse.json({ offers: state.offers })),
    http.post(apiUrl(VENDOR_OFFERS_PATH), async ({ request }) => {
      const sent = await capture(request);
      state.received.push(sent);
      const body = vendorOfferCreateRequestSchema.parse(sent.body);
      const created = offer({
        id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c69',
        kind: body.kind,
        value: body.value,
        min_cart_npr: body.min_cart_npr,
        max_discount_npr: body.max_discount_npr,
        label:
          body.kind === 'FLAT'
            ? `Flat Rs. ${String(body.value)} OFF`
            : `${String(body.value)}% OFF`,
      });
      state.offers = [created, ...state.offers];
      return HttpResponse.json({ offer: created }, { status: 201 });
    }),
    http.post(apiUrl(`${VENDOR_OFFERS_PATH}/:id/end`), async ({ request, params }) => {
      state.received.push(await capture(request));
      state.offers = state.offers.map((each) =>
        each.id === params.id
          ? offer({ ...each, status: 'CANCELLED', ended_at: '2026-10-08T06:00:00.000Z' })
          : each,
      );
      return HttpResponse.json({ offer: state.offers.find((each) => each.id === params.id) });
    }),
  );
  return state;
}

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

beforeEach(() => {
  useToastStore.setState({ toast: null });
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

describe('Marketing: My Offers (GET /api/vendor/offers)', () => {
  it('lists the shop’s offers with the server’s label and who pays for them', async () => {
    offersApi([offer()]);
    renderWithProviders(<VendorMarketingScreen />);

    const card = within(await screen.findByTestId(`offer-${FLAT_ID}`));
    expect(screen.getByTestId('marketing-section-OFFERS')).toBeSelected();
    expect(screen.getByText(/You fund these discounts yourself/)).toBeOnTheScreen();
    expect(card.getByText('Flat Rs. 100 OFF')).toBeOnTheScreen();
    expect(card.getByText('Minimum order Rs. 1000')).toBeOnTheScreen();
    expect(card.getByText('Running since 2026-10-01')).toBeOnTheScreen();
  });

  it('shows the derived status of each offer, and offers End only on a running one', async () => {
    offersApi([
      offer(),
      offer({
        id: ENDED_ID,
        label: '10% OFF',
        kind: 'PERCENTAGE',
        value: 10,
        min_cart_npr: 0,
        ends_at: '2026-10-05T18:15:00.000Z',
        status: 'ENDED',
      }),
      offer({
        id: CANCELLED_ID,
        label: 'Flat Rs. 50 OFF',
        value: 50,
        status: 'CANCELLED',
        ended_at: '2026-10-03T06:00:00.000Z',
      }),
    ]);
    renderWithProviders(<VendorMarketingScreen />);
    await screen.findByTestId(`offer-${FLAT_ID}`);

    expect(screen.getByTestId(`offer-status-${FLAT_ID}`)).toHaveTextContent('Active');
    expect(screen.getByTestId(`offer-status-${ENDED_ID}`)).toHaveTextContent('Ended');
    expect(screen.getByTestId(`offer-status-${CANCELLED_ID}`)).toHaveTextContent('Cancelled');
    // Its end date passed (Nepal Time), or the shop switched it off: each says which and when.
    expect(screen.getByTestId(`offer-end-line-${ENDED_ID}`)).toHaveTextContent(
      'Ended on 2026-10-06',
    );
    expect(screen.getByTestId(`offer-end-line-${CANCELLED_ID}`)).toHaveTextContent(
      'You ended it on 2026-10-03',
    );
    expect(screen.getByTestId(`offer-end-${FLAT_ID}`)).toBeOnTheScreen();
    expect(screen.queryByTestId(`offer-end-${ENDED_ID}`)).toBeNull();
    expect(screen.queryByTestId(`offer-end-${CANCELLED_ID}`)).toBeNull();
  });

  it('says when a running offer will stop by itself', async () => {
    offersApi([offer({ ends_at: '2026-10-20T18:15:00.000Z' })]);
    renderWithProviders(<VendorMarketingScreen />);

    expect(await screen.findByTestId(`offer-end-line-${FLAT_ID}`)).toHaveTextContent(
      'Runs until 2026-10-21',
    );
  });

  it('shows the empty state for a shop without offers, and the form from the button', async () => {
    offersApi([]);
    renderWithProviders(<VendorMarketingScreen />);

    expect(await screen.findByTestId('offers-empty')).toBeOnTheScreen();
    press('offer-add');
    expect(router.push).toHaveBeenCalledWith('/offer');
  });

  it('ends an offer on the server only after confirming, then shows it as Cancelled', async () => {
    const api = offersApi([offer()]);
    renderWithProviders(<VendorMarketingScreen />);
    await screen.findByTestId(`offer-${FLAT_ID}`);

    press(`offer-end-${FLAT_ID}`);
    expect(lastAlert().title).toBe('End "Flat Rs. 100 OFF"?');
    pressAlertButton('Cancel');
    expect(api.received).toHaveLength(0);

    press(`offer-end-${FLAT_ID}`);
    pressAlertButton('End offer');

    await waitFor(() => {
      expect(screen.getByTestId(`offer-status-${FLAT_ID}`)).toHaveTextContent('Cancelled');
    });
    expect(api.received).toHaveLength(1);
    expect(api.received[0]?.url.pathname).toBe(`${VENDOR_OFFERS_PATH}/${FLAT_ID}/end`);
    expect(api.received[0]?.headers.get('authorization')).toMatch(/^Bearer /);
    expect(api.received[0]?.body).toBeUndefined();
    expect(toast()?.message).toBe('Offer ended.');
    expect(screen.queryByTestId(`offer-end-${FLAT_ID}`)).toBeNull();
  });

  it('keeps the offer running and says so when ending it fails', async () => {
    offersApi([offer()]);
    server.use(
      http.post(apiUrl(`${VENDOR_OFFERS_PATH}/:id/end`), () =>
        HttpResponse.json(errorBody('OFFER_NOT_FOUND'), { status: 404 }),
      ),
    );
    renderWithProviders(<VendorMarketingScreen />);
    await screen.findByTestId(`offer-${FLAT_ID}`);

    press(`offer-end-${FLAT_ID}`);
    pressAlertButton('End offer');

    await waitFor(() => {
      expect(toast()?.message).toBe("That didn't go through. Try again.");
    });
    expect(screen.getByTestId(`offer-status-${FLAT_ID}`)).toHaveTextContent('Active');
  });

  it('offers a retry when the offers cannot be loaded', async () => {
    let fail = true;
    server.use(
      http.get(apiUrl(VENDOR_OFFERS_PATH), () =>
        fail
          ? HttpResponse.json(errorBody('VENDOR_NOT_FOUND'), { status: 404 })
          : HttpResponse.json({ offers: [offer()] }),
      ),
    );
    renderWithProviders(<VendorMarketingScreen />);

    await screen.findByTestId('offers-error');
    fail = false;
    fireEvent.press(screen.getByText('Try again'));
    expect(await screen.findByTestId(`offer-${FLAT_ID}`)).toBeOnTheScreen();
  });
});

describe('Marketing: the offer form (POST /api/vendor/offers)', () => {
  it('creates a flat offer from type, amount and minimum order, with no start date', async () => {
    const api = offersApi([]);
    renderWithProviders(<VendorOfferScreen />);

    type('offer-value', '150');
    type('offer-minCart', '1200');
    press('offer-save');

    await waitFor(() => {
      expect(router.navigate).toHaveBeenLastCalledWith('/marketing');
    });
    // Exactly the rule: the offer starts when the server stores it.
    expect(api.received[0]?.body).toEqual({
      kind: 'FLAT',
      value: 150,
      min_cart_npr: 1200,
      max_discount_npr: null,
      ends_at: null,
    });
    expect(toast()?.message).toBe('Offer created.');
  });

  it('creates a percentage offer', async () => {
    const api = offersApi([]);
    renderWithProviders(<VendorOfferScreen />);

    press('offer-kind-PERCENTAGE');
    type('offer-value', '१५');
    press('offer-save');

    await waitFor(() => {
      expect(api.received).toHaveLength(1);
    });
    expect(api.received[0]?.body).toMatchObject({
      kind: 'PERCENTAGE',
      value: 15,
      min_cart_npr: 0,
    });
  });

  it('sends nothing and explains while the offer breaks a rule', () => {
    const api = offersApi([]);
    renderWithProviders(<VendorOfferScreen />);

    type('offer-value', '500');
    type('offer-minCart', '300');
    press('offer-save');

    expect(screen.getByTestId('offer-minCart-error')).toBeOnTheScreen();
    expect(api.received).toHaveLength(0);
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('keeps the form and names the limit when the shop already runs the most offers', async () => {
    offersApi([]);
    server.use(
      http.post(apiUrl(VENDOR_OFFERS_PATH), () =>
        HttpResponse.json(errorBody('OFFER_LIMIT_REACHED', { max: 10 }), { status: 422 }),
      ),
    );
    renderWithProviders(<VendorOfferScreen />);

    type('offer-value', '100');
    type('offer-minCart', '1000');
    press('offer-save');

    await waitFor(() => {
      expect(toast()?.message).toMatch(/End one first/);
    });
    expect(router.navigate).not.toHaveBeenCalled();
    expect(screen.getByTestId('offer-value').props.value).toBe('100');
  });
});
