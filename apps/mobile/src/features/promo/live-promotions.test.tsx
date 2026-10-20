import { feedResponseSchema, homePromotionsResponseSchema } from '@hamro-pasal/shared-types';
import { screen, waitFor } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import { HOME_PROMOTIONS_PATH } from '../../api/promotions';
import { feedResponse } from '../../test/api-fixtures';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { renderHookWithProviders, renderWithProviders } from '../../test/render';
import { matchingVendors } from '../discovery/ProductResults';
import { BannerCarousel } from './BannerCarousel';
import { NO_PROMOTIONS } from './promo-model';
import { toHomePromotions, useHomePromotions } from './useHomePromotions';

setupApiTestEnvironment();

const ID = '9d2f6a10-3b4c-4d5e-8f60-718293a4b5c6';
const banner = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  placement: 'CAROUSEL',
  image_url: 'https://cdn.hamropasal.test/promotions/dashain.webp',
  title: 'Dashain offers are here',
  subtitle: null,
  target_type: 'CATEGORY',
  target_value: 'festive',
  is_sponsored: false,
  ...overrides,
});

/** Home reads the Super Admin's promotions from GET /api/home/promotions (STATE_HANDOFF §8Z.29). */
describe('Home promotions from the API', () => {
  it('takes the server’s banners and offers, leaving out a row that lacks what it draws', () => {
    const body = homePromotionsResponseSchema.parse({
      banners: [banner(), banner({ id: ID.replace('9', '8'), image_url: null })],
      offers: [
        banner({ placement: 'FEATURED', image_url: null, title: '10% OFF' }),
        banner({ placement: 'FEATURED', title: null }),
      ],
    });

    const promotions = toHomePromotions(body);

    expect(promotions.banners.map((each) => each.id)).toEqual([ID]);
    expect(promotions.offers.map((each) => each.title)).toEqual(['10% OFF']);
  });

  it('asks without a token and shows what the server sent, not the samples', async () => {
    let authorization: string | null = 'unset';
    server.use(
      http.get(apiUrl(HOME_PROMOTIONS_PATH), ({ request }) => {
        authorization = request.headers.get('authorization');
        return HttpResponse.json({ banners: [banner({ is_sponsored: true })], offers: [] });
      }),
    );

    const { result } = renderHookWithProviders(() => useHomePromotions());

    await waitFor(() => {
      expect(result.current.banners.map((each) => each.id)).toEqual([ID]);
    });
    expect(result.current.offers).toEqual([]);
    expect(result.current.banners[0]).toMatchObject({
      target_value: 'festive',
      is_sponsored: true,
    });
    expect(authorization).toBeNull();
  });

  it('shows nothing, in any build, while the server has no running promotion (2026-10-20)', async () => {
    let asked = 0;
    server.use(
      http.get(apiUrl(HOME_PROMOTIONS_PATH), () => {
        asked += 1;
        return HttpResponse.json({ banners: [], offers: [] });
      }),
    );

    const { result } = renderHookWithProviders(() => useHomePromotions());

    await waitFor(() => {
      expect(asked).toBe(1);
    });
    // No sample banner fills the gap: an empty database shows an empty Home.
    expect(result.current).toEqual(NO_PROMOTIONS);
  });

  it('shows nothing while the server cannot be reached', async () => {
    server.use(
      http.get(apiUrl(HOME_PROMOTIONS_PATH), () =>
        HttpResponse.json({ error: { code: 'INTERNAL', message: 'down' } }, { status: 500 }),
      ),
    );

    const { result } = renderHookWithProviders(() => useHomePromotions());

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result.current).toEqual(NO_PROMOTIONS);
  });

  it('labels a sponsored banner "Ad" and no other', () => {
    const other = ID.replace('9', '7');
    const { banners } = toHomePromotions(
      homePromotionsResponseSchema.parse({
        banners: [banner({ is_sponsored: true }), banner({ id: other })],
        offers: [],
      }),
    );

    renderWithProviders(<BannerCarousel banners={banners} onOpen={jest.fn()} />);

    expect(screen.getByTestId(`banner-ad-${ID}`)).toHaveTextContent('Ad');
    expect(screen.queryByTestId(`banner-ad-${other}`)).toBeNull();
  });
});

describe('sponsored shops in search', () => {
  const base = feedResponse().serviceable[0];
  if (base === undefined) throw new Error('fixture');
  const entry = (id: string, name: string, sponsored: boolean, serviceable = true) => ({
    ...base,
    vendor: { ...base.vendor, id, business_name: name },
    serviceable,
    is_sponsored: sponsored,
  });
  const AD = '11111111-1111-4111-8111-111111111111';
  const KIRANA = '22222222-2222-4222-8222-222222222222';
  const FAR = '33333333-3333-4333-8333-333333333333';
  const feed = feedResponseSchema.parse({
    serviceable: [entry(AD, 'New Road Electronics', true), entry(KIRANA, 'Thamel Kirana', false)],
    explore_further: [entry(FAR, 'Kirtipur Kirana', false, false)],
  });

  it('leads every search with the feed’s sponsored shops, then the shops that match', () => {
    expect(matchingVendors(feed, 'kirana').map((each) => each.vendor.id)).toEqual([
      AD,
      KIRANA,
      FAR,
    ]);
    // A sponsored shop that also matches is listed once, in its paid place.
    expect(matchingVendors(feed, 'electronics').map((each) => each.vendor.id)).toEqual([AD]);
  });

  it('shows nothing, sponsored or not, until something is typed', () => {
    expect(matchingVendors(feed, '  ')).toEqual([]);
    expect(matchingVendors(undefined, 'kirana')).toEqual([]);
  });
});
