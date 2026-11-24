/**
 * @fileoverview Copying stored objects: every source, each object once.
 * @module src/backup/engine/backup-worker.files.spec
 *
 * `attachments` is one component over six tables and five buckets, so the worker has to walk all of
 * a component's sources rather than the first — asking for one is what left task, process, GDPR,
 * list and asset-object attachments out of every archive while their rows went in.
 *
 * Walking several sources introduces the opposite risk: two tables can name the same object, and
 * appending it twice puts a duplicate entry in the zip and downloads the bytes twice.
 */

import { Readable } from 'node:stream';
import { BackupWorkerService } from './backup-worker.service';
import type {
  BackupStorageService,
  StorageSource,
} from './backup-storage.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { TableExporterService } from './table-exporter.service';
import type { BackupSecretsService } from '../services/backup-secrets.service';
import type { SftpTargetAdapter } from '../adapters/sftp/sftp.adapter';
import type { BackupArchiveCipherService } from '../services/backup-archive-cipher.service';
import type { BackupSpoolService } from './backup-spool.service';

type Opened = { object: { bucket: string; path: string; bytes: number } };

function source(table: string, bucket: string): StorageSource {
  return {
    component: 'attachments',
    table,
    pathColumn: 'file_path',
    tenantColumn: 'organization_id',
    buckets: [bucket],
  };
}

function harness(options: {
  sources: StorageSource[];
  paths: Record<string, string[]>;
  /** Paths storage does not hold. */
  absent?: string[];
  bytes?: number;
}) {
  const appended: string[] = [];
  const opens: string[] = [];

  const archive = {
    append: (_body: unknown, opts: { name: string }) => {
      appended.push(opts.name);
    },
  };

  const storage = {
    sourcesFor: (component: string) =>
      options.sources.filter((s) => s.component === component),
    collectPaths: (_org: string, src: StorageSource) =>
      Promise.resolve(options.paths[src.table] ?? []),
    open: (src: StorageSource, path: string): Promise<Opened | null> => {
      opens.push(`${src.table}:${path}`);

      if (options.absent?.includes(path)) {
        return Promise.resolve(null);
      }

      return Promise.resolve({
        object: {
          bucket: src.buckets[0],
          path,
          bytes: options.bytes ?? 10,
        },
        // Consumed by the worker when the entry is a duplicate, appended otherwise.
        body: Readable.from([Buffer.from('x')]),
      } as Opened);
    },
  } as unknown as BackupStorageService;

  const service = new BackupWorkerService(
    {} as unknown as SupabaseAdminService,
    {} as unknown as TableExporterService,
    {} as unknown as BackupSecretsService,
    {} as unknown as SftpTargetAdapter,
    {} as unknown as BackupArchiveCipherService,
    {} as unknown as BackupSpoolService,
    storage,
  );

  /** copyStoredObjects is private; what it puts in the archive is the behaviour under test. */
  const copy = (component: string) =>
    (
      service as unknown as {
        copyStoredObjects: (
          a: unknown,
          c: string,
          o: string,
        ) => Promise<{ copied: number; missing: string[] }>;
      }
    ).copyStoredObjects(archive, component, 'org-1');

  return { appended, opens, copy };
}

describe('copying stored objects', () => {
  it('copies from every source of a component, not just the first', async () => {
    const { appended, copy } = harness({
      sources: [
        source('task_attachments', 'task-attachments'),
        source('process_attachments', 'process-attachments'),
        source('gdpr_record_attachments', 'gdpr-attachments'),
      ],
      paths: {
        task_attachments: ['a.pdf'],
        process_attachments: ['b.pdf'],
        gdpr_record_attachments: ['c.pdf'],
      },
    });

    const result = await copy('attachments');

    expect(appended).toEqual([
      'files/task-attachments/a.pdf',
      'files/process-attachments/b.pdf',
      'files/gdpr-attachments/c.pdf',
    ]);
    expect(result).toEqual({ copied: 3, missing: [] });
  });

  it('appends an object named by two tables only once', async () => {
    const { appended, copy } = harness({
      sources: [
        source('task_attachments', 'attachments'),
        source('file_versions', 'attachments'),
      ],
      paths: {
        task_attachments: ['shared.pdf'],
        file_versions: ['shared.pdf'],
      },
    });

    const result = await copy('attachments');

    // Same bucket and path, so the same archive entry. A second append would produce a zip with
    // two members of one name.
    expect(appended).toEqual(['files/attachments/shared.pdf']);
    expect(result.copied).toBe(1);
  });

  it('keeps an object that two buckets happen to share', async () => {
    const { appended, copy } = harness({
      sources: [
        source('task_attachments', 'task-attachments'),
        source('gdpr_record_attachments', 'gdpr-attachments'),
      ],
      paths: {
        task_attachments: ['same-name.pdf'],
        gdpr_record_attachments: ['same-name.pdf'],
      },
    });

    // Different buckets are different objects, and the archive path keeps them apart.
    await copy('attachments');

    expect(appended).toEqual([
      'files/task-attachments/same-name.pdf',
      'files/gdpr-attachments/same-name.pdf',
    ]);
  });

  it('records a missing object and keeps going through the remaining sources', async () => {
    const { appended, copy } = harness({
      sources: [
        source('task_attachments', 'task-attachments'),
        source('process_attachments', 'process-attachments'),
      ],
      paths: {
        task_attachments: ['gone.pdf'],
        process_attachments: ['here.pdf'],
      },
      absent: ['gone.pdf'],
    });

    const result = await copy('attachments');

    // A row pointing at a deleted object is the tenant's pre-existing inconsistency. Stopping
    // would let it block every future backup of everything else.
    expect(result).toEqual({ copied: 1, missing: ['gone.pdf'] });
    expect(appended).toEqual(['files/process-attachments/here.pdf']);
  });

  it('refuses an object above the per-file limit', async () => {
    const { copy } = harness({
      sources: [source('task_attachments', 'task-attachments')],
      paths: { task_attachments: ['huge.bin'] },
      bytes: Number.MAX_SAFE_INTEGER,
    });

    await expect(copy('attachments')).rejects.toThrow(/per-file limit/);
  });

  it('does nothing for a component that stores no files', async () => {
    const { appended, opens, copy } = harness({
      sources: [source('task_attachments', 'task-attachments')],
      paths: { task_attachments: ['a.pdf'] },
    });

    const result = await copy('tasks');

    expect(result).toEqual({ copied: 0, missing: [] });
    expect(appended).toEqual([]);
    expect(opens).toEqual([]);
  });
});
