import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { http, HttpResponse } from 'msw';
import { Alert, Linking } from 'react-native';

import VendorSettingsScreen from '../../../app/(vendor)/settings';
import { ApiError } from '../../api/http';
import { useAuthStore } from '../../store/useAuthStore';
import { useToastStore } from '../../store/useToastStore';
import { accessTokenFor } from '../../test/access-tokens';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import { PanDocumentCard } from './PanDocumentCard';
import {
  PAN_DOCUMENT_UPLOAD_QUALITY,
  panDocumentErrorKey,
  pickPanDocument,
  preparePanDocument,
  resizeTarget,
} from './pan-document';

/** Stands in for ImageManipulator.manipulate (the name lets the hoisted mock below reach it). */
const mockManipulate = jest.fn();

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(),
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));
jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
  ImageManipulator: { manipulate: (uri: string): unknown => mockManipulate(uri) },
}));

const picker = jest.mocked(ImagePicker);
const manipulate = mockManipulate;

setupApiTestEnvironment();

const VENDOR_USER_ID = '9f1c2a10-0000-4000-8000-0000000000aa';
const VENDOR_ID = '7b1f0c8e-0000-4000-8000-0000000000aa';
const COMPRESSED_URI = 'file:///cache/ImageManipulator/pan-compressed.jpg';

const GRANTED = { granted: true, canAskAgain: true, status: 'granted', expires: 'never' };
const DENIED = { granted: false, canAskAgain: true, status: 'denied', expires: 'never' };
const BLOCKED = { granted: false, canAskAgain: false, status: 'denied', expires: 'never' };

/** What the manipulator was asked to do with the last picture. */
let resize: jest.Mock;
let saveAsync: jest.Mock;
let openSettings: jest.SpyInstance;

function asset(width = 4000, height = 3000) {
  return {
    canceled: false,
    assets: [{ uri: 'file:///photos/pan-original.jpg', width, height, mimeType: 'image/jpeg' }],
  };
}

const identity = (overrides: Record<string, unknown> = {}) => ({
  vendor_id: VENDOR_ID,
  tax_id: '302118845',
  is_vat_registered: false,
  legal_name: null,
  registered_address: null,
  status: 'LIVE',
  pan_verified_at: null,
  has_pan_document: false,
  ...overrides,
});

const uploadAnswer = (overrides: Record<string, unknown> = {}) => ({
  vendor_id: VENDOR_ID,
  has_pan_document: true,
  replaced: false,
  verification_cleared: false,
  pan_verified_at: null,
  ...overrides,
});

/** Serves the tax identity, and records every upload it answers. */
function serve(
  options: {
    identity?: Record<string, unknown>;
    upload?: () => Response | Promise<Response>;
  } = {},
) {
  const uploads: { contentType: string | null; authorization: string | null }[] = [];
  let current = identity(options.identity);
  server.use(
    http.get(apiUrl('/api/vendor/tax-identity'), () => HttpResponse.json(current)),
    http.post(apiUrl('/api/vendor/tax-identity/document'), async ({ request }) => {
      uploads.push({
        contentType: request.headers.get('content-type'),
        authorization: request.headers.get('authorization'),
      });
      const response = await (options.upload ?? (() => HttpResponse.json(uploadAnswer())))();
      if (response.ok) current = { ...current, has_pan_document: true, pan_verified_at: null };
      return response;
    }),
  );
  return uploads;
}

const press = (testID: string): void => {
  fireEvent.press(screen.getByTestId(testID));
};
const toast = () => useToastStore.getState().toast;
const status = () => screen.getByTestId('pan-document-status');

/** The buttons of the last native alert, by their text. */
function alertButton(text: string): { onPress?: (() => void) | undefined } {
  const buttons = jest.mocked(Alert.alert).mock.calls.at(-1)?.[2] ?? [];
  const button = buttons.find((candidate) => candidate.text === text);
  if (button === undefined) throw new Error(`no alert button "${text}"`);
  return { onPress: button.onPress };
}

beforeEach(() => {
  jest.clearAllMocks();
  useAuthStore.getState().setLocale('en');
  useAuthStore.getState().setSession({
    accessToken: accessTokenFor('VENDOR', VENDOR_USER_ID),
    refreshToken: 'r.jwt',
  });
  useToastStore.setState({ toast: null });
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue();

  picker.requestCameraPermissionsAsync.mockResolvedValue(GRANTED as never);
  picker.requestMediaLibraryPermissionsAsync.mockResolvedValue(GRANTED as never);
  picker.launchCameraAsync.mockResolvedValue(asset() as never);
  picker.launchImageLibraryAsync.mockResolvedValue(asset() as never);

  saveAsync = jest.fn().mockResolvedValue({ uri: COMPRESSED_URI, width: 1200, height: 900 });
  resize = jest.fn();
  manipulate.mockImplementation(() => ({
    resize,
    renderAsync: jest.fn().mockResolvedValue({ saveAsync }),
  }));
});

describe('preparing the photo on the phone', () => {
  it('scales the longer side to 1200 px and leaves a small picture alone', () => {
    expect(resizeTarget(4000, 3000)).toEqual({ width: 1200 });
    expect(resizeTarget(3000, 4000)).toEqual({ height: 1200 });
    expect(resizeTarget(2000, 2000)).toEqual({ width: 1200 });
    expect(resizeTarget(1200, 900)).toBeNull();
    expect(resizeTarget(640, 480)).toBeNull();
  });

  it('compresses to a JPEG at 75% before anything is sent', async () => {
    const file = await preparePanDocument({ uri: 'file:///a.heic', width: 4032, height: 3024 });

    expect(manipulate).toHaveBeenCalledWith('file:///a.heic');
    expect(resize).toHaveBeenCalledWith({ width: 1200 });
    expect(saveAsync).toHaveBeenCalledWith({ format: SaveFormat.JPEG, compress: 0.75 });
    expect(PAN_DOCUMENT_UPLOAD_QUALITY).toBe(0.75);
    expect(file).toEqual({ uri: COMPRESSED_URI, mimeType: 'image/jpeg' });
  });

  it('does not enlarge: a small picture is only re-encoded', async () => {
    await preparePanDocument({ uri: 'file:///small.png', width: 800, height: 600 });

    expect(resize).not.toHaveBeenCalled();
    expect(saveAsync).toHaveBeenCalledWith({ format: SaveFormat.JPEG, compress: 0.75 });
  });

  it('asks only for the permission its source needs, and only when called', async () => {
    await pickPanDocument('camera');
    expect(picker.requestCameraPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(picker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
    expect(picker.launchCameraAsync).toHaveBeenCalledWith(
      expect.objectContaining({ mediaTypes: ['images'], allowsMultipleSelection: false }),
    );

    jest.clearAllMocks();
    await pickPanDocument('library');
    expect(picker.requestMediaLibraryPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(picker.requestCameraPermissionsAsync).not.toHaveBeenCalled();
  });

  it('reports a refused permission without opening the camera or the gallery', async () => {
    picker.requestCameraPermissionsAsync.mockResolvedValue(BLOCKED as never);
    picker.requestMediaLibraryPermissionsAsync.mockResolvedValue(DENIED as never);

    await expect(pickPanDocument('camera')).resolves.toEqual({
      status: 'permission_denied',
      source: 'camera',
      canAskAgain: false,
    });
    await expect(pickPanDocument('library')).resolves.toEqual({
      status: 'permission_denied',
      source: 'library',
      canAskAgain: true,
    });
    expect(picker.launchCameraAsync).not.toHaveBeenCalled();
    expect(picker.launchImageLibraryAsync).not.toHaveBeenCalled();
  });

  it('reports a closed picker as cancelled, with nothing compressed', async () => {
    picker.launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null } as never);

    await expect(pickPanDocument('library')).resolves.toEqual({ status: 'cancelled' });
    expect(manipulate).not.toHaveBeenCalled();
  });

  it('names each kind of upload failure', () => {
    expect(panDocumentErrorKey(new ApiError(413, 'FILE_TOO_LARGE', 'x'))).toBe('tooLarge');
    expect(panDocumentErrorKey(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'x'))).toBe(
      'notAnImage',
    );
    expect(panDocumentErrorKey(new ApiError(0, 'NETWORK_ERROR', 'x'))).toBe('network');
    expect(panDocumentErrorKey(new ApiError(500, 'INTERNAL_SERVER_ERROR', 'x'))).toBe('generic');
    expect(panDocumentErrorKey(new Error('boom'))).toBe('generic');
  });
});

describe('PAN document card', () => {
  it('says what is on file: nothing, awaiting verification, or verified', async () => {
    serve();
    const first = renderWithProviders(<PanDocumentCard />);
    await waitFor(() => {
      expect(status()).toHaveTextContent('No document uploaded yet.');
    });
    expect(screen.getByTestId('pan-document-library')).toHaveTextContent('Choose from gallery');
    first.unmount();

    serve({ identity: { has_pan_document: true } });
    const second = renderWithProviders(<PanDocumentCard />);
    await waitFor(() => {
      expect(status()).toHaveTextContent(
        'Document uploaded. Waiting for Hamro Pasal to verify it.',
      );
    });
    expect(screen.getByTestId('pan-document-library')).toHaveTextContent('Replace from gallery');
    second.unmount();

    serve({
      identity: { has_pan_document: true, pan_verified_at: '2026-10-08T20:00:00.000Z' },
    });
    renderWithProviders(<PanDocumentCard />);
    await waitFor(() => {
      // 20:00 UTC is already the 9th in Nepal Time.
      expect(status()).toHaveTextContent('Verified on 2026-10-09.');
    });
  });

  it('uploads a photo from the gallery: compressed first, sent as multipart with the token', async () => {
    const uploads = serve();
    renderWithProviders(<PanDocumentCard />);
    await waitFor(() => {
      expect(status()).toBeOnTheScreen();
    });

    press('pan-document-library');

    await waitFor(() => {
      expect(toast()).toMatchObject({ message: 'PAN document uploaded.', tone: 'success' });
    });
    expect(picker.launchImageLibraryAsync).toHaveBeenCalledTimes(1);
    expect(picker.launchCameraAsync).not.toHaveBeenCalled();
    expect(resize).toHaveBeenCalledWith({ width: 1200 });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(uploads[0]?.authorization).toBe(`Bearer ${accessTokenFor('VENDOR', VENDOR_USER_ID)}`);
    // The compressed copy is what is shown, and the status follows the server.
    expect(screen.getByTestId('pan-document-preview').props).toMatchObject({
      source: { uri: COMPRESSED_URI },
    });
    await waitFor(() => {
      expect(status()).toHaveTextContent(
        'Document uploaded. Waiting for Hamro Pasal to verify it.',
      );
    });
  });

  it('uploads a photo taken with the camera', async () => {
    const uploads = serve();
    renderWithProviders(<PanDocumentCard />);
    await waitFor(() => {
      expect(status()).toBeOnTheScreen();
    });

    press('pan-document-camera');

    await waitFor(() => {
      expect(uploads).toHaveLength(1);
    });
    expect(picker.requestCameraPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(picker.launchCameraAsync).toHaveBeenCalledTimes(1);
    expect(picker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
  });

  it('shows it is working, and takes no second press, while the upload is on its way', async () => {
    // The server answers only when the test lets it.
    let answer: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const uploads = serve({
      upload: async () => {
        await held;
        return HttpResponse.json(uploadAnswer());
      },
    });
    renderWithProviders(<PanDocumentCard />);
    await waitFor(() => {
      expect(status()).toBeOnTheScreen();
    });

    press('pan-document-library');

    await waitFor(() => {
      expect(screen.getByTestId('pan-document-busy')).toHaveTextContent('Uploading…');
    });
    expect(screen.getByTestId('pan-document-camera')).toBeDisabled();
    expect(screen.getByTestId('pan-document-library')).toBeDisabled();
    press('pan-document-library');
    press('pan-document-camera');
    answer();

    await waitFor(() => {
      expect(toast()).toMatchObject({ message: 'PAN document uploaded.', tone: 'success' });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('pan-document-busy')).toBeNull();
    });
    expect(uploads).toHaveLength(1);
    expect(picker.launchImageLibraryAsync).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the vendor closes the picker', async () => {
    const uploads = serve();
    picker.launchCameraAsync.mockResolvedValue({ canceled: true, assets: null } as never);
    renderWithProviders(<PanDocumentCard />);
    await waitFor(() => {
      expect(status()).toBeOnTheScreen();
    });

    press('pan-document-camera');

    await waitFor(() => {
      expect(picker.launchCameraAsync).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByTestId('pan-document-camera')).not.toBeDisabled();
    });
    expect(uploads).toEqual([]);
    expect(toast()).toBeNull();
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(screen.queryByTestId('pan-document-preview')).toBeNull();
  });

  describe('when a permission is refused', () => {
    it('explains why the camera is needed to go LIVE, and can be asked again', async () => {
      const uploads = serve();
      picker.requestCameraPermissionsAsync.mockResolvedValue(DENIED as never);
      renderWithProviders(<PanDocumentCard />);
      await waitFor(() => {
        expect(status()).toBeOnTheScreen();
      });

      press('pan-document-camera');

      await waitFor(() => {
        expect(Alert.alert).toHaveBeenCalledTimes(1);
      });
      const [title, body, buttons] = jest.mocked(Alert.alert).mock.calls[0] ?? [];
      expect(title).toBe('Permission needed');
      expect(body).toBe(
        'Hamro Pasal needs your camera to photograph your PAN document. Without it your shop cannot be verified to go LIVE and be paid. Please allow it when asked.',
      );
      expect(buttons?.map((button) => button.text)).toEqual(['OK']);
      expect(picker.launchCameraAsync).not.toHaveBeenCalled();
      expect(uploads).toEqual([]);
      // Not a dead end: the buttons work again, and the gallery is still offered.
      expect(screen.getByTestId('pan-document-camera')).not.toBeDisabled();
      expect(screen.getByTestId('pan-document-library')).not.toBeDisabled();
    });

    it('offers the phone’s Settings when the system will not ask again', async () => {
      serve();
      picker.requestMediaLibraryPermissionsAsync.mockResolvedValue(BLOCKED as never);
      renderWithProviders(<PanDocumentCard />);
      await waitFor(() => {
        expect(status()).toBeOnTheScreen();
      });

      press('pan-document-library');

      await waitFor(() => {
        expect(Alert.alert).toHaveBeenCalledTimes(1);
      });
      const [, body, buttons] = jest.mocked(Alert.alert).mock.calls[0] ?? [];
      expect(body).toContain('needs access to your photos');
      expect(body).toContain('You can allow it in your phone’s Settings.');
      expect(buttons?.map((button) => button.text)).toEqual(['Cancel', 'Open Settings']);
      expect(openSettings).not.toHaveBeenCalled();

      act(() => {
        alertButton('Open Settings').onPress?.();
      });
      expect(openSettings).toHaveBeenCalledTimes(1);
      expect(picker.launchImageLibraryAsync).not.toHaveBeenCalled();
    });

    it('still works through the other source', async () => {
      const uploads = serve();
      picker.requestCameraPermissionsAsync.mockResolvedValue(BLOCKED as never);
      renderWithProviders(<PanDocumentCard />);
      await waitFor(() => {
        expect(status()).toBeOnTheScreen();
      });

      press('pan-document-camera');
      await waitFor(() => {
        expect(Alert.alert).toHaveBeenCalledTimes(1);
      });
      press('pan-document-library');

      await waitFor(() => {
        expect(uploads).toHaveLength(1);
      });
    });
  });

  describe('replacing a verified document', () => {
    const verified = { has_pan_document: true, pan_verified_at: '2026-10-08T06:00:00.000Z' };

    it('warns that payouts pause first, and does nothing on Cancel', async () => {
      const uploads = serve({ identity: verified });
      renderWithProviders(<PanDocumentCard />);
      await waitFor(() => {
        expect(status()).toHaveTextContent('Verified on 2026-10-08.');
      });

      press('pan-document-library');

      expect(Alert.alert).toHaveBeenCalledTimes(1);
      const [title, body, buttons] = jest.mocked(Alert.alert).mock.calls[0] ?? [];
      expect(title).toBe('Replace your verified document?');
      expect(body).toContain('payouts are paused until Hamro Pasal verifies the new one');
      expect(buttons?.map((button) => button.text)).toEqual(['Cancel', 'Replace it']);
      expect(picker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
      expect(uploads).toEqual([]);
    });

    it('uploads after the vendor confirms, and says the verification was cleared', async () => {
      const uploads = serve({
        identity: verified,
        upload: () =>
          HttpResponse.json(uploadAnswer({ replaced: true, verification_cleared: true })),
      });
      renderWithProviders(<PanDocumentCard />);
      await waitFor(() => {
        expect(status()).toHaveTextContent(/Verified on/);
      });

      press('pan-document-camera');
      act(() => {
        alertButton('Replace it').onPress?.();
      });

      await waitFor(() => {
        expect(toast()).toMatchObject({
          message: 'PAN document replaced. Payouts wait until the new one is verified.',
          tone: 'success',
        });
      });
      expect(uploads).toHaveLength(1);
      await waitFor(() => {
        expect(status()).toHaveTextContent(
          'Document uploaded. Waiting for Hamro Pasal to verify it.',
        );
      });
    });

    it('replaces an unverified document without asking', async () => {
      const uploads = serve({ identity: { has_pan_document: true } });
      renderWithProviders(<PanDocumentCard />);
      await waitFor(() => {
        expect(status()).toHaveTextContent(/Waiting for/);
      });

      press('pan-document-library');

      await waitFor(() => {
        expect(uploads).toHaveLength(1);
      });
      expect(Alert.alert).not.toHaveBeenCalled();
    });
  });

  describe('when the upload fails', () => {
    const refusal = (httpStatus: number, code: string) => () =>
      HttpResponse.json({ error: { code, message: code } }, { status: httpStatus });

    it.each([
      [413, 'FILE_TOO_LARGE', 'The photo is too large. Take it again from a little further away.'],
      [415, 'UNSUPPORTED_MEDIA_TYPE', "That file isn't a photo we can read. Try another one."],
      [500, 'INTERNAL_SERVER_ERROR', "Couldn't upload the document. Try again."],
    ])(
      '%i %s: says why, drops the preview, and can be tried again',
      async (code, name, message) => {
        const uploads = serve({ upload: refusal(code, name) });
        renderWithProviders(<PanDocumentCard />);
        await waitFor(() => {
          expect(status()).toBeOnTheScreen();
        });

        press('pan-document-library');

        await waitFor(() => {
          expect(toast()).toMatchObject({ message, tone: 'error' });
        });
        expect(screen.queryByTestId('pan-document-preview')).toBeNull();
        expect(status()).toHaveTextContent('No document uploaded yet.');
        expect(screen.getByTestId('pan-document-library')).not.toBeDisabled();
        // Never retried by itself: a retry is a second upload.
        expect(uploads).toHaveLength(1);
      },
    );

    it('names a lost connection', async () => {
      serve({ upload: () => HttpResponse.error() });
      renderWithProviders(<PanDocumentCard />);
      await waitFor(() => {
        expect(status()).toBeOnTheScreen();
      });

      press('pan-document-camera');

      await waitFor(() => {
        expect(toast()).toMatchObject({
          message: "Couldn't reach the server. Check your connection and try again.",
          tone: 'error',
        });
      });
    });

    it('says so when the camera cannot be opened, and stays usable', async () => {
      const uploads = serve();
      picker.launchCameraAsync.mockRejectedValue(new Error('Camera not available on simulator'));
      renderWithProviders(<PanDocumentCard />);
      await waitFor(() => {
        expect(status()).toBeOnTheScreen();
      });

      press('pan-document-camera');

      await waitFor(() => {
        expect(toast()).toMatchObject({
          message:
            "The camera couldn't be opened on this phone. Choose a photo from the gallery instead.",
          tone: 'error',
        });
      });
      expect(uploads).toEqual([]);
      expect(screen.getByTestId('pan-document-library')).not.toBeDisabled();
    });
  });

  it('can still upload when the status cannot be read, and offers to check again', async () => {
    let healthy = false;
    const uploads: number[] = [];
    server.use(
      http.get(apiUrl('/api/vendor/tax-identity'), () =>
        healthy
          ? HttpResponse.json(identity({ has_pan_document: true }))
          : HttpResponse.json(
              { error: { code: 'VENDOR_NOT_FOUND', message: 'x' } },
              { status: 404 },
            ),
      ),
      http.post(apiUrl('/api/vendor/tax-identity/document'), () => {
        uploads.push(1);
        return HttpResponse.json(uploadAnswer());
      }),
    );
    renderWithProviders(<PanDocumentCard />);

    await waitFor(() => {
      expect(status()).toHaveTextContent("Couldn't check your document right now.");
    });
    expect(screen.getByTestId('pan-document-camera')).not.toBeDisabled();

    healthy = true;
    press('pan-document-retry');

    await waitFor(() => {
      expect(status()).toHaveTextContent(
        'Document uploaded. Waiting for Hamro Pasal to verify it.',
      );
    });
    expect(screen.queryByTestId('pan-document-retry')).toBeNull();
  });

  it('is part of the Tax identity section of Shop settings, in Nepali too', async () => {
    serve();
    useAuthStore.getState().setLocale('ne');
    renderWithProviders(<VendorSettingsScreen />, { locale: 'ne' });

    await waitFor(() => {
      expect(status()).toHaveTextContent('अहिलेसम्म कुनै कागजात अपलोड गरिएको छैन।');
    });
    expect(screen.getByTestId('settings-tax-id')).toBeOnTheScreen();
    expect(screen.getByTestId('pan-document-camera')).toHaveTextContent('फोटो खिच्नुहोस्');
  });
});
