import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import VendorSettingsScreen from '../../../app/(vendor)/settings';
import { saveDeliverySettings } from '../../api/vendor-delivery-settings';
import { useAuthStore } from '../../store/useAuthStore';
import { useToastStore } from '../../store/useToastStore';
import { useVendorShopStore } from '../../store/useVendorShopStore';
import { accessTokenFor } from '../../test/access-tokens';
import {
  apiUrl,
  capture,
  server,
  setupApiTestEnvironment,
  type CapturedRequest,
} from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import {
  deliveryRequestOf,
  formFromDeliveryResponse,
  validateDeliverySettings,
} from './shop-settings';

// The PAN document card has its own tests; it is not what this file is about.
jest.mock('./PanDocumentCard', () => ({ PanDocumentCard: () => null }));

setupApiTestEnvironment();

const VENDOR_USER_ID = '9f1c2a10-0000-4000-8000-0000000000aa';
const VENDOR_ID = '7b1f0c8e-0000-4000-8000-0000000000aa';
const PATH = '/api/vendor/delivery-settings';
const OWN_PALIKA = 'Kathmandu Metropolitan City';

interface Settings {
  vendor_id: string;
  fulfillment_mode: 'SELF_DELIVERY' | 'PLATFORM_FLEET';
  delivery_scope: 'RADIUS_BOUND' | 'CITY_WIDE' | 'NATION_WIDE';
  radius_km: number;
  serviceable_palikas: string[];
  municipality_palika_string: string;
  base_delivery_fee_npr: number;
  delivery_fee_per_km_npr: number;
  free_delivery_above_npr: number | null;
  min_order_value: number;
  platform: {
    self_delivery_enabled: boolean;
    platform_fleet_enabled: boolean;
    platform_delivery_fee_npr: number;
  };
  fulfillment_mode_enabled: boolean;
}

const settings = (overrides: Partial<Settings> = {}): Settings => ({
  vendor_id: VENDOR_ID,
  fulfillment_mode: 'SELF_DELIVERY',
  delivery_scope: 'RADIUS_BOUND',
  radius_km: 5,
  serviceable_palikas: [OWN_PALIKA],
  municipality_palika_string: OWN_PALIKA,
  base_delivery_fee_npr: 0,
  delivery_fee_per_km_npr: 0,
  free_delivery_above_npr: null,
  min_order_value: 0,
  platform: {
    self_delivery_enabled: true,
    platform_fleet_enabled: true,
    platform_delivery_fee_npr: 50,
  },
  fulfillment_mode_enabled: true,
  ...overrides,
});

type SaveBody = Pick<
  Settings,
  | 'fulfillment_mode'
  | 'delivery_scope'
  | 'serviceable_palikas'
  | 'base_delivery_fee_npr'
  | 'delivery_fee_per_km_npr'
  | 'free_delivery_above_npr'
> & { radius_km: number | null };

/**
 * A server that holds one shop's delivery settings and applies a PUT as the API does: the shop's
 * own Palika is always first in the list, and the stored radius is kept outside the radius tier.
 */
function serve(
  options: { settings?: Partial<Settings>; refuse?: (body: SaveBody) => Response | null } = {},
) {
  const saves: CapturedRequest[] = [];
  let current = settings(options.settings);
  server.use(
    http.get(apiUrl(PATH), () => HttpResponse.json(current)),
    http.put(apiUrl(PATH), async ({ request }) => {
      const captured = await capture(request);
      saves.push(captured);
      const body = captured.body as SaveBody;
      const refusal = options.refuse?.(body) ?? null;
      if (refusal !== null) return refusal;
      current = {
        ...current,
        ...body,
        radius_km: body.radius_km ?? current.radius_km,
        serviceable_palikas: [
          OWN_PALIKA,
          ...body.serviceable_palikas.filter((name) => name !== OWN_PALIKA),
        ],
      };
      return HttpResponse.json(current);
    }),
  );
  return saves;
}

const press = (testID: string): void => {
  fireEvent.press(screen.getByTestId(testID));
};
const type = (testID: string, text: string): void => {
  fireEvent.changeText(screen.getByTestId(testID), text);
};
const toast = () => useToastStore.getState().toast;

/** The settings screen, once the server's delivery settings are on it. */
async function open(locale: 'en' | 'ne' = 'en') {
  renderWithProviders(<VendorSettingsScreen />, { locale });
  await waitFor(() => {
    expect(screen.getByTestId('settings-save')).toBeEnabled();
  });
}

beforeEach(() => {
  useAuthStore.getState().setLocale('en');
  useAuthStore.getState().setSession({
    accessToken: accessTokenFor('VENDOR', VENDOR_USER_ID),
    refreshToken: 'r.jwt',
  });
  useVendorShopStore.setState({ online: true, stored: null });
  useToastStore.setState({ toast: null });
});

describe('delivery settings: form and wire format', () => {
  it('turns the form into the seven settings the API takes, empty where they do not apply', () => {
    const form = formFromDeliveryResponse(
      settings({
        delivery_scope: 'CITY_WIDE',
        serviceable_palikas: [OWN_PALIKA, 'Lalitpur Metropolitan City'],
        base_delivery_fee_npr: 40,
        delivery_fee_per_km_npr: 12.5,
        free_delivery_above_npr: 2000,
      }),
      '',
    );
    expect(form).toMatchObject({
      radiusKm: '5',
      palikas: [OWN_PALIKA, 'Lalitpur Metropolitan City'],
      baseFee: '40',
      perKmFee: '12.5',
      freeAbove: '2000',
    });

    const result = validateDeliverySettings(form);
    if (!result.ok) throw new Error('the form should be valid');
    expect(deliveryRequestOf(result.settings)).toEqual({
      fulfillment_mode: 'SELF_DELIVERY',
      delivery_scope: 'CITY_WIDE',
      radius_km: null,
      serviceable_palikas: [OWN_PALIKA, 'Lalitpur Metropolitan City'],
      base_delivery_fee_npr: 40,
      delivery_fee_per_km_npr: 12.5,
      free_delivery_above_npr: 2000,
      min_order_value: 0,
    });
  });

  it('shows no municipality list for a shop outside the city tier, although the server keeps one', () => {
    expect(formFromDeliveryResponse(settings(), '302118845')).toMatchObject({
      taxId: '302118845',
      palikas: [],
    });
  });

  it('never sends settings the API would refuse', async () => {
    const saves = serve();

    await expect(
      saveDeliverySettings({
        fulfillment_mode: 'PLATFORM_FLEET',
        delivery_scope: 'NATION_WIDE',
        radius_km: null,
        serviceable_palikas: [],
        base_delivery_fee_npr: 40,
        delivery_fee_per_km_npr: 0,
        free_delivery_above_npr: null,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_DELIVERY_SETTINGS' });
    await expect(
      saveDeliverySettings({
        fulfillment_mode: 'SELF_DELIVERY',
        delivery_scope: 'CITY_WIDE',
        radius_km: null,
        serviceable_palikas: ['Atlantis Municipality'],
        base_delivery_fee_npr: 0,
        delivery_fee_per_km_npr: 0,
        free_delivery_above_npr: null,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_DELIVERY_SETTINGS' });
    expect(saves).toEqual([]);
  });
});

describe('Shop settings: delivery settings on the server', () => {
  it('opens on what the server holds, not on what the phone last saved', async () => {
    useVendorShopStore.getState().saveSettings(
      {
        taxId: '302118845',
        fulfillmentMode: 'SELF_DELIVERY',
        deliveryScope: 'RADIUS_BOUND',
        radiusKm: 3,
        serviceablePalikas: [],
        baseDeliveryFeeNpr: 10,
        perKmFeeNpr: 0,
        freeDeliveryAboveNpr: null,
      },
      VENDOR_USER_ID,
    );
    serve({
      settings: {
        delivery_scope: 'CITY_WIDE',
        serviceable_palikas: [OWN_PALIKA, 'Lalitpur Metropolitan City'],
        base_delivery_fee_npr: 60,
        free_delivery_above_npr: 1500,
      },
    });

    await open();

    expect(screen.getByTestId('settings-scope-CITY_WIDE')).toBeSelected();
    expect(screen.getByTestId('settings-base-fee')).toHaveDisplayValue('60');
    expect(screen.getByTestId('settings-free-above')).toHaveDisplayValue('1500');
    expect(screen.getByText('Lalitpur Metropolitan City')).toBeOnTheScreen();
    // The shop's own municipality is marked and cannot be removed.
    expect(
      screen.getByText('Kathmandu Metropolitan City (your own, always served)'),
    ).toBeOnTheScreen();
    expect(screen.queryByTestId(`settings-palika-remove-${OWN_PALIKA}`)).not.toBeOnTheScreen();
    expect(
      screen.getByTestId('settings-palika-remove-Lalitpur Metropolitan City'),
    ).toBeOnTheScreen();
  });

  it('saves the delivery charges and shows the server’s answer', async () => {
    const saves = serve();
    await open();

    type('settings-radius', '7.5');
    type('settings-base-fee', '40');
    type('settings-per-km-fee', '12.5');
    type('settings-free-above', '2000');
    press('settings-save');

    await waitFor(() => {
      expect(toast()).toMatchObject({ message: 'Shop settings saved.', tone: 'success' });
    });
    expect(saves).toHaveLength(1);
    expect(saves[0]?.method).toBe('PUT');
    expect(saves[0]?.headers.get('authorization')).toMatch(/^Bearer /);
    expect(saves[0]?.body).toEqual({
      fulfillment_mode: 'SELF_DELIVERY',
      delivery_scope: 'RADIUS_BOUND',
      radius_km: 7.5,
      serviceable_palikas: [],
      base_delivery_fee_npr: 40,
      delivery_fee_per_km_npr: 12.5,
      free_delivery_above_npr: 2000,
      min_order_value: 0,
    });
    expect(screen.getByTestId('settings-radius')).toHaveDisplayValue('7.5');
    expect(screen.getByTestId('settings-base-fee')).toHaveDisplayValue('40');
  });

  it('saves the municipalities a city shop serves, and shows its own one the server added', async () => {
    const saves = serve();
    await open();

    press('settings-scope-CITY_WIDE');
    press('settings-palika');
    press('settings-palika-option-Lalitpur Metropolitan City');
    press('settings-palika');
    press('settings-palika-option-Bhaktapur Municipality');
    press('settings-save');

    await waitFor(() => {
      expect(toast()).toMatchObject({ tone: 'success' });
    });
    expect(saves[0]?.body).toMatchObject({
      delivery_scope: 'CITY_WIDE',
      radius_km: null,
      serviceable_palikas: ['Lalitpur Metropolitan City', 'Bhaktapur Municipality'],
    });
    // The answer, not what was typed: the shop's own Palika now leads the list.
    await waitFor(() => {
      expect(
        screen.getByText('Kathmandu Metropolitan City (your own, always served)'),
      ).toBeOnTheScreen();
    });
    expect(screen.getByText('Bhaktapur Municipality')).toBeOnTheScreen();

    // Removing one and saving again sends the shorter list.
    press('settings-palika-remove-Bhaktapur Municipality');
    press('settings-save');
    await waitFor(() => {
      expect(saves).toHaveLength(2);
    });
    expect(saves[1]?.body).toMatchObject({
      serviceable_palikas: [OWN_PALIKA, 'Lalitpur Metropolitan City'],
    });
  });

  it('sends no charges under platform delivery, and says who sets that fee', async () => {
    const saves = serve({ settings: { base_delivery_fee_npr: 40 } });
    await open();

    press('settings-mode-PLATFORM_FLEET');
    expect(screen.getByTestId('settings-platform-fee')).toHaveTextContent(
      'Hamro Pasal sets this delivery charge: Rs. 50 per order.',
    );
    press('settings-scope-NATION_WIDE');
    press('settings-save');

    await waitFor(() => {
      expect(saves).toHaveLength(1);
    });
    expect(saves[0]?.body).toEqual({
      fulfillment_mode: 'PLATFORM_FLEET',
      delivery_scope: 'NATION_WIDE',
      radius_km: null,
      serviceable_palikas: [],
      base_delivery_fee_npr: 0,
      delivery_fee_per_km_npr: 0,
      free_delivery_above_npr: null,
      min_order_value: 0,
    });
  });

  it('checks the form on the phone first: an invalid charge sends nothing', async () => {
    const saves = serve();
    await open();

    type('settings-free-above', '0');
    press('settings-save');

    expect(screen.getByTestId('settings-free-above-error')).toHaveTextContent(
      'Enter an amount in rupees.',
    );
    expect(toast()).toMatchObject({ message: 'Check the highlighted fields.', tone: 'error' });
    expect(saves).toEqual([]);
  });

  it('cannot choose a mode Hamro Pasal has switched off', async () => {
    const saves = serve({
      settings: {
        platform: {
          self_delivery_enabled: true,
          platform_fleet_enabled: false,
          platform_delivery_fee_npr: 50,
        },
      },
    });
    await open();

    const fleet = screen.getByTestId('settings-mode-PLATFORM_FLEET');
    expect(fleet).toBeDisabled();
    expect(screen.getByText('Switched off by Hamro Pasal for now.')).toBeOnTheScreen();
    fireEvent.press(fleet);

    expect(screen.getByTestId('settings-mode-SELF_DELIVERY')).toBeSelected();
    expect(saves).toEqual([]);
  });

  it('tells a shop whose own mode was switched off that it is offline, and lets it move', async () => {
    const saves = serve({
      settings: {
        platform: {
          self_delivery_enabled: false,
          platform_fleet_enabled: true,
          platform_delivery_fee_npr: 50,
        },
        fulfillment_mode_enabled: false,
      },
    });
    await open();

    expect(screen.getByTestId('settings-forced-offline')).toHaveTextContent(
      /^Hamro Pasal has switched your delivery mode off\. Your shop takes no orders/,
    );
    // Its current mode stays selected (it may still save its other settings); the other is open.
    expect(screen.getByTestId('settings-mode-SELF_DELIVERY')).toBeSelected();
    expect(screen.getByTestId('settings-mode-PLATFORM_FLEET')).toBeEnabled();

    press('settings-mode-PLATFORM_FLEET');
    press('settings-save');

    await waitFor(() => {
      expect(saves).toHaveLength(1);
    });
    expect(saves[0]?.body).toMatchObject({ fulfillment_mode: 'PLATFORM_FLEET' });
  });

  it('words the server’s refusals and keeps what was typed', async () => {
    let answer: Response = HttpResponse.json(
      { error: { code: 'DELIVERY_MODE_DISABLED', message: 'off' } },
      { status: 422 },
    );
    const saves = serve({ refuse: () => answer });
    await open();
    type('settings-base-fee', '40');

    press('settings-save');
    await waitFor(() => {
      expect(toast()).toMatchObject({
        message:
          'Hamro Pasal has switched this delivery mode off for now. Please choose the other one.',
        tone: 'error',
      });
    });

    answer = HttpResponse.json(
      { error: { code: 'VALIDATION_FAILED', message: 'no' } },
      { status: 400 },
    );
    press('settings-save');
    await waitFor(() => {
      expect(toast()).toMatchObject({
        message: 'These settings were not accepted. Check the highlighted fields.',
      });
    });

    answer = HttpResponse.error();
    press('settings-save');
    await waitFor(() => {
      expect(toast()).toMatchObject({
        message: 'No connection. Your delivery settings were not saved.',
      });
    });

    answer = HttpResponse.json(
      { error: { code: 'INTERNAL_SERVER_ERROR', message: 'x' } },
      { status: 500 },
    );
    press('settings-save');
    await waitFor(() => {
      expect(toast()).toMatchObject({
        message: "Couldn't save your delivery settings. Try again.",
      });
    });

    // One request per press: nothing is retried by itself. The form still holds the change.
    expect(saves).toHaveLength(4);
    expect(screen.getByTestId('settings-base-fee')).toHaveDisplayValue('40');
    expect(useVendorShopStore.getState().stored).toBeNull();
  });

  it('cannot save until the server’s settings have loaded, and offers to load them again', async () => {
    const saves = serve();
    let fail = true;
    server.use(
      http.get(apiUrl(PATH), () =>
        fail
          ? HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'no' } }, { status: 403 })
          : HttpResponse.json(settings({ base_delivery_fee_npr: 25 })),
      ),
    );
    renderWithProviders(<VendorSettingsScreen />);

    expect(await screen.findByTestId('settings-delivery-error')).toBeOnTheScreen();
    // Saving the form's defaults over settings that could not be read would replace them.
    expect(screen.getByTestId('settings-save')).toBeDisabled();
    press('settings-save');
    expect(saves).toEqual([]);

    fail = false;
    press('settings-delivery-retry');

    await waitFor(() => {
      expect(screen.getByTestId('settings-save')).toBeEnabled();
    });
    expect(screen.getByTestId('settings-base-fee')).toHaveDisplayValue('25');
  });

  it('keeps a copy on the phone once a PAN is on file, for the dashboard reminder', async () => {
    serve({ settings: { base_delivery_fee_npr: 40 } });
    server.use(
      http.get(apiUrl('/api/vendor/tax-identity'), () =>
        HttpResponse.json({
          vendor_id: VENDOR_ID,
          tax_id: '302118845',
          is_vat_registered: false,
          legal_name: null,
          registered_address: null,
          status: 'LIVE',
          pan_verified_at: null,
          has_pan_document: false,
        }),
      ),
    );
    await open();
    await waitFor(() => {
      expect(screen.getByTestId('settings-tax-id')).toHaveDisplayValue('302118845');
    });

    press('settings-save');

    await waitFor(() => {
      expect(useVendorShopStore.getState().stored).toEqual({
        userId: VENDOR_USER_ID,
        settings: {
          taxId: '302118845',
          fulfillmentMode: 'SELF_DELIVERY',
          deliveryScope: 'RADIUS_BOUND',
          radiusKm: 5,
          serviceablePalikas: [],
          baseDeliveryFeeNpr: 40,
          perKmFeeNpr: 0,
          freeDeliveryAboveNpr: null,
          minOrderValueNpr: 0,
        },
      });
    });
  });

  it('reads Nepali under ne', async () => {
    serve({
      settings: {
        platform: {
          self_delivery_enabled: true,
          platform_fleet_enabled: false,
          platform_delivery_fee_npr: 50,
        },
      },
    });
    await open('ne');

    expect(screen.getByText('हाम्रो पसलले अहिलेका लागि बन्द गरेको छ।')).toBeOnTheScreen();
  });
});
