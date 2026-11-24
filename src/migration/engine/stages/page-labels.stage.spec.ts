/**
 * `page_labels` stage.
 *
 * The whole difficulty is a scope mismatch: a Confluence label is INSTANCE-global (a bare name, with
 * its own id, shared by every space) while `wiki_labels` is space-scoped with a UUID key. Resolving by
 * the source's label id would create a duplicate row per page. The customer's space makes that concrete
 * — 200 page→label rows across exactly ONE distinct name, so 199 of them must reuse the same row.
 */

jest.mock('../../mappers/page.mapper', () => ({ PAGE_ENTITY: 'page' }));

import { PageLabelsStage } from './page-labels.stage';
import type { StageContext } from './stage.interface';

const SPACE_UUID = '11111111-2222-4333-8444-555555555555';
const PAGE_UUID = '99999999-8888-4777-8666-555555555555';
const LABEL_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** Chainable stand-in for the Supabase query builder used by `findLabelId`. */
function fakeDb(labelRows: Record<string, string>) {
  const chain: any = {
    _name: '',
    from: () => chain,
    select: () => chain,
    eq: (col: string, val: string) => {
      if (col === 'name') chain._name = val;

      return chain;
    },
    filter: () => chain,
    in: () => chain,
    order: () => chain,
    range: () => chain,
    maybeSingle: () =>
      Promise.resolve({
        data: labelRows[chain._name] ? { id: labelRows[chain._name] } : null,
      }),
  };

  return chain;
}

function harness(opts: { existingLabels?: Record<string, string> } = {}) {
  const created: string[] = [];
  const setCalls: { pageId: string; spaceId: string; labelIds: string[] }[] =
    [];
  const known = { ...(opts.existingLabels ?? {}) };

  const labels = {
    createLabel: (spaceId: string, dto: { name: string }) => {
      created.push(dto.name);
      known[dto.name] = LABEL_UUID;

      return Promise.resolve({ id: LABEL_UUID });
    },
    setPageLabels: (
      pageId: string,
      spaceId: string,
      dto: { label_ids: string[] },
    ) => {
      setCalls.push({ pageId, spaceId, labelIds: dto.label_ids });

      return Promise.resolve([]);
    },
  };

  const stage = new PageLabelsStage(
    labels as any,
    {
      getClient: () => fakeDb(known),
    } as any,
  );

  const ctx = {
    orgId: 'org-1',
    dryRun: false,
    run: { id: 'run-1' },
    job: { source_ref: 'MT', connection_id: 'conn-1', id: 'job-1' },
    entityMap: {
      getTarget: async (
        _org: string,
        _conn: string,
        entityType: string,
      ): Promise<{ target_id: string; status?: string } | null> =>
        entityType === 'space'
          ? { target_id: SPACE_UUID, status: 'mapped' }
          : { target_id: PAGE_UUID },
      getExistingWikiPageTarget: async (
        _org: string,
        _conn: string,
        sourceId: string,
      ): Promise<{ target_id: string; status?: string } | null> =>
        sourceId === '1836449793' ? { target_id: PAGE_UUID } : null,
    },
    getAdapter: async () => ({ product: 'confluence' }),
    log: async () => undefined,
  } as unknown as StageContext;

  return { stage, ctx, created, setCalls };
}

const item = (labels: string[]) =>
  ({ payload: { pageSourceId: '1836449793', labels } }) as any;

describe('PageLabelsStage.processItem', () => {
  it('creates the label on first sight and assigns it', async () => {
    const h = harness();
    const out = await h.stage.processItem(h.ctx, item(['meeting-notes']));

    expect(h.created).toEqual(['meeting-notes']);
    expect(h.setCalls[0].labelIds).toEqual([LABEL_UUID]);
    expect(out.kind).toBe('updated');
  });

  it('REUSES an existing space label instead of creating a duplicate', async () => {
    // This is the case that repeats 199 times in the customer's space.
    const h = harness({ existingLabels: { 'meeting-notes': LABEL_UUID } });

    await h.stage.processItem(h.ctx, item(['meeting-notes']));

    expect(h.created).toEqual([]);
    expect(h.setCalls[0].labelIds).toEqual([LABEL_UUID]);
  });

  it('de-duplicates a name Confluence listed twice under different label ids', async () => {
    // `wiki_page_labels` has a unique (page, label) constraint, so a repeat would fail the write.
    const h = harness({ existingLabels: { dup: LABEL_UUID } });

    await h.stage.processItem(h.ctx, item(['dup', 'dup']));

    expect(h.setCalls[0].labelIds).toEqual([LABEL_UUID]);
  });

  it('caps the assignment at the 50 the DTO allows', async () => {
    const h = harness({ existingLabels: { a: LABEL_UUID } });
    const many = Array.from({ length: 60 }, () => 'a');

    await h.stage.processItem(h.ctx, item(many));

    expect(h.setCalls[0].labelIds.length).toBeLessThanOrEqual(50);
  });

  it('blocks on the page rather than failing when it is not migrated yet', async () => {
    const h = harness();

    (h.ctx as any).entityMap.getTarget = async (
      _org: string,
      _conn: string,
      entityType: string,
    ) =>
      entityType === 'space'
        ? { target_id: SPACE_UUID, status: 'mapped' }
        : null;
    (h.ctx as any).entityMap.getExistingWikiPageTarget = async () => null;

    const out = await h.stage.processItem(h.ctx, item(['x']));

    expect(out.kind).toBe('blocked');
    expect(h.setCalls).toHaveLength(0);
  });

  it('writes nothing in a dry run', async () => {
    const h = harness();

    (h.ctx as any).dryRun = true;
    (h.ctx as any).entityMap.getTarget = async (
      _org: string,
      _conn: string,
      entityType: string,
    ) =>
      entityType === 'space'
        ? { target_id: 'planned:MT', status: 'planned' }
        : { target_id: PAGE_UUID };

    const out = await h.stage.processItem(h.ctx, item(['x']));

    expect(out.kind).toBe('planned');
    expect(h.created).toEqual([]);
    expect(h.setCalls).toHaveLength(0);
  });

  it('rejects an item with no snapshot instead of silently doing nothing', async () => {
    const h = harness();

    await expect(
      h.stage.processItem(h.ctx, { payload: null } as any),
    ).rejects.toThrow(/missing its snapshot/);
  });

  it('skips a page whose label names are all blank', async () => {
    const h = harness();
    const out = await h.stage.processItem(h.ctx, item(['   ']));

    expect(out.kind).toBe('skipped');
    expect(h.setCalls).toHaveLength(0);
  });
});

describe('PageLabelsStage — resolveTargetSpace gate', () => {
  it('blocks until the space exists', async () => {
    const h = harness();

    // `resolveTargetSpace` reads the space crosswalk; with no space row the gate stays shut.
    (h.ctx as any).entityMap.getTarget = async (
      _org: string,
      _conn: string,
      entityType: string,
    ) => (entityType === 'space' ? null : { target_id: PAGE_UUID });
    (h.ctx as any).entityMap.getExistingWikiPageTarget = async () => ({
      target_id: PAGE_UUID,
    });

    const out = await h.stage.processItem(h.ctx, item(['x']));

    expect(out.kind).toBe('blocked');
  });
});

describe('PageLabelsStage.produce', () => {
  it('seeds one item per LABELLED page and skips unlabelled ones', async () => {
    const h = harness();
    const pages = [
      { source_id: 'p1' },
      { source_id: 'p2' },
      { source_id: 'p3' },
    ];

    (h.stage as any).supabaseAdmin = undefined;
    Object.defineProperty(h.stage, 'db', {
      get: () => ({
        from: () => {
          const c: any = {
            select: () => c,
            eq: () => c,
            filter: () => c,
            or: () => c,
            in: () => c,
            order: () => c,
            range: () => Promise.resolve({ data: pages, error: null }),
          };

          return c;
        },
      }),
    });

    (h.ctx as any).getAdapter = async () => ({
      product: 'confluence',
      getPageLabels: async (id: string) =>
        id === 'p2' ? [] : ['meeting-notes'],
    });

    const result = await h.stage.produce(h.ctx, { checkpoint: null } as any);

    expect(result.items.map((i) => i.sourceRef)).toEqual(['p1', 'p3']);
    expect(result.done).toBe(true);
  });

  it('keeps going when one page’s label read fails', async () => {
    const h = harness();
    const pages = [{ source_id: 'bad' }, { source_id: 'good' }];

    Object.defineProperty(h.stage, 'db', {
      get: () => ({
        from: () => {
          const c: any = {
            select: () => c,
            eq: () => c,
            filter: () => c,
            or: () => c,
            in: () => c,
            order: () => c,
            range: () => Promise.resolve({ data: pages, error: null }),
          };

          return c;
        },
      }),
    });

    (h.ctx as any).getAdapter = async () => ({
      product: 'confluence',
      getPageLabels: async (id: string) => {
        if (id === 'bad') throw new Error('403');

        return ['keep'];
      },
    });

    const result = await h.stage.produce(h.ctx, { checkpoint: null } as any);

    // The page already migrated; a label read must never take it down with it.
    expect(result.items.map((i) => i.sourceRef)).toEqual(['good']);
  });

  it('excludes folder containers while keeping pages that carry no is_folder key', async () => {
    // A container has no labels, comments or history to read. PostgREST `neq` compiles to SQL `<>`,
    // which is NULL for a missing key and would silently drop every ordinary page too — so the filter
    // must be `is.null OR neq.true`.
    const h = harness();
    const orFilters: string[] = [];

    Object.defineProperty(h.stage, 'db', {
      get: () => ({
        from: () => {
          const c: any = {
            select: () => c,
            eq: () => c,
            filter: () => c,
            or: (expr: string) => (orFilters.push(expr), c),
            in: () => c,
            order: () => c,
            range: () => Promise.resolve({ data: [], error: null }),
          };

          return c;
        },
      }),
    });

    await h.stage.produce(h.ctx, { checkpoint: null } as any);

    expect(orFilters).toEqual([
      'metadata->>is_folder.is.null,metadata->>is_folder.neq.true',
    ]);
  });
});
