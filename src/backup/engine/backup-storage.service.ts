/**
 * @fileoverview Copies an organization's stored objects into the archive.
 * @module src/backup/engine/backup-storage.service
 *
 * ## Where the object list comes from
 *
 * NOT from listing buckets. A bucket is shared by every tenant, so listing one and filtering by a
 * path prefix would make tenant isolation depend on a naming convention — one malformed path away
 * from putting another organization's files in this archive.
 *
 * Instead the list comes from the version tables (`fe_versions`, `file_versions`), which record the
 * exact object path for every file and are themselves reached only through an org-scoped parent.
 * Verified against live data: `fe_versions.file_path` is byte-identical to `storage.objects.name`.
 * If a path is not referenced by a row this organization owns, it is not in the archive.
 *
 * That ordering also matters for correctness: those version tables were invisible to the registry
 * until recently, so an archive could contain a file's bytes with no row saying which file it was.
 * Bytes without their metadata are unrestorable, which is why the metadata landed first.
 *
 * ## What a missing object does
 *
 * It is recorded and the run continues. A row pointing at an object that storage no longer holds is
 * a pre-existing inconsistency in the tenant's data, not a fault in the backup — failing the run
 * would mean one stale reference blocks every future backup, and the correct archive of everything
 * else is worth having. The count surfaces on the run rather than being swallowed.
 */

import { Readable } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import {
  IMAGE_BUCKET,
  UPLOAD_REGISTRY,
  uploadPath,
} from '../../test-management/automation/custom-images/upload/storage/custom-image-storage';

/**
 * Where an organization's stored objects are recorded.
 *
 * Adding a bucket is one entry here. `buckets` is ordered: the attachments service still reads a
 * legacy bucket for older rows, so a path is looked for in each until one has it.
 */
export interface StorageSource {
  /** Component key the files belong to, matching the registry. */
  component: string;
  /** Table holding the object paths. */
  table: string;
  /** Column on that table holding the full object path. */
  pathColumn: string;
  /**
   * For a table that stores no path of its own: the columns to read and how the path is built from
   * them. A null result means the row has no stored file.
   */
  buildPath?: {
    columns: string[];
    build: (row: Record<string, unknown>) => string | null;
  };
  /**
   * Set when the table carries its own tenant column and is filtered on it directly.
   *
   * Exactly one of this and `parent` must be set. Neither would mean no tenant filter at all, and
   * a bucket is shared by every organization — see the guard in collectPaths.
   */
  tenantColumn?: 'organization_id' | 'organizationid';
  /** Set instead when the table has no tenant column and is narrowed through its parent. */
  parent?: {
    table: string;
    tenantColumn: 'organization_id' | 'organizationid';
    /**
     * FK column on THIS table pointing at the parent, naming which relationship to join on.
     *
     * Required for the same reason the exporter needs it: `fe_nodes` points back at `fe_versions`
     * through `current_version_id`, and `file_attachments` back at `file_versions` the same way, so
     * two relationships link each pair and an unhinted embed is rejected with PGRST201. Without
     * this, collecting paths fails and the binary files of the file_explorer and attachments
     * components are silently absent from the archive.
     */
    column: string;
  };
  /** Candidate buckets, most likely first. */
  buckets: string[];
}

/**
 * One entry per table that records a stored object path, with the bucket its own service writes to.
 *
 * Buckets are taken from the service that owns each feature, not guessed: `task-attachments` from
 * tasks-attachments.service.ts, `process-attachments` from processes-attachments.service.ts,
 * `gdpr-attachments` from gdpr.service.ts, `list-attachments` from assets-attachments.service.ts,
 * `asset-object-attachments` from asset-object-attachments.service.ts, and `wiki-attachments` from
 * wiki.service.ts. Where a feature has moved bucket, both are listed newest-first and `open` tries
 * each — `attachments.service.ts` still falls back to `task-attachments` for older rows.
 *
 * Two known omissions, left out deliberately rather than guessed at:
 *
 *   - Form-builder submission uploads. form-builder-uploads.service.ts returns the path to the
 *     client, which stores it inside the submission's JSON payload. There is no path column to
 *     read, and picking values out of arbitrary JSON would either miss files or pick up strings
 *     that are not paths.
 *   - space_gdpr_record_attachments.filepath. The legacy space-GDPR tables have no writer left in
 *     the backend, so which bucket holds those objects cannot be established from the code. Their
 *     rows are archived; their bytes are not.
 */
export const STORAGE_SOURCES: StorageSource[] = [
  {
    component: 'file_explorer',
    table: 'fe_versions',
    pathColumn: 'file_path',
    parent: {
      table: 'fe_nodes',
      tenantColumn: 'organization_id',
      column: 'node_id',
    },
    buckets: ['file-explorer'],
  },
  {
    component: 'attachments',
    table: 'file_versions',
    pathColumn: 'file_path',
    parent: {
      table: 'file_attachments',
      tenantColumn: 'organization_id',
      column: 'attachment_id',
    },
    buckets: ['attachments', 'task-attachments'],
  },
  {
    component: 'attachments',
    table: 'task_attachments',
    pathColumn: 'file_path',
    tenantColumn: 'organization_id',
    buckets: ['task-attachments', 'attachments'],
  },
  {
    component: 'attachments',
    table: 'process_attachments',
    pathColumn: 'file_path',
    tenantColumn: 'organization_id',
    buckets: ['process-attachments'],
  },
  {
    component: 'attachments',
    table: 'gdpr_record_attachments',
    pathColumn: 'file_path',
    tenantColumn: 'organization_id',
    buckets: ['gdpr-attachments'],
  },
  {
    component: 'attachments',
    table: 'asset_item_attachments',
    pathColumn: 'file_path',
    tenantColumn: 'organization_id',
    buckets: ['list-attachments'],
  },
  {
    component: 'attachments',
    table: 'asset_object_attachments',
    pathColumn: 'file_path',
    tenantColumn: 'organization_id',
    buckets: ['asset-object-attachments'],
  },
  {
    component: 'wiki',
    table: 'wiki_attachments',
    pathColumn: 'file_path',
    parent: {
      table: 'wiki_pages',
      tenantColumn: 'organization_id',
      column: 'wiki_page_id',
    },
    buckets: ['wiki-attachments'],
  },
  {
    component: 'wiki',
    table: 'wiki_page_attachments',
    pathColumn: 'file_path',
    parent: {
      table: 'wiki_pages',
      tenantColumn: 'organization_id',
      column: 'wiki_page_id',
    },
    buckets: ['wiki-attachments'],
  },
  {
    // Own `organization_id`, pinned to the parent whiteboard's by the composite FK, so it is filtered
    // directly. Path is `{space_id}/{whiteboard_id}/{file_id}`; bucket from whiteboards.constants.ts.
    component: 'whiteboards',
    table: 'whiteboard_files',
    pathColumn: 'storage_path',
    tenantColumn: 'organization_id',
    buckets: ['whiteboard-files'],
  },
  {
    // An automation setting's uploaded test project; bucket from test-automation-configs.service.ts.
    component: 'test_automation',
    table: 'test_automation_configs',
    pathColumn: 'zip_path',
    tenantColumn: 'organization_id',
    buckets: ['attachments'],
  },
  {
    // Only images uploaded as a file are stored; registry images are pulled again by digest.
    component: 'test_automation',
    table: 'test_automation_user_images',
    pathColumn: 'digest',
    tenantColumn: 'organization_id',
    buildPath: {
      columns: ['organization_id', 'digest', 'registry'],
      build: (row) =>
        row.registry === UPLOAD_REGISTRY &&
        typeof row.organization_id === 'string' &&
        typeof row.digest === 'string'
          ? uploadPath(row.organization_id, row.digest)
          : null,
    },
    buckets: [IMAGE_BUCKET],
  },
];

/** Rows read per page when collecting paths. Matches the table exporter. */
const PATH_PAGE_SIZE = 500;

export interface StoredObject {
  bucket: string;
  path: string;
  bytes: number;
}

export interface StorageCopyResult {
  copied: number;
  bytes: number;
  /** Paths a row referenced but storage did not hold. */
  missing: string[];
}

@Injectable()
export class BackupStorageService {
  private readonly logger = new Logger(BackupStorageService.name);

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Every source for one component; empty when the component stores no files.
   *
   * A component can have several: `attachments` covers six tables, each with its own bucket, and
   * `wiki` has both the current and legacy attachment tables.
   */
  sourcesFor(component: string): StorageSource[] {
    return STORAGE_SOURCES.filter((source) => source.component === component);
  }

  /**
   * Every object path this organization owns for one source.
   *
   * Paged and de-duplicated: two versions of a file can point at the same object, and copying it
   * twice would both waste bandwidth and produce a duplicate archive entry.
   */
  async collectPaths(
    organizationId: string,
    source: StorageSource,
  ): Promise<string[]> {
    // Without one of these there is no tenant filter, and every bucket is shared by every
    // organization — the read would collect other tenants' object paths and the archive would
    // carry their files. Refused rather than defaulted.
    if (!source.tenantColumn === !source.parent) {
      throw new Error(
        `${source.table} must be scoped by exactly one of tenantColumn or parent before its ` +
          'files can be collected.',
      );
    }

    const seen = new Set<string>();
    const columns = source.buildPath
      ? source.buildPath.columns.join(', ')
      : source.pathColumn;
    let from = 0;

    for (;;) {
      const scoped = source.parent
        ? this.db
            .from(source.table)
            // The `!column` hint names which foreign key to join on, matching the table exporter
            // and the restore preflight. Two of the four parent-scoped sources here are linked to
            // their parent by more than one FK, so an unhinted embed is answered with 300/PGRST201
            // and the component's binary files never reach the archive.
            .select(
              `${columns}, ${source.parent.table}!${source.parent.column}!inner(${source.parent.tenantColumn})`,
            )
            .eq(
              `${source.parent.table}.${source.parent.tenantColumn}`,
              organizationId,
            )
        : this.db
            .from(source.table)
            .select(columns)
            .eq(source.tenantColumn!, organizationId);

      const { data, error } = (await scoped
        .order('id', { ascending: true })
        .range(from, from + PATH_PAGE_SIZE - 1)) as unknown as {
        data: Record<string, unknown>[] | null;
        error: { message: string } | null;
      };

      if (error) {
        throw new Error(
          `Could not list stored files for ${source.component}: ${error.message}`,
        );
      }

      const rows = data ?? [];

      for (const row of rows) {
        const path = source.buildPath
          ? source.buildPath.build(row)
          : row[source.pathColumn];

        if (typeof path === 'string' && path.length) {
          seen.add(path);
        }
      }

      if (rows.length < PATH_PAGE_SIZE) {
        break;
      }

      from += PATH_PAGE_SIZE;
    }

    return [...seen];
  }

  /**
   * Downloads one object, trying each candidate bucket in order.
   *
   * @returns The object and a stream of its bytes, or null when no bucket holds it.
   */
  async open(
    source: StorageSource,
    path: string,
  ): Promise<{ object: StoredObject; body: Readable } | null> {
    for (const bucket of source.buckets) {
      const { data, error } = await this.db.storage.from(bucket).download(path);

      if (error || !data) {
        continue;
      }

      return {
        object: { bucket, path, bytes: data.size },
        // The Blob is already materialised by download(), so peak memory is one object. The
        // per-file cap in the worker is what keeps that bounded.
        body: Readable.fromWeb(data.stream() as never),
      };
    }

    return null;
  }
}
