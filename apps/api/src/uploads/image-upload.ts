import { STORED_IMAGE_CONTENT_TYPE } from '@hamro-pasal/shared-types';
import type { RequestHandler } from 'express';
import multer, { MulterError } from 'multer';

import { HttpError } from '../http/errors';
import { sniffEvidenceType } from './evidence-storage';
import { compressImage, ImageNotCompressibleError, InvalidImageError } from './image-compression';

/** An upload as it is stored: always WebP, at most 1200 px, under 300 KB. */
export interface StoredImage {
  readonly bytes: Buffer;
  readonly contentType: typeof STORED_IMAGE_CONTENT_TYPE;
}

/**
 * The multipart parser of a route that takes exactly one image in `field` and nothing else: the
 * file is held in memory (at most `maxBytes`, refused while streaming beyond it: 413), no form
 * field and no second file is accepted (400).
 */
export function singleImageUpload(field: string, maxBytes: number): RequestHandler {
  const parse = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 0, parts: 1 },
  }).single(field);
  return (req, res, next) => {
    parse(req, res, (error: unknown) => {
      // The shared error mapping reads a file-count overflow as a product photo limit.
      if (
        error instanceof MulterError &&
        (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_PART_COUNT')
      ) {
        next(new HttpError(400, 'MALFORMED_REQUEST', 'Upload rejected: one file, no other fields'));
        return;
      }
      next(error);
    });
  };
}

/**
 * Turns uploaded bytes into the image that is stored.
 *
 * - The type is the file's own signature, never the declared Content-Type or the file name:
 *   anything but JPEG, PNG or WebP is 415.
 * - A file that carries such a signature but cannot be decoded is 415 as well.
 * - Then SPEC's compression rule (`compressImage`).
 *
 * `what` names the upload in the error message ("Product photos", "The PAN document").
 */
export async function storedImageOf(bytes: Buffer, what: string): Promise<StoredImage> {
  if (sniffEvidenceType(bytes) === null) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', `${what} must be a JPEG, PNG or WebP image`);
  }
  try {
    return { bytes: await compressImage(bytes), contentType: STORED_IMAGE_CONTENT_TYPE };
  } catch (error: unknown) {
    if (error instanceof InvalidImageError) {
      throw new HttpError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        `${what} must be a readable JPEG, PNG or WebP image`,
      );
    }
    if (error instanceof ImageNotCompressibleError) {
      throw new HttpError(
        422,
        'IMAGE_NOT_COMPRESSIBLE',
        'The image could not be made small enough',
      );
    }
    throw error;
  }
}

/** 400 for a multipart request without its one file. */
export function missingFile(field: string, message: string): HttpError {
  return new HttpError(400, 'VALIDATION_FAILED', 'Request validation failed', {
    issues: [{ path: field, message }],
  });
}
