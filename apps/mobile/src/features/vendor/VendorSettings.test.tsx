import { fireEvent, screen } from '@testing-library/react-native';

import VendorSettingsScreen from '../../../app/(vendor)/settings';
import { selectHasSession, useAuthStore } from '../../store/useAuthStore';
import { useToastStore } from '../../store/useToastStore';
import { useVendorShopStore } from '../../store/useVendorShopStore';
import { accessTokenFor } from '../../test/access-tokens';
import { renderWithProviders } from '../../test/render';
import { VendorOnlineToggle } from './VendorOnlineToggle';

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
});

describe('Shop settings: PAN', () => {
  it('takes digits only (Nepali digits converted) and never more than nine', () => {
    renderWithProviders(<VendorSettingsScreen />);

    type('settings-tax-id', '30-12 34x567890');
    expect(screen.getByTestId('settings-tax-id')).toHaveDisplayValue('301234567');

    type('settings-tax-id', '३०१२३४५६७');
    expect(screen.getByTestId('settings-tax-id')).toHaveDisplayValue('301234567');
  });

  it('is mandatory: nothing is saved without nine digits', () => {
    renderWithProviders(<VendorSettingsScreen />);
    type('settings-tax-id', '30123');

    press('settings-save');

    expect(screen.getByTestId('settings-tax-id-error')).toHaveTextContent(
      'Enter your 9-digit PAN.',
    );
    expect(toast()).toMatchObject({ message: 'Check the highlighted fields.', tone: 'error' });
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
