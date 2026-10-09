import { randomBytes } from 'node:crypto';

import sharp from 'sharp';

/**
 * Real, decodable test images. Since Phase 34 every upload is re-encoded by the server, so a
 * signature followed by padding is no longer an image the API accepts.
 */
export function photo(
  options: {
    width?: number;
    height?: number;
    format?: 'jpeg' | 'png' | 'webp';
  } = {},
): Promise<Buffer> {
  const image = sharp({
    create: {
      width: options.width ?? 64,
      height: options.height ?? 48,
      channels: 3,
      background: { r: 200, g: 60, b: 40 },
    },
  });
  if (options.format === 'png') return image.png().toBuffer();
  if (options.format === 'webp') return image.webp().toBuffer();
  return image.jpeg().toBuffer();
}

/** A JPEG of random pixels: the worst case for a compressor (about 3 MB at the default size). */
export function noisyJpeg(width = 2400, height = 1800): Promise<Buffer> {
  return sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 85 })
    .toBuffer();
}

/**
 * `image` followed by padding up to exactly `size` bytes (a decoder ignores what follows the end
 * of a JPEG). An image already that large is returned as it is.
 */
export function paddedTo(image: Buffer, size: number): Buffer {
  return image.length >= size
    ? image
    : Buffer.concat([image, Buffer.alloc(size - image.length, 0x20)]);
}

/** What the API stored: its format, dimensions and size. */
export async function describeImage(
  bytes: Buffer,
): Promise<{ format: string | undefined; width: number; height: number; bytes: number }> {
  const { format, width, height } = await sharp(bytes).metadata();
  return { format, width, height, bytes: bytes.length };
}
