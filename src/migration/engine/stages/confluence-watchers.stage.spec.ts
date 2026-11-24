import { AtlassianRequestError } from '../../adapters/http/atlassian-http-client';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { IConfluenceSourceAdapter } from '../../adapters/source-adapter.interface';
import type { PermissionsService } from '../../../permissions/permissions.service';
import type { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import type { WikiPermissionsService } from '../../../wiki/wiki-permissions.service';
import { ConfluenceWatchersStage } from './confluence-watchers.stage';
import {
  MigrationItemError,
  type MigrationRunItemRow,
  type StageContext,
} from './stage.interface';

type DbResult = {
  data: unknown;
  error: { message: string; code?: string } | null;
};

function query(result: DbResult) {
  const q: Record<
    string,
    jest.Mock | ((fn: (value: DbResult) => unknown) => unknown)
  > = {};
  for (const method of [
    'select',
    'eq',
    'ilike',
    'insert',
    'upsert',
    'limit',
    'order',
    'range',
    'filter',
    'or',
    'in',
    'is',
  ])
    q[method] = jest.fn(() => q);
  q['maybeSingle'] = jest.fn().mockResolvedValue(result);
  q['single'] = jest.fn().mockResolvedValue(result);
  q['then'] = (fn: (value: DbResult) => unknown) =>
    Promise.resolve(result).then(fn);
  return q as Record<string, jest.Mock> & PromiseLike<DbResult>;
}

const watcher = (overrides: Record<string, unknown> = {}) => ({
  sourceId: 'source-user',
  displayName: 'Source User',
  email: 'source@example.test',
  active: true,
  ...overrides,
});

function item(scope: 'space' | 'page' = 'page'): MigrationRunItemRow {
  return {
    source_ref: `${scope === 'page' ? 'page-1' : 'SPACE'}:source-user`,
    payload: {
      scope,
      spaceSourceId: 'SPACE',
      ...(scope === 'page' ? { pageSourceId: 'page-1' } : {}),
      watcher: watcher(),
    },
  } as unknown as MigrationRunItemRow;
}

function setup(options?: {
  dryRun?: boolean;
  userTarget?: Record<string, unknown> | null;
  pageTarget?: Record<string, unknown> | null;
  db?: Record<string, ReturnType<typeof query>[]>;
}) {
  const getSpaceWatchers = jest.fn().mockResolvedValue({
    items: [watcher(), watcher()],
    nextCursor: 'space-next',
    total: null,
  });
  const getPageWatchers = jest.fn().mockResolvedValue({
    items: [watcher()],
    nextCursor: null,
    total: null,
  });
  const adapter = {
    product: 'confluence',
    getSpaceWatchers,
    getPageWatchers,
  } as unknown as IConfluenceSourceAdapter;
  const tables = options?.db ?? {};
  const from = jest.fn((table: string) => {
    const next = tables[table]?.shift();
    if (!next) throw new Error(`No response configured for ${table}`);
    return next;
  });
  const entityMap = {
    getTarget: jest.fn((_org, _conn, type) => {
      if (type === 'space') return { status: 'mapped', target_id: 'space-1' };
      if (type === 'page')
        return (
          options?.pageTarget ?? { status: 'mapped', target_id: 'page-target' }
        );
      return options?.userTarget === undefined
        ? { status: 'mapped', target_id: 'user-1', is_placeholder: false }
        : options.userTarget;
    }),
    getExistingWikiPageTarget: jest.fn().mockResolvedValue(
      options?.pageTarget === undefined
        ? {
            status: 'mapped',
            target_id: 'page-target',
            target_table: 'wiki_pages',
          }
        : options.pageTarget,
    ),
    recordMapping: jest.fn().mockResolvedValue({}),
  };
  const log = jest.fn();
  const ctx = {
    orgId: 'org-1',
    run: { id: 'run-1', config_snapshot: {} },
    job: {
      id: 'job-1',
      connection_id: 'conn-1',
      source_ref: 'SPACE',
      scope: {},
    },
    dryRun: options?.dryRun ?? false,
    getAdapter: jest.fn().mockResolvedValue(adapter),
    entityMap,
    log,
  } as unknown as StageContext;
  const permissions = {
    getUserSpacePermissions: jest.fn().mockResolvedValue({
      isMember: true,
      permissions: { view_wiki_pages: true },
    }),
  };
  const wikiPermissions = {
    assertPageAccess: jest.fn().mockResolvedValue(undefined),
  };
  const stage = new ConfluenceWatchersStage(
    { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
    permissions as unknown as PermissionsService,
    wikiPermissions as unknown as WikiPermissionsService,
  );
  return {
    stage,
    ctx,
    adapter,
    getSpaceWatchers,
    getPageWatchers,
    from,
    entityMap,
    permissions,
    wikiPermissions,
    log,
  };
}

describe('ConfluenceWatchersStage', () => {
  it('pages space watchers first and emits stable deduplicated relationship references', async () => {
    const { stage, ctx, getSpaceWatchers } = setup();
    const result = await stage.produce(ctx, {
      checkpoint: null,
    } as MigrationRunItemRow);

    expect(getSpaceWatchers).toHaveBeenCalledWith('SPACE', {
      cursor: null,
      pageSize: 100,
    });
    expect(result).toEqual({
      items: [
        expect.objectContaining({
          entityType: 'confluence_space_watcher',
          sourceRef: 'SPACE:source-user',
        }),
      ],
      nextCheckpoint: {
        scope: 'space',
        watcherCursor: 'space-next',
        seenWatcherIds: ['source-user'],
      },
      done: false,
    });
  });

  it('resumes the current mapped page cursor and excludes folder mappings', async () => {
    const pages = query({ data: [{ source_id: 'page-1' }], error: null });
    const { stage, ctx, getPageWatchers } = setup({
      db: { migration_entity_map: [pages] },
    });
    getPageWatchers.mockResolvedValue({
      items: [watcher()],
      nextCursor: 'watch-next',
      total: null,
    });

    const result = await stage.produce(ctx, {
      checkpoint: {
        scope: 'page',
        pageOffset: 3,
        pageSourceId: 'page-1',
        watcherCursor: 'old',
      },
    } as unknown as MigrationRunItemRow);

    expect(pages.filter).toHaveBeenCalledWith(
      'metadata->>space_ref',
      'eq',
      'SPACE',
    );
    expect(pages.or).toHaveBeenCalledWith(
      'metadata->>is_folder.is.null,metadata->>is_folder.neq.true',
    );
    expect(pages.range).toHaveBeenCalledWith(3, 3);
    expect(getPageWatchers).toHaveBeenCalledWith('page-1', {
      cursor: 'old',
      pageSize: 100,
    });
    expect(result.nextCheckpoint).toEqual({
      scope: 'page',
      pageOffset: 3,
      pageSourceId: 'page-1',
      watcherCursor: 'watch-next',
      visitedCursors: ['old'],
      seenWatcherIds: ['source-user'],
    });
  });

  it('reports unreadable source watcher pages and advances instead of treating them as complete', async () => {
    const { stage, ctx, getSpaceWatchers, log } = setup();
    getSpaceWatchers.mockRejectedValue(
      new AtlassianRequestError('forbidden', 403),
    );

    await expect(
      stage.produce(ctx, { checkpoint: null } as MigrationRunItemRow),
    ).resolves.toEqual({
      items: [],
      nextCheckpoint: { scope: 'page', pageOffset: 0 },
      done: false,
    });
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringMatching(/watcher/i),
      expect.objectContaining({ status: 403 }),
    );
  });

  it.each([
    [
      'placeholder',
      { status: 'placeholder', target_id: 'user-1', is_placeholder: true },
      watcher(),
    ],
    [
      'inactive source',
      { status: 'mapped', target_id: 'user-1', is_placeholder: false },
      watcher({ active: false }),
    ],
    ['unmatched', null, watcher({ email: undefined })],
  ])(
    'skips and reports %s users without creating anything',
    async (_label, userTarget, sourceWatcher) => {
      const { stage, ctx, from, log } = setup({ userTarget });
      const value = item();
      value.payload = { ...(value.payload ?? {}), watcher: sourceWatcher };

      await expect(stage.processItem(ctx, value)).resolves.toMatchObject({
        kind: 'skipped',
      });
      expect(log).toHaveBeenCalledWith(
        'warn',
        expect.any(String),
        expect.any(Object),
      );
      expect(from).not.toHaveBeenCalledWith('wiki_watches');
    },
  );

  it('validates a mapped active org member with page access before inserting and recording', async () => {
    const user = query({
      data: { id: 'user-1', is_active: true },
      error: null,
    });
    const member = query({ data: { user_id: 'user-1' }, error: null });
    const inserted = query({ data: { id: 'watch-1' }, error: null });
    const { stage, ctx, entityMap, wikiPermissions } = setup({
      db: {
        users: [user],
        organization_members: [member],
        wiki_watches: [inserted],
      },
    });

    await expect(stage.processItem(ctx, item())).resolves.toEqual({
      kind: 'created',
      targetId: 'watch-1',
      targetTable: 'wiki_watches',
    });
    expect(wikiPermissions.assertPageAccess).toHaveBeenCalledWith(
      'page-target',
      'user-1',
      'space-1',
      'can_view',
    );
    expect(inserted.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: 'org-1',
        space_id: 'space-1',
        page_id: 'page-target',
        scope: 'page',
        user_id: 'user-1',
      }),
      { onConflict: 'space_id,page_id,user_id' },
    );
    expect(inserted.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      entityMap.recordMapping.mock.invocationCallOrder[0],
    );
  });

  it('resolves a hidden-email Server watcher through its legacy username crosswalk', async () => {
    const user = query({
      data: { id: 'legacy-user', is_active: true },
      error: null,
    });
    const member = query({ data: { user_id: 'legacy-user' }, error: null });
    const inserted = query({ data: { id: 'watch-legacy' }, error: null });
    const { stage, ctx, entityMap } = setup({
      userTarget: null,
      db: {
        users: [user],
        organization_members: [member],
        wiki_watches: [inserted],
      },
    });
    entityMap.getTarget.mockImplementation((_org, _conn, type, sourceId) => {
      if (type === 'space')
        return Promise.resolve({ status: 'mapped', target_id: 'space-1' });
      if (type === 'page')
        return Promise.resolve({ status: 'mapped', target_id: 'page-target' });
      return Promise.resolve(
        sourceId === 'legacy-name'
          ? {
              status: 'mapped',
              target_id: 'legacy-user',
              is_placeholder: false,
            }
          : null,
      );
    });
    const value = item('space');
    value.payload = {
      ...(value.payload ?? {}),
      watcher: watcher({
        sourceId: 'stable-key',
        username: 'legacy-name',
        email: undefined,
      }),
    };

    await expect(stage.processItem(ctx, value)).resolves.toMatchObject({
      targetId: 'watch-legacy',
    });
    expect(entityMap.getTarget.mock.calls.slice(-2)).toEqual([
      ['org-1', 'conn-1', 'user', 'stable-key'],
      ['org-1', 'conn-1', 'user', 'legacy-name'],
    ]);
  });

  it('does not write a subscription or identity data in dry run', async () => {
    const user = query({
      data: { id: 'user-1', is_active: true },
      error: null,
    });
    const member = query({ data: { user_id: 'user-1' }, error: null });
    const { stage, ctx, from } = setup({
      dryRun: true,
      db: { users: [user], organization_members: [member] },
    });

    await expect(stage.processItem(ctx, item('space'))).resolves.toEqual({
      kind: 'planned',
    });
    expect(from).not.toHaveBeenCalledWith('wiki_watches');
    expect(from).not.toHaveBeenCalledWith('invitations');
    expect(from).not.toHaveBeenCalledWith('auth.users');
  });

  it('plans a not-yet-created page in an existing target space without a physical ACL lookup', async () => {
    const user = query({
      data: { id: 'user-1', is_active: true },
      error: null,
    });
    const member = query({ data: { user_id: 'user-1' }, error: null });
    const { stage, ctx, wikiPermissions } = setup({
      dryRun: true,
      pageTarget: { status: 'planned', target_id: 'planned:page-1' },
      db: { users: [user], organization_members: [member] },
    });

    await expect(stage.processItem(ctx, item('page'))).resolves.toEqual({
      kind: 'planned',
    });
    expect(wikiPermissions.assertPageAccess).not.toHaveBeenCalled();
  });

  it('skips only a genuine page authorization denial', async () => {
    const user = query({
      data: { id: 'user-1', is_active: true },
      error: null,
    });
    const member = query({ data: { user_id: 'user-1' }, error: null });
    const { stage, ctx, wikiPermissions, from } = setup({
      db: { users: [user], organization_members: [member] },
    });
    wikiPermissions.assertPageAccess.mockRejectedValue(
      new ForbiddenException('denied'),
    );

    await expect(stage.processItem(ctx, item('page'))).resolves.toMatchObject({
      kind: 'skipped',
    });
    expect(from).not.toHaveBeenCalledWith('wiki_watches');
  });

  it.each([
    ['operational failure', new Error('permission database unavailable')],
    ['stale mapped page', new NotFoundException('Page not found')],
  ])(
    'retries page ACL %s instead of silently losing the watcher',
    async (_label, failure) => {
      const user = query({
        data: { id: 'user-1', is_active: true },
        error: null,
      });
      const member = query({ data: { user_id: 'user-1' }, error: null });
      const { stage, ctx, wikiPermissions, from } = setup({
        db: { users: [user], organization_members: [member] },
      });
      wikiPermissions.assertPageAccess.mockRejectedValue(failure);

      let caught: unknown;
      try {
        await stage.processItem(ctx, item('page'));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MigrationItemError);
      expect((caught as MigrationItemError).errorClass).toBe('transient');
      expect((caught as MigrationItemError).message).toMatch(
        /verify.*page access/i,
      );
      expect(from).not.toHaveBeenCalledWith('wiki_watches');
    },
  );

  it('allows unknown Cloud activity only after active-member and current-access checks', async () => {
    const user = query({
      data: { id: 'user-1', is_active: true },
      error: null,
    });
    const member = query({ data: { user_id: 'user-1' }, error: null });
    const { stage, ctx, permissions, log } = setup({
      dryRun: true,
      db: { users: [user], organization_members: [member] },
    });
    const value = item('space');
    value.payload = {
      ...(value.payload ?? {}),
      watcher: watcher({ active: null }),
    };

    await expect(stage.processItem(ctx, value)).resolves.toEqual({
      kind: 'planned',
    });
    expect(permissions.getUserSpacePermissions.mock.calls).toContainEqual([
      'user-1',
      'org-1',
      'space-1',
    ]);
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringMatching(/activity is unknown/),
      expect.any(Object),
    );
  });

  it('does not import an implicit org-admin watcher without direct space membership', async () => {
    const user = query({
      data: { id: 'user-1', is_active: true },
      error: null,
    });
    const member = query({ data: { user_id: 'user-1' }, error: null });
    const directSpaceMember = query({ data: null, error: null });
    const groups = query({ data: [], error: null });
    const roles = query({ data: [], error: null });
    const { stage, ctx, permissions, from } = setup({
      dryRun: true,
      db: {
        users: [user],
        organization_members: [member],
        space_members: [directSpaceMember],
        user_group_members: [groups],
        user_role_assignments: [roles],
      },
    });
    permissions.getUserSpacePermissions.mockResolvedValue({
      isMember: true,
      globalRole: 'admin',
      permissions: { view_wiki_pages: true },
    });

    await expect(stage.processItem(ctx, item('space'))).resolves.toMatchObject({
      kind: 'skipped',
    });
    expect(directSpaceMember.eq).toHaveBeenCalledWith(
      'spaces.organization_id',
      'org-1',
    );
    expect(from).not.toHaveBeenCalledWith('wiki_watches');
  });

  it.each([
    [
      'group',
      [
        {
          group_id: 'group-1',
          group: { organization_id: 'org-1', is_deleted: false },
        },
      ],
      [],
      [{ member_type: 'group', group_id: 'group-1', role_id: null }],
    ],
    [
      'role',
      [],
      [{ role_id: 'role-1' }],
      [{ member_type: 'role', group_id: null, role_id: 'role-1' }],
    ],
  ])(
    'accepts an org admin with explicit %s space membership',
    async (_kind, groupRows, roleRows, spaceRows) => {
      const user = query({
        data: { id: 'user-1', is_active: true },
        error: null,
      });
      const member = query({ data: { user_id: 'user-1' }, error: null });
      const direct = query({ data: null, error: null });
      const groups = query({ data: groupRows, error: null });
      const roles = query({ data: roleRows, error: null });
      const indirect = query({ data: spaceRows, error: null });
      const { stage, ctx, permissions } = setup({
        dryRun: true,
        db: {
          users: [user],
          organization_members: [member],
          space_members: [direct, indirect],
          user_group_members: [groups],
          user_role_assignments: [roles],
        },
      });
      permissions.getUserSpacePermissions.mockResolvedValue({
        isMember: true,
        globalRole: 'admin',
        permissions: { view_wiki_pages: true },
      });

      await expect(stage.processItem(ctx, item('space'))).resolves.toEqual({
        kind: 'planned',
      });
    },
  );

  it('stops a non-adjacent cursor cycle and awaits its report', async () => {
    const { stage, ctx, getSpaceWatchers, log } = setup();
    getSpaceWatchers.mockResolvedValue({
      items: [watcher({ sourceId: 'second' })],
      nextCursor: 'cursor-a',
      total: null,
    });

    const result = await stage.produce(ctx, {
      checkpoint: {
        scope: 'space',
        watcherCursor: 'cursor-b',
        visitedCursors: ['cursor-a'],
        seenWatcherIds: ['source-user'],
      },
    } as unknown as MigrationRunItemRow);

    expect(result).toEqual({
      items: [
        expect.objectContaining({
          sourceRef: 'SPACE:second',
          entityType: 'confluence_space_watcher',
        }),
      ],
      nextCheckpoint: { scope: 'page', pageOffset: 0 },
      done: false,
    });
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringMatching(/repeated a cursor/),
      expect.any(Object),
    );
  });

  it('stops when the next source page repeats only identities already seen', async () => {
    const { stage, ctx, getSpaceWatchers, log } = setup();
    getSpaceWatchers.mockResolvedValue({
      items: [watcher()],
      nextCursor: 'cursor-c',
      total: null,
    });

    const result = await stage.produce(ctx, {
      checkpoint: {
        scope: 'space',
        watcherCursor: 'cursor-b',
        visitedCursors: ['cursor-a'],
        seenWatcherIds: ['source-user'],
      },
    } as unknown as MigrationRunItemRow);

    expect(result.items).toEqual([]);
    expect(result.nextCheckpoint).toEqual({ scope: 'page', pageOffset: 0 });
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringMatching(/no identity progress/),
      expect.any(Object),
    );
  });
});
