/**
 * `confluence_page_hierarchy` — repair of an already-imported space's page tree.
 *
 * This stage writes live customer wiki rows, so every case below is a guard: a page a user moved
 * stays put, a cycle is refused, a second pass changes nothing, and a container is created once.
 */

// `PageMapper` reaches WikiService → jsdom, which this jest environment cannot load as ESM.
jest.mock('../../mappers/page.mapper', () => ({ PageMapper: class {} }));

import { ConfluencePageHierarchyStage } from './confluence-page-hierarchy.stage';
import { PagesStage } from './pages.stage';
import type { MigrationRunItemRow, StageContext } from './stage.interface';

type Page = {
  id: string;
  parent_id: string | null;
  sort_order: number | null;
  level: number;
  space_id: string;
  is_archived: boolean;
  path: string[];
};
type MapRow = {
  id: string;
  target_id: string;
  status: string;
  metadata: Record<string, unknown>;
};

/** In-memory wiki + crosswalk; the `wiki_pages_path` trigger is simulated on every parent write. */
function harness(pages: Partial<Page>[], crosswalk: Record<string, string>) {
  const rows = new Map<string, Page>();

  for (const p of pages) {
    rows.set(p.id!, {
      parent_id: null,
      sort_order: 0,
      level: 0,
      space_id: 'space-1',
      is_archived: false,
      path: [p.id!],
      ...p,
    } as Page);
  }

  const trigger = (row: Page) => {
    const parent = row.parent_id ? rows.get(row.parent_id) : null;

    row.path = [...(parent?.path ?? []), row.id];
    row.level = parent ? parent.level + 1 : 0;
  };
  const map = new Map<string, MapRow>(
    Object.entries(crosswalk).map(([sourceId, targetId]) => [
      sourceId,
      {
        id: `map-${sourceId}`,
        target_id: targetId,
        status: 'mapped',
        metadata: { title: sourceId, space_ref: 'AS' },
      },
    ]),
  );
  const writes: { table: string; patch: Record<string, unknown> }[] = [];

  const db = {
    from(table: string) {
      const eqs: Record<string, unknown> = {};
      let patch: Record<string, unknown> | null = null;
      let containsId: string | null = null;
      let limit = Infinity;

      const run = (): { data: unknown; error: null } => {
        if (table === 'migration_run_items') return { data: [], error: null };

        if (table === 'migration_entity_map') {
          const row = [...map.values()].find((r) => r.id === eqs.id);

          if (patch && row) {
            writes.push({ table, patch });
            Object.assign(row, patch);
          }

          return { data: null, error: null };
        }

        if (patch) {
          const row = rows.get(eqs.id as string);

          if (!row || row.parent_id !== (eqs.parent_id ?? null))
            return { data: [], error: null };

          writes.push({ table, patch });
          Object.assign(row, patch);

          if ('parent_id' in patch) trigger(row);

          return { data: [{ id: row.id }], error: null };
        }

        if (containsId) {
          const data = [...rows.values()]
            .filter((r) => r.path.includes(containsId!))
            .sort((a, b) => b.level - a.level)
            .slice(0, limit);

          return { data, error: null };
        }

        if (eqs.id)
          return { data: rows.get(eqs.id as string) ?? null, error: null };

        return {
          data: [...rows.values()].filter((r) => r.space_id === eqs.space_id),
          error: null,
        };
      };

      const chain: any = {
        select: () => chain,
        update: (p: Record<string, unknown>) => ((patch = p), chain),
        eq: (col: string, val: unknown) => ((eqs[col] = val), chain),
        is: (col: string, val: unknown) => ((eqs[col] = val), chain),
        filter: () => chain,
        contains: (_col: string, val: string[]) => (
          (containsId = val[0]),
          chain
        ),
        order: () => chain,
        range: () => chain,
        limit: (n: number) => ((limit = n), chain),
        maybeSingle: () => Promise.resolve(run()),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(run()).then(resolve),
      };

      return chain;
    },
  };

  const entityMap = {
    getTarget: async (
      _o: string,
      _c: string,
      type: string,
      sourceId: string,
    ) =>
      type === 'space'
        ? { status: 'mapped', target_id: 'space-1' }
        : (map.get(sourceId) ?? null),
    getExistingWikiPageTarget: async (
      _o: string,
      _c: string,
      sourceId: string,
      spaceId: string,
    ) => {
      const row = map.get(sourceId);
      const page = row && rows.get(row.target_id);

      return page && !page.is_archived && page.space_id === spaceId
        ? row
        : null;
    },
    recordMapping: async (m: {
      sourceId: string;
      targetId: string;
      status: string;
      metadata: Record<string, unknown>;
    }) =>
      void map.set(m.sourceId, {
        id: `map-${m.sourceId}`,
        target_id: m.targetId,
        status: m.status,
        metadata: m.metadata,
      }),
    deleteExactStaleMapping: async () => undefined,
  };

  const refreshSubtreePaths = jest.fn(async (_org: string, pageId: string) => {
    const subtree = [...rows.values()]
      .filter((r) => r.path.includes(pageId) && r.id !== pageId)
      .sort((a, b) => a.level - b.level);

    for (const r of subtree) trigger(r);

    return subtree.length;
  });
  const createContainer = jest.fn(async () => {
    rows.set('w-folder', {
      id: 'w-folder',
      parent_id: null,
      sort_order: 0,
      level: 0,
      space_id: 'space-1',
      is_archived: false,
      path: ['w-folder'],
    });

    return {
      targetId: 'w-folder',
      level: 0,
      depthFlattened: false,
      needsRelink: false,
      excerptContent: null,
    };
  });
  const supabaseAdmin = { getClient: () => db } as any;
  const pagesStage = new PagesStage({ createContainer } as any, supabaseAdmin);
  const stage = new ConfluencePageHierarchyStage(
    pagesStage,
    { refreshSubtreePaths } as any,
    supabaseAdmin,
  );
  const logs: { level: string; message: string }[] = [];
  const ctx = (adapter: Record<string, unknown> = {}) =>
    ({
      orgId: 'org-1',
      dryRun: false,
      run: { id: 'run-2', config_snapshot: { repair_of_run_id: 'run-1' } },
      job: {
        id: 'job-1',
        connection_id: 'conn-1',
        source_ref: 'AS',
        scope: {},
      },
      entityMap,
      getAdapter: async () => ({ product: 'confluence', ...adapter }),
      log: async (level: string, message: string) =>
        void logs.push({ level, message }),
    }) as unknown as StageContext;

  return {
    stage,
    rows,
    map,
    writes,
    logs,
    ctx,
    refreshSubtreePaths,
    createContainer,
  };
}

const item = (payload: Record<string, unknown>) =>
  ({
    payload: { ancestors: [], version: 1, bodyFormat: 'storage', ...payload },
    retry_count: 0,
  }) as unknown as MigrationRunItemRow;

describe('ConfluencePageHierarchyStage.processItem', () => {
  it('re-parents a page the import flattened to the root, sets sort_order, and is idempotent', async () => {
    const h = harness(
      [
        { id: 'w-parent' },
        { id: 'w-page' },
        {
          id: 'w-child',
          parent_id: 'w-page',
          level: 1,
          path: ['w-page', 'w-child'],
        },
      ],
      { 'c-parent': 'w-parent', 'c-page': 'w-page' },
    );
    h.map.get('c-page')!.metadata.parent_source_id = 'c-parent';
    const it1 = item({
      sourceId: 'c-page',
      title: 'Page',
      parentSourceId: 'c-parent',
      ancestors: ['c-parent'],
      position: 7,
    });

    await expect(h.stage.processItem(h.ctx(), it1)).resolves.toMatchObject({
      kind: 'updated',
      targetId: 'w-page',
    });
    expect(h.rows.get('w-page')).toMatchObject({
      parent_id: 'w-parent',
      sort_order: 7,
      level: 1,
    });
    // Descendants follow the move.
    expect(h.rows.get('w-child')!.path).toEqual([
      'w-parent',
      'w-page',
      'w-child',
    ]);
    expect(h.refreshSubtreePaths).toHaveBeenCalledWith('org-1', 'w-page');
    expect(h.map.get('c-page')!.metadata).toMatchObject({
      title: 'c-page',
      parent_source_id: 'c-parent',
      level: 1,
    });

    const writesAfterFirst = h.writes.length;

    await expect(h.stage.processItem(h.ctx(), it1)).resolves.toMatchObject({
      kind: 'skipped',
      reason: 'hierarchy already correct',
    });
    expect(h.writes).toHaveLength(writesAfterFirst);
  });

  it('leaves a page a user moved after the import where the user put it', async () => {
    const h = harness(
      [
        { id: 'w-parent' },
        { id: 'w-user' },
        {
          id: 'w-page',
          parent_id: 'w-user',
          level: 1,
          sort_order: 3,
          path: ['w-user', 'w-page'],
        },
      ],
      { 'c-parent': 'w-parent', 'c-page': 'w-page' },
    );
    h.map.get('c-page')!.metadata.parent_source_id = 'c-parent';

    await expect(
      h.stage.processItem(
        h.ctx(),
        item({
          sourceId: 'c-page',
          title: 'Page',
          parentSourceId: 'c-parent',
          position: 9,
        }),
      ),
    ).resolves.toMatchObject({ kind: 'skipped' });
    expect(h.rows.get('w-page')).toMatchObject({
      parent_id: 'w-user',
      sort_order: 3,
    });
    expect(h.writes).toHaveLength(0);
    expect(h.logs.some((l) => /moved after the import/.test(l.message))).toBe(
      true,
    );
  });

  it('leaves a nested page a user moved to the root at the root', async () => {
    const h = harness([{ id: 'w-parent' }, { id: 'w-page' }], {
      'c-parent': 'w-parent',
      'c-page': 'w-page',
    });
    // The import nested it (level 1); a user then dragged it to the root.
    Object.assign(h.map.get('c-page')!.metadata, {
      parent_source_id: 'c-parent',
      level: 1,
    });

    await h.stage.processItem(
      h.ctx(),
      item({ sourceId: 'c-page', title: 'Page', parentSourceId: 'c-parent' }),
    );
    expect(h.rows.get('w-page')!.parent_id).toBeNull();
    expect(h.writes).toHaveLength(0);
    expect(h.logs.some((l) => /moved after the import/.test(l.message))).toBe(
      true,
    );
  });

  it('skips a page the import never created, and a page whose parent was never created', async () => {
    const h = harness([{ id: 'w-page' }], { 'c-page': 'w-page' });

    await expect(
      h.stage.processItem(
        h.ctx(),
        item({ sourceId: 'c-missing', title: 'X', parentSourceId: null }),
      ),
    ).resolves.toEqual({ kind: 'skipped', reason: 'page not imported' });
    await expect(
      h.stage.processItem(
        h.ctx(),
        item({
          sourceId: 'c-page',
          title: 'Page',
          parentSourceId: 'c-deleted',
          position: 4,
        }),
      ),
    ).resolves.toEqual({ kind: 'skipped', reason: 'parent page not imported' });
    expect(h.writes).toHaveLength(0);
  });

  it('refuses to attach a page under its own descendant', async () => {
    const h = harness(
      [
        { id: 'w-page', sort_order: 1 },
        {
          id: 'w-desc',
          parent_id: 'w-page',
          level: 1,
          path: ['w-page', 'w-desc'],
        },
      ],
      { 'c-page': 'w-page', 'c-desc': 'w-desc' },
    );

    await expect(
      h.stage.processItem(
        h.ctx(),
        item({ sourceId: 'c-page', title: 'Page', parentSourceId: 'c-desc' }),
      ),
    ).resolves.toMatchObject({ kind: 'skipped' });
    expect(h.rows.get('w-page')!.parent_id).toBeNull();
    expect(h.logs.some((l) => /descendants/.test(l.message))).toBe(true);
  });

  it('falls back to the deepest ancestor that keeps the page within level 10', async () => {
    const deep = Array.from({ length: 11 }, (_, i) => `w-${i}`);
    const h = harness(
      [
        ...deep.map((id, i) => ({
          id,
          parent_id: i ? deep[i - 1] : null,
          level: i,
          path: deep.slice(0, i + 1),
        })),
        { id: 'w-page', sort_order: 1 },
      ],
      { 'c-page': 'w-page', 'c-10': 'w-10', 'c-9': 'w-9', 'c-2': 'w-2' },
    );

    await h.stage.processItem(
      h.ctx(),
      item({
        sourceId: 'c-page',
        title: 'Page',
        parentSourceId: 'c-10',
        ancestors: ['c-2', 'c-9', 'c-10'],
      }),
    );

    expect(h.rows.get('w-page')).toMatchObject({ parent_id: 'w-9', level: 10 });
    expect(h.map.get('c-page')!.metadata).toMatchObject({
      depth_flattened: true,
    });
  });

  it('creates a missing container once, through the pages stage', async () => {
    const h = harness([], {});
    const folder = item({
      sourceId: 'f-1',
      title: 'Folder',
      contentKind: 'folder',
      parentSourceId: null,
    });

    await expect(h.stage.processItem(h.ctx(), folder)).resolves.toMatchObject({
      kind: 'created',
    });
    await expect(h.stage.processItem(h.ctx(), folder)).resolves.toMatchObject({
      kind: 'skipped',
    });
    expect(h.createContainer).toHaveBeenCalledTimes(1);
    expect(h.map.get('f-1')!.metadata).toMatchObject({ is_folder: true });
  });
});

describe('ConfluencePageHierarchyStage.produce', () => {
  it('seeds containers first, gates only on them, and sweeps stale paths before seeding', async () => {
    const h = harness(
      [
        { id: 'w-a' },
        { id: 'w-b', parent_id: 'w-a', level: 1, path: ['stale', 'w-b'] },
      ],
      {},
    );
    const adapter = {
      iteratePages: () => ({
        next: async () => ({
          done: false,
          value: {
            items: [
              {
                sourceId: 'p-1',
                title: 'In folder',
                parentSourceId: 'f-1',
                parentType: 'folder',
                ancestors: ['f-1'],
              },
              {
                sourceId: 'p-2',
                title: 'Under page',
                parentSourceId: 'p-0',
                parentType: 'page',
                ancestors: ['p-0'],
              },
              {
                sourceId: 'p-3',
                title: 'Lost folder',
                parentSourceId: 'f-404',
                parentType: 'folder',
                ancestors: ['f-404'],
              },
            ],
            nextCursor: null,
          },
        }),
      }),
      getFolder: async (id: string) =>
        id === 'f-1'
          ? {
              sourceId: 'f-1',
              title: 'Folder',
              contentKind: 'folder',
              parentSourceId: null,
              ancestors: [],
            }
          : null,
    };

    const result = await h.stage.produce(h.ctx(adapter), {
      checkpoint: null,
    } as any);

    expect(result.done).toBe(true);
    expect(result.items.map((s) => [s.sourceRef, s.parentSourceRef])).toEqual([
      ['f-1', undefined],
      ['p-1', 'f-1'],
      ['p-2', undefined],
      ['p-3', undefined],
    ]);
    expect(h.refreshSubtreePaths).toHaveBeenCalledWith('org-1', 'w-b');
    expect(h.rows.get('w-b')!.path).toEqual(['w-a', 'w-b']);
  });
});
