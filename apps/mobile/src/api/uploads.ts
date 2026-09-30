import {
  disputeEvidenceUploadResponseSchema,
  MAX_DISPUTE_EVIDENCE_BYTES,
  type ChatAttachment,
} from '@hamro-pasal/shared-types';

import { ApiError, apiRequest } from './http';

export const DISPUTE_EVIDENCE_PATH = '/api/uploads/dispute-evidence';

/** An image picked on the device (expo-image-picker asset fields). */
export interface EvidenceFile {
  uri: string;
  mimeType: string | null;
  fileSize: number | null;
  fileName?: string | null;
}

export type EvidenceRejection = 'not_an_image' | 'too_large' | 'window_closed';

/** The image was refused, by this device before sending or by the server. */
export class EvidenceRejectedError extends Error {
  constructor(readonly reason: EvidenceRejection) {
    super(`Evidence rejected: ${reason}`);
    this.name = 'EvidenceRejectedError';
  }
}

const REJECTIONS: Readonly<Record<string, EvidenceRejection>> = {
  FILE_TOO_LARGE: 'too_large',
  UNSUPPORTED_MEDIA_TYPE: 'not_an_image',
  DISPUTE_WINDOW_CLOSED: 'window_closed',
};

/**
 * React Native's FormData sends a `{ uri, name, type }` part by streaming the file at `uri`; the
 * DOM typings only know Blob, hence the cast.
 */
function filePart(file: EvidenceFile, contentType: string): Blob {
  const extension = contentType.split('/')[1] ?? 'jpg';
  return {
    uri: file.uri,
    name: file.fileName ?? `evidence.${extension}`,
    type: contentType,
  } as unknown as Blob;
}

/**
 * POST /api/uploads/dispute-evidence (multipart `order_id` + `file`): stores a photo for the
 * order's dispute and returns the attachment to send with `chat:new_message`. Files over 5 MB or
 * that are not images are refused here without being sent; the server checks both again (and the
 * actual image bytes).
 */
export async function uploadDisputeEvidence(
  orderId: string,
  file: EvidenceFile,
): Promise<ChatAttachment> {
  const contentType = file.mimeType ?? 'image/jpeg';
  if (!contentType.startsWith('image/')) throw new EvidenceRejectedError('not_an_image');
  if (file.fileSize !== null && file.fileSize > MAX_DISPUTE_EVIDENCE_BYTES) {
    throw new EvidenceRejectedError('too_large');
  }

  const form = new FormData();
  form.append('order_id', orderId);
  form.append('file', filePart(file, contentType));
  try {
    return await apiRequest({
      method: 'POST',
      path: DISPUTE_EVIDENCE_PATH,
      body: form,
      schema: disputeEvidenceUploadResponseSchema,
    });
  } catch (error) {
    const reason = error instanceof ApiError ? REJECTIONS[error.code] : undefined;
    throw reason === undefined ? error : new EvidenceRejectedError(reason);
  }
}
