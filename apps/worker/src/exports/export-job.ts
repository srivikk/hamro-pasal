import { exportJobs, type Database } from '@hamro-pasal/db';
import { buildExportZip, type ExportScope } from '@hamro-pasal/exports';
import { MAX_MAIL_ATTACHMENT_BYTES, type MailGateway } from '@hamro-pasal/mail';
import { EXPORT_LINK_TTL_DAYS } from '@hamro-pasal/shared-types';
import type { ObjectStore } from '@hamro-pasal/storage';
import { and, eq, isNotNull, lte, or, sql } from 'drizzle-orm';

/** A RUNNING job untouched this long belonged to a worker that died: it may be taken again. */
export const EXPORT_STALE_RUN_MS = 30 * 60_000;

export type ExportRunOutcome =
  | { readonly status: 'ATTACHED' | 'LINKED'; readonly rowCount: number; readonly bytes: number }
  | { readonly status: 'SKIPPED' }
  | { readonly status: 'FAILED'; readonly error: string };

export interface ExportJobDeps {
  readonly db: Database;
  /** null when MAIL_PROVIDER=DISABLED: the job fails, nothing can be sent. */
  readonly mail: MailGateway | null;
  /** The private store (the private bucket in production). */
  readonly files: ObjectStore;
  /** Where the API is reached, for the link: `<base>/api/…/exports/<id>/download`. */
  readonly apiBaseUrl: string;
  readonly now?: () => Date;
  /** Tests only: a smaller limit. Production attaches below MAX_MAIL_ATTACHMENT_BYTES (7 MB). */
  readonly attachmentLimitBytes?: number;
}

/** The private store key of a linked export. */
export function exportFileKey(jobId: string): string {
  return `exports/${jobId}.zip`;
}

/**
 * Step 7.6 (SPEC core 11, verification 30): builds one queued export and emails it through
 * Amazon SES (`@hamro-pasal/mail`). The CSV is streamed from the database a page at a time into a
 * zip; the zip is **attached when under 7 MB** (SES refuses a message over 10 MB, and an
 * attachment grows by a third when encoded), **otherwise stored** in the private bucket as
 * `exports/<job>.zip` and **linked**: the link is the API's download route, which needs the
 * requester to sign in, and works for 7 days.
 *
 * At most one worker runs a job: it is claimed QUEUED -> RUNNING (or taken over from a worker that
 * died). A failure puts it back to QUEUED for BullMQ's next attempt; after the last one it is
 * FAILED with the reason.
 */
export class ExportJobService {
  private readonly now: () => Date;

  constructor(private readonly deps: ExportJobDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async run(jobId: string, options: { readonly finalAttempt: boolean }): Promise<ExportRunOutcome> {
    const { db } = this.deps;
    const [job] = await db
      .update(exportJobs)
      .set({ status: 'RUNNING', started_at: sql`now()`, error: null })
      .where(
        and(
          eq(exportJobs.id, jobId),
          or(
            eq(exportJobs.status, 'QUEUED'),
            and(
              eq(exportJobs.status, 'RUNNING'),
              sql`${exportJobs.started_at} < now() - make_interval(secs => ${EXPORT_STALE_RUN_MS / 1000})`,
            ),
          ),
        ),
      )
      .returning();
    if (job === undefined) return { status: 'SKIPPED' };

    try {
      if (this.deps.mail === null)
        throw new Error('Email is not configured (MAIL_PROVIDER=DISABLED)');
      const role = job.role === 'VENDOR' ? 'VENDOR' : 'SUPER_ADMIN';
      const scope: ExportScope = { role, vendorId: job.params.vendor_id };
      const built = await buildExportZip(db, job.kind, job.params, scope);
      const kindLabel = job.kind.toLowerCase().replace(/_/g, ' ');
      const range = `${job.params.from} to ${job.params.to}`;

      const limit = Math.min(
        this.deps.attachmentLimitBytes ?? MAX_MAIL_ATTACHMENT_BYTES,
        MAX_MAIL_ATTACHMENT_BYTES,
      );
      if (built.zip.length < limit) {
        await this.deps.mail.send({
          to: job.email,
          subject: `Your Hamro Pasal ${kindLabel} export (${range})`,
          text:
            `Your ${kindLabel} export for ${range} is attached: ${String(built.rowCount)} rows, ` +
            'as a CSV file in a zip. Times are Nepal Time.',
          attachments: [
            { filename: built.fileName, content: built.zip, contentType: 'application/zip' },
          ],
        });
        await db
          .update(exportJobs)
          .set({
            status: 'DONE',
            delivery: 'ATTACHMENT',
            row_count: built.rowCount,
            finished_at: sql`now()`,
          })
          .where(eq(exportJobs.id, job.id));
        return { status: 'ATTACHED', rowCount: built.rowCount, bytes: built.zip.length };
      }

      const key = exportFileKey(job.id);
      // A retried job may have stored the file before its email failed.
      await this.deps.files.delete(key);
      await this.deps.files.put(key, built.zip, {
        contentType: 'application/zip',
        cacheControl: 'private, no-store',
      });
      const expiresAt = new Date(this.now().getTime() + EXPORT_LINK_TTL_DAYS * 86_400_000);
      const path = role === 'VENDOR' ? 'vendor' : 'admin';
      const link = `${this.deps.apiBaseUrl.replace(/\/+$/, '')}/api/${path}/exports/${job.id}/download`;
      await this.deps.mail.send({
        to: job.email,
        subject: `Your Hamro Pasal ${kindLabel} export (${range})`,
        text:
          `Your ${kindLabel} export for ${range} (${String(built.rowCount)} rows) is too large to ` +
          `attach. Download it here after signing in, until ${expiresAt.toISOString().slice(0, 10)}:\n${link}`,
      });
      await db
        .update(exportJobs)
        .set({
          status: 'DONE',
          delivery: 'LINK',
          file_key: key,
          expires_at: expiresAt,
          row_count: built.rowCount,
          finished_at: sql`now()`,
        })
        .where(eq(exportJobs.id, job.id));
      return { status: 'LINKED', rowCount: built.rowCount, bytes: built.zip.length };
    } catch (failure: unknown) {
      const error = (failure instanceof Error ? failure.message : String(failure)).slice(0, 500);
      await db
        .update(exportJobs)
        .set(
          options.finalAttempt
            ? { status: 'FAILED', error, finished_at: sql`now()` }
            : { status: 'QUEUED', error },
        )
        .where(eq(exportJobs.id, job.id));
      if (!options.finalAttempt) throw failure;
      return { status: 'FAILED', error };
    }
  }

  /**
   * The daily sweep: deletes the files of linked exports whose 7 days are over. The job row stays
   * (its audit and history); its download then answers 410.
   */
  async sweepExpired(): Promise<number> {
    const { db } = this.deps;
    const expired = await db
      .select({ id: exportJobs.id, key: exportJobs.file_key })
      .from(exportJobs)
      .where(and(isNotNull(exportJobs.file_key), lte(exportJobs.expires_at, this.now())));
    for (const { id, key } of expired) {
      if (key !== null) await this.deps.files.delete(key);
      await db.update(exportJobs).set({ file_key: null }).where(eq(exportJobs.id, id));
    }
    return expired.length;
  }
}
