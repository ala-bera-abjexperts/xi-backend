import type { PermissionsService } from '../../../permissions/permissions.service';
import type { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import type {
  NormalizedIssue,
  NormalizedWatcher,
} from '../../model/normalized';
import type { IJiraSourceAdapter } from '../../adapters/source-adapter.interface';
import { WatchersStage } from './watchers.stage';
import type { MigrationRunItemRow, StageContext } from './stage.interface';

type DbResult = { data: unknown; error: { message: string } | null };

function query(result: DbResult) {
  const q: Record<
    string,
    jest.Mock | ((fn: (value: DbResult) => unknown) => unknown)
  > = {};
  for (const method of ['select', 'eq', 'upsert', 'limit', 'order', 'range']) {
    q[method] = jest.fn(() => q);
  }
  q['maybeSingle'] = jest.fn().mockResolvedValue(result);
  q['single'] = jest.fn().mockResolvedValue(result);
  q['then'] = (fn: (value: DbResult) => unknown) =>
    Promise.resolve(result).then(fn);
  return q as Record<string, jest.Mock> & PromiseLike<DbResult>;
}

const watcher = (
  overrides: Partial<NormalizedWatcher> = {},
): NormalizedWatcher => ({
  sourceId: 'source-user',
  displayName: 'Source User',
  email: 'source@example.com',
  active: true,
  ...overrides,
});

function issue(id: string, key = `PROJ-${id}`): NormalizedIssue {
  return { sourceId: id, key, summary: key } as NormalizedIssue;
}

function item(value: NormalizedWatcher = watcher()): MigrationRunItemRow {
  return {
    source_ref: `issue-1:${value.sourceId}`,
    payload: { issueSourceId: 'issue-1', issueKey: 'PROJ-1', watcher: value },
  } as unknown as MigrationRunItemRow;
}

function setup(options?: {
  dryRun?: boolean;
  targetSpaceId?: string | null;
  issueTarget?: Record<string, unknown> | null;
  userTarget?: Record<string, unknown> | null;
  db?: Record<string, ReturnType<typeof query>[]>;
}) {
  const getIssueWatchers = jest.fn().mockResolvedValue({
    total: 2,
    watchers: [watcher(), watcher({ sourceId: 'source-user-2' })],
  });
  const iterateIssues = jest.fn(async function* () {
    await Promise.resolve();
    yield {
      items: [issue('issue-1'), issue('issue-2')],
      nextCursor: 'next',
      total: 4,
    };
  });
  const adapter = {
    product: 'jira',
    listProjects: jest.fn(),
    iterateIssues,
    getIssueWatchers,
  } as unknown as IJiraSourceAdapter;
  const tables = options?.db ?? {};
  const from = jest.fn((table: string) => {
    const next = tables[table]?.shift();
    if (!next) throw new Error(`No response configured for ${table}`);
    return next;
  });
  const getTarget = jest.fn((_org, _conn, type) =>
    Promise.resolve(
      type === 'issue'
        ? options && 'issueTarget' in options
          ? options.issueTarget
          : { status: 'mapped', target_id: 'task-1' }
        : options && 'userTarget' in options
          ? options.userTarget
          : {
              status: 'mapped',
              target_id: 'user-1',
              is_placeholder: false,
            },
    ),
  );
  const entityMap = {
    getTarget,
    recordMapping: jest.fn().mockResolvedValue({}),
  };
  const getAdapter = jest.fn().mockResolvedValue(adapter);
  const log = jest.fn();
  const ctx = {
    orgId: 'org-1',
    run: { id: 'run-1' },
    job: {
      id: 'job-1',
      connection_id: 'conn-1',
      source_ref: 'PROJ',
      target_space_id: options?.targetSpaceId ?? null,
      scope: {},
    },
    dryRun: options?.dryRun ?? false,
    getAdapter,
    entityMap,
    log,
  } as unknown as StageContext;
  const permissions = {
    getUserSpacePermissions: jest.fn().mockResolvedValue({
      isMember: true,
      permissions: { view_tasks: true },
    }),
  };
  const stage = new WatchersStage(
    { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
    permissions as unknown as PermissionsService,
  );
  return {
    stage,
    ctx,
    adapter,
    getIssueWatchers,
    iterateIssues,
    from,
    entityMap,
    permissions,
    getAdapter,
    log,
  };
}

describe('WatchersStage', () => {
  it('pages issues and emits stable deduplicated relationship references', async () => {
    const { stage, ctx, iterateIssues, getAdapter, getIssueWatchers } = setup();
    getIssueWatchers
      .mockResolvedValueOnce({ total: 2, watchers: [watcher(), watcher()] })
      .mockResolvedValueOnce({ total: 0, watchers: [] });

    const result = await stage.produce(ctx, {
      checkpoint: { cursor: 'old' },
    } as MigrationRunItemRow);

    expect(result).toMatchObject({
      done: false,
      nextCheckpoint: { cursor: 'next' },
    });
    expect(result.items).toEqual([
      expect.objectContaining({
        entityType: 'watcher',
        sourceRef: 'issue-1:source-user',
      }),
    ]);
    expect(getAdapter).toHaveBeenCalledTimes(1);
    expect(iterateIssues).toHaveBeenCalledWith(
      'PROJ',
      expect.objectContaining({ cursor: 'old', pageSize: 50 }),
    );
  });

  it('blocks until the issue target exists', async () => {
    const { stage, ctx, from } = setup({ issueTarget: null });

    await expect(stage.processItem(ctx, item())).resolves.toEqual({
      kind: 'blocked',
      waitingFor: { entityType: 'issue', sourceId: 'issue-1' },
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('upserts a mapped active real org member before recording the crosswalk', async () => {
    const user = query({
      data: { id: 'user-1', is_active: true },
      error: null,
    });
    const member = query({ data: { role: 'member' }, error: null });
    const task = query({
      data: { id: 'task-1', space_id: 'space-1' },
      error: null,
    });
    const subscription = query({ data: { id: 'watch-1' }, error: null });
    const { stage, ctx, entityMap } = setup({
      db: {
        users: [user],
        organization_members: [member],
        tasks: [task],
        task_watchers: [subscription],
      },
    });

    await expect(stage.processItem(ctx, item())).resolves.toEqual({
      kind: 'created',
      targetId: 'watch-1',
      targetTable: 'task_watchers',
    });
    expect(subscription.upsert).toHaveBeenCalledWith(
      { organization_id: 'org-1', task_id: 'task-1', user_id: 'user-1' },
      { onConflict: 'task_id,user_id' },
    );
    expect(subscription.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      entityMap.recordMapping.mock.invocationCallOrder[0],
    );
  });

  it.each([
    [
      'placeholder',
      { status: 'placeholder', target_id: 'user-1', is_placeholder: true },
      watcher(),
    ],
    [
      'inactive source watcher',
      { status: 'mapped', target_id: 'user-1', is_placeholder: false },
      watcher({ active: false }),
    ],
    ['unmatched', null, watcher({ email: undefined })],
  ])(
    'skips and logs %s identities without writes',
    async (_label, userTarget, sourceWatcher) => {
      const { stage, ctx, from, log } = setup({ userTarget });

      await expect(
        stage.processItem(ctx, item(sourceWatcher)),
      ).resolves.toMatchObject({ kind: 'skipped' });
      expect(log).toHaveBeenCalledWith(
        'warn',
        expect.any(String),
        expect.any(Object),
      );
      expect(from).not.toHaveBeenCalledWith('task_watchers');
    },
  );

  it('skips a crosswalk target whose existing user is inactive', async () => {
    const inactive = query({ data: null, error: null });
    const { stage, ctx, from } = setup({ db: { users: [inactive] } });

    await expect(stage.processItem(ctx, item())).resolves.toMatchObject({
      kind: 'skipped',
    });
    expect(from).not.toHaveBeenCalledWith('task_watchers');
  });

  it('skips an active user who is not a member of the target organization', async () => {
    const user = query({
      data: { id: 'user-1', is_active: true },
      error: null,
    });
    const member = query({ data: null, error: null });
    const { stage, ctx, from } = setup({
      db: { users: [user], organization_members: [member] },
    });

    await expect(stage.processItem(ctx, item())).resolves.toMatchObject({
      kind: 'skipped',
    });
    expect(from).not.toHaveBeenCalledWith('task_watchers');
  });

  it('skips a member who cannot currently view the target task', async () => {
    const user = query({
      data: { id: 'user-1', is_active: true },
      error: null,
    });
    const member = query({ data: { role: 'member' }, error: null });
    const task = query({
      data: { id: 'task-1', space_id: 'space-1' },
      error: null,
    });
    const { stage, ctx, from, permissions } = setup({
      db: { users: [user], organization_members: [member], tasks: [task] },
    });
    permissions.getUserSpacePermissions.mockResolvedValue({
      isMember: true,
      permissions: { view_tasks: false },
    });

    await expect(stage.processItem(ctx, item())).resolves.toMatchObject({
      kind: 'skipped',
    });
    expect(from).not.toHaveBeenCalledWith('task_watchers');
  });

  it('allows unknown source activity only after current target validation', async () => {
    const user = query({
      data: { id: 'user-1', is_active: true },
      error: null,
    });
    const member = query({ data: { role: 'member' }, error: null });
    const task = query({
      data: { id: 'task-1', space_id: 'space-1' },
      error: null,
    });
    const subscription = query({ data: { id: 'watch-unknown' }, error: null });
    const { stage, ctx, log } = setup({
      db: {
        users: [user],
        organization_members: [member],
        tasks: [task],
        task_watchers: [subscription],
      },
    });

    await expect(
      stage.processItem(ctx, item(watcher({ active: null }))),
    ).resolves.toMatchObject({ targetId: 'watch-unknown' });
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('activity is unknown'),
      expect.objectContaining({ reason: 'source_activity_unknown' }),
    );
  });

  it('falls back to one exact-email active existing organization member', async () => {
    const emailMatch = query({
      data: [
        {
          user_id: 'email-user',
          users: {
            id: 'email-user',
            is_active: true,
            email: ' SOURCE@Example.Com ',
          },
        },
      ],
      error: null,
    });
    const user = query({
      data: { id: 'email-user', is_active: true },
      error: null,
    });
    const member = query({ data: { role: 'member' }, error: null });
    const task = query({
      data: { id: 'task-1', space_id: 'space-1' },
      error: null,
    });
    const subscription = query({ data: { id: 'watch-email' }, error: null });
    const { stage, ctx } = setup({
      userTarget: null,
      db: {
        organization_members: [emailMatch, member],
        users: [user],
        tasks: [task],
        task_watchers: [subscription],
      },
    });

    await expect(stage.processItem(ctx, item())).resolves.toMatchObject({
      targetId: 'watch-email',
    });
    expect(emailMatch.range).toHaveBeenCalledWith(0, 499);
    expect(emailMatch).not.toHaveProperty('ilike');
  });

  it('resolves a hidden-email Server watcher through its legacy username crosswalk', async () => {
    const user = query({
      data: { id: 'legacy-user', is_active: true },
      error: null,
    });
    const member = query({ data: { role: 'member' }, error: null });
    const task = query({
      data: { id: 'task-1', space_id: 'space-1' },
      error: null,
    });
    const subscription = query({ data: { id: 'watch-legacy' }, error: null });
    const { stage, ctx, entityMap } = setup({
      userTarget: null,
      db: {
        users: [user],
        organization_members: [member],
        tasks: [task],
        task_watchers: [subscription],
      },
    });
    entityMap.getTarget.mockImplementation((_org, _conn, type, sourceId) => {
      if (type === 'issue')
        return Promise.resolve({ status: 'mapped', target_id: 'task-1' });
      return Promise.resolve(
        sourceId === 'old-login'
          ? {
              status: 'mapped',
              target_id: 'legacy-user',
              is_placeholder: false,
            }
          : null,
      );
    });

    await expect(
      stage.processItem(
        ctx,
        item(
          watcher({
            sourceId: 'JIRAUSER100',
            username: 'old-login',
            email: undefined,
          }),
        ),
      ),
    ).resolves.toMatchObject({ targetId: 'watch-legacy' });
    expect(entityMap.getTarget.mock.calls.slice(1, 3)).toEqual([
      ['org-1', 'conn-1', 'user', 'JIRAUSER100'],
      ['org-1', 'conn-1', 'user', 'old-login'],
    ]);
  });

  it('treats percent and underscore as literal email characters', async () => {
    const emailMatch = query({
      data: [
        {
          user_id: 'literal-user',
          users: {
            id: 'literal-user',
            is_active: true,
            email: ' %_USER@Example.COM ',
          },
        },
      ],
      error: null,
    });
    const user = query({
      data: { id: 'literal-user', is_active: true },
      error: null,
    });
    const member = query({ data: { role: 'member' }, error: null });
    const task = query({
      data: { id: 'task-1', space_id: 'space-1' },
      error: null,
    });
    const subscription = query({ data: { id: 'watch-literal' }, error: null });
    const { stage, ctx } = setup({
      userTarget: null,
      db: {
        organization_members: [emailMatch, member],
        users: [user],
        tasks: [task],
        task_watchers: [subscription],
      },
    });

    await expect(
      stage.processItem(ctx, item(watcher({ email: '%_User@example.com' }))),
    ).resolves.toMatchObject({ targetId: 'watch-literal' });
  });

  it('never resolves an ambiguous exact normalized email', async () => {
    const ambiguous = query({
      data: [
        {
          user_id: 'user-a',
          users: { id: 'user-a', is_active: true, email: 'same@example.com' },
        },
        {
          user_id: 'user-b',
          users: { id: 'user-b', is_active: true, email: ' SAME@example.com ' },
        },
      ],
      error: null,
    });
    const { stage, ctx, from } = setup({
      userTarget: null,
      db: { organization_members: [ambiguous] },
    });

    await expect(
      stage.processItem(ctx, item(watcher({ email: 'same@example.com' }))),
    ).resolves.toMatchObject({ kind: 'skipped' });
    expect(from).not.toHaveBeenCalledWith('task_watchers');
  });

  it('does not write subscriptions, accounts, invitations, or memberships in dry run', async () => {
    const user = query({
      data: { id: 'user-1', is_active: true },
      error: null,
    });
    const member = query({ data: { role: 'member' }, error: null });
    const task = query({
      data: { id: 'task-1', space_id: 'space-1' },
      error: null,
    });
    const { stage, ctx, from } = setup({
      dryRun: true,
      db: { users: [user], organization_members: [member], tasks: [task] },
    });

    await expect(stage.processItem(ctx, item())).resolves.toEqual({
      kind: 'planned',
    });
    expect(from).not.toHaveBeenCalledWith('task_watchers');
    expect(from).not.toHaveBeenCalledWith('invitations');
    expect(from).not.toHaveBeenCalledWith('auth.users');
    expect(from).not.toHaveBeenCalledWith('notifications');
    expect(member.upsert).not.toHaveBeenCalled();
  });

  it('plans against a planned issue using only the existing target space', async () => {
    const user = query({
      data: { id: 'user-1', is_active: true },
      error: null,
    });
    const member = query({ data: { role: 'member' }, error: null });
    const { stage, ctx, from, permissions } = setup({
      dryRun: true,
      targetSpaceId: 'space-1',
      issueTarget: { status: 'planned', target_id: 'planned:issue-1' },
      db: { users: [user], organization_members: [member] },
    });

    await expect(stage.processItem(ctx, item())).resolves.toEqual({
      kind: 'planned',
    });
    expect(permissions.getUserSpacePermissions).toHaveBeenCalledWith(
      'user-1',
      'org-1',
      'space-1',
    );
    expect(from).not.toHaveBeenCalledWith('tasks');
    expect(from).not.toHaveBeenCalledWith('task_watchers');
  });

  it('repairs the subscription on retry when crosswalk recording previously failed', async () => {
    const db = {
      users: [
        query({ data: { id: 'user-1', is_active: true }, error: null }),
        query({ data: { id: 'user-1', is_active: true }, error: null }),
      ],
      organization_members: [
        query({ data: { role: 'member' }, error: null }),
        query({ data: { role: 'member' }, error: null }),
      ],
      tasks: [
        query({ data: { id: 'task-1', space_id: 'space-1' }, error: null }),
        query({ data: { id: 'task-1', space_id: 'space-1' }, error: null }),
      ],
      task_watchers: [
        query({ data: { id: 'watch-1' }, error: null }),
        query({ data: { id: 'watch-1' }, error: null }),
      ],
    };
    const { stage, ctx, entityMap, from } = setup({ db });
    entityMap.recordMapping
      .mockRejectedValueOnce(new Error('crosswalk unavailable'))
      .mockResolvedValueOnce({});

    await expect(stage.processItem(ctx, item())).rejects.toThrow(
      'crosswalk unavailable',
    );
    await expect(stage.processItem(ctx, item())).resolves.toMatchObject({
      kind: 'created',
    });
    expect(
      from.mock.calls.filter(([table]) => table === 'task_watchers'),
    ).toHaveLength(2);
  });
});
