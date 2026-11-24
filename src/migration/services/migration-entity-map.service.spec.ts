import { MigrationEntityMapService } from './migration-entity-map.service';
import { pageReferenceKey } from '../transformers/canonical-ir';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';

const EDV_PAGE = '11111111-2222-4333-8444-555555555555';
const DEFAULT_PAGE = '99999999-8888-4777-8666-555555555555';
const EDV_SPACE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function terminal<T>(data: T) {
  return Promise.resolve({ data, error: null });
}

function query<T>(result: T) {
  const chain = {
    select: jest.fn(),
    eq: jest.fn(),
    in: jest.fn(),
    order: jest.fn(),
    range: jest.fn(),
    limit: jest.fn(),
    maybeSingle: jest.fn(),
  };

  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.in.mockReturnValue(terminal(result));
  chain.order.mockReturnValue(chain);
  chain.range.mockReturnValue(chain);
  chain.limit.mockReturnValue(terminal(result));
  chain.maybeSingle.mockReturnValue(terminal(result));

  return chain;
}

describe('MigrationEntityMapService.resolveWikiPageTargets', () => {
  it('uses the storage ref space key to avoid routing a same-named page to DEFAULT', async () => {
    const mapRows = query([
      {
        source_id: '100',
        source_key: 'SNMP',
        target_id: EDV_PAGE,
        status: 'mapped',
        metadata: { title: 'SNMP', space_ref: 'EDV' },
      },
      {
        source_id: '200',
        source_key: 'SNMP',
        target_id: DEFAULT_PAGE,
        status: 'mapped',
        metadata: { title: 'SNMP', space_ref: 'DEFAULT' },
      },
    ]);
    const pages = query([{ id: EDV_PAGE, slug: 'snmp', space_id: EDV_SPACE }]);
    const spaces = query([{ id: EDV_SPACE, key: 'EDV' }]);
    const from = jest.fn((table: string) => {
      if (table === 'migration_entity_map') return mapRows;
      if (table === 'wiki_pages') return pages;
      if (table === 'spaces') return spaces;
      throw new Error(`unexpected table ${table}`);
    });
    const service = new MigrationEntityMapService({
      getClient: () => ({ from }),
    } as unknown as SupabaseAdminService);

    const out = await service.resolveWikiPageTargets('org', 'conn', [
      { sourceId: 'SNMP', sourceSpaceKey: 'EDV' },
    ]);

    expect(out.get(pageReferenceKey('SNMP', 'EDV'))).toEqual({
      pageId: EDV_PAGE,
      pageSlug: 'snmp',
      spaceKey: 'EDV',
      title: 'SNMP',
    });
    expect(JSON.stringify(out)).not.toContain(DEFAULT_PAGE);
  });

  it('leaves an ambiguous or missing source-space title unresolved', async () => {
    const mapRows = query([
      {
        source_id: '200',
        source_key: 'SNMP',
        target_id: DEFAULT_PAGE,
        status: 'mapped',
        metadata: { title: 'SNMP', space_ref: 'DEFAULT' },
      },
    ]);
    const from = jest.fn((table: string) => {
      if (table === 'migration_entity_map') return mapRows;
      throw new Error(`unexpected table ${table}`);
    });
    const service = new MigrationEntityMapService({
      getClient: () => ({ from }),
    } as unknown as SupabaseAdminService);

    const out = await service.resolveWikiPageTargets('org', 'conn', [
      { sourceId: 'SNMP', sourceSpaceKey: 'EDV' },
    ]);

    expect(out).toEqual(new Map());
  });
});

describe('MigrationEntityMapService.resolveIssueTargets', () => {
  it('returns only exact mapped source keys whose target task still exists', async () => {
    const issueRows = query([
      { source_key: 'XI-42', target_id: 'task-1' },
      { source_key: 'XI-404', target_id: 'task-missing' },
    ]);
    const tasks = query([{ id: 'task-1', key: 'ENG-9' }]);
    const from = jest.fn((table: string) => {
      if (table === 'migration_entity_map') return issueRows;
      if (table === 'tasks') return tasks;
      throw new Error(`unexpected table ${table}`);
    });
    const service = new MigrationEntityMapService({
      getClient: () => ({ from }),
    } as unknown as SupabaseAdminService);

    await expect(
      service.resolveIssueTargets('org', 'conn', ['XI-42', 'XI-404']),
    ).resolves.toEqual(new Map([['XI-42', { taskKey: 'ENG-9' }]]));
  });
});

describe('MigrationEntityMapService.resolveAttachmentTargets', () => {
  it('returns only exact mapped source ids whose target attachment still exists', async () => {
    const attachmentRows = query([
      { source_id: '10001', target_id: 'attachment-1' },
      { source_id: '10002', target_id: 'attachment-missing' },
    ]);
    const attachments = query([{ id: 'attachment-1' }]);
    const from = jest.fn((table: string) => {
      if (table === 'migration_entity_map') return attachmentRows;
      if (table === 'file_attachments') return attachments;
      throw new Error(`unexpected table ${table}`);
    });
    const service = new MigrationEntityMapService({
      getClient: () => ({ from }),
    } as unknown as SupabaseAdminService);

    await expect(
      service.resolveAttachmentTargets('org', 'conn', ['10001', '10002']),
    ).resolves.toEqual(new Map([['10001', { attachmentId: 'attachment-1' }]]));
  });
});

describe('MigrationEntityMapService.getExistingTarget', () => {
  const mapped = {
    id: 'map-1',
    organization_id: 'org',
    source_connection_id: 'conn',
    entity_type: 'issue',
    source_id: '10001',
    target_table: 'tasks',
    target_id: 'task-1',
    status: 'mapped',
  };

  function call(service: MigrationEntityMapService) {
    return (
      service as unknown as {
        getExistingTarget: (
          orgId: string,
          connectionId: string,
          entityType: string,
          sourceId: string,
          targetTable: 'tasks',
        ) => Promise<unknown>;
      }
    ).getExistingTarget('org', 'conn', 'issue', '10001', 'tasks');
  }

  it('returns null when the typed physical target no longer exists', async () => {
    const map = query(mapped);
    const tasks = query([]);
    const service = new MigrationEntityMapService({
      getClient: () => ({
        from: (table: string) => (table === 'tasks' ? tasks : map),
      }),
    } as unknown as SupabaseAdminService);

    await expect(call(service)).resolves.toBeNull();
  });

  it('returns the mapping when the typed physical target still exists', async () => {
    const map = query(mapped);
    const tasks = query([{ id: 'task-1' }]);
    const service = new MigrationEntityMapService({
      getClient: () => ({
        from: (table: string) => (table === 'tasks' ? tasks : map),
      }),
    } as unknown as SupabaseAdminService);

    await expect(call(service)).resolves.toEqual(mapped);
  });
});

describe('MigrationEntityMapService.inspectSpaceTarget', () => {
  const mapping = {
    id: 'map-space',
    organization_id: 'org',
    source_connection_id: 'conn',
    entity_type: 'space',
    source_id: 'DOCS',
    target_table: 'spaces',
    target_id: 'space-1',
    status: 'mapped',
    metadata: {},
  };

  it.each([
    [[{ id: 'space-1', is_archived: false }], 'active'],
    [[{ id: 'space-1', is_archived: true }], 'archived'],
    [[], 'missing'],
  ] as const)(
    'reports the physical mapped-space state',
    async (spaces, state) => {
      const map = query(mapping);
      const physical = query(spaces);
      const service = new MigrationEntityMapService({
        getClient: () => ({
          from: (table: string) => (table === 'spaces' ? physical : map),
        }),
      } as unknown as SupabaseAdminService);

      await expect(
        service.inspectSpaceTarget('org', 'conn', 'DOCS'),
      ).resolves.toEqual({ mapping, state });
    },
  );
});

describe('MigrationEntityMapService Confluence target recovery', () => {
  it('invalidates only mappings owned by the selected source space', async () => {
    const rows = [
      {
        id: 'space-map',
        entity_type: 'space',
        source_id: 'DOCS',
        target_id: 'space-deleted',
        metadata: {},
      },
      {
        id: 'page-map',
        entity_type: 'page',
        source_id: 'page-1',
        target_id: 'wiki-page-1',
        metadata: { space_ref: 'DOCS' },
      },
      {
        id: 'attachment-map',
        entity_type: 'page_attachment',
        source_id: 'page-1:file.pdf',
        target_id: 'attachment-1',
        metadata: { page_source_id: 'page-1' },
      },
      {
        id: 'comment-map',
        entity_type: 'page_comment',
        source_id: 'comment-1',
        target_id: 'comment-1',
        metadata: { page_source_id: 'page-1' },
      },
      {
        id: 'restriction-map',
        entity_type: 'page_restriction',
        source_id: 'page-1',
        target_id: 'wiki-page-1',
        metadata: {},
      },
      {
        id: 'space-watcher-map',
        entity_type: 'confluence_space_watcher',
        source_id: 'space:DOCS:account-1',
        target_id: 'space-watch-1',
        metadata: { resource_source_id: 'DOCS' },
      },
      {
        id: 'page-watcher-map',
        entity_type: 'confluence_page_watcher',
        source_id: 'page:page-1:account-1',
        target_id: 'page-watch-1',
        metadata: { resource_source_id: 'page-1' },
      },
      {
        id: 'other-page',
        entity_type: 'page',
        source_id: 'page-2',
        target_id: 'wiki-page-2',
        metadata: { space_ref: 'OTHER' },
      },
      {
        id: 'other-space-watcher',
        entity_type: 'confluence_space_watcher',
        source_id: 'space:OTHER:account-1',
        target_id: 'other-space-watch',
        metadata: { resource_source_id: 'OTHER' },
      },
      {
        id: 'other-page-watcher',
        entity_type: 'confluence_page_watcher',
        source_id: 'page:page-2:account-1',
        target_id: 'other-page-watch',
        metadata: { resource_source_id: 'page-2' },
      },
      {
        id: 'jira-issue',
        entity_type: 'issue',
        source_id: 'DOCS-1',
        target_id: 'task-1',
        metadata: {},
      },
    ];
    const selectChain = query(rows);
    const service = new MigrationEntityMapService({
      getClient: () => ({
        from: () => selectChain,
      }),
    } as unknown as SupabaseAdminService);
    const deleteExact = jest
      .spyOn(service, 'deleteExactStaleMapping')
      .mockResolvedValue(true);

    await service.recoverStaleConfluenceSpaceMappings(
      'org',
      'conn',
      'DOCS',
      'space-deleted',
    );

    const deletedIds = deleteExact.mock.calls.map((call) => call[4]);
    expect(deletedIds).toEqual(
      expect.arrayContaining([
        'space-deleted',
        'wiki-page-1',
        'attachment-1',
        'comment-1',
        'space-watch-1',
        'page-watch-1',
      ]),
    );
    expect(deletedIds).not.toEqual(
      expect.arrayContaining([
        'wiki-page-2',
        'other-space-watch',
        'other-page-watch',
        'task-1',
      ]),
    );
    expect(deleteExact.mock.calls.at(-1)).toEqual([
      'org',
      'conn',
      'space',
      'DOCS',
      'space-deleted',
    ]);
  });

  it('deletes one stale mapping only when its target id still matches', async () => {
    const calls: Array<[string, unknown]> = [];
    const chain = {
      delete: () => chain,
      eq: (column: string, value: unknown) => {
        calls.push([column, value]);
        return chain;
      },
      select: () => chain,
      maybeSingle: () => terminal({ id: 'map-1' }),
    };
    const service = new MigrationEntityMapService({
      getClient: () => ({ from: () => chain }),
    } as unknown as SupabaseAdminService);

    await expect(
      service.deleteExactStaleMapping(
        'org',
        'conn',
        'page',
        'page-1',
        'wiki-page-deleted',
      ),
    ).resolves.toBe(true);
    expect(calls).toEqual(
      expect.arrayContaining([
        ['organization_id', 'org'],
        ['source_connection_id', 'conn'],
        ['entity_type', 'page'],
        ['source_id', 'page-1'],
        ['target_id', 'wiki-page-deleted'],
      ]),
    );
  });

  it('validates a wiki page in its expected space and child ownership', async () => {
    const pageMap = query({
      id: 'map-page',
      entity_type: 'page',
      source_id: 'page-1',
      target_table: 'wiki_pages',
      target_id: 'wiki-page-1',
      status: 'mapped',
    });
    const page = query([{ id: 'wiki-page-1', space_id: 'space-1' }]);
    const attachmentMap = query({
      id: 'map-attachment',
      entity_type: 'page_attachment',
      source_id: 'page-1:file.pdf',
      target_table: 'wiki_page_attachments',
      target_id: 'attachment-1',
      status: 'mapped',
    });
    const attachment = query([
      { id: 'attachment-1', wiki_page_id: 'wiki-page-1' },
    ]);
    let mapLookup = 0;
    const from = (table: string) => {
      if (table === 'migration_entity_map') {
        return mapLookup++ === 0 ? pageMap : attachmentMap;
      }
      if (table === 'wiki_pages') return page;
      if (table === 'wiki_page_attachments') return attachment;
      throw new Error(`unexpected table ${table}`);
    };
    const service = new MigrationEntityMapService({
      getClient: () => ({ from }),
    } as unknown as SupabaseAdminService);

    await expect(
      service.getExistingWikiPageTarget('org', 'conn', 'page-1', 'space-1'),
    ).resolves.toEqual(expect.objectContaining({ target_id: 'wiki-page-1' }));
    await expect(
      service.getExistingWikiChildTarget(
        'org',
        'conn',
        'page_attachment',
        'page-1:file.pdf',
        'wiki_page_attachments',
        'wiki-page-1',
      ),
    ).resolves.toEqual(expect.objectContaining({ target_id: 'attachment-1' }));
    expect(page.eq).toHaveBeenCalledWith('organization_id', 'org');
    expect(page.eq).toHaveBeenCalledWith('is_archived', false);
    expect(page.eq).toHaveBeenCalledWith('space_id', 'space-1');
    expect(attachment.eq).toHaveBeenCalledWith('wiki_page_id', 'wiki-page-1');
  });
});

describe('MigrationEntityMapService.recoverStaleSpaceMappings', () => {
  it('invalidates only project-owned mappings for this job and connection', async () => {
    const calls: Array<{ column: string; value: unknown }> = [];
    let invalidated: string[] = [];
    const chain = {
      delete: () => chain,
      eq: (column: string, value: unknown) => {
        calls.push({ column, value });
        return chain;
      },
      in: (_column: string, values: string[]) => {
        invalidated = values;
        return Promise.resolve({ error: null });
      },
    };
    const service = new MigrationEntityMapService({
      getClient: () => ({ from: () => chain }),
    } as unknown as SupabaseAdminService);

    await (
      service as unknown as {
        recoverStaleSpaceMappings: (
          orgId: string,
          connectionId: string,
          jobId: string,
        ) => Promise<void>;
      }
    ).recoverStaleSpaceMappings('org', 'conn', 'job');

    expect(calls).toEqual([
      { column: 'organization_id', value: 'org' },
      { column: 'source_connection_id', value: 'conn' },
      { column: 'job_id', value: 'job' },
    ]);
    expect(invalidated).toEqual(
      expect.arrayContaining([
        'space',
        'role',
        'issue_type',
        'field_group',
        'workflow',
        'workflow_assignment',
        'issue',
        'board',
        'board_card',
        'sprint',
        'link',
        'comment',
        'attachment',
        'history',
      ]),
    );
    expect(invalidated).not.toEqual(
      expect.arrayContaining([
        'user',
        'user_group',
        'priority',
        'resolution',
        'status_category',
        'task_status',
        'custom_field',
      ]),
    );
  });
});

describe('MigrationEntityMapService.getExistingCustomFieldTarget', () => {
  const mapping = {
    id: 'map-field',
    organization_id: 'org',
    source_connection_id: 'conn',
    entity_type: 'custom_field',
    source_id: 'customfield_10001',
    target_table: 'custom_fields',
    target_id: 'jira_field_key',
    status: 'mapped',
    metadata: { custom_field_id: 'field-uuid' },
  };

  it('keeps a live shared field but drops a mapping whose physical field is gone', async () => {
    for (const [fields, expected] of [
      [[{ id: 'field-uuid' }], mapping],
      [[], null],
    ] as const) {
      const map = query(mapping);
      const customFields = query(fields);
      const service = new MigrationEntityMapService({
        getClient: () => ({
          from: (table: string) =>
            table === 'custom_fields' ? customFields : map,
        }),
      } as unknown as SupabaseAdminService);

      await expect(
        service.getExistingCustomFieldTarget(
          'org',
          'conn',
          'customfield_10001',
        ),
      ).resolves.toEqual(expected);
    }
  });

  it('preserves native and skipped decisions that have no physical row', async () => {
    const native = {
      ...mapping,
      target_table: null,
      target_id: 'native:sprint',
    };
    const map = query(native);
    const service = new MigrationEntityMapService({
      getClient: () => ({ from: () => map }),
    } as unknown as SupabaseAdminService);

    await expect(
      service.getExistingCustomFieldTarget('org', 'conn', 'customfield_10001'),
    ).resolves.toEqual(native);
  });
});
