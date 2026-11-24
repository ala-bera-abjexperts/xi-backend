/**
 * @fileoverview Locks the storage source table against the registry and against a tenant leak.
 * @module src/backup/engine/backup-storage.service.spec
 *
 * Two failures these guard against, both silent:
 *
 *   - A source with no tenant filter. Buckets are shared by every organization, so a source that
 *     is neither scoped by its own tenant column nor through a parent reads every tenant's paths
 *     and puts their files in one tenant's archive.
 *   - Bytes with no metadata. A source whose table is not in COMPONENT_REGISTRY copies the file
 *     into the archive while the row naming it stays behind, and a restore cannot place it.
 */

import {
  BackupStorageService,
  STORAGE_SOURCES,
} from './backup-storage.service';
import { COMPONENT_REGISTRY, tableEntry } from '../registry/component-registry';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';

const service = new BackupStorageService({
  getClient: () => ({}),
} as unknown as SupabaseAdminService);

describe('storage sources', () => {
  it('scopes every source by exactly one of tenant column or parent', () => {
    for (const source of STORAGE_SOURCES) {
      const scopes = [source.tenantColumn, source.parent].filter(Boolean);

      // Zero means an unfiltered read across every tenant. Two means two conflicting filters.
      expect({ table: source.table, scopes: scopes.length }).toEqual({
        table: source.table,
        scopes: 1,
      });
    }
  });

  it('backs up the row behind every file it copies', () => {
    for (const source of STORAGE_SOURCES) {
      // The path column lives on this table, so without the table in the registry the archive
      // holds bytes that nothing names.
      expect({
        table: source.table,
        registered: !!tableEntry(source.table),
      }).toEqual({
        table: source.table,
        registered: true,
      });
    }
  });

  it('files every source under the component its table belongs to', () => {
    for (const source of STORAGE_SOURCES) {
      const entry = COMPONENT_REGISTRY.find((e) => e.table === source.table);

      // A mismatch means the worker never asks for these files: it looks them up by the
      // component being exported, not by table.
      expect({ table: source.table, component: source.component }).toEqual({
        table: source.table,
        component: entry?.component,
      });
    }
  });

  it('names at least one bucket per source, with no blanks or duplicates', () => {
    for (const source of STORAGE_SOURCES) {
      expect(source.buckets.length).toBeGreaterThan(0);
      expect(source.buckets.every((b) => b.trim().length > 0)).toBe(true);
      expect(new Set(source.buckets).size).toBe(source.buckets.length);
    }
  });

  it('lists one source per table', () => {
    const tables = STORAGE_SOURCES.map((s) => s.table);

    // A duplicate would copy every one of that table's objects twice.
    expect(new Set(tables).size).toBe(tables.length);
  });

  it('covers every attachment table that records a file path', () => {
    // Snapshot from the live catalog, 2026-08-05: public base tables with a file_path column.
    // wiki_pages.path is a page hierarchy path, not a stored object, and is excluded.
    //
    // +1: whiteboard_files, migration 20260925120100_whiteboards.sql. It spells the column
    // `storage_path` rather than `file_path`, so the query above does not find it; listed by hand.
    //
    // +2: test_automation_configs (`zip_path`) and test_automation_user_images (path built from the
    // organization and digest), listed by hand for the same reason.
    const PATH_BEARING_TABLES = [
      'asset_item_attachments',
      'asset_object_attachments',
      'fe_versions',
      'file_versions',
      'gdpr_record_attachments',
      'process_attachments',
      'task_attachments',
      'test_automation_configs',
      'test_automation_user_images',
      'whiteboard_files',
      'wiki_attachments',
      'wiki_page_attachments',
    ];

    expect(STORAGE_SOURCES.map((s) => s.table).sort()).toEqual(
      PATH_BEARING_TABLES,
    );
  });
});

describe('sourcesFor', () => {
  it('returns every source for a component that has several', () => {
    const attachments = service.sourcesFor('attachments');

    // Six tables, six buckets. Returning only the first is what left task attachments behind.
    expect(attachments.map((s) => s.table).sort()).toEqual([
      'asset_item_attachments',
      'asset_object_attachments',
      'file_versions',
      'gdpr_record_attachments',
      'process_attachments',
      'task_attachments',
    ]);
  });

  it('returns both wiki attachment tables', () => {
    expect(
      service
        .sourcesFor('wiki')
        .map((s) => s.table)
        .sort(),
    ).toEqual(['wiki_attachments', 'wiki_page_attachments']);
  });

  it('returns nothing for a component that stores no files', () => {
    expect(service.sourcesFor('tasks')).toEqual([]);
    expect(service.sourcesFor('not_a_component')).toEqual([]);
  });
});

describe('collectPaths', () => {
  it('refuses a source with no tenant scope rather than reading every tenant', () => {
    return expect(
      service.collectPaths('org-1', {
        component: 'attachments',
        table: 'task_attachments',
        pathColumn: 'file_path',
        buckets: ['task-attachments'],
      }),
    ).rejects.toThrow(/must be scoped by exactly one/);
  });

  it('refuses a source scoped two ways at once', () => {
    return expect(
      service.collectPaths('org-1', {
        component: 'attachments',
        table: 'task_attachments',
        pathColumn: 'file_path',
        tenantColumn: 'organization_id',
        parent: {
          table: 'tasks',
          tenantColumn: 'organization_id',
          column: 'task_id',
        },
        buckets: ['task-attachments'],
      }),
    ).rejects.toThrow(/must be scoped by exactly one/);
  });
});

describe('automation files', () => {
  const imageSource = STORAGE_SOURCES.find(
    (source) => source.table === 'test_automation_user_images',
  );

  it('stores an uploaded image under its organization and digest', () => {
    expect(
      imageSource?.buildPath?.build({
        organization_id: 'org-1',
        digest: 'sha256:abc',
        registry: 'upload',
      }),
    ).toBe('org-1/abc');
  });

  it('has no stored file for an image pulled from a registry', () => {
    expect(
      imageSource?.buildPath?.build({
        organization_id: 'org-1',
        digest: 'sha256:abc',
        registry: 'docker.io',
      }),
    ).toBeNull();
  });
});
