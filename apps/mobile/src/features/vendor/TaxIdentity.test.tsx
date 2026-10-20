import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';
import { Alert } from 'react-native';

import VendorSettingsScreen from '../../../app/(vendor)/settings';
import { saveTaxIdentity } from '../../api/vendor-tax-identity';
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

setupApiTestEnvironment();

const VENDOR_USER_ID = '9f1c2a10-0000-4000-8000-0000000000aa';
const VENDOR_ID = '7b1f0c8e-0000-4000-8000-0000000000aa';
const TAX_IDENTITY_PATH = '/api/vendor/tax-identity';

const identity = (overrides: Record<string, unknown> = {}) => ({
  vendor_id: VENDOR_ID,
  tax_id: null,
  is_vat_registered: false,
  legal_name: null,
  registered_address: null,
  status: 'LIVE',
  pan_verified_at: null,
  has_pan_document: false,
  ...overrides,
});

interface SaveBody {
  tax_id: string;
  is_vat_registered: boolean;
}

/**
 * A server that holds one shop's tax identity and applies the PUT as the API does: a changed
 * number clears the verification and removes the document.
 */
function serve(
  options: {
    identity?: Record<string, unknown>;
    save?: (body: SaveBody) => Response | null;
    answer?: Record<string, unknown>;
  } = {},
) {
  const saves: CapturedRequest[] = [];
  let current: Record<string, unknown> = identity(options.identity);
  server.use(
    http.get(apiUrl(TAX_IDENTITY_PATH), () => HttpResponse.json(current)),
    http.put(apiUrl(TAX_IDENTITY_PATH), async ({ request }) => {
      const captured = await capture(request);
      saves.push(captured);
      const body = captured.body as SaveBody;
      const refusal = options.save?.(body) ?? null;
      if (refusal !== null) return refusal;
      const changed = current.tax_id !== null && current.tax_id !== body.tax_id;
      current = {
        ...current,
        tax_id: body.tax_id,
        is_vat_registered: body.is_vat_registered,
        pan_verified_at: changed ? null : current.pan_verified_at,
        has_pan_document: changed ? false : current.has_pan_document,
      };
      return HttpResponse.json({
        vendor_id: VENDOR_ID,
        tax_id: body.tax_id,
        is_vat_registered: body.is_vat_registered,
        legal_name: null,
        registered_address: null,
        status: 'LIVE',
        compliance_suspension_lifted: false,
        pan_verified_at: current.pan_verified_at,
        waiting_invoices_issued: 0,
        pan_document_removed: changed,
        has_pan_document: current.has_pan_document,
        ...options.answer,
      });
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
const taxField = () => screen.getByTestId('settings-tax-id');
const vatSwitch = () => screen.getByTestId('settings-vat-registered');

/** The buttons of the last native alert, by their text. */
function alertButton(text: string): { onPress?: (() => void) | undefined } {
  const buttons = jest.mocked(Alert.alert).mock.calls.at(-1)?.[2] ?? [];
  const button = buttons.find((candidate) => candidate.text === text);
  if (button === undefined) throw new Error(`no alert button "${text}"`);
  return { onPress: button.onPress };
}

/** The settings screen, once the document card has read what is on file. */
async function open(locale: 'en' | 'ne' = 'en') {
  renderWithProviders(<VendorSettingsScreen />, { locale });
  await screen.findByTestId('pan-document-status');
}

beforeEach(() => {
  jest.clearAllMocks();
  useAuthStore.getState().setLocale('en');
  useAuthStore.getState().setSession({
    accessToken: accessTokenFor('VENDOR', VENDOR_USER_ID),
    refreshToken: 'r.jwt',
  });
  useVendorShopStore.setState({ online: true, stored: null });
  useToastStore.setState({ toast: null });
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
});

describe('PUT /api/vendor/tax-identity from the app', () => {
  it('sends exactly the PAN and the VAT flag, with the session', async () => {
    const saves = serve();

    const result = await saveTaxIdentity({ taxId: '302118845', isVatRegistered: true });

    expect(saves).toHaveLength(1);
    expect(saves[0]?.method).toBe('PUT');
    expect(saves[0]?.headers.get('authorization')).toMatch(/^Bearer /);
    // No name or address key: the server keeps what it has for a key that is not sent.
    expect(saves[0]?.body).toEqual({ tax_id: '302118845', is_vat_registered: true });
    expect(result).toMatchObject({ tax_id: '302118845', pan_document_removed: false });
  });

  it('never sends a number that is not nine digits', async () => {
    const saves = serve();

    for (const taxId of ['', '30211884', '3021188456', '30211884a', '३०२११८८४५']) {
      await expect(saveTaxIdentity({ taxId, isVatRegistered: false })).rejects.toMatchObject({
        code: 'INVALID_TAX_IDENTITY',
      });
    }
    expect(saves).toEqual([]);
  });

  it('reads an answer from before Phase 35 as "nothing removed"', async () => {
    serve();
    server.use(
      http.put(apiUrl(TAX_IDENTITY_PATH), () =>
        HttpResponse.json({
          vendor_id: VENDOR_ID,
          tax_id: '302118845',
          is_vat_registered: false,
          legal_name: null,
          registered_address: null,
          status: 'LIVE',
          compliance_suspension_lifted: false,
          pan_verified_at: null,
        }),
      ),
    );

    await expect(
      saveTaxIdentity({ taxId: '302118845', isVatRegistered: false }),
    ).resolves.toMatchObject({ pan_document_removed: false, waiting_invoices_issued: 0 });
  });
});

describe('Shop settings: tax identity on the server', () => {
  it('shows what is on file: the PAN and the VAT switch come from the server', async () => {
    serve({ identity: { tax_id: '302118845', is_vat_registered: true } });

    await open();

    await waitFor(() => {
      expect(taxField()).toHaveDisplayValue('302118845');
    });
    expect(vatSwitch().props.value).toBe(true);
  });

  it('saves a first PAN with the VAT switch, and says so', async () => {
    const saves = serve();
    await open();

    type('settings-tax-id', '30-2118845');
    fireEvent(vatSwitch(), 'valueChange', true);
    press('settings-tax-save');

    await waitFor(() => {
      expect(toast()).toMatchObject({ message: 'Tax identity saved.', tone: 'success' });
    });
    expect(saves.map((save) => save.body)).toEqual([
      { tax_id: '302118845', is_vat_registered: true },
    ]);
    // No question is asked for a first number, and the form now follows the server.
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(taxField()).toHaveDisplayValue('302118845');
    expect(vatSwitch().props.value).toBe(true);
  });

  it('changes only the VAT registration without asking anything', async () => {
    const saves = serve({
      identity: {
        tax_id: '302118845',
        has_pan_document: true,
        pan_verified_at: '2026-10-07T00:00:00.000Z',
      },
    });
    await open();
    await waitFor(() => {
      expect(taxField()).toHaveDisplayValue('302118845');
    });

    fireEvent(vatSwitch(), 'valueChange', true);
    press('settings-tax-save');

    await waitFor(() => {
      expect(saves).toHaveLength(1);
    });
    expect(saves[0]?.body).toEqual({ tax_id: '302118845', is_vat_registered: true });
    expect(Alert.alert).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(toast()).toMatchObject({ message: 'Tax identity saved.', tone: 'success' });
    });
    // The same number keeps its document and its verification.
    expect(screen.getByTestId('pan-document-status')).toHaveTextContent(/^Verified on/);
  });

  it('refuses anything but nine digits on the phone: nothing is sent', async () => {
    const saves = serve();
    await open();

    type('settings-tax-id', '30211');
    press('settings-tax-save');

    expect(screen.getByTestId('settings-tax-id-error')).toHaveTextContent(
      'Enter your 9-digit PAN.',
    );
    expect(toast()).toMatchObject({ message: 'Enter your 9-digit PAN.', tone: 'error' });
    expect(saves).toEqual([]);

    // Typing clears the mark.
    type('settings-tax-id', '302118845');
    expect(screen.queryByTestId('settings-tax-id-error')).not.toBeOnTheScreen();
  });

  describe('changing the PAN number', () => {
    const ON_FILE = {
      tax_id: '302118845',
      has_pan_document: true,
      pan_verified_at: '2026-10-07T00:00:00.000Z',
    };

    it('asks first: the document and its verification go with the old number', async () => {
      const saves = serve({ identity: ON_FILE });
      await open();
      await waitFor(() => {
        expect(taxField()).toHaveDisplayValue('302118845');
      });

      type('settings-tax-id', '609871234');
      press('settings-tax-save');

      expect(Alert.alert).toHaveBeenCalledWith(
        'Change your PAN?',
        expect.stringContaining('Changing the number removes it'),
        expect.any(Array),
      );
      // Nothing is sent until the vendor agrees.
      expect(saves).toEqual([]);

      alertButton('Cancel').onPress?.();
      expect(saves).toEqual([]);
      expect(taxField()).toHaveDisplayValue('609871234');
    });

    it('saves on agreement, and the document card shows that a new certificate is needed', async () => {
      const saves = serve({ identity: ON_FILE });
      await open();
      await waitFor(() => {
        expect(screen.getByTestId('pan-document-status')).toHaveTextContent(/^Verified on/);
      });

      type('settings-tax-id', '609871234');
      press('settings-tax-save');
      alertButton('Change PAN').onPress?.();

      await waitFor(() => {
        expect(toast()).toMatchObject({
          message: 'PAN changed. Upload the certificate for the new number so it can be verified.',
          tone: 'success',
        });
      });
      expect(saves.map((save) => save.body)).toEqual([
        { tax_id: '609871234', is_vat_registered: false },
      ]);
      await waitFor(() => {
        expect(screen.getByTestId('pan-document-status')).toHaveTextContent(
          'No document uploaded yet.',
        );
      });
      expect(taxField()).toHaveDisplayValue('609871234');
    });

    it('does not ask when nothing is on file for the old number', async () => {
      const saves = serve({ identity: { tax_id: '302118845' } });
      await open();
      await waitFor(() => {
        expect(taxField()).toHaveDisplayValue('302118845');
      });

      type('settings-tax-id', '609871234');
      press('settings-tax-save');

      await waitFor(() => {
        expect(saves).toHaveLength(1);
      });
      expect(Alert.alert).not.toHaveBeenCalled();
    });
  });

  it('tells a shop suspended for compliance that it stays offline until the PAN is verified', async () => {
    // SPEC core 10 (amended 2026-10-20): a save never brings the shop online.
    serve({
      identity: { status: 'SUSPENDED_COMPLIANCE' },
      answer: { status: 'SUSPENDED_COMPLIANCE' },
    });
    await open();

    type('settings-tax-id', '302118845');
    press('settings-tax-save');

    await waitFor(() => {
      expect(toast()).toMatchObject({
        message:
          'PAN saved. Your shop stays offline until Hamro Pasal verifies your PAN certificate.',
        tone: 'success',
      });
    });
  });

  it('sends one request while a save is on its way', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const saves = serve();
    const answered: SaveBody[] = [];
    server.use(
      http.put(apiUrl(TAX_IDENTITY_PATH), async ({ request }) => {
        answered.push((await request.json()) as SaveBody);
        await held;
        return HttpResponse.json({
          vendor_id: VENDOR_ID,
          tax_id: '302118845',
          is_vat_registered: false,
          legal_name: null,
          registered_address: null,
          status: 'LIVE',
          compliance_suspension_lifted: false,
          pan_verified_at: null,
          waiting_invoices_issued: 0,
          pan_document_removed: false,
          has_pan_document: false,
        });
      }),
    );
    await open();

    type('settings-tax-id', '302118845');
    press('settings-tax-save');
    await waitFor(() => {
      expect(screen.getByTestId('settings-tax-save')).toBeDisabled();
    });
    expect(screen.getByText('Saving…')).toBeOnTheScreen();
    press('settings-tax-save');
    press('settings-tax-save');
    release();

    await waitFor(() => {
      expect(toast()).toMatchObject({ tone: 'success' });
    });
    expect(answered).toHaveLength(1);
    expect(saves).toEqual([]);
  });

  it('words a refusal and a lost connection, keeps what was typed, and never retries by itself', async () => {
    const saves = serve({
      save: () =>
        HttpResponse.json(
          { error: { code: 'INTERNAL_SERVER_ERROR', message: 'x' } },
          { status: 500 },
        ),
    });
    await open();

    type('settings-tax-id', '302118845');
    press('settings-tax-save');

    await waitFor(() => {
      expect(toast()).toMatchObject({
        message: "Couldn't save your tax identity. Try again.",
        tone: 'error',
      });
    });
    expect(saves).toHaveLength(1);
    expect(taxField()).toHaveDisplayValue('302118845');

    server.use(http.put(apiUrl(TAX_IDENTITY_PATH), () => HttpResponse.error()));
    press('settings-tax-save');
    await waitFor(() => {
      expect(toast()).toMatchObject({
        message: 'No connection. Your tax identity was not saved.',
        tone: 'error',
      });
    });

    server.use(
      http.put(apiUrl(TAX_IDENTITY_PATH), () =>
        HttpResponse.json(
          { error: { code: 'VALIDATION_FAILED', message: 'A PAN is nine digits' } },
          { status: 400 },
        ),
      ),
    );
    press('settings-tax-save');
    await waitFor(() => {
      expect(screen.getByTestId('settings-tax-id-error')).toHaveTextContent(
        'Enter your 9-digit PAN.',
      );
    });
  });

  it('can still save when what is on file could not be read', async () => {
    const saves = serve();
    server.use(
      http.get(apiUrl(TAX_IDENTITY_PATH), () =>
        HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'no' } }, { status: 403 }),
      ),
    );
    renderWithProviders(<VendorSettingsScreen />);

    expect(await screen.findByTestId('settings-tax-load-error')).toHaveTextContent(
      "Couldn't check what is on file. You can still save.",
    );
    type('settings-tax-id', '302118845');
    press('settings-tax-save');

    await waitFor(() => {
      expect(saves).toHaveLength(1);
    });
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('leaves the delivery settings to their own button: saving them does not touch the PAN', async () => {
    const saves = serve({ identity: { tax_id: '302118845' } });
    const deliverySaves: unknown[] = [];
    server.use(
      http.put(apiUrl('/api/vendor/delivery-settings'), async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        deliverySaves.push(body);
        return HttpResponse.json({
          vendor_id: VENDOR_ID,
          ...body,
          radius_km: 5,
          serviceable_palikas: ['Kathmandu Metropolitan City'],
          municipality_palika_string: 'Kathmandu Metropolitan City',
          platform: {
            self_delivery_enabled: true,
            platform_fleet_enabled: true,
            platform_delivery_fee_npr: 50,
          },
          fulfillment_mode_enabled: true,
        });
      }),
    );
    await open();
    await waitFor(() => {
      expect(taxField()).toHaveDisplayValue('302118845');
    });
    await waitFor(() => {
      expect(screen.getByTestId('settings-save')).toBeEnabled();
    });

    press('settings-save');

    await waitFor(() => {
      expect(toast()).toMatchObject({ message: 'Shop settings saved.', tone: 'success' });
    });
    expect(deliverySaves).toHaveLength(1);
    // The phone's copy carries the PAN that is on file, without the vendor retyping it.
    expect(useVendorShopStore.getState().stored?.settings.taxId).toBe('302118845');
    expect(saves).toEqual([]);
  });

  it('reads Nepali under ne', async () => {
    serve();
    await open('ne');

    expect(screen.getByText('भ्याटमा दर्ता भएको')).toBeOnTheScreen();
    type('settings-tax-id', '302');
    press('settings-tax-save');
    expect(screen.getByTestId('settings-tax-id-error')).toHaveTextContent(
      'आफ्नो ९ अङ्कको प्यान लेख्नुहोस्।',
    );
  });
});
