import { PlansService } from './plans.service';

describe('PlansService plan access parity', () => {
  const makeService = (overrides?: {
    isMember?: boolean;
    permissions?: Record<string, boolean>;
    planPermissionLevel?: string | null;
  }) => {
    const planPermissionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: overrides?.planPermissionLevel
          ? { permission_level: overrides.planPermissionLevel }
          : null,
        error: null,
      }),
    };

    const supabaseAdmin = {
      getClient: jest.fn(() => ({
        from: jest.fn((table: string) => {
          if (table === 'plan_permissions') return planPermissionQuery;
          throw new Error(`Unexpected table ${table}`);
        }),
      })),
    };

    const permissionsService = {
      isAdminOrOwner: jest.fn().mockResolvedValue(false),
      getUserSpacePermissions: jest.fn().mockResolvedValue({
        isMember: overrides?.isMember ?? true,
        permissions: overrides?.permissions ?? {},
      }),
    };

    return {
      service: new PlansService(
        supabaseAdmin as never,
        permissionsService as never,
        {} as never,
      ),
      supabaseAdmin,
      permissionsService,
      planPermissionQuery,
    };
  };

  it('falls through to explicit plan grants when a space member lacks module permission', async () => {
    const { service, planPermissionQuery } = makeService({
      isMember: true,
      permissions: { view_plans: true, edit_plans: false },
      planPermissionLevel: 'admin',
    });

    await expect(
      (
        service as unknown as {
          userCanAccessPlan: (
            userId: string,
            organizationId: string,
            planId: string,
            spaceId: string,
            level: string,
          ) => Promise<boolean>;
        }
      ).userCanAccessPlan('user-1', 'org-1', 'plan-1', 'space-1', 'edit'),
    ).resolves.toBe(true);

    expect(planPermissionQuery.maybeSingle).toHaveBeenCalled();
  });

  it('keeps explicit plan permissions for non-space-member sharees', async () => {
    const { service, planPermissionQuery } = makeService({
      isMember: false,
      planPermissionLevel: 'edit',
    });

    await expect(
      (
        service as unknown as {
          userCanAccessPlan: (
            userId: string,
            organizationId: string,
            planId: string,
            spaceId: string,
            level: string,
          ) => Promise<boolean>;
        }
      ).userCanAccessPlan('user-1', 'org-1', 'plan-1', 'space-1', 'edit'),
    ).resolves.toBe(true);

    expect(planPermissionQuery.maybeSingle).toHaveBeenCalled();
  });
});

describe('PlansService plan key generation', () => {
  const makeService = () => {
    const insertArgsByTable = new Map<string, Record<string, unknown>[]>();

    type MockQuery = {
      select: jest.Mock;
      eq: jest.Mock;
      order: jest.Mock;
      limit: jest.Mock;
      delete: jest.Mock;
      maybeSingle: jest.Mock;
      single: jest.Mock;
      insert: jest.Mock;
    };

    const makeQuery = (table: string): MockQuery => {
      const query: MockQuery = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        delete: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
        single: jest
          .fn()
          .mockResolvedValue({ data: { id: 'row-1' }, error: null }),
        insert: jest.fn((payload: Record<string, unknown>) => {
          const inserts = insertArgsByTable.get(table) ?? [];
          inserts.push(payload);
          insertArgsByTable.set(table, inserts);
          if (table === 'plans') {
            query.single.mockResolvedValueOnce({
              data: { id: 'plan-1', ...payload, plan_key: 'SP-P1' },
              error: null,
            });
          }
          if (table === 'tasks') {
            query.single.mockResolvedValueOnce({
              data: { id: 'task-1' },
              error: null,
            });
          }
          if (table === 'plan_tasks') {
            query.single.mockResolvedValueOnce({
              data: {
                id: 'plan-task-1',
                task_id: 'task-1',
                item_type: 'task',
                sort_order: 1,
                task: {
                  id: 'task-1',
                  key: 'SP-T1',
                  summary: 'Write brief',
                },
              },
              error: null,
            });
          }
          return query;
        }),
      };

      if (table === 'spaces') {
        query.maybeSingle.mockResolvedValue({
          data: { key: 'SP' },
          error: null,
        });
      }
      if (table === 'plans') {
        query.maybeSingle.mockResolvedValue({
          data: {
            id: 'plan-1',
            space_id: 'space-1',
            organization_id: 'org-1',
            status: 'draft',
            is_archived: false,
            settings: {},
          },
          error: null,
        });
      }

      return query;
    };

    const client = {
      from: jest.fn((table: string) => makeQuery(table)),
    };

    const supabaseAdmin = {
      getClient: jest.fn(() => client),
    };

    const permissionsService = {
      isAdminOrOwner: jest.fn().mockResolvedValue(false),
      getUserSpacePermissions: jest.fn().mockResolvedValue({
        isMember: true,
        permissions: { create_plans: true, edit_plans: true },
      }),
    };

    const service = new PlansService(
      supabaseAdmin as never,
      permissionsService as never,
      {} as never,
    );

    (service as unknown as { recalculateWbs: jest.Mock }).recalculateWbs = jest
      .fn()
      .mockResolvedValue(undefined);

    return { service, client, insertArgsByTable };
  };

  it('lets the database trigger generate plan_key when creating plans', async () => {
    const { service, insertArgsByTable } = makeService();

    await service.createPlan('org-1', 'user-1', {
      space_id: 'space-1',
      spaceId: 'space-1',
      organizationId: 'ignored-org',
      organization_id: 'ignored-org',
      name: 'Delivery Plan',
    } as any);

    expect(insertArgsByTable.get('plans')?.[0]).toMatchObject({
      space_id: 'space-1',
      organization_id: 'org-1',
      created_by: 'user-1',
      name: 'Delivery Plan',
    });
    expect(insertArgsByTable.get('plans')?.[0]).not.toHaveProperty('plan_key');
    expect(insertArgsByTable.get('plans')?.[0]).not.toHaveProperty('spaceId');
    expect(insertArgsByTable.get('plans')?.[0]).not.toHaveProperty(
      'organizationId',
    );
  });

  it('lets the database trigger generate task keys when adding plan items', async () => {
    const { service, insertArgsByTable } = makeService();

    await service.addItem('plan-1', 'org-1', 'user-1', {
      name: 'Write brief',
    } as any);

    expect(insertArgsByTable.get('tasks')?.[0]).toMatchObject({
      space_id: 'space-1',
      organization_id: 'org-1',
      summary: 'Write brief',
      created_by: 'user-1',
    });
    expect(insertArgsByTable.get('tasks')?.[0]).not.toHaveProperty('key');
  });

  // XE-T353 1.22: the task insert moved into insertPlanItemTask; a person's item is written as before.
  it('writes exactly the task row a person always got, and Robert only adds his reserved id', async () => {
    const human = makeService();
    const dto = {
      name: 'Write brief',
      description: 'Why',
      start_date: '2026-10-01',
      duration_days: 3,
      priority: 'high',
      estimated_hours: 2,
      progress: 10,
    } as any;
    await human.service.addItem('plan-1', 'org-1', 'user-1', dto);
    const row = human.insertArgsByTable.get('tasks')?.[0];
    expect(row).toEqual({
      space_id: 'space-1',
      organization_id: 'org-1',
      summary: 'Write brief',
      description: 'Why',
      start_date: '2026-10-01',
      end_date: '2026-10-04',
      due_date: '2026-10-04',
      duration: 3,
      parent_task_id: null,
      priority: 'high',
      assigned_to: undefined,
      estimated_cost: undefined,
      estimated_time: 120,
      task_type_id: expect.any(String),
      progress: 10,
      created_by: 'user-1',
      status: 'open',
    });

    const robert = makeService();
    await robert.service.insertPlanItemTask(
      'plan-1',
      { id: 'plan-1', space_id: 'space-1' },
      'org-1',
      'user-1',
      dto,
      { taskId: 'task-reserved' },
    );
    expect(robert.insertArgsByTable.get('tasks')?.[0]).toEqual({
      ...row,
      id: 'task-reserved',
    });
  });

  it('createPlan takes a reserved id only from a trusted caller', async () => {
    const human = makeService();
    await human.service.createPlan('org-1', 'user-1', {
      space_id: 'space-1',
      name: 'Delivery Plan',
    } as any);
    expect(human.insertArgsByTable.get('plans')?.[0]).not.toHaveProperty('id');

    const robert = makeService();
    await robert.service.createPlan(
      'org-1',
      'user-1',
      { space_id: 'space-1', name: 'Delivery Plan' } as any,
      { id: 'plan-reserved' },
    );
    expect(robert.insertArgsByTable.get('plans')?.[0]).toMatchObject({
      id: 'plan-reserved',
      status: 'draft',
    });
  });
});

describe('PlansService plan view orphan handling', () => {
  const plan = {
    id: 'plan-1',
    organization_id: 'org-1',
    space_id: 'space-1',
    name: 'Delivery Plan',
    status: 'draft',
  };

  const orphanPlanTask = {
    id: 'plan-task-1',
    task_id: 'task-1',
    item_type: 'task',
    wbs_number: '1',
    sort_order: 1,
    is_critical_path: false,
    color: null,
    task: {
      id: 'task-1',
      key: 'SP-T1',
      summary: 'Orphaned visible task',
      description: null,
      start_date: '2026-05-03T18:30:00+00:00',
      end_date: null,
      due_date: '2026-05-28T18:30:00+00:00',
      duration: 8,
      progress: 52,
      status: 'in_progress',
      priority: 'medium',
      estimated_time: 45,
      actual_time: 0,
      estimated_cost: 4545454,
      actual_cost: 0,
      parent_task_id: 'missing-parent-task',
      assigned_to: 'user-1',
      task_type_id: 'initiative',
      assignee: {
        id: 'user-1',
        first_name: 'Prince',
        last_name: 'Jadiya',
        email: 'prince@ambertech.solutions',
        avatar_url: null,
      },
      process: { id: 'process-1', title: '5 Führung' },
    },
  };

  const makeQuery = (result: unknown) => {
    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      in: jest.fn().mockResolvedValue(result),
      order: jest.fn().mockResolvedValue(result),
      single: jest.fn().mockResolvedValue(result),
      maybeSingle: jest.fn().mockResolvedValue(result),
    };

    return query;
  };

  const makeService = () => {
    const planQuery = makeQuery({ data: plan, error: null });
    const emptyConfigQuery = makeQuery({ data: null, error: null });
    const planTasksQuery = makeQuery({ data: [orphanPlanTask], error: null });
    const relationTypesQuery = makeQuery({ data: [], error: null });

    const queriesByTable = new Map<string, unknown[]>([
      ['plans', [planQuery]],
      ['task_hierarchy_configurations', [emptyConfigQuery, emptyConfigQuery]],
      ['plan_tasks', [planTasksQuery]],
      ['relation_types', [relationTypesQuery]],
    ]);

    const client = {
      from: jest.fn((table: string) => {
        const queue = queriesByTable.get(table);
        if (!queue?.length) throw new Error(`Unexpected table ${table}`);
        return queue.shift();
      }),
    };

    const supabaseAdmin = {
      getClient: jest.fn(() => client),
    };

    const service = new PlansService(
      supabaseAdmin as never,
      {} as never,
      {} as never,
    );

    (
      service as unknown as {
        verifyPlanAccess: jest.Mock;
      }
    ).verifyPlanAccess = jest.fn().mockResolvedValue(plan);

    return service;
  };

  it('re-roots Gantt tasks whose parent is not included in the plan', async () => {
    const service = makeService();

    const result = await service.getGanttView('plan-1', 'org-1', 'user-1');

    expect((result.tasks as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'task-1',
      parent: null,
    });
  });

  it('keeps WBS items visible when their database parent is outside the plan', async () => {
    const service = makeService();

    const result = await service.getWbsView('plan-1', 'org-1', 'user-1');

    expect(result.root_items).toHaveLength(1);
    expect(
      (result.root_items as Array<Record<string, unknown>>)[0],
    ).toMatchObject({
      id: 'task-1',
      parent_task_id: null,
      depth: 0,
    });
  });
});

// ── PERF: loop-invariant permission hoisting ─────────────────────────────
// `isAdminOrOwner` depends only on (userId, organizationId), so calling it
// inside the per-plan loop re-queried `organization_members` once per row.
// These tests pin the call count AND prove authorization is unchanged.

describe('PlansService list permission hoisting (perf)', () => {
  const thenable = (resolved: unknown) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of [
      'select',
      'eq',
      'neq',
      'order',
      'range',
      'ilike',
      'in',
      'gte',
      'lte',
    ]) {
      chain[m] = jest.fn().mockImplementation(self);
    }
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);
    return chain;
  };

  const makeListService = (opts: {
    isAdminOrOwner: boolean;
    rows: Record<string, unknown>[];
    isMember?: boolean;
    permissions?: Record<string, boolean>;
  }) => {
    const from = jest.fn((table: string) => {
      if (table === 'plans') return thenable({ data: opts.rows, error: null });
      if (table === 'plan_tasks') return thenable({ data: [], error: null });
      // No explicit per-plan grant.
      if (table === 'plan_permissions')
        return thenable({ data: null, error: null });
      throw new Error(`Unexpected table ${table}`);
    });

    const permissionsService = {
      isAdminOrOwner: jest.fn().mockResolvedValue(opts.isAdminOrOwner),
      getUserSpacePermissions: jest.fn().mockResolvedValue({
        isMember: opts.isMember ?? true,
        permissions: opts.permissions ?? {},
      }),
    };

    return {
      service: new PlansService(
        { getClient: () => ({ from }) } as never,
        permissionsService as never,
        {} as never,
      ),
      permissionsService,
    };
  };

  const rows = Array.from({ length: 5 }, (_, i) => ({
    id: `plan-${i}`,
    space_id: `space-${i}`,
  }));

  it('resolves isAdminOrOwner once per request, not once per plan', async () => {
    const { service, permissionsService } = makeListService({
      isAdminOrOwner: true,
      rows,
    });

    const result = await service.listOrganizationPlans('org-1', 'user-1', {
      page: 1,
      pageSize: 20,
    });

    expect(permissionsService.isAdminOrOwner).toHaveBeenCalledTimes(1);
    expect(result.data).toHaveLength(5);
  });

  it('short-circuits the per-plan checks entirely for an admin/owner', async () => {
    const { service, permissionsService } = makeListService({
      isAdminOrOwner: true,
      rows,
    });

    await service.listOrganizationPlans('org-1', 'user-1', {
      page: 1,
      pageSize: 20,
    });

    // An admin passes unconditionally, so no space resolution is needed at all.
    expect(permissionsService.getUserSpacePermissions).not.toHaveBeenCalled();
  });

  it('still calls isAdminOrOwner only once for a non-admin', async () => {
    const { service, permissionsService } = makeListService({
      isAdminOrOwner: false,
      rows,
      permissions: { view_plans: true },
    });

    const result = await service.listOrganizationPlans('org-1', 'user-1', {
      page: 1,
      pageSize: 20,
    });

    expect(permissionsService.isAdminOrOwner).toHaveBeenCalledTimes(1);
    // Space permission still grants access to all five.
    expect(result.data).toHaveLength(5);
  });

  it('still denies a non-admin with no space permission and no explicit grant', async () => {
    const { service } = makeListService({
      isAdminOrOwner: false,
      rows,
      isMember: false,
      permissions: {},
    });

    const result = await service.listOrganizationPlans('org-1', 'user-1', {
      page: 1,
      pageSize: 20,
    });

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});
