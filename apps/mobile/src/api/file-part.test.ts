/*
 * Regression guard for the Expo 57 upload failure: expo/fetch (the global fetch on a device)
 * encodes FormData with its own encoder, which throws on React Native's `{ uri, name, type }`
 * parts, so every photo upload failed as "Couldn't reach the server". Here each upload's body goes
 * through that same encoder, on React Native's FormData with Expo's patch, as on the phone.
 */
import { convertFormDataAsync } from 'expo/src/winter/fetch/convertFormData';
import type * as ExpoFormDataModule from 'expo/src/winter/FormData';

import { uploadCitizenshipDocument } from '../features/seller/seller-api';
import { useAuthStore } from '../store/useAuthStore';
import { localFilePart } from './file-part';
import { uploadDisputeEvidence } from './uploads';
import { uploadPanDocument } from './vendor-tax-identity';

const PHOTO_BYTES = [0xff, 0xd8, 0xff, 0xe0, 0x42];

// expo-file-system's File is native: a stand-in with the members the encoder reads.
jest.mock('expo-file-system', () => ({
  File: class {
    readonly uri: string;
    readonly name: string;
    readonly type = 'image/jpeg';
    constructor(uri: string) {
      this.uri = uri;
      this.name = uri.slice(uri.lastIndexOf('/') + 1);
    }
    bytes(): Promise<Uint8Array> {
      return Promise.resolve(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x42]));
    }
  },
}));

// jest-expo stubs the patch out (it is native-runtime only); the phone runs the real one.
const { installFormDataPatch } = jest.requireActual<typeof ExpoFormDataModule>(
  'expo/src/winter/FormData',
);
// Typed structurally: React Native ships no declarations for its Libraries/ paths.
const RNFormData = jest.requireActual<{ default: typeof FormData }>(
  'react-native/Libraries/Network/FormData',
).default;
const ExpoFormData = installFormDataPatch(RNFormData);
const originalFormData = globalThis.FormData;
const originalFetch = globalThis.fetch;
let encoded: string[] = [];

beforeEach(() => {
  encoded = [];
  globalThis.FormData = ExpoFormData as unknown as typeof FormData;
  // What expo/fetch does with a FormData body, then a stop answer from the "server".
  globalThis.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
    const { body } = await convertFormDataAsync(init?.body as unknown as FormData, 'BOUNDARY');
    encoded.push(String.fromCharCode(...body));
    return new Response(JSON.stringify({ error: { code: 'TEST_STOP', message: 'stop' } }), {
      status: 418,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  useAuthStore.getState().setSession({ accessToken: 'a.jwt', refreshToken: 'r.jwt' });
});

afterEach(() => {
  globalThis.FormData = originalFormData;
  globalThis.fetch = originalFetch;
});

const PHOTO = 'file:///data/user/0/com.hamro.pasal.seller/cache/ImagePicker/photo.jpg';
const photoPart = (field: string) =>
  `--BOUNDARY\r\ncontent-disposition: form-data; name="${field}"; filename="photo.jpg"\r\n` +
  `content-type: image/jpeg\r\n\r\n${String.fromCharCode(...PHOTO_BYTES)}\r\n`;

describe('photo uploads through the expo/fetch encoder', () => {
  it('encodes the PAN document as its bytes', async () => {
    await expect(uploadPanDocument({ uri: PHOTO, mimeType: 'image/jpeg' })).rejects.toMatchObject({
      status: 418,
      code: 'TEST_STOP',
    });
    expect(encoded).toEqual([`${photoPart('document')}--BOUNDARY--\r\n`]);
  });

  it('encodes the citizenship document as its bytes', async () => {
    await expect(
      uploadCitizenshipDocument({ uri: PHOTO, mimeType: 'image/jpeg' }),
    ).rejects.toMatchObject({ status: 418, code: 'TEST_STOP' });
    expect(encoded).toEqual([`${photoPart('document')}--BOUNDARY--\r\n`]);
  });

  it('encodes dispute evidence after its order id', async () => {
    await expect(
      uploadDisputeEvidence('00000000-0000-4000-8000-000000000001', {
        uri: PHOTO,
        mimeType: 'image/jpeg',
        fileSize: 5,
      }),
    ).rejects.toMatchObject({ status: 418, code: 'TEST_STOP' });
    expect(encoded).toEqual([
      '--BOUNDARY\r\ncontent-disposition: form-data; name="order_id"\r\n\r\n' +
        `00000000-0000-4000-8000-000000000001\r\n${photoPart('file')}--BOUNDARY--\r\n`,
    ]);
  });

  it('is what the old { uri, name, type } part was not: the encoder refused it', async () => {
    const legacy = new ExpoFormData();
    legacy.append('document', { uri: PHOTO, name: 'photo.jpg', type: 'image/jpeg' });
    await expect(convertFormDataAsync(legacy as unknown as FormData)).rejects.toThrow(
      'Unsupported FormDataPart implementation',
    );

    const fixed = new ExpoFormData();
    fixed.append('document', localFilePart(PHOTO));
    await expect(convertFormDataAsync(fixed as unknown as FormData)).resolves.toBeDefined();
  });
});
