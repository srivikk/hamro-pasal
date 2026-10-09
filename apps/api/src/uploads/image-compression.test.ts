import { randomBytes } from 'node:crypto';

import sharp from 'sharp';

import {
  compressImage,
  ImageNotCompressibleError,
  InvalidImageError,
  STORED_IMAGE_LIMITS,
} from './image-compression';

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#2a6' } });

/** Random pixels: nothing compresses worse. */
function noise(width: number, height: number): sharp.Sharp {
  return sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } });
}

describe('compressImage', () => {
  it('uses SPEC limits by default: 1200 px and 300 KB', () => {
    expect(STORED_IMAGE_LIMITS).toEqual({ maxDimension: 1200, maxBytes: 300 * 1024 });
  });

  it.each(['jpeg', 'png', 'webp'] as const)('re-encodes a %s as WebP', async (format) => {
    const input = await solid(400, 300).toFormat(format).toBuffer();

    const output = await compressImage(input);

    expect(await sharp(output).metadata()).toMatchObject({
      format: 'webp',
      width: 400,
      height: 300,
    });
  });

  it('scales the longer side down to 1200 px, keeping the proportions', async () => {
    const landscape = await compressImage(await solid(4000, 3000).jpeg().toBuffer());
    const portrait = await compressImage(await solid(1500, 3000).jpeg().toBuffer());

    expect(await sharp(landscape).metadata()).toMatchObject({ width: 1200, height: 900 });
    expect(await sharp(portrait).metadata()).toMatchObject({ width: 600, height: 1200 });
  });

  it('never enlarges a small image, and leaves one of exactly 1200 px alone', async () => {
    const small = await compressImage(await solid(320, 200).png().toBuffer());
    const exact = await compressImage(await solid(1200, 800).png().toBuffer());

    expect(await sharp(small).metadata()).toMatchObject({ width: 320, height: 200 });
    expect(await sharp(exact).metadata()).toMatchObject({ width: 1200, height: 800 });
  });

  it('brings the worst case (a multi-megabyte photo of noise) strictly under 300 KB', async () => {
    const input = await noise(3000, 2400).jpeg({ quality: 90 }).toBuffer();
    expect(input.length).toBeGreaterThan(3 * 1024 * 1024);

    const output = await compressImage(input);

    expect(output.length).toBeLessThan(300 * 1024);
    expect(await sharp(output).metadata()).toMatchObject({
      format: 'webp',
      width: 1200,
      height: 960,
    });
  }, 30_000);

  it('lowers the quality first and the size only when quality is not enough', async () => {
    const input = await noise(600, 600).png().toBuffer();
    const atFullQuality = await compressImage(input, { maxDimension: 600, maxBytes: 10_000_000 });

    const byQuality = await compressImage(input, {
      maxDimension: 600,
      maxBytes: atFullQuality.length,
    });
    const tight = Math.floor(atFullQuality.length * 0.3);
    const bySize = await compressImage(input, { maxDimension: 600, maxBytes: tight });

    expect(byQuality.length).toBeLessThan(atFullQuality.length);
    expect((await sharp(byQuality).metadata()).width).toBe(600);
    expect(bySize.length).toBeLessThan(tight);
    expect((await sharp(bySize).metadata()).width).toBeLessThan(600);
  }, 30_000);

  it('gives up rather than store an image over the limit', async () => {
    const input = await noise(800, 800).png().toBuffer();

    await expect(compressImage(input, { maxDimension: 1200, maxBytes: 2000 })).rejects.toThrow(
      ImageNotCompressibleError,
    );
  });

  it('turns the picture upright from its EXIF orientation and drops the metadata', async () => {
    // Orientation 6: the stored pixels are 400 x 200, the picture is 200 x 400.
    const input = await solid(400, 200)
      .jpeg()
      .withExif({ IFD0: { Make: 'HamroCam', Copyright: 'secret-owner' } })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect((await sharp(input).metadata()).orientation).toBe(6);

    const output = await compressImage(input);

    const metadata = await sharp(output).metadata();
    expect(metadata).toMatchObject({ width: 200, height: 400 });
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
    expect(output.includes(Buffer.from('secret-owner'))).toBe(false);
  });

  it('keeps transparency', async () => {
    const input = await sharp({
      create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();

    expect((await sharp(await compressImage(input)).metadata()).hasAlpha).toBe(true);
  });

  it('refuses bytes that are not a decodable JPEG, PNG or WebP', async () => {
    const signatureOnly = Buffer.alloc(2048, 0x20);
    Buffer.from([0xff, 0xd8, 0xff]).copy(signatureOnly);
    const gif = await solid(50, 50).gif().toBuffer();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    const truncated = (await solid(600, 600).png().toBuffer()).subarray(0, 60);

    for (const bytes of [
      signatureOnly,
      gif,
      svg,
      truncated,
      Buffer.from('%PDF-1.7'),
      Buffer.alloc(0),
    ]) {
      await expect(compressImage(bytes)).rejects.toThrow(InvalidImageError);
    }
  });
});
