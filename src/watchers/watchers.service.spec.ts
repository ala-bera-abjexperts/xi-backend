import { NotFoundException } from '@nestjs/common';

import { WatchersService } from './watchers.service';

type Result = { data: unknown; error: { message: string } | null };

function chain(result: Result) {
  const value: Record<
    string,
    jest.Mock | ((fn: (v: Result) => unknown) => unknown)
  > = {};
  const self = () => value;

  for (const method of [
    'select',
    'eq',
    'in',
    'is',
    'upsert',
    'delete',
    'insert',
    'limit',
  ]) {
    value[method] = jest.fn(self);
  }
  value['maybeSingle'] = jest.fn().mockResolvedValue(result);
  value['single'] = jest.fn().mockResolvedValue(result);
  value['then'] = (fn: (v: Result) => unknown) =>
    Promise.resolve(result).then(fn);

  return value as Record<string, jest.Mock> & PromiseLike<Result>;
}

describe('WatchersService', () => {
  const ORG = 'org-1';
  const USER = 'user-1';
  const TASK = 'task-1';
  const SPACE = 'space-1';
  const PAGE = 'page-1';

  let responses: Record<string, ReturnType<typeof chain>[]>;
  let from: jest.Mock;
  let permissions: { getUserSpacePermissions: jest.Mock };
  let wikiPermissions: { resolveWithTrace: jest.Mock };
  let broadcast: { broadcastNotification: jest.Mock };
  let email: { emailForNotifications: jest.Mock };
  let service: WatchersService;

  beforeEach(() => {
    responses = {};
    from = jest.fn((table: string) => {
      const next = responses[table]?.shift();
      if (!next) throw new Error(`No response configured for ${table}`);
      return next;
    });
    permissions = {
      getUserSpacePermissions: jest.fn().mockResolvedValue({
        isMember: true,
        permissions: { view_tasks: true, view_wiki_pages: true },
      }),
    };
    wikiPermissions = {
      resolveWithTrace: jest.fn().mockResolvedValue({
        decision: { can_view: true },
      }),
    };
    broadcast = { broadcastNotification: jest.fn() };
    email = { emailForNotifications: jest.fn().mockResolvedValue(undefined) };
    service = new WatchersService(
      { getClient: () => ({ from }) } as never,
      permissions as never,
      wikiPermissions as never,
      broadcast as never,
      email as never,
    );
  });

  it('idempotently watches a task with explicit tenant and self predicates', async () => {
    const task = chain({ data: { id: TASK, space_id: SPACE }, error: null });
    const member = chain({
      data: [{ user_id: USER, users: { is_active: true } }],
      error: null,
    });
    const upsert = chain({ data: null, error: null });
    responses.tasks = [task];
    responses.organization_members = [member];
    responses.task_watchers = [upsert];

    await expect(service.setTaskWatch(ORG, USER, TASK, true)).resolves.toEqual({
      watching: true,
    });
    expect(task.eq).toHaveBeenCalledWith('organization_id', ORG);
    expect(upsert.upsert).toHaveBeenCalledWith(
      { organization_id: ORG, task_id: TASK, user_id: USER },
      { onConflict: 'task_id,user_id', ignoreDuplicates: true },
    );
  });

  it('idempotently deletes only the authenticated task watcher in the org', async () => {
    responses.tasks = [
      chain({ data: { id: TASK, space_id: SPACE }, error: null }),
    ];
    responses.organization_members = [
      chain({
        data: [{ user_id: USER, users: { is_active: true } }],
        error: null,
      }),
    ];
    const deletion = chain({ data: null, error: null });
    responses.task_watchers = [deletion];

    await expect(service.setTaskWatch(ORG, USER, TASK, false)).resolves.toEqual(
      {
        watching: false,
      },
    );
    expect(deletion.eq).toHaveBeenCalledWith('organization_id', ORG);
    expect(deletion.eq).toHaveBeenCalledWith('task_id', TASK);
    expect(deletion.eq).toHaveBeenCalledWith('user_id', USER);
  });

  it('mutes and unmutes a task for the authenticated user only (ticket 9)', async () => {
    const access = () => {
      responses.tasks = [
        ...(responses.tasks ?? []),
        chain({ data: { id: TASK, space_id: SPACE }, error: null }),
      ];
      responses.organization_members = [
        ...(responses.organization_members ?? []),
        chain({
          data: [{ user_id: USER, users: { is_active: true } }],
          error: null,
        }),
      ];
    };
    const upsert = chain({ data: null, error: null });
    const deletion = chain({ data: null, error: null });
    const state = chain({ data: { id: 'm1' }, error: null });

    access();
    access();
    access();
    responses.task_notification_mutes = [upsert, state, deletion];

    await expect(service.setTaskMute(ORG, USER, TASK, true)).resolves.toEqual({
      muted: true,
    });
    expect(upsert.upsert).toHaveBeenCalledWith(
      { organization_id: ORG, task_id: TASK, user_id: USER },
      { onConflict: 'task_id,user_id', ignoreDuplicates: true },
    );
    await expect(service.getTaskMuteState(ORG, USER, TASK)).resolves.toEqual({
      muted: true,
    });
    await expect(service.setTaskMute(ORG, USER, TASK, false)).resolves.toEqual({
      muted: false,
    });
    expect(deletion.eq).toHaveBeenCalledWith('organization_id', ORG);
    expect(deletion.eq).toHaveBeenCalledWith('task_id', TASK);
    expect(deletion.eq).toHaveBeenCalledWith('user_id', USER);
  });

  it('muting a task the user cannot see is rejected like watching', async () => {
    responses.tasks = [chain({ data: null, error: null })];

    await expect(service.setTaskMute(ORG, USER, TASK, true)).rejects.toThrow(
      'Task not found',
    );
  });

  it('git helpers: watchers, muted users and visible users without the actor (ticket 9)', async () => {
    responses.task_watchers = [
      chain({ data: [{ user_id: 'w1' }, { user_id: 'w2' }], error: null }),
    ];
    responses.task_notification_mutes = [
      chain({ data: [{ user_id: 'w2' }], error: null }),
    ];
    responses.organization_members = [
      chain({
        data: [
          { user_id: 'w1', users: { is_active: true } },
          { user_id: 'w3', users: { is_active: false } },
        ],
        error: null,
      }),
    ];

    await expect(service.taskWatcherIds(ORG, TASK)).resolves.toEqual([
      'w1',
      'w2',
    ]);
    await expect(
      service.mutedTaskUsers(ORG, TASK, ['w1', 'w2']),
    ).resolves.toEqual(new Set(['w2']));
    await expect(service.mutedTaskUsers(ORG, TASK, [])).resolves.toEqual(
      new Set(),
    );
    await expect(
      service.visibleTaskUsers(ORG, SPACE, ['w1', 'w3', 'actor'], 'actor'),
    ).resolves.toEqual(['w1']);
    expect(permissions.getUserSpacePermissions).toHaveBeenCalledWith(
      'w1',
      ORG,
      SPACE,
    );
  });

  it('rejects a cross-org task uniformly', async () => {
    responses.tasks = [chain({ data: null, error: null })];

    await expect(service.getTaskWatchState(ORG, USER, TASK)).rejects.toThrow(
      NotFoundException,
    );
    expect(from).toHaveBeenCalledTimes(1);
  });

  it('rejects a wiki page that does not belong to the requested org and space', async () => {
    const page = chain({ data: null, error: null });
    responses.wiki_pages = [page];

    await expect(
      service.setWikiWatch(ORG, USER, SPACE, PAGE, 'page', true),
    ).rejects.toThrow(NotFoundException);
    expect(page.eq).toHaveBeenCalledWith('organization_id', ORG);
    expect(page.eq).toHaveBeenCalledWith('space_id', SPACE);
  });

  it('rejects a non-member org admin from wiki-space watch state', async () => {
    responses.spaces = [chain({ data: { id: SPACE }, error: null })];
    responses.organization_members = [
      chain({
        data: [{ user_id: USER, users: { is_active: true } }],
        error: null,
      }),
    ];
    permissions.getUserSpacePermissions.mockResolvedValueOnce({
      isMember: true,
      globalRole: 'admin',
      permissions: { view_wiki_pages: true },
    });
    const directMembership = chain({ data: null, error: null });
    responses.space_members = [directMembership];
    responses.user_group_members = [chain({ data: [], error: null })];
    responses.user_role_assignments = [chain({ data: [], error: null })];

    await expect(service.getWikiWatchState(ORG, USER, SPACE)).rejects.toThrow(
      NotFoundException,
    );
    expect(from).not.toHaveBeenCalledWith('wiki_watches');
    expect(directMembership.select).toHaveBeenCalledWith(
      'id, spaces!inner(organization_id)',
    );
    expect(directMembership.eq).toHaveBeenCalledWith(
      'spaces.organization_id',
      ORG,
    );
  });

  it.each([
    ['group', 'user_group_members', { group_id: 'group-1', role_id: null }],
    ['role', 'user_role_assignments', { role_id: 'role-1' }],
  ] as const)(
    'accepts an org admin with active explicit %s space membership',
    async (memberType, membershipTable, membershipRow) => {
      responses.spaces = [chain({ data: { id: SPACE }, error: null })];
      responses.organization_members = [
        chain({
          data: [{ user_id: USER, users: { is_active: true } }],
          error: null,
        }),
      ];
      permissions.getUserSpacePermissions.mockResolvedValueOnce({
        isMember: true,
        globalRole: 'admin',
        permissions: { view_wiki_pages: true },
      });
      const explicitMembership = chain({
        data: [{ id: 'explicit-member' }],
        error: null,
      });
      responses.space_members = [
        chain({ data: [], error: null }),
        explicitMembership,
      ];
      responses.user_group_members = [
        chain({
          data: membershipTable === 'user_group_members' ? [membershipRow] : [],
          error: null,
        }),
      ];
      responses.user_role_assignments = [
        chain({
          data:
            membershipTable === 'user_role_assignments' ? [membershipRow] : [],
          error: null,
        }),
      ];
      if (memberType === 'role') {
        responses.custom_roles = [
          chain({ data: [{ id: 'role-1' }], error: null }),
        ];
      }
      responses.wiki_watches = [chain({ data: null, error: null })];

      await expect(
        service.getWikiWatchState(ORG, USER, SPACE),
      ).resolves.toEqual({ watching: false });
      expect(from).toHaveBeenCalledWith(membershipTable);
      expect(explicitMembership.eq).toHaveBeenCalledWith(
        'member_type',
        memberType,
      );
    },
  );

  it('dedupes page and space watchers, excludes the actor, and honors channel preferences', async () => {
    responses.wiki_pages = [
      chain({
        data: { id: PAGE, title: 'Runbook', organization_id: ORG },
        error: null,
      }),
    ];
    responses.spaces = [
      chain({ data: { id: SPACE, key: 'OPS' }, error: null }),
    ];
    responses.wiki_watches = [
      chain({
        data: [
          { user_id: 'actor' },
          { user_id: 'both' },
          { user_id: 'in-app-only' },
          { user_id: 'email-only' },
        ],
        error: null,
      }),
      chain({
        data: [{ user_id: 'both' }, { user_id: 'space-only' }],
        error: null,
      }),
    ];
    responses.organization_members = [
      chain({
        data: [
          { user_id: 'both', users: { is_active: true } },
          { user_id: 'in-app-only', users: { is_active: true } },
          { user_id: 'email-only', users: { is_active: true } },
          { user_id: 'space-only', users: { is_active: true } },
        ],
        error: null,
      }),
    ];
    responses.notification_preferences = [
      chain({
        data: [
          { user_id: 'in-app-only', in_app: true, email: false },
          { user_id: 'email-only', in_app: false, email: true },
        ],
        error: null,
      }),
    ];
    const notifications = chain({
      data: [
        { id: 'n-both', user_id: 'both' },
        { id: 'n-in', user_id: 'in-app-only' },
        { id: 'n-space', user_id: 'space-only' },
      ],
      error: null,
    });
    responses.notifications = [notifications];

    await service.notifyWikiWatchers({
      organizationId: ORG,
      spaceId: SPACE,
      pageId: PAGE,
      actorUserId: 'actor',
      title: 'Runbook',
      changeKind: 'page_updated',
    });

    const inserted = notifications.insert.mock.calls[0][0] as Array<{
      user_id: string;
    }>;
    expect(inserted.map((row) => row.user_id).sort()).toEqual([
      'both',
      'in-app-only',
      'space-only',
    ]);
    expect(broadcast.broadcastNotification).toHaveBeenCalledTimes(3);
    expect(email.emailForNotifications).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ user_id: 'both', type: 'watcher_updates' }),
        expect.objectContaining({
          user_id: 'email-only',
          type: 'watcher_updates',
        }),
        expect.objectContaining({
          user_id: 'space-only',
          type: 'watcher_updates',
        }),
      ]),
    );
  });

  it('requires current wiki space membership even when page ACL identifies the user as creator', async () => {
    responses.wiki_pages = [
      chain({
        data: { id: PAGE, title: 'Private', organization_id: ORG },
        error: null,
      }),
    ];
    responses.wiki_watches = [
      chain({ data: [{ user_id: 'revoked-creator' }], error: null }),
      chain({ data: [], error: null }),
    ];
    responses.organization_members = [
      chain({
        data: [{ user_id: 'revoked-creator', users: { is_active: true } }],
        error: null,
      }),
    ];
    permissions.getUserSpacePermissions.mockResolvedValue({
      isMember: false,
      permissions: { view_wiki_pages: false },
    });

    await service.notifyWikiWatchers({
      organizationId: ORG,
      spaceId: SPACE,
      pageId: PAGE,
      actorUserId: 'actor',
      title: 'Private',
      changeKind: 'page_updated',
    });

    expect(wikiPermissions.resolveWithTrace).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalledWith('notifications');
  });

  it('drops inactive, revoked, and cross-resource task watchers before delivery', async () => {
    responses.tasks = [
      chain({
        data: { id: TASK, key: 'OPS-1', summary: 'Fix', space_id: SPACE },
        error: null,
      }),
    ];
    responses.spaces = [
      chain({ data: { id: SPACE, key: 'OPS' }, error: null }),
    ];
    responses.task_watchers = [
      chain({
        data: [
          { user_id: 'allowed' },
          { user_id: 'revoked' },
          { user_id: 'inactive' },
        ],
        error: null,
      }),
    ];
    responses.organization_members = [
      chain({
        data: [
          { user_id: 'allowed', users: { is_active: true } },
          { user_id: 'revoked', users: { is_active: true } },
          { user_id: 'inactive', users: { is_active: false } },
          { user_id: 'unknown-active', users: { is_active: null } },
        ],
        error: null,
      }),
    ];
    permissions.getUserSpacePermissions.mockImplementation((userId: string) =>
      Promise.resolve({
        isMember: userId !== 'revoked',
        permissions: { view_tasks: userId !== 'revoked' },
      }),
    );
    responses.task_notification_mutes = [chain({ data: [], error: null })];
    responses.notification_preferences = [chain({ data: [], error: null })];
    const notifications = chain({
      data: [{ id: 'n1', user_id: 'allowed' }],
      error: null,
    });
    responses.notifications = [notifications];

    await service.notifyTaskWatchers({
      organizationId: ORG,
      spaceId: SPACE,
      taskId: TASK,
      actorUserId: 'actor',
      taskKey: 'OPS-1',
      title: 'Fix',
      changeKind: 'task_updated',
    });

    expect(notifications.insert).toHaveBeenCalledWith([
      expect.objectContaining({ user_id: 'allowed' }),
    ]);
  });

  it('skips a watcher who muted the task', async () => {
    responses.tasks = [
      chain({
        data: { id: TASK, key: 'OPS-1', summary: 'Fix', space_id: SPACE },
        error: null,
      }),
    ];
    responses.spaces = [
      chain({ data: { id: SPACE, key: 'OPS' }, error: null }),
    ];
    responses.task_watchers = [
      chain({
        data: [{ user_id: 'muted' }, { user_id: 'listening' }],
        error: null,
      }),
    ];
    responses.organization_members = [
      chain({
        data: [
          { user_id: 'muted', users: { is_active: true } },
          { user_id: 'listening', users: { is_active: true } },
        ],
        error: null,
      }),
    ];
    const mutes = chain({ data: [{ user_id: 'muted' }], error: null });
    responses.task_notification_mutes = [mutes];
    responses.notification_preferences = [chain({ data: [], error: null })];
    const notifications = chain({
      data: [{ id: 'n1', user_id: 'listening' }],
      error: null,
    });
    responses.notifications = [notifications];

    await service.notifyTaskWatchers({
      organizationId: ORG,
      spaceId: SPACE,
      taskId: TASK,
      actorUserId: 'actor',
      taskKey: 'OPS-1',
      title: 'Fix',
      changeKind: 'task_updated',
    });

    expect(mutes.eq).toHaveBeenCalledWith('task_id', TASK);
    expect(notifications.insert).toHaveBeenCalledWith([
      expect.objectContaining({ user_id: 'listening' }),
    ]);
  });

  it('applies the fan-out cap after access filtering so stale rows cannot starve a valid watcher', async () => {
    const staleIds = Array.from(
      { length: 500 },
      (_, index) => `stale-${index}`,
    );
    const watcherIds = [...staleIds, 'valid-last'];
    responses.tasks = [
      chain({
        data: { id: TASK, key: 'OPS-1', summary: 'Fix', space_id: SPACE },
        error: null,
      }),
    ];
    responses.task_watchers = [
      chain({ data: watcherIds.map((user_id) => ({ user_id })), error: null }),
    ];
    const members = chain({
      data: watcherIds.map((user_id) => ({
        user_id,
        users: { is_active: true },
      })),
      error: null,
    });
    responses.organization_members = [members];
    permissions.getUserSpacePermissions.mockImplementation((userId: string) =>
      Promise.resolve({
        isMember: userId === 'valid-last',
        permissions: { view_tasks: userId === 'valid-last' },
      }),
    );
    responses.spaces = [
      chain({ data: { id: SPACE, key: 'OPS' }, error: null }),
    ];
    responses.task_notification_mutes = [chain({ data: [], error: null })];
    responses.notification_preferences = [chain({ data: [], error: null })];
    const notifications = chain({
      data: [{ id: 'n', user_id: 'valid-last' }],
      error: null,
    });
    responses.notifications = [notifications];

    await service.notifyTaskWatchers({
      organizationId: ORG,
      spaceId: SPACE,
      taskId: TASK,
      actorUserId: 'actor',
      taskKey: 'OPS-1',
      title: 'Fix',
      changeKind: 'task_updated',
    });

    expect(members.in.mock.calls[0][1] as string[]).toHaveLength(501);
    expect(notifications.insert).toHaveBeenCalledWith([
      expect.objectContaining({ user_id: 'valid-last' }),
    ]);
  });
});
