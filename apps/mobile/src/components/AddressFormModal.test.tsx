import type { NepalAddress } from '@hamro-pasal/shared-types';
import { act, fireEvent, screen } from '@testing-library/react-native';

import { useAuthStore } from '../store/useAuthStore';
import { THAMEL_ADDRESS } from '../test/api-fixtures';
import { renderWithProviders } from '../test/render';
import { AddressFormModal } from './AddressFormModal';

const KATHMANDU_PIN = { latitude: 27.7154, longitude: 85.3123 };

function renderForm({
  initial = null,
  locatePin = () => Promise.resolve(KATHMANDU_PIN),
  locale = 'en',
}: {
  initial?: NepalAddress | null;
  locatePin?: () => Promise<{ latitude: number; longitude: number } | null>;
  locale?: 'en' | 'ne';
} = {}) {
  const onSave = jest.fn();
  const onClose = jest.fn();
  useAuthStore.getState().setLocale(locale);
  renderWithProviders(
    <AddressFormModal
      visible
      initial={initial}
      onSave={onSave}
      onClose={onClose}
      locatePin={locatePin}
    />,
    { locale },
  );
  return { onSave, onClose };
}

function pick(selectTestId: string, option: string): void {
  fireEvent.press(screen.getByTestId(selectTestId));
  fireEvent.press(screen.getByText(option));
}

async function dropPin(): Promise<void> {
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Use my current location' }));
    await Promise.resolve();
  });
}

async function fillValidAddress(ward = '26'): Promise<void> {
  pick('address-province', '3. Bagmati');
  pick('address-district', 'Kathmandu');
  fireEvent.changeText(screen.getByTestId('address-palika'), 'Kathmandu Metropolitan City');
  fireEvent.changeText(screen.getByTestId('address-ward'), ward);
  fireEvent.changeText(screen.getByTestId('address-tole'), 'Thamel');
  fireEvent.changeText(screen.getByTestId('address-landmark'), 'Near Kathmandu Guest House');
  await dropPin();
}

const save = () => {
  fireEvent.press(screen.getByRole('button', { name: 'Save address' }));
};

afterEach(() => {
  useAuthStore.getState().setLocale('en');
});

describe('AddressFormModal', () => {
  it('saves a valid address as the schema output', async () => {
    const { onSave } = renderForm();
    await fillValidAddress();

    save();

    expect(onSave).toHaveBeenCalledWith(THAMEL_ADDRESS);
  });

  it('rejects ward 34 and does not save', async () => {
    const { onSave } = renderForm();
    await fillValidAddress('34');

    save();

    expect(screen.getByTestId('address-error-ward_number')).toHaveTextContent(
      'Enter a ward number from 1 to 33.',
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it('accepts a ward typed in Devanagari digits', async () => {
    const { onSave } = renderForm();
    await fillValidAddress('२६');

    save();

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ ward_number: 26 }));
  });

  it('shows an error for every missing field of an empty form', () => {
    const { onSave } = renderForm();

    save();

    for (const field of [
      'province_id',
      'district_string',
      'municipality_palika_string',
      'ward_number',
      'tole_locality',
      'landmark',
      'pin',
    ]) {
      expect(screen.getByTestId(`address-error-${field}`)).toBeOnTheScreen();
    }
    expect(onSave).not.toHaveBeenCalled();
  });

  it('cascades districts from the chosen province and resets them when it changes', () => {
    renderForm();
    expect(screen.getByTestId('address-district')).toBeDisabled();

    pick('address-province', '3. Bagmati');
    fireEvent.press(screen.getByTestId('address-district'));
    expect(screen.getByText('Kathmandu')).toBeOnTheScreen();
    expect(screen.queryByText('Jhapa')).toBeNull();
    fireEvent.press(screen.getByText('Kathmandu'));

    // Switching to Koshi clears Kathmandu, so a mismatched pair cannot be submitted.
    pick('address-province', '1. Koshi');
    expect(screen.getByTestId('address-district')).toHaveTextContent('Select…');
    fireEvent.press(screen.getByTestId('address-district'));
    expect(screen.getByText('Jhapa')).toBeOnTheScreen();
    expect(screen.queryByText('Kathmandu')).toBeNull();
  });

  it('cannot submit a district left over from a previously chosen province', () => {
    // Editing the saved Kathmandu address: pick Koshi/Jhapa, then switch back to Bagmati.
    const { onSave } = renderForm({ initial: THAMEL_ADDRESS });
    pick('address-province', '1. Koshi');
    pick('address-district', 'Jhapa');
    pick('address-province', '3. Bagmati');

    save();

    expect(screen.getByTestId('address-error-district_string')).toHaveTextContent(
      'Select a district in the selected province.',
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it('pre-fills the saved address', () => {
    const { onSave } = renderForm({ initial: THAMEL_ADDRESS });

    expect(screen.getByTestId('address-province')).toHaveTextContent('3. Bagmati');
    expect(screen.getByTestId('address-district')).toHaveTextContent('Kathmandu');
    expect(screen.getByTestId('address-ward').props.value).toBe('26');

    save();
    expect(onSave).toHaveBeenCalledWith(THAMEL_ADDRESS);
  });

  it('captures the pin from the location source, and explains a failure', async () => {
    renderForm({ locatePin: () => Promise.resolve(null) });
    expect(screen.getByTestId('address-pin-value')).toHaveTextContent('No pin yet');

    await dropPin();

    expect(
      screen.getByText("Couldn't get your location. Check that GPS is on and try again."),
    ).toBeOnTheScreen();
  });

  it('shows the pinned coordinates', async () => {
    renderForm();

    await dropPin();

    expect(screen.getByTestId('address-pin-value')).toHaveTextContent('27.7154, 85.3123');
  });

  it('labels provinces in Nepali with Devanagari numbers', () => {
    renderForm({ locale: 'ne' });

    fireEvent.press(screen.getByTestId('address-province'));

    expect(screen.getByText('३. बागमती')).toBeOnTheScreen();
    expect(screen.getByText('७. सुदूरपश्चिम')).toBeOnTheScreen();
  });

  it('closes without saving', () => {
    const { onSave, onClose } = renderForm();

    fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});
