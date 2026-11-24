/**
 * `pages` stage — parent reconciliation.
 *
 * Confluence `parentId` can be a DANGLING reference: on the customer's live 339-page space three
 * parent ids return HTTP 404 (deleted pages) while 129 descendants still point at them. Because the
 * worker gates every item on `parent_source_ref`, those children block forever, the tick's deadlock
 * guard then fails them as orphans, and the cascade takes whole subtrees down — while the run reports
 * only `partially_completed`. Two full runs were lost to this, to two different root causes, so each
 * case below is a measured regression guard rather than a hypothetical.
 */

// `PageMapper` reaches WikiService → sanitize-rich-text → jsdom, which this jest environment cannot
// load as ESM. The producer under test never calls the mapper (that is `processItem`'s job), so the
// module is stubbed to keep the import graph shallow.
jest.mock('../../mappers/page.mapper', () => ({ PageMapper: class {} }));

import { PagesStage } from './pages.stage';
import type { SeedItem, StageContext } from './stage.interface';

type Row = {
  id: string;
  source_ref: string | null;
  parent_source_ref: string | null;
  status: string;
  checkpoint: Record<string, unknown> | null;
  error_message: string | null;
  payload?: Record<string, unknown> | null;
};

const row = (over: Partial<Row> & { id: string }): Row => ({
  source_ref: over.id,
  parent_source_ref: null,
  status: 'pending',
  checkpoint: null,
  error_message: null,
  ...over,
});

/**
 * Minimal stand-in for the Supabase query builder: every `select`/`eq`/`update` returns `this`, and
 * awaiting resolves with the seeded rows (select) or records the patch (update). Like PostgREST, a
 * select never returns more than 1000 rows, whatever `range` asked for.
 */
function fakeDb(rows: Row[]) {
  const updates: { patch: Record<string, unknown>; id?: string }[] = [];

  const builder = () => {
    let mode: 'select' | 'update' = 'select';
    let patch: Record<string, unknown> = {};
    let id: string | undefined;
    let folderOnly = false;
    let window: [number, number] = [0, Infinity];

    const chain: any = {
      select: () => ((mode = 'select'), chain),
      update: (p: Record<string, unknown>) => (
        (mode = 'update'),
        (patch = p),
        chain
      ),
      eq: (col: string, val: string) => {
        if (col === 'id') id = val;

        return chain;
      },
      filter: (col: string, _op: string, val: string) => (
        (folderOnly = col === 'payload->>contentKind' && val === 'folder'),
        chain
      ),
      order: () => chain,
      range: (from: number, to: number) => ((window = [from, to]), chain),
      then: (resolve: (v: unknown) => void) => {
        if (mode === 'update') updates.push({ patch, id });

        const [from, to] = window;
        const data = rows
          .filter((r) => !folderOnly || r.payload?.contentKind === 'folder')
          .slice(from, Math.min(to + 1, from + 1000));

        return Promise.resolve(
          mode === 'select'
            ? { data, error: null }
            : { data: null, error: null },
        ).then(resolve);
      },
    };

    return chain;
  };

  return { db: { from: () => builder() }, updates };
}

/** One batch of pages, then the cursor ends — so `produce` reports `done` and reconciles. */
function ctxFor(
  pages: Record<string, unknown>[],
  opts: {
    adapter?: Record<string, unknown>;
    scope?: Record<string, unknown>;
    nextCursor?: string | null;
  } = {},
) {
  const logs: { level: string; message: string }[] = [];
  const adapter = {
    product: 'confluence',
    iteratePages: () => ({
      next: async () => ({
        done: false,
        value: { items: pages, nextCursor: opts.nextCursor ?? null },
      }),
    }),
    ...opts.adapter,
  };

  return {
    logs,
    ctx: {
      orgId: 'org-1',
      run: { id: 'run-1' },
      job: { source_ref: 'MT', scope: opts.scope ?? {} },
      getAdapter: async () => adapter,
      log: async (level: string, message: string) =>
        void logs.push({ level, message }),
    } as unknown as StageContext,
  };
}

const collectionItem = { checkpoint: null } as any;

function stageWith(rows: Row[]) {
  const { db, updates } = fakeDb(rows);
  const stage = new PagesStage({} as any, { getClient: () => db } as any);

  return { stage, updates };
}

const seedOf = (items: SeedItem[], sourceRef: string) =>
  items.find((i) => i.sourceRef === sourceRef);

describe('PagesStage.produce — unreachable parent reconciliation', () => {
  it('detaches a FINAL-BATCH page whose parent is dangling', async () => {
    // The engine inserts `produce`'s seeds only AFTER it returns, so the last batch is invisible to
    // the reconcile query. Ignoring it left 11 pages holding a dead `parent_source_ref`; they blocked
    // and took 24 descendants with them. The fix reconciles those seeds in memory.
    const { stage } = stageWith([]);
    const { ctx } = ctxFor([
      { sourceId: '900', parentSourceId: '1836449793' }, // parent deleted in Confluence
      { sourceId: '901' },
    ]);
    const result = await stage.produce(ctx, collectionItem);

    expect(result.done).toBe(true);
    expect(seedOf(result.items, '900')?.parentSourceRef).toBeUndefined();
  });

  it('does NOT detach a page whose parent is in that same final batch', async () => {
    // The mirror-image failure: treating the pending batch as absent would move every page whose
    // parent happens to arrive last to the space root — silent hierarchy corruption, no error.
    const { stage } = stageWith([]);
    const { ctx } = ctxFor([
      { sourceId: '910', parentSourceId: '911' },
      { sourceId: '911' },
    ]);
    const result = await stage.produce(ctx, collectionItem);

    expect(seedOf(result.items, '910')?.parentSourceRef).toBe('911');
  });

  it('keeps a parent that was seeded in an EARLIER batch', async () => {
    const { stage } = stageWith([row({ id: '800', status: 'succeeded' })]);
    const { ctx } = ctxFor([{ sourceId: '801', parentSourceId: '800' }]);
    const result = await stage.produce(ctx, collectionItem);

    expect(seedOf(result.items, '801')?.parentSourceRef).toBe('800');
  });

  it('detaches an already-inserted row whose parent will never arrive', async () => {
    const { stage, updates } = stageWith([
      row({ id: 'r1', source_ref: '700', parent_source_ref: '1836452455' }),
    ]);
    const { ctx } = ctxFor([]);

    await stage.produce(ctx, collectionItem);

    const patch = updates.find((u) => u.id === 'r1')?.patch;

    expect(patch?.parent_source_ref).toBeNull();
    expect(patch?.status).toBe('pending');
  });

  it('requeues cascade victims WITHOUT touching their legitimate parent', async () => {
    // A subtree under an unreachable ancestor is already `failed`, which is terminal. These keep
    // their real parent and simply go back in the queue; retry is safe because the page write adopts
    // an existing crosswalk row instead of duplicating.
    const { stage, updates } = stageWith([
      row({ id: 'anc', source_ref: '600', parent_source_ref: '1836456545' }),
      row({
        id: 'kid',
        source_ref: '601',
        parent_source_ref: '600',
        status: 'failed',
        error_message: 'Dependency page:600 did not migrate (failed)',
        checkpoint: { waiting_entity_type: 'page', waiting_source_id: '600' },
      }),
    ]);
    const { ctx } = ctxFor([]);

    await stage.produce(ctx, collectionItem);

    const kid = updates.find((u) => u.id === 'kid')?.patch;

    expect(kid).toBeDefined();
    expect(kid).not.toHaveProperty('parent_source_ref');
    expect(kid?.status).toBe('pending');
    // `blockItem` records the dependency here, and BOTH `unblockReadyItems` and the deadlock guard
    // read it from the checkpoint — not from `parent_source_ref`. Leaving these keys behind means the
    // guard re-fails the item on the very next tick.
    expect(kid?.checkpoint).toEqual({});
  });

  it('leaves a genuinely failed page failed instead of retrying it forever', async () => {
    const { stage, updates } = stageWith([
      row({
        id: 'bad',
        source_ref: '500',
        status: 'failed',
        error_message: 'Confluence returned 404 for page 500',
      }),
    ]);
    const { ctx } = ctxFor([]);

    await stage.produce(ctx, collectionItem);

    expect(updates.find((u) => u.id === 'bad')).toBeUndefined();
  });

  it('reports every distinct dangling parent, from both the DB rows and the pending batch', async () => {
    const { stage } = stageWith([
      row({ id: 'r1', source_ref: '400', parent_source_ref: 'gone-a' }),
    ]);
    const { ctx, logs } = ctxFor([
      { sourceId: '401', parentSourceId: 'gone-b' },
    ]);

    await stage.produce(ctx, collectionItem);

    const warn = logs.find((l) =>
      l.message.includes('not in the migrated set'),
    );

    expect(warn?.message).toContain('2 page(s) reference 2 parent(s)');
  });
});

describe('PagesStage.produce — beyond the 1000-row PostgREST cap', () => {
  it('reconciles every run item, not just the first 1000', async () => {
    // Space AS (1,480 pages, release 1.2.18): the unpaged read saw 1000 rows, so real parents past
    // the cap looked unreachable (597 pages hoisted to the root) and cascade victims past the cap
    // were never requeued (138 pages never created).
    const rows = Array.from({ length: 1500 }, (_, i) =>
      row({ id: `r${i}`, source_ref: `p${i}`, status: 'succeeded' }),
    );

    rows[3] = row({ id: 'r3', source_ref: 'p3', parent_source_ref: 'p1400' });
    rows[1300] = row({
      id: 'r1300',
      source_ref: 'p1300',
      parent_source_ref: 'p1299',
      status: 'failed',
      error_message: 'Dependency page:p1299 did not migrate (failed)',
    });

    const { stage, updates } = stageWith(rows);
    const { ctx } = ctxFor([]);

    await stage.produce(ctx, collectionItem);

    expect(updates.find((u) => u.id === 'r3')).toBeUndefined();

    const victim = updates.find((u) => u.id === 'r1300')?.patch;

    expect(victim?.status).toBe('pending');
    expect(victim).not.toHaveProperty('parent_source_ref');
  });
});

describe('PagesStage.produce — Cloud folders', () => {
  const folderRef = (sourceId: string, parentSourceId: string) => ({
    sourceId,
    parentSourceId,
    parentType: 'folder',
  });

  it('seeds nested folders before the pages inside them, fetching each once', async () => {
    const folders: Record<string, Record<string, unknown>> = {
      f1: {
        sourceId: 'f1',
        contentKind: 'folder',
        parentSourceId: 'f0',
        parentType: 'folder',
      },
      f0: {
        sourceId: 'f0',
        contentKind: 'folder',
        parentSourceId: 'home',
        parentType: 'page',
      },
    };
    const getFolder = jest.fn(async (id: string) => folders[id] ?? null);
    const { stage } = stageWith([]);
    const { ctx } = ctxFor(
      [{ sourceId: 'home' }, folderRef('a', 'f1'), folderRef('b', 'f1')],
      { adapter: { getFolder } },
    );
    const result = await stage.produce(ctx, collectionItem);

    expect(result.items.map((i) => i.sourceRef)).toEqual([
      'f0',
      'f1',
      'home',
      'a',
      'b',
    ]);
    expect(getFolder).toHaveBeenCalledTimes(2);
    expect(seedOf(result.items, 'f1')?.parentSourceRef).toBe('f0');
    expect(seedOf(result.items, 'a')?.parentSourceRef).toBe('f1');
  });

  it('detaches pages under a deleted folder and never re-fetches an already seeded one', async () => {
    const getFolder = jest.fn(async () => null);
    const { stage } = stageWith([
      row({ id: 'r9', source_ref: 'f9', payload: { contentKind: 'folder' } }),
    ]);
    const { ctx } = ctxFor([folderRef('x', 'gone'), folderRef('y', 'f9')], {
      adapter: { getFolder },
    });
    const result = await stage.produce(ctx, collectionItem);

    expect(getFolder).toHaveBeenCalledTimes(1);
    expect(getFolder).toHaveBeenCalledWith('gone');
    expect(seedOf(result.items, 'x')?.parentSourceRef).toBeUndefined();
    expect(seedOf(result.items, 'y')?.parentSourceRef).toBe('f9');
  });
});

describe('PagesStage.produce — blog containers', () => {
  it('files posts under Blog → year → month, containers first and not counted as pages', async () => {
    const { stage } = stageWith([]);
    const blog = (sourceId: string, createdAt?: string) => ({
      sourceId,
      contentKind: 'blogpost',
      parentSourceId: null,
      ancestors: [],
      createdAt,
    });
    const { ctx } = ctxFor(
      [blog('post1', '2025-11-03T10:00:00Z'), blog('post2')],
      { nextCursor: '/next' },
    );
    const result = await stage.produce(ctx, collectionItem);

    expect(result.items.map((i) => i.sourceRef)).toEqual([
      'blog:MT:root',
      'blog:MT:2025',
      'blog:MT:2025-11',
      'post1',
      'post2',
    ]);
    expect(seedOf(result.items, 'blog:MT:2025-11')?.parentSourceRef).toBe(
      'blog:MT:2025',
    );
    expect(seedOf(result.items, 'post1')?.parentSourceRef).toBe(
      'blog:MT:2025-11',
    );
    expect(seedOf(result.items, 'post2')?.parentSourceRef).toBe('blog:MT:root');
    // 2 real posts of a 3-page cap: five seeds must not read as the cap being reached.
    expect(result.done).toBe(false);
    expect(result.nextCheckpoint).toEqual({ cursor: '/next', seeded: 2 });
  });
});

describe('PagesStage.processItem — containers', () => {
  const folder = {
    sourceId: 'f1',
    title: 'Inner',
    contentKind: 'folder',
    parentSourceId: 'f0',
    ancestors: ['f0'],
    bodyFormat: 'atlas_doc_format',
    position: 4,
  };

  function containerCtx(dryRun: boolean) {
    const entityMap = {
      getTarget: jest.fn((_org: string, _conn: string, entityType: string) =>
        Promise.resolve(
          entityType === 'space'
            ? { status: 'mapped', target_id: 'space-live' }
            : null,
        ),
      ),
      getExistingWikiPageTarget: jest.fn().mockResolvedValue(null),
      deleteExactStaleMapping: jest.fn(),
      recordMapping: jest.fn().mockResolvedValue(undefined),
    };
    const ctx = {
      orgId: 'org-1',
      dryRun,
      job: { id: 'job-1', connection_id: 'conn-1', source_ref: 'DOCS' },
      run: { id: 'run-1' },
      entityMap,
      log: jest.fn().mockResolvedValue(undefined),
    } as unknown as StageContext;

    return { ctx, entityMap };
  }

  it('creates a folder with no body fetch and no title adoption', async () => {
    const pageMapper = {
      createPage: jest.fn(),
      createContainer: jest.fn().mockResolvedValue({
        targetId: 'wiki-f1',
        level: 1,
        depthFlattened: false,
        needsRelink: false,
        excerptContent: null,
      }),
    };
    // `getClient()` has no `from`: were a retry to attempt adoption, this would throw.
    const stage = new PagesStage(
      pageMapper as never,
      { getClient: () => ({}) } as never,
    );
    const { ctx, entityMap } = containerCtx(false);

    await expect(
      stage.processItem(ctx, { payload: folder, retry_count: 1 } as never),
    ).resolves.toEqual({
      kind: 'created',
      targetId: 'wiki-f1',
      targetTable: 'wiki_pages',
    });
    expect(pageMapper.createPage).not.toHaveBeenCalled();
    expect(entityMap.recordMapping.mock.calls[0][0].metadata).toEqual({
      title: 'Inner',
      level: 1,
      space_ref: 'DOCS',
      is_folder: true,
      needs_relink: false,
      parent_source_id: 'f0',
    });
  });

  it('plans a folder in a dry run without rendering a body', async () => {
    // No `renderTipTap` on the mapper: a body validation attempt would throw.
    const stage = new PagesStage(
      {} as never,
      { getClient: () => ({}) } as never,
    );
    const { ctx, entityMap } = containerCtx(true);

    await expect(
      stage.processItem(ctx, { payload: folder, retry_count: 0 } as never),
    ).resolves.toEqual({ kind: 'planned' });
    expect(entityMap.recordMapping.mock.calls[0][0]).toMatchObject({
      status: 'planned',
      metadata: { is_folder: true },
    });
  });
});

describe('PagesStage.processItem — stale target recovery', () => {
  it('deletes a stale page mapping and recreates the page in the live space', async () => {
    const pageMapper = {
      createPage: jest.fn().mockResolvedValue({
        targetId: 'page-new',
        level: 0,
        depthFlattened: false,
        needsRelink: false,
        excerptContent: null,
      }),
    };
    const entityMap = {
      getTarget: jest.fn(
        (_org: string, _connection: string, entityType: string) =>
          Promise.resolve(
            entityType === 'space'
              ? { status: 'mapped', target_id: 'space-live' }
              : {
                  status: 'mapped',
                  target_id: 'page-deleted',
                },
          ),
      ),
      getExistingWikiPageTarget: jest.fn().mockResolvedValue(null),
      deleteExactStaleMapping: jest.fn().mockResolvedValue(true),
      recordMapping: jest.fn().mockResolvedValue(undefined),
    };
    const stage = new PagesStage(
      pageMapper as never,
      {
        getClient: () => ({}),
      } as never,
    );
    const ctx = {
      orgId: 'org-1',
      dryRun: false,
      job: {
        id: 'job-1',
        connection_id: 'conn-1',
        source_ref: 'DOCS',
      },
      run: { id: 'run-1' },
      entityMap,
      log: jest.fn().mockResolvedValue(undefined),
    } as unknown as StageContext;
    const page = {
      sourceId: 'source-page-1',
      title: 'Recovered page',
      ancestors: [],
      bodyFormat: 'storage',
    };

    await expect(
      stage.processItem(ctx, {
        payload: page,
        retry_count: 0,
      } as never),
    ).resolves.toEqual({
      kind: 'created',
      targetId: 'page-new',
      targetTable: 'wiki_pages',
    });
    expect(entityMap.deleteExactStaleMapping).toHaveBeenCalledWith(
      'org-1',
      'conn-1',
      'page',
      'source-page-1',
      'page-deleted',
    );
    expect(pageMapper.createPage).toHaveBeenCalledWith(ctx, page, 'space-live');
  });
});
