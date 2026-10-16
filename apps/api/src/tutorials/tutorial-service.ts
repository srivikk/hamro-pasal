import { appTutorials, recordAuditLog, type Database } from '@hamro-pasal/db';
import type {
  AppVariant,
  AuditContext,
  TutorialView,
  TutorialWriteRequest,
} from '@hamro-pasal/shared-types';
import { and, asc, eq } from 'drizzle-orm';

import { HttpError } from '../http/errors';

type TutorialRow = typeof appTutorials.$inferSelect;

function view(row: TutorialRow): TutorialView {
  return {
    id: row.id,
    app: row.app,
    youtube_video_id: row.youtube_video_id,
    title: row.title,
    display_order: row.display_order,
    is_active: row.is_active,
  };
}

const state = (row: TutorialRow) => ({
  app: row.app,
  youtube_video_id: row.youtube_video_id,
  title: row.title,
  display_order: row.display_order,
  is_active: row.is_active,
});

/**
 * Step 7.8 (SPEC core 11): the tutorial videos each app shows in its floating card, played inside
 * the app. A Super Admin manages them (audited); the apps read the active ones, in order.
 */
export class TutorialService {
  constructor(private readonly db: Database) {}

  /** GET /api/tutorials?app=: public, active only. */
  async listActive(app: AppVariant): Promise<TutorialView[]> {
    const rows = await this.db
      .select()
      .from(appTutorials)
      .where(and(eq(appTutorials.app, app), eq(appTutorials.is_active, true)))
      .orderBy(asc(appTutorials.display_order), asc(appTutorials.created_at));
    return rows.map(view);
  }

  /** GET /api/admin/tutorials: every video of both apps, hidden ones included. */
  async listAll(): Promise<TutorialView[]> {
    const rows = await this.db
      .select()
      .from(appTutorials)
      .orderBy(
        asc(appTutorials.app),
        asc(appTutorials.display_order),
        asc(appTutorials.created_at),
      );
    return rows.map(view);
  }

  async create(adminUserId: string, input: TutorialWriteRequest, context: AuditContext) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(appTutorials).values(input).returning();
      if (row === undefined) throw new Error('Tutorial not stored');
      await recordAuditLog(tx, {
        actor: { kind: 'USER', user_id: adminUserId, role: 'SUPER_ADMIN' },
        action: 'TUTORIAL_CREATED',
        entityId: row.id,
        vendorId: null,
        beforeState: {},
        afterState: state(row),
        context,
      });
      return view(row);
    });
  }

  /** PUT: replaces every field. */
  async update(
    adminUserId: string,
    id: string,
    input: TutorialWriteRequest,
    context: AuditContext,
  ): Promise<TutorialView> {
    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(appTutorials)
        .where(eq(appTutorials.id, id))
        .for('update');
      if (before === undefined) throw notFound();
      const [after] = await tx
        .update(appTutorials)
        .set(input)
        .where(eq(appTutorials.id, id))
        .returning();
      if (after === undefined) throw notFound();
      await recordAuditLog(tx, {
        actor: { kind: 'USER', user_id: adminUserId, role: 'SUPER_ADMIN' },
        action: 'TUTORIAL_UPDATED',
        entityId: id,
        vendorId: null,
        beforeState: state(before),
        afterState: state(after),
        context,
      });
      return view(after);
    });
  }

  async remove(adminUserId: string, id: string, context: AuditContext): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [removed] = await tx.delete(appTutorials).where(eq(appTutorials.id, id)).returning();
      if (removed === undefined) throw notFound();
      await recordAuditLog(tx, {
        actor: { kind: 'USER', user_id: adminUserId, role: 'SUPER_ADMIN' },
        action: 'TUTORIAL_DELETED',
        entityId: id,
        vendorId: null,
        beforeState: state(removed),
        afterState: {},
        context,
      });
    });
  }
}

function notFound(): HttpError {
  return new HttpError(404, 'TUTORIAL_NOT_FOUND', 'Tutorial not found');
}
