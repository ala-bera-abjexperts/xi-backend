/**
 * `page_restrictions` — the FAIL-CLOSED contract.
 *
 * A restricted page exists because someone must not see it, so every failure path here has to end with
 * the page more restricted, not less. The dangerous case is subtle: `setPagePermissions` treats an
 * EMPTY permission list as "no custom permissions", which publishes the page to the whole space. So a
 * read restriction whose principals all fail to resolve must fail the item, never write.
 */

jest.mock('../../mappers/page.mapper', () => ({ PAGE_ENTITY: 'page' }));
jest.mock('../../../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (v: string | null | undefined) =>
    v == null ? null : String(v),
}));

import { PageRestrictionsStage } from './page-restrictions.stage';
import type { StageContext } from './stage.interface';

const SPACE = '11111111-2222-4333-8444-555555555555';
const PAGE = '99999999-8888-4777-8666-555555555555';
const USER_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function harness(userMap: Record<string, string> = {}) {
  const calls: { pageId: string; dto: any }[] = [];
  const logs: { level: string; message: string }[] = [];

  const permissions = {
    setPagePermissions: (pageId: string, _s: string, dto: any) => {
      calls.push({ pageId, dto });

      return Promise.resolve([]);
    },
  };

  const stage = new PageRestrictionsStage(
    permissions as any,
    {
      getClient: () => ({}),
    } as any,
  );

  const ctx = {
    orgId: 'org-1',
    dryRun: false,
    run: { id: 'run-1', created_by: USER_A },
    job: { source_ref: 'MT', connection_id: 'conn-1', id: 'job-1' },
    entityMap: {
      getTarget: async (
        _o: string,
        _c: string,
        entityType: string,
        sourceId: string,
      ) => {
        if (entityType === 'space')
          return { target_id: SPACE, status: 'mapped' };
        if (entityType === 'page') return { target_id: PAGE };
        if (entityType === 'user' && userMap[sourceId])
          return { target_id: userMap[sourceId] };

        return null;
      },
      getExistingWikiPageTarget: async (
        _org: string,
        _connection: string,
        sourceId: string,
      ) => (sourceId === '1836449793' ? { target_id: PAGE } : null),
      recordMapping: async () => undefined,
    },
    getAdapter: async () => ({ product: 'confluence' }),
    log: async (level: string, message: string) =>
      void logs.push({ level, message }),
  } as unknown as StageContext;

  return { stage, ctx, calls, logs };
}

const item = (restrictions: unknown[]) =>
  ({ payload: { pageSourceId: '1836449793', restrictions } }) as any;

describe('PageRestrictionsStage.processItem', () => {
  it('maps a read restriction to can_view for the resolved user', async () => {
    const h = harness({ 'acc-1': USER_A });
    const out = await h.stage.processItem(
      h.ctx,
      item([
        { operation: 'read', userSourceIds: ['acc-1'], groupSourceIds: [] },
      ]),
    );

    expect(h.calls[0].dto.permissions).toEqual([
      {
        entity_type: 'user',
        entity_id: USER_A,
        can_view: true,
        can_edit: false,
        can_delete: false,
      },
    ]);
    expect(out.kind).toBe('updated');
  });

  it('treats an update restriction as implying read, since Confluence does', async () => {
    const h = harness({ 'acc-1': USER_A });

    await h.stage.processItem(
      h.ctx,
      item([
        { operation: 'update', userSourceIds: ['acc-1'], groupSourceIds: [] },
      ]),
    );

    expect(h.calls[0].dto.permissions[0]).toMatchObject({
      can_view: true,
      can_edit: true,
    });
  });

  it('REFUSES to write when a read restriction resolves to nobody', async () => {
    // The critical case: an empty list would clear has_custom_permissions and expose the page.
    const h = harness({});

    await expect(
      h.stage.processItem(
        h.ctx,
        item([
          { operation: 'read', userSourceIds: ['ghost'], groupSourceIds: [] },
        ]),
      ),
    ).rejects.toThrow(/empty allow-list|visible to the whole space/);

    expect(h.calls).toHaveLength(0);
  });

  it('FAILS a group-only READ restriction, because skipping it would expose the page', async () => {
    // The target has no group ACL for wiki pages. Silently skipping a read restriction would leave the
    // page visible to the whole space, so the operator has to be told.
    const h = harness({});

    await expect(
      h.stage.processItem(
        h.ctx,
        item([
          { operation: 'read', userSourceIds: [], groupSourceIds: ['grp-1'] },
        ]),
      ),
    ).rejects.toThrow(/only by group|empty allow-list/);

    expect(h.calls).toHaveLength(0);
  });

  it('skips a group-only UPDATE restriction, which exposes nothing', async () => {
    // An update-only restriction means the page was already readable by everyone at the source, so
    // not reproducing it does not widen visibility.
    const h = harness({});
    const out = await h.stage.processItem(
      h.ctx,
      item([
        { operation: 'update', userSourceIds: [], groupSourceIds: ['grp-1'] },
      ]),
    );

    expect(out.kind).toBe('skipped');
    expect(h.calls).toHaveLength(0);
    expect(h.logs.some((l) => /only by group/.test(l.message))).toBe(true);
  });

  it('warns when the allow-list ends up NARROWER than the source', async () => {
    const h = harness({ 'acc-1': USER_A });

    await h.stage.processItem(
      h.ctx,
      item([
        {
          operation: 'read',
          userSourceIds: ['acc-1', 'ghost'],
          groupSourceIds: ['grp-1'],
        },
      ]),
    );

    expect(h.calls).toHaveLength(1);
    expect(h.logs.some((l) => /NARROWER/.test(l.message))).toBe(true);
  });

  it('propagates to children, as Confluence inheritance does', async () => {
    const h = harness({ 'acc-1': USER_A });

    await h.stage.processItem(
      h.ctx,
      item([
        { operation: 'read', userSourceIds: ['acc-1'], groupSourceIds: [] },
      ]),
    );

    expect(h.calls[0].dto.apply_to_children).toBe(true);
  });

  it('writes nothing in a dry run', async () => {
    const h = harness({ 'acc-1': USER_A });

    (h.ctx as any).dryRun = true;

    const out = await h.stage.processItem(
      h.ctx,
      item([
        { operation: 'read', userSourceIds: ['acc-1'], groupSourceIds: [] },
      ]),
    );

    expect(out.kind).toBe('planned');
    expect(h.calls).toHaveLength(0);
  });

  it('rejects an item with no snapshot', async () => {
    const h = harness();

    await expect(
      h.stage.processItem(h.ctx, { payload: null } as any),
    ).rejects.toThrow(/missing its snapshot/);
  });
});
