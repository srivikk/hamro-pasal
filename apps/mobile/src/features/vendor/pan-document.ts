import { STORED_IMAGE_MAX_DIMENSION } from '@hamro-pasal/shared-types';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import type { PanDocumentFile } from '../../api/vendor-tax-identity';
import { ApiError } from '../../api/http';

/** Where the photo of the document comes from. */
export type PanDocumentSource = 'camera' | 'library';

/** JPEG quality of the copy that is sent (SPEC infrastructure section 6: a 75% quality cap). */
export const PAN_DOCUMENT_UPLOAD_QUALITY = 0.75;

export type PanDocumentPick =
  | { readonly status: 'picked'; readonly file: PanDocumentFile }
  /** The vendor closed the camera or the gallery without choosing. */
  | { readonly status: 'cancelled' }
  /**
   * The camera or photo permission was refused. `canAskAgain` false: the system will not show its
   * prompt again, so only the app's page in Settings can change it.
   */
  | {
      readonly status: 'permission_denied';
      readonly source: PanDocumentSource;
      readonly canAskAgain: boolean;
    };

/** The size the longer side is scaled down to, or null when the picture is already small enough. */
export function resizeTarget(
  width: number,
  height: number,
  max: number = STORED_IMAGE_MAX_DIMENSION,
): { readonly width: number } | { readonly height: number } | null {
  if (width <= max && height <= max) return null;
  return width >= height ? { width: max } : { height: max };
}

/**
 * Makes the copy that goes over the wire: at most 1200 px on its longer side, JPEG at 75%. A
 * camera photo of several megabytes becomes a few hundred kilobytes, which matters on a 3G
 * connection; the server re-encodes it once more to the stored format.
 */
export async function preparePanDocument(asset: {
  readonly uri: string;
  readonly width: number;
  readonly height: number;
}): Promise<PanDocumentFile> {
  const context = ImageManipulator.manipulate(asset.uri);
  const target = resizeTarget(asset.width, asset.height);
  if (target !== null) context.resize(target);
  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({
    format: SaveFormat.JPEG,
    compress: PAN_DOCUMENT_UPLOAD_QUALITY,
  });
  return { uri: saved.uri, mimeType: 'image/jpeg' };
}

/**
 * Asks for the permission the source needs, opens the camera or the gallery, and compresses what
 * was chosen.
 *
 * - The permission is requested only when the vendor presses the button, never at launch.
 * - "Limited" photo access (iOS 14+, Android 14+) is enough: the vendor picks the one picture.
 * - Nothing is uploaded here; the caller decides.
 */
export async function pickPanDocument(source: PanDocumentSource): Promise<PanDocumentPick> {
  const permission =
    source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    return { status: 'permission_denied', source, canAskAgain: permission.canAskAgain };
  }

  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    allowsMultipleSelection: false,
    // Full quality here: the one lossy step is ours (preparePanDocument).
    quality: 1,
    exif: false,
  };
  const picked =
    source === 'camera'
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
  const asset = picked.canceled ? undefined : picked.assets[0];
  if (asset === undefined) return { status: 'cancelled' };
  return { status: 'picked', file: await preparePanDocument(asset) };
}

/** The translation key (under `vendorShop.document.errors`) for a failed upload. */
export function panDocumentErrorKey(
  error: unknown,
): 'tooLarge' | 'notAnImage' | 'network' | 'generic' {
  if (error instanceof ApiError) {
    if (error.code === 'FILE_TOO_LARGE') return 'tooLarge';
    if (error.code === 'UNSUPPORTED_MEDIA_TYPE') return 'notAnImage';
    if (error.code === 'NETWORK_ERROR') return 'network';
  }
  return 'generic';
}
