import {
  STORED_IMAGE_MAX_BYTES,
  STORED_IMAGE_MAX_DIMENSION,
  type DisputeEvidenceContentType,
} from '@hamro-pasal/shared-types';
import sharp from 'sharp';

/** The bytes carry an image signature but cannot be decoded as that image. */
export class InvalidImageError extends Error {
  constructor(reason: string) {
    super(`Not a readable image: ${reason}`);
    this.name = 'InvalidImageError';
  }
}

/** No setting brought the image under the size limit (not seen in practice at 1200 px). */
export class ImageNotCompressibleError extends Error {
  constructor(readonly maxBytes: number) {
    super(`The image could not be compressed below ${String(maxBytes)} bytes`);
    this.name = 'ImageNotCompressibleError';
  }
}

export interface CompressionLimits {
  /** Longest side, in pixels. A smaller image is never enlarged. */
  readonly maxDimension: number;
  /** The result is strictly smaller than this. */
  readonly maxBytes: number;
}

export const STORED_IMAGE_LIMITS: CompressionLimits = {
  maxDimension: STORED_IMAGE_MAX_DIMENSION,
  maxBytes: STORED_IMAGE_MAX_BYTES,
};

/** SPEC infrastructure section 6 caps the quality at 75%; lower steps are tried only for size. */
const QUALITY_STEPS = [75, 65, 55, 45, 35] as const;
/** When the lowest quality is still too large, the image is made smaller, down to this side. */
const MIN_DIMENSION = 320;
/** A decoded image larger than this is refused before it is inflated (a decompression bomb). */
const MAX_INPUT_PIXELS = 50_000_000;

const DECODABLE: Readonly<Record<string, DisputeEvidenceContentType>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/**
 * Re-encodes an uploaded JPEG, PNG or WebP as the image that is stored (SPEC infrastructure
 * section 6): WebP, at most `maxDimension` on its longer side, strictly under `maxBytes`.
 *
 * - The picture is turned upright from its EXIF orientation first; every other piece of metadata
 *   (camera, time, GPS position) is dropped, because sharp writes none unless asked.
 * - Quality starts at 75 and steps down only while the result is too large; if 35 is still too
 *   large the picture is scaled down by a fifth and the steps start again.
 * - An animated image is stored as its first frame.
 */
export async function compressImage(
  bytes: Buffer,
  limits: CompressionLimits = STORED_IMAGE_LIMITS,
): Promise<Buffer> {
  // sharp types the format of a decodable image as always present; an unknown one is not.
  let format: string | undefined;
  try {
    const metadata: { format?: string } = await sharp(bytes, {
      limitInputPixels: MAX_INPUT_PIXELS,
    }).metadata();
    ({ format } = metadata);
  } catch (error: unknown) {
    throw new InvalidImageError(error instanceof Error ? error.message : 'unreadable');
  }
  if (format === undefined || DECODABLE[format] === undefined) {
    throw new InvalidImageError(`unsupported format ${format ?? 'unknown'}`);
  }

  for (
    let dimension = limits.maxDimension;
    dimension >= Math.min(MIN_DIMENSION, limits.maxDimension);
    dimension = Math.floor(dimension * 0.8)
  ) {
    for (const quality of QUALITY_STEPS) {
      let encoded: Buffer;
      try {
        encoded = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
          .rotate()
          .resize({
            width: dimension,
            height: dimension,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({ quality })
          .toBuffer();
      } catch (error: unknown) {
        throw new InvalidImageError(error instanceof Error ? error.message : 'undecodable');
      }
      if (encoded.length < limits.maxBytes) return encoded;
    }
  }
  throw new ImageNotCompressibleError(limits.maxBytes);
}
