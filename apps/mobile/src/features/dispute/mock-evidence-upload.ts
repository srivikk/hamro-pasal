import type { ChatAttachment } from './chat-contract';

/*
 * MOCK evidence upload. The real flow (SPEC infrastructure §3/§6): compress with
 * react-native-compressor (WebP, max 1200 px, 75% quality, under 300 KB), obtain a presigned PUT
 * URL from the API, upload the file to Cloudflare R2, and attach the CDN URL. No upload endpoint
 * exists yet, so this only validates the file and returns a fake CDN URL. Nothing leaves the device.
 */

export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
const MOCK_CDN_BASE = 'https://evidence.hamropasal.test/disputes';

export interface EvidenceFile {
  uri: string;
  mimeType: string | null;
  fileSize: number | null;
}

export class EvidenceRejectedError extends Error {
  constructor(readonly reason: 'not_an_image' | 'too_large') {
    super(`Evidence rejected: ${reason}`);
    this.name = 'EvidenceRejectedError';
  }
}

let uploadCounter = 0;

export async function uploadDisputeEvidence(
  orderId: string,
  file: EvidenceFile,
  { latencyMs = 500 }: { latencyMs?: number } = {},
): Promise<ChatAttachment> {
  const contentType = file.mimeType ?? 'image/jpeg';
  if (!contentType.startsWith('image/')) throw new EvidenceRejectedError('not_an_image');
  if (file.fileSize !== null && file.fileSize > MAX_EVIDENCE_BYTES) {
    throw new EvidenceRejectedError('too_large');
  }
  await new Promise((resolve) => setTimeout(resolve, latencyMs));
  uploadCounter += 1;
  return {
    url: `${MOCK_CDN_BASE}/${orderId}/${String(Date.now())}-${String(uploadCounter)}.webp`,
    content_type: 'image/webp',
  };
}
