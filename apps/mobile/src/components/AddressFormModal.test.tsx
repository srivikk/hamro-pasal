import { act, fireEvent, screen } from '@testing-library/react-native';

import type { AddressDraft } from '../store/useAddressStore';
import { useAuthStore } from '../store/useAuthStore';
import { describePlace } from '../features/location/describe-place';
import { THAMEL_ADDRESS } from '../test/api-fixtures';
import { mockWebView } from '../test/mock-webview';
import { renderWithProviders } from '../test/render';
import { AddressFormModal } from './AddressFormModal';

const KATHMANDU_PIN = { latitude: 27.7154, longitude: 85.3123 };
const THAMEL_HOME: AddressDraft = { label: 'HOME', recipient: null, address: THAMEL_ADDRESS };

/** What the map page posts after the customer moves it. */
function moveMapTo(lat: number, lng: number): void {
  const onMessage = mockWebView.props?.onMessage;
  if (onMessage === undefined) throw new Error('No map WebView is rendered');
  act(() => {
    onMessage({
      nativeEvent: { data: JSON.stringify({ type: 'center', lat, lng }) },
    } as Parameters<typeof onMessage>[0]);
  });
}

function renderForm({
  initial = null,
  locatePin = () => Promise.resolve(KATHMANDU_PIN),
  locale = 'en',
}: {
  initial?: AddressDraft | null;
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
  jest.mocked(describePlace).mockResolvedValue(null);
});

describe('AddressFormModal', () => {
  it('saves a valid address as the schema output', async () => {
    const { onSave } = renderForm();
    await fillValidAddress();

    save();

    expect(onSave).toHaveBeenCalledWith(THAMEL_HOME);
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

    expect(onSave).toHaveBeenCalledWith({ ...THAMEL_HOME, address: THAMEL_ADDRESS });
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
    const { onSave } = renderForm({ initial: THAMEL_HOME });
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
    const { onSave } = renderForm({ initial: THAMEL_HOME });

    expect(screen.getByTestId('address-province')).toHaveTextContent('3. Bagmati');
    expect(screen.getByTestId('address-district')).toHaveTextContent('Kathmandu');
    expect(screen.getByTestId('address-ward').props.value).toBe('26');

    save();
    expect(onSave).toHaveBeenCalledWith(THAMEL_HOME);
  });

  it('captures the pin from the location source, and explains a failure', async () => {
    renderForm({ locatePin: () => Promise.resolve(null) });
    expect(screen.getByTestId('address-pin-value')).toHaveTextContent('No pin yet');

    await dropPin();

    expect(
      screen.getByText("Couldn't get your location. Check that GPS is on and try again."),
    ).toBeOnTheScreen();
  });

  it('shows the pinned place by name, never its coordinates', async () => {
    jest.mocked(describePlace).mockResolvedValue('Thamel Marg, Kathmandu');
    renderForm();

    await dropPin();

    expect(await screen.findByText('Thamel Marg, Kathmandu')).toBeOnTheScreen();
    expect(describePlace).toHaveBeenCalledWith(KATHMANDU_PIN);
    expect(screen.queryByText(/27.7154/)).toBeNull();
  });

  it('says only that the pin is set when the place has no name', async () => {
    renderForm();

    await dropPin();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByTestId('address-pin-value')).toHaveTextContent('Pin set');
    expect(screen.queryByText(/27.7154/)).toBeNull();
  });

  it('labels provinces in Nepali with Devanagari numbers', () => {
    renderForm({ locale: 'ne' });

    fireEvent.press(screen.getByTestId('address-province'));

    expect(screen.getByText('३. बागमती')).toBeOnTheScreen();
    expect(screen.getByText('७. सुदूरपश्चिम')).toBeOnTheScreen();
  });

  it('saves under Home, Work or Other, asking who receives the order only for Other', async () => {
    const { onSave } = renderForm();
    await fillValidAddress();
    expect(screen.queryByTestId('address-recipient-name')).toBeNull();

    fireEvent.press(screen.getByTestId('address-label-WORK'));
    expect(screen.queryByTestId('address-recipient-name')).toBeNull();
    fireEvent.press(screen.getByTestId('address-label-OTHER'));
    save();

    expect(screen.getByTestId('address-error-recipient_name')).toHaveTextContent(
      "Enter the recipient's name.",
    );
    expect(screen.getByTestId('address-error-recipient_phone')).toBeOnTheScreen();
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.changeText(screen.getByTestId('address-recipient-name'), 'Sita Gurung');
    fireEvent.changeText(screen.getByTestId('address-recipient-phone'), '9800000002');
    save();

    expect(onSave).toHaveBeenCalledWith({
      label: 'OTHER',
      recipient: { name: 'Sita Gurung', phone: '+9779800000002' },
      address: THAMEL_ADDRESS,
    });
  });

  it('pre-fills an Other address with its recipient, and drops the recipient when it becomes Home', () => {
    const { onSave } = renderForm({
      initial: {
        label: 'OTHER',
        recipient: { name: 'Sita Gurung', phone: '+9779800000002' },
        address: THAMEL_ADDRESS,
      },
    });

    expect(screen.getByTestId('address-recipient-name').props.value).toBe('Sita Gurung');
    expect(screen.getByTestId('address-recipient-phone').props.value).toBe('9800000002');
    fireEvent.press(screen.getByTestId('address-label-HOME'));
    save();

    expect(onSave).toHaveBeenCalledWith(THAMEL_HOME);
  });

  it('drops the pin on the map: the centre the customer confirms becomes the pin', () => {
    const { onSave } = renderForm({ initial: THAMEL_HOME });

    fireEvent.press(screen.getByTestId('address-pin-map'));
    expect(screen.getByRole('button', { name: 'Use this location' })).toBeDisabled();
    moveMapTo(27.6727, 85.3249);
    fireEvent.press(screen.getByRole('button', { name: 'Use this location' }));

    expect(screen.getByTestId('address-pin-value')).toHaveTextContent('Pin set');
    save();
    expect(onSave).toHaveBeenCalledWith({
      ...THAMEL_HOME,
      address: { ...THAMEL_ADDRESS, exact_lat: 27.6727, exact_lng: 85.3249 },
    });
  });

  it('refuses a map position outside Nepal', () => {
    renderForm({ initial: THAMEL_HOME });

    fireEvent.press(screen.getByTestId('address-pin-map'));
    moveMapTo(28.6139, 77.209);

    expect(screen.getByTestId('map-pin-outside')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Use this location' })).toBeDisabled();
  });

  it('closes without saving', () => {
    const { onSave, onClose } = renderForm();

    fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});
