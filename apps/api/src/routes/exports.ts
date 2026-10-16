import {
  adminExportRequestSchema,
  idParamSchema,
  vendorExportRequestSchema,
  type ExportJobResponseBody,
} from '@hamro-pasal/shared-types';
import { Router, type Request, type Response } from 'express';

import type { ExportRequester, ExportService } from '../exports/export-service';
import { authOf } from '../http/auth';
import { auditContextOf } from '../http/request-context';
import { parseInput } from '../http/validate';

function requesterOf(req: Request): ExportRequester {
  const { userId, role } = authOf(req);
  if (role !== 'VENDOR' && role !== 'SUPER_ADMIN') throw new Error(`No exports for ${role}`);
  return { userId, role };
}

/**
 * POST /, GET /:id and GET /:id/download (step 7.6, SPEC core 11). Mounted at /api/vendor/exports
 * behind vendor auth and at /api/admin/exports behind SUPER_ADMIN auth. A POST answers
 * `200 text/csv` (at most 5 000 rows, streamed) or `202 { job }` (queued and emailed).
 */
export function exportsRouter(exports: ExportService, audience: 'VENDOR' | 'SUPER_ADMIN'): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.post('/', async (req: Request, res: Response) => {
    const request =
      audience === 'VENDOR'
        ? parseInput(vendorExportRequestSchema, req.body)
        : parseInput(adminExportRequestSchema, req.body);
    const outcome = await exports.request(
      requesterOf(req),
      {
        kind: request.kind,
        from: request.from,
        to: request.to,
        vendorId: 'vendor_id' in request ? request.vendor_id : undefined,
      },
      auditContextOf(req, res),
    );
    if (outcome.mode === 'QUEUED') {
      const body: ExportJobResponseBody = { job: outcome.job };
      res.status(202).json(body);
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${outcome.fileName}"`);
    res.setHeader('X-Row-Count', String(outcome.rowCount));
    for await (const chunk of outcome.chunks) {
      if (!res.write(chunk.text)) {
        await new Promise<void>((resolve) =>
          res.once('drain', () => {
            resolve();
          }),
        );
      }
    }
    res.end();
  });

  router.get('/:id', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const body: ExportJobResponseBody = { job: await exports.status(requesterOf(req), id) };
    res.status(200).json(body);
  });

  router.get('/:id/download', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const file = await exports.download(requesterOf(req), id);
    res.status(200);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.send(file.bytes);
  });

  return router;
}
