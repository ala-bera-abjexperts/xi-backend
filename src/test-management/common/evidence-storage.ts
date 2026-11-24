import type { Logger } from '@nestjs/common';

import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { TestManagementAttachmentType } from '../access/test-management-attachment-access.service';

// Test Management evidence lives in the private attachments bucket.
const EVIDENCE_BUCKET = 'attachments';
const REMOVE_CHUNK = 100;

export interface StorageCleanup {
  removed: number;
  failed: number;
}

/**
 * Removes evidence files whose rows a delete function already removed. A failure is logged with its
 * paths and counted, so the response says honestly what is left in storage; paths never leave the server.
 */
export async function removeEvidenceFiles(
  client: ReturnType<SupabaseAdminService['getClient']>,
  logger: Logger,
  paths: string[],
  context: string,
): Promise<StorageCleanup> {
  const cleanup: StorageCleanup = { removed: 0, failed: 0 };

  for (let i = 0; i < paths.length; i += REMOVE_CHUNK) {
    const chunk = paths.slice(i, i + REMOVE_CHUNK);

    try {
      const { error } = await client.storage
        .from(EVIDENCE_BUCKET)
        .remove(chunk);

      if (error) throw error;

      cleanup.removed += chunk.length;
    } catch (error: unknown) {
      cleanup.failed += chunk.length;
      logger.error(
        `${context}: evidence storage cleanup failed for ${chunk.join(', ')}`,
        error,
      );
    }
  }

  return cleanup;
}

/**
 * Removes File Explorer link rows of deleted Test Management rows; entity_file_links has no foreign key
 * to them. A failure is only logged: the linked files stay in File Explorer, just the pointer rows remain.
 */
export async function removeEvidenceFileLinks(
  client: ReturnType<SupabaseAdminService['getClient']>,
  logger: Logger,
  organizationId: string,
  entityType: TestManagementAttachmentType,
  entityIds: string[],
  context: string,
): Promise<void> {
  for (let i = 0; i < entityIds.length; i += REMOVE_CHUNK) {
    const chunk = entityIds.slice(i, i + REMOVE_CHUNK);

    try {
      const { error } = await client
        .from('entity_file_links')
        .delete()
        .eq('organization_id', organizationId)
        .eq('entity_type', entityType)
        .in('entity_id', chunk);

      if (error) throw error;
    } catch (error: unknown) {
      logger.error(
        `${context}: file link cleanup failed for ${entityType} ${chunk.join(', ')}`,
        error,
      );
    }
  }
}

/** Removes the files and File Explorer links of deleted rows; those are already gone, so a failure only warns. */
export async function removeRecordFiles(
  client: ReturnType<SupabaseAdminService['getClient']>,
  logger: Logger,
  organizationId: string,
  entityType: TestManagementAttachmentType,
  entityIds: string[],
  context: string,
): Promise<StorageCleanup> {
  if (entityIds.length === 0) return { removed: 0, failed: 0 };

  try {
    const { data, error } = await client
      .from('file_attachments')
      .select(
        'id, versions:file_versions!file_versions_attachment_id_fkey(file_path)',
      )
      .eq('organization_id', organizationId)
      .eq('entity_type', entityType)
      .in('entity_id', entityIds);

    if (error) throw error;

    const rows = (data ?? []) as unknown as {
      id: string;
      versions: { file_path: string }[] | null;
    }[];
    let cleanup: StorageCleanup = { removed: 0, failed: 0 };

    if (rows.length) {
      const { error: deleteError } = await client
        .from('file_attachments')
        .delete()
        .eq('organization_id', organizationId)
        .in(
          'id',
          rows.map((row) => row.id),
        );

      if (deleteError) throw deleteError;

      cleanup = await removeEvidenceFiles(
        client,
        logger,
        rows.flatMap((row) => (row.versions ?? []).map((v) => v.file_path)),
        context,
      );
    }

    await removeEvidenceFileLinks(
      client,
      logger,
      organizationId,
      entityType,
      entityIds,
      context,
    );

    return cleanup;
  } catch (error) {
    logger.warn(
      `${context}: could not remove the files: ${(error as { message?: string } | null)?.message ?? String(error)}`,
    );

    return { removed: 0, failed: 0 };
  }
}
