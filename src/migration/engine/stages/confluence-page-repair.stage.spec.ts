jest.mock('../../mappers/page.mapper', () => ({ PageMapper: class {} }));

import {
  ConfluencePageRepairStage,
  isPriorMigrationRepair,
} from './confluence-page-repair.stage';

describe('isPriorMigrationRepair', () => {
  it('recognizes a page timestamp written by the completed repair item', () => {
    expect(
      isPriorMigrationRepair(
        '2026-08-20T14:52:56.370Z',
        '2026-08-20T14:52:55.456Z',
        '2026-08-20T14:52:56.383Z',
      ),
    ).toBe(true);
  });

  it('does not mistake a later user edit for a migration repair', () => {
    expect(
      isPriorMigrationRepair(
        '2026-08-20T14:53:00.000Z',
        '2026-08-20T14:52:55.456Z',
        '2026-08-20T14:52:56.383Z',
      ),
    ).toBe(false);
  });
});
import type { StageContext } from './stage.interface';

const pageId = '11111111-2222-4333-8444-555555555555';
const finishedAt = '2026-08-19T10:00:00.000Z';

function repairHarness(pageUpdatedAt: string) {
  const content = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep edited prose' }] }] });
  const repairProfileMacros = jest.fn().mockResolvedValue(JSON.stringify({ ...JSON.parse(content), content: [...JSON.parse(content).content, { type: 'profilePicture', attrs: { userId: pageId } }] }));
  const renderTipTap = jest.fn().mockResolvedValue({
    content: JSON.stringify({ type: 'doc', content: [] }),
    needsRelink: true,
    excerptContent: JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Excerpt body' }],
        },
      ],
    }),
  });
  const updatePage = jest.fn().mockResolvedValue({});
  const updates: Record<string, unknown>[] = [];
  const mappingFilters: [string, unknown][] = [];
  const mappingQueries: Array<{
    select?: string;
    filters: Array<[string, unknown]>;
  }> = [];
  let migrationRunsLookups = 0;
  const db = {
    from(table: string) {
      let patch: Record<string, unknown> | undefined;
      let selected = false;
      const mappingQuery = { filters: [] as Array<[string, unknown]> } as {
        select?: string;
        filters: Array<[string, unknown]>;
      };
      if (table === 'migration_entity_map') mappingQueries.push(mappingQuery);
      const result = () => {
        if (table === 'migration_runs') {
          migrationRunsLookups += 1;
          return migrationRunsLookups === 1
            ? { data: { finished_at: finishedAt }, error: null }
            : { data: [], error: null };
        }
        if (table === 'migration_run_items') return { data: [], error: null };
        if (table === 'wiki_pages')
          return {
            data: {
              id: pageId,
              space_id: 'space-1',
              updated_at: pageUpdatedAt,
              content, content_format: 'tiptap',
            },
            error: null,
          };
        if (table === 'spaces') return { data: { key: 'EDV1' }, error: null };
        if (table === 'migration_entity_map') {
          if (patch) updates.push(patch);
          if (selected)
            return mappingQuery.select === 'target_id, metadata'
              ? {
                  data: [
                    {
                      source_id: 'child-source-id',
                      target_id: 'child-page-id',
                      metadata: { title: 'Child page', space_ref: 'EDV' },
                    },
                  ],
                  error: null,
                }
              : {
                  data: [
                    {
                      source_id: 'child-source-id',
                      target_id: 'child-page-id',
                      metadata: { title: 'Child page', space_ref: 'EDV' },
                    },
                    {
                      source_id: 'ops-source-id',
                      target_id: 'ops-page-id',
                      metadata: { title: 'Child page', space_ref: 'OPS' },
                    },
                  ],
                  error: null,
                };
          return { data: null, error: null };
        }
        throw new Error(`Unexpected table: ${table}`);
      };
      const chain: any = {
        select: (selection: string) => {
          selected = true;
          mappingQuery.select = selection;
          return chain;
        },
        update: (next: Record<string, unknown>) => {
          patch = next;
          return chain;
        },
        eq: (field: string, value: unknown) => {
          if (table === 'migration_entity_map')
            mappingFilters.push([field, value]);
          if (table === 'migration_entity_map')
            mappingQuery.filters.push([field, value]);
          return chain;
        },
        maybeSingle: () => Promise.resolve(result()),
        filter: () => chain,
        neq: () => chain,
        in: () => chain,
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(result()).then(resolve),
      };
      return chain;
    },
  };
  const stage = new ConfluencePageRepairStage(
    { renderTipTap, repairProfileMacros } as any,
    { updatePage } as any,
    { getClient: () => db } as any,
  );
  const ctx = {
    orgId: 'org-1',
    dryRun: false,
    run: {
      created_by: 'user-1',
      config_snapshot: { repair_of_run_id: 'source-run' },
    },
    job: { id: 'job-1', connection_id: 'connection-1', source_ref: 'EDV' },
    getAdapter: async () => ({ product: 'confluence' }),
    log: jest.fn(),
  } as unknown as StageContext;
  const item = {
    payload: {
      sourceId: '100',
      targetId: pageId,
      title: 'SNMP',
      bodyFormat: 'storage',
      metadata: { title: 'SNMP', body_format: 'storage', needs_relink: true },
    },
  } as any;

  return {
    stage,
    ctx,
    item,
    renderTipTap,
    updatePage,
    updates,
    mappingFilters,
    mappingQueries,
    repairProfileMacros, content,
  };
}

function produceHarness() {
  const filters: [string, unknown][] = [];
  const page = {
    source_id: '100',
    target_id: pageId,
    metadata: { title: 'SNMP', body_format: 'storage' },
  };
  const db = {
    from: jest.fn(() => {
      const chain: any = {
        select: () => chain,
        eq: (field: string, value: unknown) => {
          filters.push([field, value]);
          return chain;
        },
        filter: () => chain,
        order: () => chain,
        range: () => Promise.resolve({ data: [page], error: null }),
      };
      return chain;
    }),
  };
  const stage = new ConfluencePageRepairStage(
    { renderTipTap: jest.fn() } as any,
    { updatePage: jest.fn() } as any,
    { getClient: () => db } as any,
  );
  const ctx = {
    orgId: 'org-1',
    dryRun: false,
    run: { config_snapshot: { repair_of_run_id: 'source-run' } },
    job: {
      id: 'job-1',
      connection_id: 'connection-1',
      source_ref: 'EDV',
    },
  } as unknown as StageContext;

  return { stage, ctx, filters };
}

describe('ConfluencePageRepairStage', () => {
  it('enumerates only mappings created by the repaired source run', async () => {
    const h = produceHarness();

    await expect(
      h.stage.produce(h.ctx, { checkpoint: {} } as MigrationRunItemRow),
    ).resolves.toMatchObject({ items: [expect.anything()] });

    expect(h.filters).toEqual(
      expect.arrayContaining([
        ['job_id', 'job-1'],
        ['run_id', 'source-run'],
      ]),
    );
  });

  it('never overwrites a page edited after the source import finished', async () => {
    const h = repairHarness('2026-08-19T10:00:01.000Z');

    await expect(h.stage.processItem(h.ctx, h.item)).resolves.toEqual({
      kind: 'skipped',
      reason: 'page changed after source import',
    });
    expect(h.renderTipTap).not.toHaveBeenCalled();
    expect(h.updatePage).not.toHaveBeenCalled();
  });

  it('uses an optimistic lock and clears the old relink flag after a safe repair', async () => {
    const h = repairHarness('2026-08-19T09:59:59.000Z');

    await expect(h.stage.processItem(h.ctx, h.item)).resolves.toMatchObject({
      kind: 'updated',
      targetId: pageId,
    });
    expect(h.updatePage).toHaveBeenCalledWith(
      pageId,
      'space-1',
      expect.objectContaining({
        expectedUpdatedAt: '2026-08-19T09:59:59.000Z',
      }),
      expect.anything(),
    );
    expect(h.renderTipTap).toHaveBeenCalledWith(
      h.ctx,
      expect.anything(),
      expect.objectContaining({
        currentPageId: pageId,
        childPages: [
          {
            url: '/spaces/EDV1/wiki/child-page-id',
            title: 'Child page',
          },
        ],
        includePages: expect.objectContaining({
          'child-source-id': {
            pageId: 'child-page-id',
            url: '/wiki/child-page-id',
            title: 'Child page',
            targetSpaceKey: 'EDV',
          },
          ['EDV\u0000Child page']: {
            pageId: 'child-page-id',
            url: '/wiki/child-page-id',
            title: 'Child page',
            targetSpaceKey: 'EDV',
          },
          ['OPS\u0000Child page']: {
            pageId: 'ops-page-id',
            url: '/wiki/ops-page-id',
            title: 'Child page',
            targetSpaceKey: 'OPS',
          },
        }),
        currentSourceSpaceKey: 'EDV',
      }),
    );
    expect(h.updatePage).toHaveBeenCalledWith(
      pageId,
      'space-1',
      expect.objectContaining({
        content: '{"type":"doc","content":[]}',
      }),
      expect.anything(),
    );
    expect(h.updates).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          needs_relink: false,
          excerpt_content: expect.any(String),
        }),
      }),
    ]);
    expect(h.mappingFilters).toEqual(
      expect.arrayContaining([
        ['job_id', 'job-1'],
        ['run_id', 'source-run'],
      ]),
    );
    const includeQuery = h.mappingQueries.find(
      (query) => query.select === 'source_id, target_id, metadata',
    );
    expect(includeQuery?.filters).toEqual(
      expect.arrayContaining([
        ['job_id', 'job-1'],
        ['run_id', 'source-run'],
      ]),
    );
  });
});

describe('profile-only repair', () => {
  it('patches current edited content with optimistic concurrency without full re-rendering', async () => {
    const h = repairHarness('2026-09-07T00:00:00.000Z');
    h.ctx.run.config_snapshot.repair_scope = 'profile_macros';
    await h.stage.processItem(h.ctx, h.item);
    expect(h.repairProfileMacros).toHaveBeenCalledWith(h.ctx, h.content, 'space-1', h.item.payload);
    expect(h.renderTipTap).not.toHaveBeenCalled();
    expect(h.updatePage).toHaveBeenCalledWith(pageId, 'space-1', expect.objectContaining({ expectedUpdatedAt: '2026-09-07T00:00:00.000Z' }), 'user-1');
    expect(h.updates).toEqual([]);
  });
  it('does not write again when no profile can be repaired', async () => {
    const h = repairHarness(finishedAt);
    h.ctx.run.config_snapshot.repair_scope = 'profile_macros';
    h.repairProfileMacros.mockResolvedValue(h.content);
    expect(await h.stage.processItem(h.ctx, h.item)).toMatchObject({ kind: 'skipped' });
    expect(h.updatePage).not.toHaveBeenCalled();
  });
  it('reports concurrent edits without retrying an unguarded overwrite', async () => {
    const h = repairHarness(finishedAt);
    h.ctx.run.config_snapshot.repair_scope = 'profile_macros';
    h.updatePage.mockRejectedValue(new Error('Page changed'));
    await expect(h.stage.processItem(h.ctx, h.item)).rejects.toThrow('Page changed');
    expect(h.updatePage).toHaveBeenCalledTimes(1);
  });
});
