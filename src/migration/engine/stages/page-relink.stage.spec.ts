import { buildIncludePageIndex, PageRelinkStage } from './page-relink.stage';
import { ContentTransformService } from '../../transformers/content-transform.service';
import { pageReferenceKey } from '../../transformers/canonical-ir';
import type { MigrationRunItemRow, StageContext } from './stage.interface';

describe('buildIncludePageIndex', () => {
  it('indexes stable ids and space-qualified titles without a collision-prone bare title', () => {
    const rows = [
      {
        source_id: '101',
        target_id: '11111111-1111-4111-8111-111111111111',
        metadata: { title: 'Runbook', space_ref: 'ENG' },
      },
      {
        source_id: '202',
        target_id: '22222222-2222-4222-8222-222222222222',
        metadata: { title: 'Runbook', space_ref: 'OPS' },
      },
    ];

    const index = buildIncludePageIndex(
      rows,
      (row) =>
        `/spaces/${String(row.metadata.space_ref)}/wiki/${row.target_id}`,
    );

    expect(index['101']).toMatchObject({
      pageId: rows[0].target_id,
      title: 'Runbook',
    });
    expect(index['ENG\u0000Runbook']).toMatchObject({
      pageId: rows[0].target_id,
    });
    expect(index['OPS\u0000Runbook']).toMatchObject({
      pageId: rows[1].target_id,
    });
    expect(index.Runbook).toBeUndefined();
  });

  it('does not index duplicate source ids or duplicate titles in one space', () => {
    const rows = [
      {
        source_id: 'duplicate',
        target_id: '11111111-1111-4111-8111-111111111111',
        metadata: { title: 'Same', space_ref: 'ENG' },
      },
      {
        source_id: 'duplicate',
        target_id: '22222222-2222-4222-8222-222222222222',
        metadata: { title: 'Same', space_ref: 'ENG' },
      },
    ];

    const index = buildIncludePageIndex(rows, () => '/wiki');

    expect(index.duplicate).toBeUndefined();
    expect(index['ENG\u0000Same']).toBeUndefined();
  });

  it('ignores containers so a page sharing their title stays resolvable', () => {
    const rows = [
      {
        source_id: 'blog-container',
        target_id: '11111111-1111-4111-8111-111111111111',
        metadata: { title: 'Blog', space_ref: 'ENG', is_folder: true },
      },
      {
        source_id: '404',
        target_id: '22222222-2222-4222-8222-222222222222',
        metadata: { title: 'Blog', space_ref: 'ENG' },
      },
    ];

    const index = buildIncludePageIndex(rows, () => '/wiki');

    expect(index['ENG\u0000Blog']).toMatchObject({ pageId: rows[1].target_id });
    expect(index['blog-container']).toBeUndefined();
  });

  it('keeps a stable source-id binding when legacy metadata is partial', () => {
    const row = {
      source_id: 'legacy-303',
      target_id: '33333333-3333-4333-8333-333333333333',
      metadata: {},
    };

    const index = buildIncludePageIndex([row], () => '/wiki/target');

    expect(index['legacy-303']).toEqual({
      pageId: row.target_id,
      title: 'legacy-303',
      url: '/wiki/target',
    });
    expect(Object.keys(index)).toEqual(['legacy-303']);
  });
});

describe('PageRelinkStage include query scope', () => {
  it('uses only the current job/run while retaining cross-space pages', async () => {
    const queries: Array<{
      table: string;
      select?: string;
      filters: Array<[string, unknown]>;
    }> = [];
    const db = {
      from(table: string) {
        const query = { table, filters: [] as Array<[string, unknown]> } as {
          table: string;
          select?: string;
          filters: Array<[string, unknown]>;
        };

        queries.push(query);
        const result = () => {
          if (table === 'spaces') {
            return { data: { key: 'ENG1' }, error: null };
          }
          if (table === 'migration_entity_map') {
            return query.select === 'target_id, metadata'
              ? { data: [], error: null }
              : {
                  data: [
                    {
                      source_id: 'eng-page',
                      target_id: 'eng-target',
                      metadata: { title: 'Runbook', space_ref: 'ENG' },
                    },
                    {
                      source_id: 'ops-page',
                      target_id: 'ops-target',
                      metadata: { title: 'Runbook', space_ref: 'OPS' },
                    },
                  ],
                  error: null,
                };
          }
          throw new Error(`Unexpected table: ${table}`);
        };
        const chain: any = {
          select: (selection: string) => {
            query.select = selection;
            return chain;
          },
          eq: (field: string, value: unknown) => {
            query.filters.push([field, value]);
            return chain;
          },
          filter: () => chain,
          maybeSingle: () => Promise.resolve(result()),
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve(result()).then(resolve),
        };

        return chain;
      },
    };
    const renderBodyAsTipTap = jest.fn().mockResolvedValue({
      content: '{"type":"doc","content":[]}',
      needsRelink: false,
    });
    const renderExcerptAsTipTap = jest
      .fn()
      .mockResolvedValue('{"type":"doc","content":[{"type":"paragraph"}]}');
    const stage = new PageRelinkStage(
      { updatePage: jest.fn().mockResolvedValue({}) } as never,
      { renderBodyAsTipTap, renderExcerptAsTipTap } as never,
      { getClient: () => db } as never,
    );
    const recordMapping = jest.fn().mockResolvedValue({});
    const ctx = {
      orgId: 'org-1',
      run: { id: 'run-current', created_by: 'user-1', config_snapshot: {} },
      job: {
        id: 'job-1',
        connection_id: 'connection-1',
        source_ref: 'ENG',
      },
      entityMap: {
        getTarget: jest.fn().mockResolvedValue({
          status: 'mapped',
          target_id: 'space-1',
        }),
        recordMapping,
      },
      getAdapter: jest.fn().mockResolvedValue({
        product: 'confluence',
        getPageBody: jest.fn().mockResolvedValue({
          format: 'storage',
          value: '<p>body</p>',
        }),
        getPageAttachments: jest.fn().mockResolvedValue([]),
        getAttachmentBytes: jest.fn(),
      }),
      getSourceBaseUrl: jest.fn().mockResolvedValue('https://wiki.test/wiki'),
      log: jest.fn(),
    } as unknown as StageContext;

    await expect(
      stage.processItem(ctx, {
        payload: {
          pageSourceId: 'eng-page',
          wikiPageId: 'eng-target',
          metadata: { title: 'Runbook', body_format: 'storage' },
        },
      } as MigrationRunItemRow),
    ).resolves.toMatchObject({ kind: 'updated', targetId: 'eng-target' });

    const includeQuery = queries.find(
      (query) => query.select === 'source_id, target_id, metadata',
    );

    expect(includeQuery?.filters).toEqual(
      expect.arrayContaining([
        ['job_id', 'job-1'],
        ['run_id', 'run-current'],
      ]),
    );
    expect(renderBodyAsTipTap).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourcePageUrl:
          'https://wiki.test/wiki/pages/viewpage.action?pageId=eng-page',
        includePages: expect.objectContaining({
          ['ENG\u0000Runbook']: expect.objectContaining({
            pageId: 'eng-target',
          }),
          ['OPS\u0000Runbook']: expect.objectContaining({
            pageId: 'ops-target',
          }),
        }),
      }),
    );
    expect(renderExcerptAsTipTap).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        currentPageId: 'eng-target',
        sourcePageUrl:
          'https://wiki.test/wiki/pages/viewpage.action?pageId=eng-page',
      }),
    );
    expect(recordMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          needs_relink: false,
          excerpt_content: '{"type":"doc","content":[{"type":"paragraph"}]}',
        }),
      }),
    );
  });
});

/**
 * XE-T471 — the genuine remaining gap. A plain `<ri:page>` (`pageLink`) to a page migrated LATER in
 * the same run used to render as plain text on pass 1, and nothing flagged the page for relink:
 * `collectRefs` recorded the reference but the render pass never marked `needs_relink`. The link
 * was lost permanently. These drive the REAL `ContentTransformService` through the stage so the
 * flag and the render are exercised together, not mocked apart.
 */
describe('PageRelinkStage relinks a cross-page link (XE-T471)', () => {
  const TARGET_ID = '11111111-1111-4111-8111-111111111111';

  interface QueryChain {
    select: (selection: string) => QueryChain;
    eq: () => QueryChain;
    filter: () => QueryChain;
    or: () => QueryChain;
    order: () => QueryChain;
    range: () => QueryChain;
    maybeSingle: () => Promise<{ data: unknown; error: null }>;
    then: (resolve: (value: unknown) => unknown) => Promise<unknown>;
  }

  function buildDb(options: {
    pages: {
      source_id: string;
      target_id: string;
      metadata: Record<string, unknown>;
    }[];
  }): { from: (table: string) => QueryChain } {
    const db = {
      from(table: string) {
        const query: { select?: string } = {};
        const result = () => {
          if (table === 'spaces')
            return { data: { key: 'APMIS' }, error: null };
          if (table === 'migration_entity_map') {
            return query.select === 'target_id, metadata'
              ? { data: [], error: null }
              : { data: options.pages, error: null };
          }
          throw new Error(`Unexpected table: ${table}`);
        };
        const chain: QueryChain = {
          select: (selection: string) => {
            query.select = selection;
            return chain;
          },
          eq: () => chain,
          filter: () => chain,
          or: () => chain,
          order: () => chain,
          range: () => chain,
          maybeSingle: () => Promise.resolve(result()),
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve(result()).then(resolve),
        };

        return chain;
      },
    };

    return db;
  }

  type RelinkWrite = { content: string };

  function buildStage(
    db: ReturnType<typeof buildDb>,
    pageTargets: Map<
      string,
      { pageId: string; pageSlug?: string; spaceKey?: string; title?: string }
    >,
  ) {
    const entityMap = {
      getTargets: jest.fn().mockResolvedValue(new Map()),
      resolveWikiPageTargets: () => Promise.resolve(pageTargets),
      listPageAttachments: jest.fn().mockResolvedValue([]),
      resolveIssueTargets: jest.fn().mockResolvedValue(new Map()),
      resolveAttachmentTargets: jest.fn().mockResolvedValue(new Map()),
    };
    const content = new ContentTransformService(entityMap as never);
    const updatePage = jest.fn<
      Promise<unknown>,
      [string, string, RelinkWrite, string]
    >();
    updatePage.mockResolvedValue({});
    const recordMapping = jest.fn().mockResolvedValue({});
    const stage = new PageRelinkStage(
      { updatePage } as never,
      content as never,
      { getClient: () => db } as never,
    );

    return { stage, updatePage, recordMapping };
  }

  function writtenContent(
    updatePage: jest.Mock<
      Promise<unknown>,
      [string, string, RelinkWrite, string]
    >,
    call: number,
  ): RelinkWrite {
    return (updatePage.mock.calls as unknown[][])[call][2] as RelinkWrite;
  }

  function buildCtx(recordMapping: jest.Mock): StageContext {
    return {
      orgId: 'org-1',
      run: { id: 'run-current', created_by: 'user-1', config_snapshot: {} },
      job: {
        id: 'job-1',
        connection_id: 'connection-1',
        source_ref: 'APMIS',
      },
      entityMap: {
        getTarget: jest.fn().mockResolvedValue({
          status: 'mapped',
          target_id: 'space-1',
        }),
        recordMapping,
      },
      getAdapter: jest.fn().mockResolvedValue({
        product: 'confluence',
        deployment: 'server',
        getPageBody: jest.fn().mockResolvedValue({
          format: 'storage',
          value:
            '<p><ac:link ac:anchor="release-notes"><ri:page ri:content-title="AM Topics" ri:space-key="APMIS"/><ac:link-body>Read more</ac:link-body></ac:link></p>',
        }),
        getPageAttachments: jest.fn().mockResolvedValue([]),
        getAttachmentBytes: jest.fn(),
      }),
      getSourceBaseUrl: jest.fn().mockResolvedValue('https://wiki.test/wiki'),
      log: jest.fn(),
    } as unknown as StageContext;
  }

  /** Typed view of the metadata recorded for a mapping call. */
  function recordedMetadata(
    recordMapping: jest.Mock,
    call: number,
  ): Record<string, unknown> {
    const arg = (recordMapping.mock.calls as unknown[][])[call]?.[0] as {
      metadata: Record<string, unknown>;
    };

    return arg.metadata;
  }

  it('renders the real link with its fragment once the target is mapped, then clears the flag', async () => {
    const db = buildDb({
      pages: [
        {
          source_id: 'AM Topics',
          target_id: TARGET_ID,
          metadata: { title: 'AM Topics', space_ref: 'APMIS' },
        },
      ],
    });
    const pageTargets = new Map([
      [
        pageReferenceKey('AM Topics', 'APMIS'),
        {
          pageId: TARGET_ID,
          pageSlug: 'am-topics',
          spaceKey: 'APMIS',
          title: 'AM Topics',
        },
      ],
    ]);
    const { stage, updatePage, recordMapping } = buildStage(db, pageTargets);
    const ctx = buildCtx(recordMapping);

    await expect(
      stage.processItem(ctx, {
        payload: {
          pageSourceId: 'home',
          wikiPageId: 'home-target',
          metadata: { title: 'Home', body_format: 'storage' },
        },
      } as unknown as MigrationRunItemRow),
    ).resolves.toMatchObject({ kind: 'updated', targetId: 'home-target' });

    const written = JSON.parse(writtenContent(updatePage, 0).content) as {
      content: Array<{
        content: Array<{ type: string; attrs?: Record<string, unknown> }>;
      }>;
    };

    expect(written.content[0].content[0]).toMatchObject({
      type: 'wikiLink',
      attrs: {
        pageId: TARGET_ID,
        pageSlug: 'am-topics',
        spaceKey: 'APMIS',
        fragment: 'release-notes',
      },
    });
    expect(recordedMetadata(recordMapping, 0)).toMatchObject({
      needs_relink: false,
    });
  });

  it('is a no-op on a second relink pass and does not flag a target that was mapped on the first', async () => {
    const pageTargets = new Map([
      [
        pageReferenceKey('AM Topics', 'APMIS'),
        {
          pageId: TARGET_ID,
          pageSlug: 'am-topics',
          spaceKey: 'APMIS',
          title: 'AM Topics',
        },
      ],
    ]);
    const db = buildDb({ pages: [] });
    const { stage, updatePage, recordMapping } = buildStage(db, pageTargets);
    const ctx = buildCtx(recordMapping);

    await stage.processItem(ctx, {
      payload: {
        pageSourceId: 'home',
        wikiPageId: 'home-target',
        metadata: { title: 'Home', body_format: 'storage' },
      },
    } as unknown as MigrationRunItemRow);

    const firstContent = writtenContent(updatePage, 0).content;

    // Second pass over the same page: byte-identical output and the flag stays cleared, so
    // `page_relink` converges rather than re-writing (or degrading) the link.
    await stage.processItem(ctx, {
      payload: {
        pageSourceId: 'home',
        wikiPageId: 'home-target',
        metadata: { title: 'Home', body_format: 'storage' },
      },
    } as unknown as MigrationRunItemRow);

    expect(writtenContent(updatePage, 1).content).toBe(firstContent);
    expect(recordedMetadata(recordMapping, 1)).toMatchObject({
      needs_relink: false,
    });
  });
});
