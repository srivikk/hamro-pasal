import { fireEvent, screen } from '@testing-library/react-native';

import VendorSettingsScreen from '../../../app/(vendor)/settings';
import { selectHasSession, useAuthStore } from '../../store/useAuthStore';
import { useToastStore } from '../../store/useToastStore';
import { useVendorShopStore } from '../../store/useVendorShopStore';
import { accessTokenFor } from '../../test/access-tokens';
import { renderWithProviders } from '../../test/render';
import { VendorOnlineToggle } from './VendorOnlineToggle';

// The PAN document card talks to the API and has its own tests (PanDocument.test.tsx); this
// file is about the form itself: what it shows, what it checks and what it hands on.
jest.mock('./PanDocumentCard', () => ({ PanDocumentCard: () => null }));
// The tax identity is the server's and has its own tests too (TaxIdentity.test.tsx): here nothing
// is on file and nothing is being saved, so the form shows what the phone holds.
jest.mock('./usePanDocument', () => ({
  useTaxIdentityQuery: () => ({ data: undefined, isError: false }),
  useSaveTaxIdentity: () => ({ mutate: jest.fn(), isPending: false }),
}));

// The delivery settings are the server's (DeliverySettings.test.tsx drives the real requests).
// Here a stand-in holds them in memory and answers a save as the API does: what was sent,
// with the shop's own Palika kept in the list and the stored radius kept outside the radius tier.
const MOCK_OWN_PALIKA = 'Kathmandu Metropolitan City';
const mockNewShop = () => ({
  vendor_id: '7b1f0c8e-0000-4000-8000-0000000000aa',
  fulfillment_mode: 'SELF_DELIVERY' as 'SELF_DELIVERY' | 'PLATFORM_FLEET',
  delivery_scope: 'RADIUS_BOUND' as 'RADIUS_BOUND' | 'CITY_WIDE' | 'NATION_WIDE',
  radius_km: 5,
  serviceable_palikas: [MOCK_OWN_PALIKA],
  municipality_palika_string: MOCK_OWN_PALIKA,
  base_delivery_fee_npr: 0,
  delivery_fee_per_km_npr: 0,
  free_delivery_above_npr: null as number | null,
  min_order_value: 0,
  platform: {
    self_delivery_enabled: true,
    platform_fleet_enabled: true,
    platform_delivery_fee_npr: 50,
  },
  fulfillment_mode_enabled: true,
});
let mockDelivery = mockNewShop();
const mockSaves: unknown[] = [];
jest.mock('./useDeliverySettings', () => ({
  useDeliverySettingsQuery: () => ({ data: mockDelivery, isError: false, refetch: jest.fn() }),
  useSaveDeliverySettings: () => ({
    isPending: false,
    mutate: (
      draft: {
        fulfillment_mode: 'SELF_DELIVERY' | 'PLATFORM_FLEET';
        delivery_scope: 'RADIUS_BOUND' | 'CITY_WIDE' | 'NATION_WIDE';
        radius_km: number | null;
        serviceable_palikas: string[];
        base_delivery_fee_npr: number;
        delivery_fee_per_km_npr: number;
        free_delivery_above_npr: number | null;
        min_order_value?: number;
      },
      options?: { onSuccess?: (result: unknown) => void },
    ) => {
      mockSaves.push(draft);
      mockDelivery = {
        ...mockDelivery,
        ...draft,
        radius_km: draft.radius_km ?? mockDelivery.radius_km,
        serviceable_palikas: [
          MOCK_OWN_PALIKA,
          ...draft.serviceable_palikas.filter((name) => name !== MOCK_OWN_PALIKA),
        ],
      };
      options?.onSuccess?.(mockDelivery);
    },
  }),
}));

const VENDOR_USER_ID = '9f1c2a10-0000-4000-8000-0000000000aa';

const field = (testID: string) => screen.queryByTestId(testID);
const press = (testID: string): void => {
  fireEvent.press(screen.getByTestId(testID));
};
const type = (testID: string, text: string): void => {
  fireEvent.changeText(screen.getByTestId(testID), text);
};
const stored = () => useVendorShopStore.getState().stored;
const toast = () => useToastStore.getState().toast;

beforeEach(() => {
  useAuthStore.getState().clearSession();
  useAuthStore.getState().setLocale('en');
  useAuthStore.getState().setSession({
    accessToken: accessTokenFor('VENDOR', VENDOR_USER_ID),
    refreshToken: 'r.jwt',
  });
  useVendorShopStore.setState({ online: true, stored: null });
  useToastStore.setState({ toast: null });
  mockDelivery = mockNewShop();
  mockSaves.length = 0;
});

describe('Shop settings: PAN', () => {
  it('takes digits only (Nepali digits converted) and never more than nine', () => {
    renderWithProviders(<VendorSettingsScreen />);

    type('settings-tax-id', '30-12 34x567890');
    expect(screen.getByTestId('settings-tax-id')).toHaveDisplayValue('301234567');

    type('settings-tax-id', '३०१२३४५६७');
    expect(screen.getByTestId('settings-tax-id')).toHaveDisplayValue('301234567');
  });

  it('is not needed to save the delivery settings, but the phone keeps no copy without one', () => {
    // A shop still being set up configures its delivery before its PAN is on file; the PAN has
    // its own Save (TaxIdentity.test.tsx).
    renderWithProviders(<VendorSettingsScreen />);
    type('settings-tax-id', '30123');
    type('settings-base-fee', '40');

    press('settings-save');

    expect(screen.queryByTestId('settings-tax-id-error')).not.toBeOnTheScreen();
    expect(toast()).toMatchObject({ message: 'Shop settings saved.', tone: 'success' });
    expect(mockSaves).toHaveLength(1);
    expect(mockSaves[0]).toMatchObject({ base_delivery_fee_npr: 40 });
    expect(stored()).toBeNull();
  });
});

describe('Shop settings: delivery mode and charges', () => {
  it('opens on self delivery with the three charge fields, base and per-km at 0', () => {
    renderWithProviders(<VendorSettingsScreen />);

    expect(screen.getByTestId('settings-mode-SELF_DELIVERY')).toBeSelected();
    expect(screen.getByTestId('settings-base-fee')).toHaveDisplayValue('0');
    expect(screen.getByTestId('settings-per-km-fee')).toHaveDisplayValue('0');
    expect(screen.getByTestId('settings-free-above')).toHaveDisplayValue('');
  });

  it('hides the charge fields under platform delivery and brings them back for self delivery', () => {
    renderWithProviders(<VendorSettingsScreen />);

    press('settings-mode-PLATFORM_FLEET');
    expect(screen.getByTestId('settings-mode-PLATFORM_FLEET')).toBeSelected();
    expect(field('settings-base-fee')).not.toBeOnTheScreen();
    expect(field('settings-per-km-fee')).not.toBeOnTheScreen();
    expect(field('settings-free-above')).not.toBeOnTheScreen();

    press('settings-mode-SELF_DELIVERY');
    expect(field('settings-base-fee')).toBeOnTheScreen();
    expect(field('settings-per-km-fee')).toBeOnTheScreen();
    expect(field('settings-free-above')).toBeOnTheScreen();
  });

  it('refuses a charge that is not an amount', () => {
    renderWithProviders(<VendorSettingsScreen />);
    type('settings-tax-id', '301234567');
    type('settings-free-above', '0');

    press('settings-save');

    expect(screen.getByTestId('settings-free-above-error')).toHaveTextContent(
      'Enter an amount in rupees.',
    );
    expect(stored()).toBeNull();
    expect(mockSaves).toEqual([]);
  });
});

describe('Shop settings: delivery scope', () => {
  it('shows the radius for Radius, the municipality list for City / Regional, neither for National', () => {
    renderWithProviders(<VendorSettingsScreen />);
    expect(screen.getByTestId('settings-radius')).toHaveDisplayValue('5');
    expect(field('settings-palika')).not.toBeOnTheScreen();

    press('settings-scope-CITY_WIDE');
    expect(field('settings-radius')).not.toBeOnTheScreen();
    expect(field('settings-palika')).toBeOnTheScreen();

    press('settings-scope-NATION_WIDE');
    expect(field('settings-radius')).not.toBeOnTheScreen();
    expect(field('settings-palika')).not.toBeOnTheScreen();
  });

  it('picks municipalities from a searchable list: nothing can be typed in as a name', () => {
    renderWithProviders(<VendorSettingsScreen />);
    press('settings-scope-CITY_WIDE');

    press('settings-palika');
    expect(
      screen.getByTestId('settings-palika-option-Kathmandu Metropolitan City'),
    ).toBeOnTheScreen();
    expect(
      screen.getByTestId('settings-palika-option-Pokhara Metropolitan City'),
    ).toBeOnTheScreen();

    type('settings-palika-search', 'lalit');
    expect(
      screen.getByTestId('settings-palika-option-Lalitpur Metropolitan City'),
    ).toBeOnTheScreen();
    expect(field('settings-palika-option-Kathmandu Metropolitan City')).not.toBeOnTheScreen();

    type('settings-palika-search', 'Lalitpur Metro Citty');
    expect(screen.getByTestId('settings-palika-empty')).toHaveTextContent(
      'No municipality matches.',
    );
    // A search that matches nothing adds nothing: there is no "add what I typed".
    expect(screen.queryByText('Lalitpur Metro Citty')).not.toBeOnTheScreen();
  });

  it('adds the picked municipalities (each once), removes one, and needs at least one', () => {
    renderWithProviders(<VendorSettingsScreen />);
    type('settings-tax-id', '301234567');
    press('settings-scope-CITY_WIDE');

    press('settings-save');
    expect(screen.getByTestId('settings-palikas-error')).toHaveTextContent(
      'Add at least one municipality.',
    );

    press('settings-palika');
    press('settings-palika-option-Lalitpur Metropolitan City');
    // Choosing closes the list, and a chosen municipality is no longer offered.
    expect(field('settings-palika-search')).not.toBeOnTheScreen();
    press('settings-palika');
    expect(field('settings-palika-option-Lalitpur Metropolitan City')).not.toBeOnTheScreen();
    press('settings-palika-option-Kirtipur Municipality');

    press('settings-palika-remove-Kirtipur Municipality');
    press('settings-save');

    expect(stored()?.settings).toMatchObject({
      deliveryScope: 'CITY_WIDE',
      radiusKm: null,
      serviceablePalikas: ['Lalitpur Metropolitan City'],
    });
  });
});

describe('Shop settings: saving', () => {
  it('saves for the signed-in account and shows the saved values when reopened', () => {
    const first = renderWithProviders(<VendorSettingsScreen />);
    type('settings-tax-id', '301234567');
    type('settings-radius', '7.5');
    type('settings-base-fee', '40');
    type('settings-per-km-fee', '12.5');
    type('settings-free-above', '2000');

    press('settings-save');

    expect(toast()).toMatchObject({ message: 'Shop settings saved.', tone: 'success' });
    expect(stored()).toEqual({
      userId: VENDOR_USER_ID,
      settings: {
        taxId: '301234567',
        fulfillmentMode: 'SELF_DELIVERY',
        deliveryScope: 'RADIUS_BOUND',
        radiusKm: 7.5,
        serviceablePalikas: [],
        baseDeliveryFeeNpr: 40,
        perKmFeeNpr: 12.5,
        freeDeliveryAboveNpr: 2000,
        minOrderValueNpr: 0,
      },
    });
    first.unmount();

    renderWithProviders(<VendorSettingsScreen />);
    expect(screen.getByTestId('settings-tax-id')).toHaveDisplayValue('301234567');
    expect(screen.getByTestId('settings-radius')).toHaveDisplayValue('7.5');
    expect(screen.getByTestId('settings-free-above')).toHaveDisplayValue('2000');
  });

  it('saves platform delivery with no charges of its own', () => {
    renderWithProviders(<VendorSettingsScreen />);
    type('settings-tax-id', '301234567');
    type('settings-base-fee', '40');
    press('settings-mode-PLATFORM_FLEET');
    press('settings-scope-NATION_WIDE');

    press('settings-save');

    expect(stored()?.settings).toEqual({
      taxId: '301234567',
      fulfillmentMode: 'PLATFORM_FLEET',
      deliveryScope: 'NATION_WIDE',
      radiusKm: null,
      serviceablePalikas: [],
      baseDeliveryFeeNpr: 0,
      perKmFeeNpr: 0,
      freeDeliveryAboveNpr: null,
      minOrderValueNpr: 0,
    });
  });

  it("never shows another account's settings", () => {
    useVendorShopStore.getState().saveSettings(
      {
        taxId: '999999999',
        fulfillmentMode: 'PLATFORM_FLEET',
        deliveryScope: 'NATION_WIDE',
        radiusKm: null,
        serviceablePalikas: [],
        baseDeliveryFeeNpr: 0,
        perKmFeeNpr: 0,
        freeDeliveryAboveNpr: null,
      },
      'another-vendor-user',
    );

    renderWithProviders(<VendorSettingsScreen />);

    expect(screen.getByTestId('settings-tax-id')).toHaveDisplayValue('');
    expect(screen.getByTestId('settings-mode-SELF_DELIVERY')).toBeSelected();
  });

  it('signs out from here', () => {
    renderWithProviders(<VendorSettingsScreen />);

    press('settings-sign-out');

    expect(selectHasSession(useAuthStore.getState())).toBe(false);
  });
});

describe('the Online / Offline switch', () => {
  it('shows the shop as Online and turns it Offline and back', () => {
    renderWithProviders(<VendorOnlineToggle />);
    const toggle = screen.getByTestId('vendor-online-toggle');
    expect(screen.getByTestId('vendor-online-label')).toHaveTextContent('Online');
    expect(toggle.props.value).toBe(true);

    fireEvent(toggle, 'valueChange', false);

    expect(useVendorShopStore.getState().online).toBe(false);
    expect(screen.getByTestId('vendor-online-label')).toHaveTextContent('Offline');

    fireEvent(screen.getByTestId('vendor-online-toggle'), 'valueChange', true);
    expect(useVendorShopStore.getState().online).toBe(true);
  });

  it('reads Nepali under ne', () => {
    renderWithProviders(<VendorOnlineToggle />, { locale: 'ne' });
    expect(screen.getByTestId('vendor-online-label')).toHaveTextContent('अनलाइन');
  });
});
