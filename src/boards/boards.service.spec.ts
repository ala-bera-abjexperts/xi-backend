import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { BoardsService } from './boards.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { SavedFiltersService } from '../saved-filters/saved-filters.service';
import { PermissionsService } from '../permissions/permissions.service';
import * as taskLinks from '../tasks/task-links.util';

describe('BoardsService', () => {
  let service: BoardsService;
  let mockFrom: jest.Mock;
  let mockRpc: jest.Mock;
  let auditLogs: { logAction: jest.Mock };
  let savedFilters: { executeFilter: jest.Mock };
  let permissions: { getUserSpacePermissions: jest.Mock };

  const ORG = 'org-1';
  const USER = 'user-1';
  const SPACE = 'space-1';

  const mockBoard = {
    id: 'board-1',
    organization_id: ORG,
    space_id: SPACE,
    name: 'Engineering Kanban',
    description: null,
    board_type: 'kanban',
    filter_id: null,
    settings: {},
    sort_order: 0,
    is_archived: false,
    created_by: USER,
    updated_by: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };

  function buildChain(resolved: {
    data: unknown;
    error: unknown;
    count?: number;
  }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.in = jest.fn().mockImplementation(self);
    chain.or = jest.fn().mockImplementation(self);
    chain.is = jest.fn().mockImplementation(self);
    chain.ilike = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.limit = jest.fn().mockImplementation(self);
    chain.range = jest.fn().mockImplementation(self);
    chain.single = jest.fn().mockResolvedValue(resolved);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);
    return chain;
  }

  function mockOrgAdminAccess(board = mockBoard) {
    mockFrom.mockReturnValueOnce(buildChain({ data: board, error: null }));
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    mockRpc = jest.fn();
    auditLogs = { logAction: jest.fn().mockResolvedValue(undefined) };
    savedFilters = { executeFilter: jest.fn() };
    permissions = {
      getUserSpacePermissions: jest.fn().mockResolvedValue({
        isMember: true,
        spaceRole: 'admin',
        globalRole: 'admin',
        permissions: {
          view_boards: true,
          create_boards: true,
          edit_boards: true,
          delete_boards: true,
        },
      }),
    };

    const supa = {
      getClient: () => ({ from: mockFrom, rpc: mockRpc }),
    } as unknown as SupabaseAdminService;

    service = new BoardsService(
      supa,
      auditLogs as unknown as AuditLogsService,
      savedFilters as unknown as SavedFiltersService,
      permissions as unknown as PermissionsService,
    );
  });

  it('requires a space id when listing boards', async () => {
    await expect(service.getAll(ORG, USER, '')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('returns paginated board lists after backend space permission checks', async () => {
    mockFrom
      .mockReturnValueOnce(buildChain({ data: { id: SPACE }, error: null }))
      .mockReturnValueOnce(buildChain({ data: null, error: null, count: 1 }))
      .mockReturnValueOnce(buildChain({ data: [mockBoard], error: null }));

    await expect(service.getAll(ORG, USER, SPACE)).resolves.toEqual({
      data: [mockBoard],
      total: 1,
      page: 1,
      pageSize: 20,
      hasMore: false,
    });
  });

  it('creates boards with backend-owned default swimlane, creator ACL, and audit', async () => {
    mockFrom
      .mockReturnValueOnce(buildChain({ data: { id: SPACE }, error: null }))
      .mockReturnValueOnce(buildChain({ data: mockBoard, error: null }))
      .mockReturnValueOnce(buildChain({ data: null, error: null }))
      .mockReturnValueOnce(buildChain({ data: null, error: null }));

    const result = await service.create(ORG, USER, {
      space_id: SPACE,
      name: 'Engineering Kanban',
      board_type: 'kanban',
    });

    expect(result).toEqual({ data: mockBoard, success: true });
    expect(auditLogs.logAction).toHaveBeenCalledWith(
      ORG,
      USER,
      'board',
      'board-1',
      'create',
      expect.objectContaining({ space_id: SPACE }),
    );
  });

  it('updates boards only after board admin access succeeds', async () => {
    mockOrgAdminAccess();
    mockFrom.mockReturnValueOnce(
      buildChain({ data: { ...mockBoard, name: 'Updated' }, error: null }),
    );

    await expect(
      service.update('board-1', ORG, USER, { name: 'Updated' }),
    ).resolves.toEqual({
      data: { ...mockBoard, name: 'Updated' },
      success: true,
    });
  });

  it('blocks destructive board delete until the board is archived', async () => {
    mockOrgAdminAccess();

    await expect(service.delete('board-1', ORG, USER)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('denies board access when neither space nor board ACL grants access', async () => {
    permissions.getUserSpacePermissions.mockResolvedValueOnce({
      isMember: true,
      spaceRole: 'member',
      globalRole: 'member',
      permissions: {},
    });
    mockFrom
      .mockReturnValueOnce(buildChain({ data: mockBoard, error: null }))
      .mockReturnValueOnce(buildChain({ data: null, error: null }))
      .mockReturnValueOnce(buildChain({ data: null, error: null }));

    await expect(
      service.update('board-1', ORG, USER, { name: 'Nope' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('keeps optimistic card move conflicts as conflicts', async () => {
    mockOrgAdminAccess();
    mockFrom
      .mockReturnValueOnce(
        buildChain({ data: { id: 'task-1', space_id: SPACE }, error: null }),
      )
      .mockReturnValueOnce(buildChain({ data: { id: 'col-2' }, error: null }));
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'Board state changed — refresh and retry' },
    });

    await expect(
      service.moveCard('board-1', ORG, USER, {
        task_id: 'task-1',
        source_column_id: 'col-1',
        target_column_id: 'col-2',
        new_position: 1000,
        expected_version: 1,
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('returns the legacy mutation wrapper after moving a card', async () => {
    const movedRanking = {
      id: 'ranking-1',
      board_id: 'board-1',
      task_id: 'task-1',
      column_id: 'col-2',
      position: 1000,
      version: 2,
    };

    mockOrgAdminAccess();
    mockFrom
      .mockReturnValueOnce(
        buildChain({ data: { id: 'task-1', space_id: SPACE }, error: null }),
      )
      .mockReturnValueOnce(buildChain({ data: { id: 'col-2' }, error: null }));
    mockRpc.mockResolvedValueOnce({ data: movedRanking, error: null });

    await expect(
      service.moveCard('board-1', ORG, USER, {
        task_id: 'task-1',
        source_column_id: 'col-2',
        target_column_id: 'col-2',
        new_position: 1000,
        expected_version: 1,
      }),
    ).resolves.toEqual({ data: movedRanking, success: true });
    expect(mockRpc).toHaveBeenCalledWith('move_board_card', {
      p_board_id: 'board-1',
      p_task_id: 'task-1',
      p_source_column_id: 'col-2',
      p_target_column_id: 'col-2',
      p_new_position: 1000,
      p_expected_version: 1,
      p_user_id: USER,
      p_organization_id: ORG,
    });
  });

  it('does not report a successful card move when the atomic move fails', async () => {
    const tableQueues: Record<string, ReturnType<typeof buildChain>[]> = {
      boards: [buildChain({ data: mockBoard, error: null })],
      tasks: [
        buildChain({ data: { id: 'task-1', space_id: SPACE }, error: null }),
      ],
      board_columns: [buildChain({ data: { id: 'col-2' }, error: null })],
    };
    mockFrom.mockImplementation((table: string) => tableQueues[table].shift());
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'status sync failed' },
    });

    await expect(
      service.moveCard('board-1', ORG, USER, {
        task_id: 'task-1',
        source_column_id: 'col-1',
        target_column_id: 'col-2',
        new_position: 1000,
        expected_version: 1,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(auditLogs.logAction).not.toHaveBeenCalled();
  });

  it('does not call the atomic card move when target column lookup fails', async () => {
    const tableQueues: Record<string, ReturnType<typeof buildChain>[]> = {
      boards: [buildChain({ data: mockBoard, error: null })],
      tasks: [
        buildChain({ data: { id: 'task-1', space_id: SPACE }, error: null }),
      ],
      board_columns: [buildChain({ data: null, error: null })],
    };
    mockFrom.mockImplementation((table: string) => tableQueues[table].shift());

    await expect(
      service.moveCard('board-1', ORG, USER, {
        task_id: 'task-1',
        source_column_id: 'col-1',
        target_column_id: 'col-2',
        new_position: 1000,
        expected_version: 1,
      }),
    ).rejects.toThrow('Target column not found');
    expect(mockRpc).not.toHaveBeenCalled();
    expect(auditLogs.logAction).not.toHaveBeenCalled();
  });

  it('enforces WIP limits before moving a card to another column', async () => {
    const boardWithWip = {
      ...mockBoard,
      settings: { enforce_wip_limits: true },
    };
    const tableQueues: Record<string, ReturnType<typeof buildChain>[]> = {
      boards: [buildChain({ data: boardWithWip, error: null })],
      tasks: [
        buildChain({ data: { id: 'task-1', space_id: SPACE }, error: null }),
      ],
      board_columns: [
        buildChain({ data: { id: 'col-2', max_wip: 2 }, error: null }),
      ],
      board_issue_ranking: [buildChain({ data: null, error: null, count: 2 })],
    };
    mockFrom.mockImplementation((table: string) => tableQueues[table].shift());

    await expect(
      service.moveCard('board-1', ORG, USER, {
        task_id: 'task-1',
        source_column_id: 'col-1',
        target_column_id: 'col-2',
        new_position: 1000,
        expected_version: 1,
      }),
    ).rejects.toThrow('Column WIP limit reached (2)');
    expect(mockRpc).not.toHaveBeenCalled();
    expect(auditLogs.logAction).not.toHaveBeenCalled();
  });

  it('syncs both status_id and legacy status key when adding a card', async () => {
    const ranking = {
      id: 'ranking-1',
      board_id: 'board-1',
      task_id: 'task-1',
      column_id: 'col-2',
      position: 1000,
      version: 0,
    };
    const statusUpdateChain = buildChain({ data: null, error: null });

    mockOrgAdminAccess();
    mockFrom
      .mockReturnValueOnce(buildChain({ data: { id: 'col-2' }, error: null }))
      .mockReturnValueOnce(
        buildChain({ data: { id: 'task-1', space_id: SPACE }, error: null }),
      )
      .mockReturnValueOnce(buildChain({ data: null, error: null }))
      .mockReturnValueOnce(buildChain({ data: ranking, error: null }))
      .mockReturnValueOnce(
        buildChain({
          data: [
            {
              status_id: 'status-2',
              status: { key: 'done', is_completed: true },
            },
          ],
          error: null,
        }),
      )
      .mockReturnValueOnce(statusUpdateChain);

    await service.addCard('board-1', ORG, USER, {
      task_id: 'task-1',
      column_id: 'col-2',
      position: 1000,
    });

    expect(statusUpdateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status_id: 'status-2',
        status: 'done',
        completed_at: expect.any(String) as unknown,
      }),
    );
  });

  it('loads unmapped global and space task statuses for the board space', async () => {
    const globalStatus = {
      id: 'status-open',
      name: 'Open',
      color: '#6B7280',
      icon: 'lucide:circle',
      space_id: null,
      is_active: true,
    };
    const spaceStatus = {
      id: 'status-review',
      name: 'Review',
      color: '#F59E0B',
      icon: 'lucide:eye',
      space_id: SPACE,
      is_active: true,
    };
    const mappedStatus = {
      id: 'status-done',
      name: 'Done',
      color: '#10B981',
      icon: 'lucide:check-circle',
      space_id: null,
      is_active: true,
    };
    const statusesChain = buildChain({
      data: [globalStatus, spaceStatus, mappedStatus],
      error: null,
    });

    mockOrgAdminAccess();
    mockFrom.mockReturnValueOnce(statusesChain).mockReturnValueOnce(
      buildChain({
        data: [{ status_id: mappedStatus.id }],
        error: null,
      }),
    );

    await expect(
      service.getUnmappedStatuses('board-1', ORG, USER),
    ).resolves.toEqual([globalStatus, spaceStatus]);
    expect(statusesChain.eq).toHaveBeenCalledWith('organization_id', ORG);
    expect(statusesChain.eq).toHaveBeenCalledWith('is_active', true);
    expect(statusesChain.or).toHaveBeenCalledWith(
      `space_id.is.null,space_id.eq.${SPACE}`,
    );
  });

  it('allows more than three card fields on board cards', async () => {
    const fields = [
      { custom_field_id: '__status', position: 1, width: 'auto' },
      { custom_field_id: '__task_type', position: 2, width: 'auto' },
      { custom_field_id: '__assignee', position: 3, width: 'auto' },
      { custom_field_id: '__key', position: 4, width: 'auto' },
    ];
    const insertChain = buildChain({
      data: fields.map((field, index) => ({
        id: `card-field-${index + 1}`,
        board_id: 'board-1',
        ...field,
      })),
      error: null,
    });

    mockOrgAdminAccess();
    mockFrom
      .mockReturnValueOnce(buildChain({ data: null, error: null }))
      .mockReturnValueOnce(insertChain);

    const result = await service.setCardFields('board-1', ORG, USER, fields);

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(4);
    expect(insertChain.insert).toHaveBeenCalledWith(
      fields.map(
        (field) =>
          expect.objectContaining({
            board_id: 'board-1',
            custom_field_id: field.custom_field_id,
          }) as unknown,
      ),
    );
  });
});

describe('BoardsService.getById Git badge fields (ticket 10)', () => {
  const GIT_FIELDS =
    'git_pr_count, git_open_pr_count, git_merged_pr_count, git_build_state';
  let taskSelects: string[];

  function chain(data: unknown, onSelect?: (cols: string) => void) {
    const c: Record<string, unknown> = {};
    const self = () => c;
    for (const m of ['eq', 'in', 'is', 'or', 'order', 'limit', 'range'])
      c[m] = jest.fn().mockImplementation(self);
    c.select = jest.fn((cols: string) => {
      onSelect?.(cols);
      return c;
    });
    c.single = jest.fn().mockResolvedValue({ data, error: null });
    c.maybeSingle = jest.fn().mockResolvedValue({ data, error: null });
    c.then = (f: (v: unknown) => unknown) =>
      Promise.resolve({ data, error: null }).then(f);
    return c;
  }

  function buildService(entitled: boolean) {
    taskSelects = [];
    const board = {
      id: 'board-1',
      organization_id: 'org-1',
      space_id: null,
      board_type: 'kanban',
      filter_id: null,
      is_archived: false,
    };
    const task = { id: 't1', key: 'ABC-1', git_pr_count: 2 };
    const from = jest.fn((table: string) => {
      switch (table) {
        case 'boards':
          return chain(board);
        case 'board_issue_ranking':
          return chain([
            { task_id: 't1', column_id: 'c1', position: 1, version: 1 },
          ]);
        case 'board_columns':
          return chain([{ id: 'c1' }]);
        case 'tasks':
          return chain([task], (cols) => taskSelects.push(cols));
        default:
          return chain([]);
      }
    });
    jest
      .spyOn(taskLinks, 'fetchLinkedTaskIds')
      .mockResolvedValue(new Map() as never);
    return new BoardsService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      {} as AuditLogsService,
      {} as SavedFiltersService,
      {
        isAdminOrOwner: jest.fn().mockResolvedValue(true),
        getUserSpacePermissions: jest.fn().mockResolvedValue({
          isMember: true,
          permissions: { view_boards: true },
        }),
      } as unknown as PermissionsService,
      undefined,
      undefined,
      undefined,
      {
        getEffectiveEntitlements: jest
          .fn()
          .mockResolvedValue(
            new Set(entitled ? ['feature_external_integrations'] : []),
          ),
      } as never,
    );
  }

  afterEach(() => jest.restoreAllMocks());

  it('selects the Git fields for card tasks when the org is entitled', async () => {
    const view = await buildService(true).getById('board-1', 'org-1', 'u1');

    expect(taskSelects.some((s) => s.endsWith(`, ${GIT_FIELDS}`))).toBe(true);
    expect(
      (view.columns[0] as unknown as { tasks: unknown[] }).tasks[0],
    ).toMatchObject({ git_pr_count: 2 });
  });

  it('leaves the Git fields out when the org is not entitled', async () => {
    await buildService(false).getById('board-1', 'org-1', 'u1');

    expect(taskSelects.length).toBeGreaterThan(0);
    expect(taskSelects.some((s) => s.includes('git_pr_count'))).toBe(false);
  });
});

describe('BoardsService.resolveLinkedTaskKeys (XE-T532)', () => {
  // Off-board linked tasks returned by the key lookup; the viewer sees space-1
  // only, and org-level tasks follow org can_view_tasks.
  let offBoardRows: { id: string; key: string; space_id: string | null }[];
  let orgCanViewTasks: boolean;
  let client: { from: jest.Mock };
  let permissions: {
    getUserSpacePermissions: jest.Mock;
    getUserEffectivePermissions: jest.Mock;
  };
  let service: BoardsService;

  const rows = [
    { id: 't10', key: 'XSD-T10' },
    { id: 't11', key: 'XSD-T11' },
  ];
  const resolve = () =>
    (
      service as unknown as {
        resolveLinkedTaskKeys: (
          org: string,
          user: string,
          taskRows: Record<string, unknown>[],
        ) => Promise<Map<string, string[]>>;
      }
    ).resolveLinkedTaskKeys('org-1', 'user-1', rows);
  const linkedTo = (links: [string, string[]][]) =>
    jest
      .spyOn(taskLinks, 'fetchLinkedTaskIds')
      .mockResolvedValue(new Map(links.map(([id, to]) => [id, new Set(to)])));

  beforeEach(() => {
    offBoardRows = [];
    orgCanViewTasks = false;
    client = {
      from: jest.fn(() => {
        const chain: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'in']) chain[m] = jest.fn(() => chain);
        chain.then = (ok: (v: unknown) => unknown) =>
          Promise.resolve({ data: offBoardRows, error: null }).then(ok);
        return chain;
      }),
    };
    permissions = {
      getUserSpacePermissions: jest.fn(
        (_user: string, _org: string, spaceId: string) =>
          Promise.resolve({
            isMember: spaceId === 'space-1',
            permissions: { view_tasks: true },
          }),
      ),
      getUserEffectivePermissions: jest.fn(() =>
        Promise.resolve({
          effective_permissions: { can_view_tasks: orgCanViewTasks },
        }),
      ),
    };
    service = new BoardsService(
      { getClient: () => client } as unknown as SupabaseAdminService,
      {} as AuditLogsService,
      {} as SavedFiltersService,
      permissions as unknown as PermissionsService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('uses board keys for both directions and shows off-board links in a viewable space', async () => {
    const linkedIds = linkedTo([
      ['t10', ['t11']],
      ['t11', ['t10', 't13', 't14']],
    ]);
    offBoardRows = [
      { id: 't13', key: 'XSD-T13', space_id: 'space-1' },
      { id: 't14', key: 'XSD-T14', space_id: 'space-1' },
    ];

    const result = await resolve();

    expect(linkedIds).toHaveBeenCalledWith(client, 'org-1', ['t10', 't11']);
    expect(result.get('t10')).toEqual(['XSD-T11']);
    expect(result.get('t11')).toEqual(['XSD-T10', 'XSD-T13', 'XSD-T14']);
    // Only the involved space is checked, once.
    expect(permissions.getUserSpacePermissions).toHaveBeenCalledTimes(1);
    expect(permissions.getUserSpacePermissions).toHaveBeenCalledWith(
      'user-1',
      'org-1',
      'space-1',
    );
  });

  it('drops an off-board link in a space the viewer cannot see', async () => {
    linkedTo([['t11', ['t10', 't99']]]);
    offBoardRows = [{ id: 't99', key: 'XSD-T99', space_id: 'space-hidden' }];

    expect((await resolve()).get('t11')).toEqual(['XSD-T10']);
  });

  it.each([
    [true, ['XSD-T50']],
    [false, []],
  ])(
    'an org-level linked task follows org can_view_tasks (%s)',
    async (canView, expected) => {
      linkedTo([['t10', ['t50']]]);
      offBoardRows = [{ id: 't50', key: 'XSD-T50', space_id: null }];
      orgCanViewTasks = canView;

      expect((await resolve()).get('t10')).toEqual(expected);
      expect(permissions.getUserSpacePermissions).not.toHaveBeenCalled();
    },
  );

  it('makes no key or permission lookup when every linked task is on the board', async () => {
    linkedTo([['t10', ['t11']]]);

    expect((await resolve()).get('t10')).toEqual(['XSD-T11']);
    expect(client.from).not.toHaveBeenCalled();
    expect(permissions.getUserSpacePermissions).not.toHaveBeenCalled();
    expect(permissions.getUserEffectivePermissions).not.toHaveBeenCalled();
  });
});
