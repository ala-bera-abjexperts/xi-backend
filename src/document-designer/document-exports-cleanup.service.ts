/**
 * @fileoverview Daily retention sweep for generated export files and stale
 * history rows. Two passes, both batched (100 rows/loop):
 *  1. Exports whose file is older than DOCUMENT_EXPORT_RETENTION_DAYS
 *     (default 30): storage objects removed, file_path nulled — the history
 *     row survives so the audit trail stays intact.
 *  2. History rows older than 180 days are deleted outright.
 *
 * Runs daily at 04:15, gated through the shared `cron_run_state` table
 * (job 'document_exports_cleanup') so multi-instance deployments run the
 * sweep once per ~day. The gate pattern replicates automation-tick's
 * runOncePerDay locally — automations code is intentionally NOT imported.
 * @module src/document-designer/document-exports-cleanup.service
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { DOCUMENT_EXPORTS_BUCKET } from './document-exports.constants';
import { claimCronSlot, releaseCronSlot } from '../common/utils/cron-claim';

const CRON_JOB_NAME = 'document_exports_cleanup';
const DEFAULT_RETENTION_DAYS = 30;
const ROW_RETENTION_DAYS = 180;
const BATCH_SIZE = 100;

/** Re-run guard window — mirrors automation-tick's runOncePerDay (23 h). */
const MIN_INTERVAL_MS = 23 * 60 * 60 * 1000;

@Injectable()
export class DocumentExportsCleanupService {
  private readonly logger = new Logger(DocumentExportsCleanupService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly configService: ConfigService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  private get retentionDays(): number {
    const raw = this.configService.get<string>(
      'DOCUMENT_EXPORT_RETENTION_DAYS',
    );
    const parsed = raw ? parseInt(raw, 10) : NaN;

    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_RETENTION_DAYS;
  }

  @Cron('0 15 4 * * *') // daily at 04:15
  async run(): Promise<void> {
    // cron_run_state gate — at most one sweep per 23 h across instances. Claimed
    // up front (atomically) rather than marked after, so two replicas cannot both
    // sweep; a failed sweep gives the slot back so the next tick retries, as before.
    const stamp = await claimCronSlot(this.db, CRON_JOB_NAME, MIN_INTERVAL_MS);
    if (!stamp) return;

    try {
      const filesPurged = await this.purgeExpiredFiles();
      const rowsDeleted = await this.deleteOldRows();

      this.logger.log(
        `Cleanup done: ${filesPurged} export file(s) purged, ${rowsDeleted} history row(s) deleted`,
      );
    } catch (err) {
      this.logger.error(`Cleanup failed: ${String(err)}`);
      await releaseCronSlot(this.db, CRON_JOB_NAME, stamp);
    }
  }

  /**
   * Pass 1: remove storage objects for exports whose file outlived the
   * retention window, then null file_path so downloads 404 cleanly.
   */
  private async purgeExpiredFiles(): Promise<number> {
    const cutoff = new Date(
      Date.now() - this.retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    let total = 0;

    // Batched loop: each iteration re-queries because processed rows drop out
    // of the filter (file_path becomes null).
    for (;;) {
      const { data, error } = (await this.db
        .from('document_exports')
        .select('id, file_path')
        .not('file_path', 'is', null)
        .lt('completed_at', cutoff)
        .limit(BATCH_SIZE)) as {
        data: Array<{ id: string; file_path: string }> | null;
        error: { message: string } | null;
      };

      if (error) {
        this.logger.error(`purgeExpiredFiles query failed: ${error.message}`);
        break;
      }

      const rows = data ?? [];
      if (rows.length === 0) break;

      const paths = rows.map((row) => row.file_path).filter(Boolean);
      if (paths.length > 0) {
        const { error: removeError } = await this.db.storage
          .from(DOCUMENT_EXPORTS_BUCKET)
          .remove(paths);
        if (removeError) {
          this.logger.error(
            `purgeExpiredFiles storage remove failed: ${removeError.message}`,
          );
          break;
        }
      }

      const { error: updateError } = await this.db
        .from('document_exports')
        .update({ file_path: null })
        .in(
          'id',
          rows.map((row) => row.id),
        );

      if (updateError) {
        this.logger.error(
          `purgeExpiredFiles update failed: ${updateError.message}`,
        );
        break;
      }

      total += rows.length;
      if (rows.length < BATCH_SIZE) break;
    }

    return total;
  }

  /** Pass 2: delete history rows older than 180 days (files already purged). */
  private async deleteOldRows(): Promise<number> {
    const cutoff = new Date(
      Date.now() - ROW_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    let total = 0;

    for (;;) {
      const { data, error } = (await this.db
        .from('document_exports')
        .select('id, file_path')
        .lt('created_at', cutoff)
        .limit(BATCH_SIZE)) as {
        data: Array<{ id: string; file_path: string | null }> | null;
        error: { message: string } | null;
      };

      if (error) {
        this.logger.error(`deleteOldRows query failed: ${error.message}`);
        break;
      }

      const rows = data ?? [];
      if (rows.length === 0) break;

      // Belt and braces: a >180d row can still hold a file when the retention
      // window is configured longer than 180 days — remove before deleting.
      const paths = rows
        .map((row) => row.file_path)
        .filter((path): path is string => Boolean(path));
      if (paths.length > 0) {
        const { error: removeError } = await this.db.storage
          .from(DOCUMENT_EXPORTS_BUCKET)
          .remove(paths);
        if (removeError) {
          this.logger.error(
            `deleteOldRows storage remove failed: ${removeError.message}`,
          );
          break;
        }
      }

      const { error: deleteError } = await this.db
        .from('document_exports')
        .delete()
        .in(
          'id',
          rows.map((row) => row.id),
        );

      if (deleteError) {
        this.logger.error(
          `deleteOldRows delete failed: ${deleteError.message}`,
        );
        break;
      }

      total += rows.length;
      if (rows.length < BATCH_SIZE) break;
    }

    return total;
  }
}
