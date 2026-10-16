import {
  enqueueDomainEvent,
  exportJobs,
  recordAuditLog,
  users,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import {
  countExportRows,
  exportCsvChunks,
  exportFileName,
  ExportScopeError,
  type CsvChunk,
  type ExportScope,
} from '@hamro-pasal/exports';
import {
  EXPORT_INLINE_ROW_LIMIT,
  type AuditContext,
  type ExportJobView,
  type ExportKind,
  type ExportParams,
} from '@hamro-pasal/shared-types';
import { and, eq } from 'drizzle-orm';

import { HttpError } from '../http/errors';
import type { ObjectStore } from '../uploads/object-store';

/** Who asks: the signed-in vendor (its own shop) or a Super Admin. */
export interface ExportRequester {
  readonly userId: string;
  readonly role: 'VENDOR' | 'SUPER_ADMIN';
}

export interface ExportRequest {
  readonly kind: ExportKind;
  readonly from: string;
  readonly to: string;
  /** An admin's filter on one shop (ORDERS, PAYOUTS, AUDIT_LOG). */
  readonly vendorId?: string | undefined;
}

export type ExportOutcome =
  | {
      /** At most 5 000 rows: sent at once as CSV. */
      readonly mode: 'DOWNLOAD';
      readonly rowCount: number;
      readonly fileName: string;
      readonly chunks: AsyncGenerator<CsvChunk>;
    }
  | { readonly mode: 'QUEUED'; readonly job: ExportJobView };

export interface ExportFile {
  readonly bytes: Buffer;
  readonly fileName: string;
}

type JobRow = typeof exportJobs.$inferSelect;

/** The filters as the audit records them (a JSON object without undefined values). */
function auditFilters(params: ExportParams): Record<string, string> {
  return {
    from: params.from,
    to: params.to,
    ...(params.vendor_id === undefined ? {} : { vendor_id: params.vendor_id }),
  };
}

function jobView(row: JobRow, now = new Date()): ExportJobView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    row_count: row.row_count,
    delivery: row.delivery,
    downloadable:
      row.delivery === 'LINK' &&
      row.file_key !== null &&
      row.expires_at !== null &&
      row.expires_at > now,
    error: row.error,
    created_at: row.created_at.toISOString(),
    finished_at: row.finished_at?.toISOString() ?? null,
    expires_at: row.expires_at?.toISOString() ?? null,
  };
}

/**
 * Step 7.6 (SPEC core 11, verification 30): data exports. The rows are counted first: at most
 * EXPORT_INLINE_ROW_LIMIT download at once as CSV; more are queued (`export_jobs` + outbox
 * `export.requested`), built by the worker and emailed to the requester's address, which is
 * therefore required (`422 EMAIL_REQUIRED`). A vendor's export is always scoped to its own shop by
 * the server. Every export is audited with its kind, filters and row count, never its data.
 */
export class ExportService {
  constructor(
    private readonly db: Database,
    private readonly files: ObjectStore,
  ) {}

  async request(
    requester: ExportRequester,
    request: ExportRequest,
    context: AuditContext,
  ): Promise<ExportOutcome> {
    const scope = await this.scopeOf(requester, request);
    const params: ExportParams = {
      from: request.from,
      to: request.to,
      ...(scope.vendorId === undefined ? {} : { vendor_id: scope.vendorId }),
    };
    let rowCount: number;
    try {
      rowCount = await countExportRows(this.db, request.kind, params, scope);
    } catch (error: unknown) {
      if (error instanceof ExportScopeError) {
        throw new HttpError(403, 'FORBIDDEN', 'This export is not available for your role');
      }
      throw error;
    }

    if (rowCount <= EXPORT_INLINE_ROW_LIMIT) {
      await this.db.transaction(async (tx) => {
        await recordAuditLog(tx, {
          actor: { kind: 'USER', user_id: requester.userId, role: requester.role },
          action: 'DATA_EXPORTED',
          entityId: requester.userId,
          vendorId: scope.vendorId ?? null,
          beforeState: {},
          afterState: {
            kind: request.kind,
            filters: auditFilters(params),
            row_count: rowCount,
            delivery: 'DOWNLOAD',
          },
          context,
        });
      });
      return {
        mode: 'DOWNLOAD',
        rowCount,
        fileName: exportFileName(request.kind, params, 'csv'),
        // Bounded by the count, in case rows were added since: a download never exceeds the limit.
        chunks: exportCsvChunks(this.db, request.kind, params, scope, {
          maxRows: EXPORT_INLINE_ROW_LIMIT,
        }),
      };
    }

    const [user] = await this.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, requester.userId));
    if (user?.email == null) {
      throw new HttpError(
        422,
        'EMAIL_REQUIRED',
        `More than ${String(EXPORT_INLINE_ROW_LIMIT)} rows are emailed: add an email address to your account first`,
        { row_count: rowCount },
      );
    }
    const email = user.email;
    const job = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(exportJobs)
        .values({
          requested_by_user_id: requester.userId,
          role: requester.role,
          kind: request.kind,
          params,
          email,
          row_count: rowCount,
        })
        .returning();
      if (row === undefined) throw new Error('Export job not stored');
      await recordAuditLog(tx, {
        actor: { kind: 'USER', user_id: requester.userId, role: requester.role },
        action: 'DATA_EXPORTED',
        entityId: row.id,
        vendorId: scope.vendorId ?? null,
        beforeState: {},
        afterState: {
          kind: request.kind,
          filters: auditFilters(params),
          row_count: rowCount,
          delivery: 'EMAIL',
        },
        context,
      });
      await enqueueDomainEvent(tx, {
        type: 'export.requested',
        aggregateId: row.id,
        payload: { job_id: row.id },
      });
      return row;
    });
    return { mode: 'QUEUED', job: jobView(job) };
  }

  /** GET …/exports/:id: the requester's own job only (anyone else: 404). */
  async status(requester: ExportRequester, jobId: string): Promise<ExportJobView> {
    return jobView(await this.ownJob(requester, jobId));
  }

  /**
   * GET …/exports/:id/download: the zip of a linked export, for the signed-in requester only and
   * only until `expires_at` (7 days). An attached export has no file to download.
   */
  async download(requester: ExportRequester, jobId: string): Promise<ExportFile> {
    const job = await this.ownJob(requester, jobId);
    if (job.status !== 'DONE') {
      throw new HttpError(409, 'EXPORT_NOT_READY', 'The export is not ready yet');
    }
    if (job.delivery !== 'LINK') {
      throw new HttpError(404, 'EXPORT_NOT_FOUND', 'This export was sent as an email attachment');
    }
    if (job.file_key === null || job.expires_at === null || job.expires_at <= new Date()) {
      throw new HttpError(410, 'EXPORT_EXPIRED', 'The link to this export has expired');
    }
    const bytes = await this.files.get(job.file_key);
    if (bytes === null) throw new HttpError(410, 'EXPORT_EXPIRED', 'The export file is gone');
    return {
      bytes,
      fileName: exportFileName(job.kind, job.params, 'zip'),
    };
  }

  private async ownJob(requester: ExportRequester, jobId: string): Promise<JobRow> {
    const [job] = await this.db
      .select()
      .from(exportJobs)
      .where(and(eq(exportJobs.id, jobId), eq(exportJobs.requested_by_user_id, requester.userId)));
    if (job === undefined) throw new HttpError(404, 'EXPORT_NOT_FOUND', 'Export not found');
    return job;
  }

  private async scopeOf(requester: ExportRequester, request: ExportRequest): Promise<ExportScope> {
    if (requester.role === 'SUPER_ADMIN') {
      return { role: 'SUPER_ADMIN', vendorId: request.vendorId };
    }
    const [vendor] = await this.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(eq(vendors.user_id, requester.userId));
    if (vendor === undefined)
      throw new HttpError(404, 'VENDOR_NOT_FOUND', 'No shop for this account');
    return { role: 'VENDOR', vendorId: vendor.id };
  }
}
