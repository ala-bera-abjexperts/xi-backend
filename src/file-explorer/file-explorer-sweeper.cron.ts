/**
 * @fileoverview Scheduled cleanup jobs for File Explorer storage hygiene.
 * - reapPendingVersions: deletes abandoned uploads (fe_versions stuck 'pending' past the grace window)
 *   and their orphaned storage objects. ON by default.
 * - purgeOldTrash: permanently deletes nodes soft-deleted longer ago than a retention window.
 *   OFF unless FE_TRASH_RETENTION_DAYS > 0.
 * All jobs are idempotent and only ever touch pending/orphaned/old-trash rows — never active versions or live nodes.
 * @module src/file-explorer/file-explorer-sweeper.cron
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { FileExplorerStorageService } from './file-explorer-storage.service';

// Grace window must exceed the maximum realistic upload time so in-flight (not-yet-confirmed) uploads
// are never reaped. 24h is comfortably safe.
const PENDING_GRACE_HOURS = 24;

// Trash auto-purge is OFF by default. Set FE_TRASH_RETENTION_DAYS to a positive integer to enable.
const TRASH_RETENTION_DAYS = Number(process.env.FE_TRASH_RETENTION_DAYS ?? 0);

@Injectable()
export class FileExplorerSweeperCron {
  private readonly logger = new Logger(FileExplorerSweeperCron.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly storage: FileExplorerStorageService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Reap abandoned uploads: fe_versions left 'pending' beyond the grace window (bytes never confirmed).
   * Removes any uploaded object then deletes the row. The grace window protects in-flight uploads.
   */
  @Cron('0 */15 * * * *') // every 15 minutes
  async reapPendingVersions(): Promise<void> {
    const cutoff = new Date(
      Date.now() - PENDING_GRACE_HOURS * 3600 * 1000,
    ).toISOString();

    const { data: stale, error } = await this.db
      .from('fe_versions')
      .select('id, node_id, file_path')
      .eq('upload_status', 'pending')
      .lt('uploaded_at', cutoff)
      .limit(500);

    if (error) {
      this.logger.error(`reapPendingVersions: query failed: ${error.message}`);

      return;
    }

    if (!stale?.length) return;

    const rows = stale as {
      id: string;
      node_id: string;
      file_path: string | null;
    }[];

    // Safety: never reap a pending version that a node still references as its current version — that
    // would break a live file's download. This can only happen if addVersion's activate-flip failed;
    // surface it as an anomaly instead of deleting.
    const nodeIds = [...new Set(rows.map((r) => r.node_id))];
    const { data: nodes } = await this.db
      .from('fe_nodes')
      .select('current_version_id')
      .in('id', nodeIds);

    const referenced = new Set(
      (nodes ?? [])
        .map((n: any) => n.current_version_id as string | null)
        .filter((v): v is string => !!v),
    );

    const anomalies = rows.filter((r) => referenced.has(r.id));
    const toReap = rows.filter((r) => !referenced.has(r.id));

    if (anomalies.length) {
      this.logger.warn(
        `reapPendingVersions: ${anomalies.length} pending version(s) still referenced by a node ` +
          `current_version_id (stuck activate-flip) — NOT reaping: ${anomalies
            .map((a) => a.id)
            .join(', ')}`,
      );
    }

    if (!toReap.length) return;

    this.logger.log(
      `reapPendingVersions: reaping ${toReap.length} abandoned pending version(s)`,
    );

    const paths = toReap
      .map((v) => v.file_path)
      .filter((p): p is string => !!p);

    // Remove storage first so a deleted row never points at bytes we failed to clean.
    if (paths.length) await this.storage.removePaths(paths);

    const { error: delErr } = await this.db
      .from('fe_versions')
      .delete()
      .in(
        'id',
        toReap.map((v) => v.id),
      );

    if (delErr) {
      this.logger.error(
        `reapPendingVersions: delete failed: ${delErr.message}`,
      );
    }
  }

  /**
   * Optional Trash retention purge — OFF unless FE_TRASH_RETENTION_DAYS > 0. Permanently deletes nodes
   * soft-deleted longer ago than the retention window, removing each node's own storage prefix first, then
   * the row (FK CASCADE removes descendant rows). Note: a single subtree larger than the batch limit is
   * finished across subsequent daily runs.
   */
  @Cron('0 30 3 * * *') // daily at 03:30
  async purgeOldTrash(): Promise<void> {
    if (!Number.isFinite(TRASH_RETENTION_DAYS) || TRASH_RETENTION_DAYS <= 0) {
      return;
    }

    const cutoff = new Date(
      Date.now() - TRASH_RETENTION_DAYS * 86400 * 1000,
    ).toISOString();

    const { data: old, error } = await this.db
      .from('fe_nodes')
      .select('id, organization_id, space_id')
      .eq('is_deleted', true)
      .lt('deleted_at', cutoff)
      .limit(1000);

    if (error || !old?.length) return;

    this.logger.log(
      `purgeOldTrash: purging ${old.length} trashed node(s) older than ${TRASH_RETENTION_DAYS}d`,
    );

    for (const n of old as {
      id: string;
      organization_id: string;
      space_id: string;
    }[]) {
      try {
        const prefix = `${n.organization_id}/file-explorer/${n.space_id}/${n.id}`;
        const objs = await this.storage.listPrefix(prefix);

        if (objs.length) await this.storage.removePaths(objs);

        await this.db.from('fe_nodes').delete().eq('id', n.id);
      } catch (e: any) {
        this.logger.error(
          `purgeOldTrash: failed for node ${n.id}: ${e?.message}`,
        );
      }
    }
  }
}
