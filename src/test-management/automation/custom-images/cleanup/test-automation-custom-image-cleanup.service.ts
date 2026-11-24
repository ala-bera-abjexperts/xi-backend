import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { AuditLogsService } from '../../../../audit-logs/audit-logs.service';
import { SupabaseAdminService } from '../../../../supabase/supabase-admin.service';
import { CUSTOM_IMAGES_TABLE } from '../../test-automation-custom-images.service';
import { MISSING_SCHEMA } from '../shared/inputs/custom-image-inputs';
import {
  IMAGE_BUCKET,
  removeStoredImages,
  UPLOAD_REGISTRY,
} from '../upload/storage/custom-image-storage';

// A refused image stays this long, so its reasons can be read, then its row is removed.
const REFUSED_KEPT_MS = 24 * 60 * 60 * 1000;
const BATCH = 100;
// A file with no image row yet may be an upload whose last step is still to come.
const UNCLAIMED_KEPT_MS = 3 * 60 * 60 * 1000;
const FOLDERS_PER_RUN = 50;
const FILE_NAME = /^[0-9a-f]{64}$/;

/** Old enough by its check time, or by its last change when it was never given one. */
function oldEnough(cutoff: string): string {
  return `checked_at.lt."${cutoff}",and(checked_at.is.null,updated_at.lt."${cutoff}")`;
}

/**
 * Removes refused custom images after a day. Blocked ones stay, so they can't simply be added again; one a setting
 * still uses stays to show why it can't run; one whose download the worker hasn't removed yet waits for that.
 * Every delete is conditional, so several API instances can run it safely.
 */
@Injectable()
export class TestAutomationCustomImageCleanupService {
  private readonly logger = new Logger(
    TestAutomationCustomImageCleanupService.name,
  );
  private cleaning = false;
  private cleaningFiles = false;
  private folderOffset = 0;

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    @Optional() private readonly auditLogs?: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'tm-custom-image-cleanup' })
  async removeOldRefusals(): Promise<void> {
    if (this.cleaning) return;

    this.cleaning = true;

    try {
      const cutoff = new Date(Date.now() - REFUSED_KEPT_MS).toISOString();
      const { data, error } = await this.client
        .from(CUSTOM_IMAGES_TABLE)
        .select('id')
        .eq('status', 'refused')
        .eq('pulled_by_runner', false)
        .or(oldEnough(cutoff))
        .limit(BATCH);

      if (error) return this.skip('find old refused images', error);

      const ids = ((data ?? []) as { id: string }[]).map((row) => row.id);

      if (ids.length === 0) return;

      const linked = await this.client
        .from('test_automation_configs')
        .select('user_image_id')
        .in('user_image_id', ids);

      if (linked.error) return this.skip('find used images', linked.error);

      const used = new Set(
        ((linked.data ?? []) as { user_image_id: string }[]).map(
          (row) => row.user_image_id,
        ),
      );
      const unused = ids.filter((id) => !used.has(id));

      if (unused.length === 0) return;

      // Checked again or blocked since the read: the conditions keep that row.
      const removed = await this.client
        .from(CUSTOM_IMAGES_TABLE)
        .delete()
        .in('id', unused)
        .eq('status', 'refused')
        .eq('pulled_by_runner', false)
        .or(oldEnough(cutoff))
        .select('id, organization_id');

      if (removed.error) this.skip('remove old refused images', removed.error);

      for (const row of (removed.data ?? []) as {
        id: string;
        organization_id: string;
      }[]) {
        void this.auditLogs?.logSystemAction(
          row.organization_id,
          'test_automation_user_image',
          row.id,
          'delete',
          { action: 'cleanup_refused' },
        );
      }
    } catch (error) {
      this.logger.error('Failed to remove old refused images', error);
    } finally {
      this.cleaning = false;
    }
  }

  /**
   * Removes uploaded image files that may no longer be used: those of refused or blocked images, and files no image
   * row claims after a few hours. A refused image's file uploaded again after its refusal stays for its new check.
   */
  @Cron(CronExpression.EVERY_10_MINUTES, {
    name: 'tm-custom-image-upload-files',
  })
  async removeUploadFiles(): Promise<void> {
    if (this.cleaningFiles) return;

    this.cleaningFiles = true;

    try {
      const storage = this.client.storage.from(IMAGE_BUCKET);
      const folders = await storage.list('', {
        limit: FOLDERS_PER_RUN,
        offset: this.folderOffset,
        sortBy: { column: 'name', order: 'asc' },
      });

      if (folders.error) return this.skipStorage(folders.error);

      // Organisation folders only; a folder entry has no id.
      const names = (folders.data ?? [])
        .filter((entry) => entry.id === null)
        .map((entry) => entry.name);

      // At most 50 organisations, and their 100 oldest files, per run; the offset moves on through the rest.
      const listed = folders.data?.length ?? 0;

      this.folderOffset =
        listed < FOLDERS_PER_RUN ? 0 : this.folderOffset + listed;

      for (const organizationId of names) {
        await this.removeFilesOf(organizationId);
      }
    } catch (error) {
      this.logger.error('Failed to remove uploaded image files', error);
    } finally {
      this.cleaningFiles = false;
    }
  }

  private async removeFilesOf(organizationId: string): Promise<void> {
    const listed = await this.client.storage
      .from(IMAGE_BUCKET)
      .list(organizationId, {
        limit: BATCH,
        sortBy: { column: 'created_at', order: 'asc' },
      });

    if (listed.error) return this.skipStorage(listed.error);

    const files = (listed.data ?? []).filter((file) => file.id !== null);

    if (files.length === 0) return;

    const refs = files
      .filter((file) => FILE_NAME.test(file.name))
      .map((file) => `${UPLOAD_REGISTRY}/image@sha256:${file.name}`);
    const { data, error } = refs.length
      ? await this.client
          .from(CUSTOM_IMAGES_TABLE)
          .select('image_ref, status, checked_at')
          .eq('organization_id', organizationId)
          .eq('registry', UPLOAD_REGISTRY)
          .in('image_ref', refs)
      : { data: [], error: null };

    if (error) return this.skip('find uploaded images', error);

    const rows = new Map(
      (
        (data ?? []) as {
          image_ref: string;
          status: string;
          checked_at: string | null;
        }[]
      ).map((row) => [row.image_ref.slice(-64), row]),
    );
    const unclaimedBefore = Date.now() - UNCLAIMED_KEPT_MS;
    const stale = files.filter((file) => {
      const row = rows.get(file.name);
      const createdAt = Date.parse(file.created_at ?? '');

      if (!row) return createdAt < unclaimedBefore;
      if (row.status === 'blocked') return true;

      return (
        row.status === 'refused' &&
        (!row.checked_at || createdAt < Date.parse(row.checked_at))
      );
    });

    try {
      await removeStoredImages(
        this.client,
        stale.map((file) => `${organizationId}/${file.name}`),
      );
    } catch (failure) {
      this.logger.warn(
        `Failed to remove uploaded image files: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
    }
  }

  // Without the bucket uploads are off, which is not worth a log line every ten minutes.
  private skipStorage(error: { message: string }) {
    if (/bucket not found/i.test(error.message)) return;

    this.logger.warn(`Failed to list uploaded image files: ${error.message}`);
  }

  // Before the migration there is nothing to remove, so that alone is not worth a log line every ten minutes.
  private skip(action: string, error: { code?: string; message: string }) {
    if (MISSING_SCHEMA.has(error.code ?? '')) return;

    this.logger.warn(`Failed to ${action}: ${error.message}`);
  }
}
