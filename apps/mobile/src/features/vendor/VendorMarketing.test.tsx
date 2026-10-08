import { act, fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Alert, type AlertButton } from 'react-native';

import VendorMarketingScreen from '../../../app/(vendor)/marketing';
import VendorOfferScreen from '../../../app/(vendor)/offer';
import { useAuthStore } from '../../store/useAuthStore';
import { useToastStore } from '../../store/useToastStore';
import { useVendorMarketingStore } from '../../store/useVendorMarketingStore';
import { renderWithProviders } from '../../test/render';
import { validateOfferForm } from './marketing-rules';

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

beforeEach(() => {
  marketing().reset();
  useAuthStore.getState().setLocale('en');
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
