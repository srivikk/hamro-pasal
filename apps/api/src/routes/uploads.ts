import {
  disputeEvidenceUploadFieldsSchema,
  MAX_DISPUTE_EVIDENCE_BYTES,
  type DisputeEvidenceUploadResponseBody,
} from '@hamro-pasal/shared-types';
import { Router } from 'express';
import multer from 'multer';

import type { DisputeService } from '../disputes/dispute-service';
import { authOf } from '../http/auth';
import { HttpError } from '../http/errors';
import { parseInput } from '../http/validate';
import { sniffEvidenceType, type EvidenceStorage } from '../uploads/evidence-storage';

/** The multipart part that carries the image. */
export const EVIDENCE_FILE_FIELD = 'file';

/** Mounted at /api/uploads behind requireAuth(CUSTOMER). */
export function uploadsRouter(disputes: DisputeService, storage: EvidenceStorage): Router {
  const router = Router();
  // Held in memory (at most 5 MB) so the type is checked before anything touches the disk.
  // Anything larger is refused by multer while streaming (413 FILE_TOO_LARGE).
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_DISPUTE_EVIDENCE_BYTES, files: 1, fields: 5 },
  });

  /**
   * Dispute evidence (SPEC customer journey 11, Super Admin flow 3): multipart `order_id` + `file`.
   * Only the order's customer, inside the 48 h dispute window. The returned `{ url, content_type }`
   * is sent as a `chat:new_message` attachment.
   */
  router.post('/dispute-evidence', upload.single(EVIDENCE_FILE_FIELD), async (req, res) => {
    const { order_id: orderId } = parseInput(disputeEvidenceUploadFieldsSchema, {
      ...(req.body as Record<string, unknown> | undefined),
    });
    const { file } = req;
    if (file === undefined) {
      throw new HttpError(400, 'VALIDATION_FAILED', 'Request validation failed', {
        issues: [{ path: EVIDENCE_FILE_FIELD, message: 'An image file is required' }],
      });
    }
    const auth = authOf(req);
    await disputes.assertAccess({ userId: auth.userId, role: auth.role }, orderId);

    const contentType = sniffEvidenceType(file.buffer);
    if (contentType === null) {
      throw new HttpError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'Evidence must be a JPEG, PNG or WebP image',
      );
    }
    const stored = await storage.save(orderId, file.buffer, contentType);
    const body: DisputeEvidenceUploadResponseBody = {
      url: stored.url,
      content_type: stored.contentType,
    };
    res.status(201).json(body);
  });

  return router;
}
