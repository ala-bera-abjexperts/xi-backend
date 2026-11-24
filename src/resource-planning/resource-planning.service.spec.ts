import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import { OrganizationModulesService } from '../organization-modules/organization-modules.service';
import { PermissionsService } from '../permissions/permissions.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { WorkingCalendarService } from './calendar/working-calendar.service';
import type { BulkUpdateCapacityDto } from './dto/bulk-update-capacity.dto';
import { CURRENCY_REQUIRED_FOR_RATE_MESSAGE } from './dto/capacity-period.dto';
import {
  getEffectiveCapacityHours,
  getEffectivePlannedHours,
  inSpaceScope,
  mergeEffectiveDateIntervals,
  ResourcePlanningService,
  type PlanAllocRow,
} from './resource-planning.service';

const allocationBase = {
  id: 'allocation-1',
  organization_id: 'org-1',
  plan_id: 'plan-1',
  user_id: 'user-1',
  planned_hours: 0,
  planned_budget: 0,
  start_date: '2026-08-01',
  end_date: '2026-08-14',
  role: null,
  notes: null,
  created_by: 'actor-1',
  updated_by: 'actor-1',
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

describe('getEffectivePlannedHours', () => {
  it('derives weekly and percentage modes using inclusive dates', () => {
    expect(
      getEffectivePlannedHours(
        {
          ...allocationBase,
          allocation_mode: 'hours_per_week',
          weekly_hours: 8,
          capacity_percent: null,
        } as PlanAllocRow,
        40,
      ),
    ).toBe(16);
    expect(
      getEffectivePlannedHours(
        {
          ...allocationBase,
          allocation_mode: 'capacity_percent',
          weekly_hours: null,
          capacity_percent: 50,
        } as PlanAllocRow,
        40,
      ),
    ).toBe(40);
  });

  it('preserves stored hours for legacy allocations', () => {
    expect(
      getEffectivePlannedHours(
        {
          ...allocationBase,
          allocation_mode: 'total_hours',
          planned_hours: 24,
          weekly_hours: null,
          capacity_percent: null,
        } as PlanAllocRow,
        null,
      ),
    ).toBe(24);
  });

  it('uses dated capacity overrides for percentage allocations', () => {
    expect(
      getEffectivePlannedHours(
        {
          ...allocationBase,
          allocation_mode: 'capacity_percent',
          weekly_hours: null,
          capacity_percent: 50,
        } as PlanAllocRow,
        40,
        [
          {
            user_id: 'user-1',
            effective_from: '2026-08-08',
            effective_to: '2026-08-14',
            weekly_capacity_hours: 20,
          },
        ],
      ),
    ).toBe(30);
  });
});

describe('effective capacity windows', () => {
  it('replaces default capacity with effective-dated overrides', () => {
    expect(
      getEffectiveCapacityHours('2026-08-01', '2026-08-14', 40, [
        {
          user_id: 'user-1',
          effective_from: '2026-08-08',
          effective_to: '2026-08-14',
          weekly_capacity_hours: 20,
        },
      ]),
    ).toBe(60);

    expect(
      getEffectiveCapacityHours('2026-08-01', '2026-08-14', null, [
        {
          user_id: 'user-1',
          effective_from: '2026-08-08',
          effective_to: '2026-08-14',
          weekly_capacity_hours: 20,
        },
      ]),
    ).toBeNull();
  });

  it('resolves overlapping capacity periods so a day counts once (latest effective_from wins)', () => {
    // Two periods both cover 2026-08-08..2026-08-14. Without precedence
    // resolution the old code summed/subtracted both independently for those
    // days (double-counting). The period with the later effective_from
    // (2026-08-08, 20h/week) must win that overlap; the earlier one
    // (2026-08-01, 40h/week) only applies to its non-overlapping days.
    const periods = [
      {
        user_id: 'user-1',
        effective_from: '2026-08-01',
        effective_to: '2026-08-14',
        weekly_capacity_hours: 40,
      },
      {
        user_id: 'user-1',
        effective_from: '2026-08-08',
        effective_to: '2026-08-14',
        weekly_capacity_hours: 20,
      },
    ];

    // 2026-08-01..2026-08-07 (7 days) at 40h/week + 2026-08-08..2026-08-14 (7 days) at 20h/week.
    expect(
      getEffectiveCapacityHours('2026-08-01', '2026-08-14', null, periods),
    ).toBe(60);

    // Order of the input array must not change the result.
    expect(
      getEffectiveCapacityHours(
        '2026-08-01',
        '2026-08-14',
        null,
        [...periods].reverse(),
      ),
    ).toBe(60);
  });

  it('resolves precedence across three overlapping periods', () => {
    // P1 covers the whole 3-week range; P2 and P3 each claim one of its
    // trailing weeks with later effective_from dates, so precedence must
    // stack correctly across all three, not just a single pairwise overlap.
    const p1 = {
      user_id: 'user-1',
      effective_from: '2026-08-01',
      effective_to: '2026-08-21',
      weekly_capacity_hours: 70,
    };
    const p2 = {
      user_id: 'user-1',
      effective_from: '2026-08-08',
      effective_to: '2026-08-14',
      weekly_capacity_hours: 140,
    };
    const p3 = {
      user_id: 'user-1',
      effective_from: '2026-08-15',
      effective_to: '2026-08-21',
      weekly_capacity_hours: 210,
    };

    // Resolved, non-overlapping days: 08-01..08-07 @70/wk (=70) +
    // 08-08..08-14 @140/wk (=140, P2 wins, later effective_from than P1) +
    // 08-15..08-21 @210/wk (=210, P3 wins, latest effective_from) = 420.
    expect(
      getEffectiveCapacityHours('2026-08-01', '2026-08-21', null, [p1, p2, p3]),
    ).toBe(420);

    // Order of the input array must not change the result.
    expect(
      getEffectiveCapacityHours('2026-08-01', '2026-08-21', null, [p3, p1, p2]),
    ).toBe(420);
  });

  it('resolves a period fully contained inside another', () => {
    // Inner period (08-11..08-20, 10 days) sits entirely inside the outer
    // period (08-01..08-30, 30 days) and has a later effective_from, so it
    // wins for its 10 days; the outer period's rate still applies to the
    // 10 days before and the 10 days after it.
    const outer = {
      user_id: 'user-1',
      effective_from: '2026-08-01',
      effective_to: '2026-08-30',
      weekly_capacity_hours: 35,
    };
    const inner = {
      user_id: 'user-1',
      effective_from: '2026-08-11',
      effective_to: '2026-08-20',
      weekly_capacity_hours: 70,
    };

    // (10/7)*35 [before] + (10/7)*70 [inner, contained] + (10/7)*35 [after]
    // = 50 + 100 + 50 = 200.
    expect(
      getEffectiveCapacityHours('2026-08-01', '2026-08-30', null, [
        outer,
        inner,
      ]),
    ).toBe(200);

    // Order of the input array must not change the result.
    expect(
      getEffectiveCapacityHours('2026-08-01', '2026-08-30', null, [
        inner,
        outer,
      ]),
    ).toBe(200);
  });

  it('merges overlapping plan windows so portfolio capacity is counted once', () => {
    const windows = mergeEffectiveDateIntervals([
      { start: '2026-08-01', end: '2026-08-14' },
      { start: '2026-08-08', end: '2026-08-21' },
    ]);
    expect(windows).toEqual([{ start: '2026-08-01', end: '2026-08-21' }]);
    expect(
      windows.reduce(
        (sum, window) =>
          sum + (getEffectiveCapacityHours(window.start, window.end, 40) ?? 0),
        0,
      ),
    ).toBe(120);
  });
});

describe('ResourcePlanningService authorization', () => {
  let service: ResourcePlanningService;
  let from: jest.Mock;
  let permissions: {
    isAdminOrOwner: jest.Mock;
    getUserSpacePermissions: jest.Mock;
  };
  let orgModules: {
    isEnabled: jest.Mock;
    isSpaceModuleEnabled: jest.Mock;
    getEnabledSpaceIds: jest.Mock;
  };
  let audit: { logAction: jest.Mock };

  function singleQuery(result: { data: unknown; error: unknown }) {
    const query: Record<string, unknown> = {};
    const self = jest.fn(() => query);
    query.select = self;
    query.eq = self;
    query.maybeSingle = jest.fn().mockResolvedValue(result);
    return query;
  }

  function updateQuery(result: { data: unknown; error: unknown }) {
    const query = singleQuery(result);
    const self = jest.fn(() => query);
    query.update = self;
    query.select = self;
    query.eq = self;
    query.single = jest.fn().mockResolvedValue(result);
    return query;
  }

  // Thenable chain for queries awaited directly without a terminal
  // .maybeSingle()/.single() call (e.g. `.eq(...)` as the last link), mirroring
  // the buildChain() pattern used in tasks.service.spec.ts.
  function chainQuery(result: { data: unknown; error: unknown }) {
    const query: Record<string, unknown> = {};
    const self = () => query;
    query.select = jest.fn(self);
    query.eq = jest.fn(self);
    query.in = jest.fn(self);
    query.order = jest.fn(self);
    query.maybeSingle = jest.fn().mockResolvedValue(result);
    query.single = jest.fn().mockResolvedValue(result);
    query.then = (
      onFulfilled: (value: typeof result) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(onFulfilled, onRejected);
    return query;
  }

  const planAllocBase = {
    id: 'alloc-1',
    organization_id: 'org-1',
    plan_id: 'plan-a',
    user_id: 'user-1',
    planned_hours: 0,
    planned_budget: 0,
    allocation_mode: 'total_hours' as const,
    start_date: '2026-08-01',
    end_date: '2026-08-14',
    weekly_hours: null,
    capacity_percent: null,
    role: null,
    notes: null,
    created_by: 'actor-1',
    updated_by: 'actor-1',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
  };

  beforeEach(() => {
    from = jest.fn();
    orgModules = {
      isEnabled: jest.fn().mockResolvedValue(true),
      isSpaceModuleEnabled: jest.fn().mockResolvedValue(true),
      getEnabledSpaceIds: jest.fn().mockResolvedValue([]),
    };
    permissions = {
      isAdminOrOwner: jest.fn().mockResolvedValue(false),
      getUserSpacePermissions: jest.fn().mockResolvedValue({
        isMember: false,
        permissions: {},
      }),
    };
    audit = { logAction: jest.fn().mockResolvedValue(undefined) };
    service = new ResourcePlanningService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      permissions as unknown as PermissionsService,
      orgModules as unknown as OrganizationModulesService,
      {
        // No org has configured a scheme in these tests — every call site
        // must fall back to legacy math, matching pre-Phase-1 behavior.
        hasAnySchemeConfigured: jest.fn().mockResolvedValue(false),
        resolveCalendarContext: jest.fn().mockResolvedValue(null),
      } as unknown as WorkingCalendarService,
      audit as unknown as AuditLogsService,
    );
  });

  describe('space scope (XE-T522)', () => {
    it('gives admins every enabled space and members only the ones they belong to', async () => {
      orgModules.getEnabledSpaceIds.mockResolvedValue(['space-a', 'space-b']);
      permissions.isAdminOrOwner.mockResolvedValueOnce(true);
      const adminScope = await service.resolveSpaceScope('org-1', 'admin-1');
      expect([...adminScope.allowedSpaceIds].sort()).toEqual([
        'space-a',
        'space-b',
      ]);

      permissions.getUserSpacePermissions.mockImplementation(
        (_userId: string, _orgId: string, spaceId: string) =>
          Promise.resolve({
            isMember: spaceId === 'space-a',
            permissions: {},
          }),
      );
      const memberScope = await service.resolveSpaceScope('org-1', 'member-1');
      expect([...memberScope.allowedSpaceIds]).toEqual(['space-a']);
    });

    it('never includes a disabled space, even for an admin; null-space rows always pass', async () => {
      orgModules.getEnabledSpaceIds.mockResolvedValue(['space-a']);
      permissions.isAdminOrOwner.mockResolvedValue(true);

      const scope = await service.resolveSpaceScope('org-1', 'admin-1');

      expect(orgModules.getEnabledSpaceIds).toHaveBeenCalledWith(
        'org-1',
        'resource_planning',
      );
      expect(inSpaceScope(scope, 'space-disabled')).toBe(false);
      expect(inSpaceScope(scope, null)).toBe(true);
      expect(inSpaceScope(scope, undefined)).toBe(false);
    });

    it('403s an owner on a task allocation when the space module is off (before the bypass)', async () => {
      from.mockReturnValueOnce(
        singleQuery({
          data: {
            id: 'task-1',
            organization_id: 'org-1',
            space_id: 'space-off',
            planned_budget: 0,
          },
          error: null,
        }),
      );
      permissions.isAdminOrOwner.mockResolvedValue(true);
      orgModules.isSpaceModuleEnabled.mockResolvedValue(false);

      await expect(
        service.listTaskAllocations('task-1', 'org-1', 'owner-1'),
      ).rejects.toThrow('Resource Planning is not enabled in this space');
      expect(permissions.isAdminOrOwner).not.toHaveBeenCalled();
    });

    it('listCapacity checks the tenant module', async () => {
      orgModules.isEnabled.mockResolvedValue(false);

      await expect(service.listCapacity('org-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(from).not.toHaveBeenCalled();
    });

    it('effectiveTaskHours returns stored hours with no queries when every row is total_hours', async () => {
      const internals = service as unknown as {
        effectiveTaskHours(org: string, rows: unknown[]): Promise<number[]>;
      };

      await expect(
        internals.effectiveTaskHours('org-1', [
          {
            id: 'a',
            user_id: 'u1',
            planned_hours: 12,
            allocation_mode: 'total_hours',
          },
          {
            id: 'b',
            user_id: 'u2',
            planned_hours: '4.5',
            allocation_mode: 'total_hours',
          },
        ]),
      ).resolves.toEqual([12, 4.5]);
      expect(from).not.toHaveBeenCalled();
    });
  });

  it('rejects cross-organization allocation users', async () => {
    from.mockReturnValueOnce(singleQuery({ data: null, error: null }));

    await expect(
      service.assertOrganizationMember('org-1', 'outside-user'),
    ).rejects.toThrow(NotFoundException);
  });

  it('accepts view plan grants but does not let them edit allocations', async () => {
    const plan = {
      id: 'plan-1',
      organization_id: 'org-1',
      space_id: 'space-1',
      currency: 'EUR',
      start_date: null,
      end_date: null,
    };

    from
      .mockReturnValueOnce(singleQuery({ data: plan, error: null }))
      .mockReturnValueOnce(
        singleQuery({ data: { permission_level: 'view' }, error: null }),
      );
    await expect(
      service.assertPlanAccess('plan-1', 'org-1', 'user-1', 'view'),
    ).resolves.toEqual(plan);

    from
      .mockReturnValueOnce(singleQuery({ data: plan, error: null }))
      .mockReturnValueOnce(
        singleQuery({ data: { permission_level: 'view' }, error: null }),
      );
    await expect(
      service.assertPlanAccess('plan-1', 'org-1', 'user-1', 'edit'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('checks organization membership before inserting a task allocation', async () => {
    from
      .mockReturnValueOnce(
        singleQuery({
          data: {
            id: 'task-1',
            organization_id: 'org-1',
            space_id: 'space-1',
            planned_budget: 0,
          },
          error: null,
        }),
      )
      .mockReturnValueOnce(singleQuery({ data: null, error: null }));
    permissions.getUserSpacePermissions.mockResolvedValue({
      isMember: true,
      permissions: { edit_tasks: true },
    });

    await expect(
      service.createTaskAllocation('task-1', 'org-1', 'actor-1', {
        user_id: 'outside-user',
        planned_hours: 4,
      }),
    ).rejects.toThrow(NotFoundException);

    expect(from).toHaveBeenCalledTimes(2);
    expect(from).not.toHaveBeenCalledWith('task_resource_allocations');
  });

  it('clears stale total hours when switching to a recurring allocation', async () => {
    const existing = {
      id: 'allocation-1',
      organization_id: 'org-1',
      plan_id: 'plan-1',
      user_id: 'user-1',
      planned_hours: 80,
      planned_budget: 0,
      allocation_mode: 'total_hours' as const,
      start_date: null,
      end_date: null,
      weekly_hours: null,
      capacity_percent: null,
      role: null,
      notes: null,
      created_by: 'actor-1',
      updated_by: 'actor-1',
      created_at: '2026-08-01T00:00:00Z',
      updated_at: '2026-08-01T00:00:00Z',
    };
    const plan = {
      id: 'plan-1',
      organization_id: 'org-1',
      space_id: 'space-1',
      currency: 'EUR',
      start_date: '2026-08-01',
      end_date: '2026-08-31',
    };
    const write = updateQuery({
      data: { ...existing, allocation_mode: 'hours_per_week' },
      error: null,
    });
    from
      .mockReturnValueOnce(singleQuery({ data: existing, error: null }))
      .mockReturnValueOnce(singleQuery({ data: plan, error: null }))
      .mockReturnValueOnce(write);
    permissions.getUserSpacePermissions.mockResolvedValue({
      isMember: true,
      permissions: { edit_plans: true },
    });

    await service.updatePlanAllocation('allocation-1', 'org-1', 'actor-1', {
      allocation_mode: 'hours_per_week',
      weekly_hours: 8,
      start_date: '2026-08-01',
      end_date: '2026-08-31',
    });

    expect(write.update).toHaveBeenCalledWith(
      expect.objectContaining({
        allocation_mode: 'hours_per_week',
        planned_hours: 0,
        weekly_hours: 8,
        capacity_percent: null,
      }),
    );
  });

  describe('getPortfolioSummary', () => {
    const portfolio = { id: 'portfolio-1', organization_id: 'org-1' };

    function plan(id: string, overrides: Record<string, unknown> = {}) {
      return {
        id,
        organization_id: 'org-1',
        space_id: 'space-1',
        currency: 'USD',
        name: id,
        start_date: '2026-08-01',
        end_date: '2026-08-31',
        ...overrides,
      };
    }

    it('normalizes currency case so USD and usd bucket together', async () => {
      permissions.isAdminOrOwner.mockResolvedValue(true);
      const planA = plan('plan-a', { currency: 'USD' });
      const planB = plan('plan-b', { currency: 'usd' });

      from
        .mockReturnValueOnce(chainQuery({ data: portfolio, error: null }))
        .mockReturnValueOnce(
          chainQuery({
            data: [
              { plan_id: 'plan-a', plan: planA },
              { plan_id: 'plan-b', plan: planB },
            ],
            error: null,
          }),
        )
        .mockReturnValueOnce(
          chainQuery({
            data: [
              {
                ...planAllocBase,
                id: 'alloc-a',
                plan_id: 'plan-a',
                planned_budget: 1000,
                user: { id: 'user-1' },
              },
              {
                ...planAllocBase,
                id: 'alloc-b',
                plan_id: 'plan-b',
                planned_budget: 500,
                user: { id: 'user-1' },
              },
            ],
            error: null,
          }),
        )
        .mockReturnValueOnce(chainQuery({ data: [], error: null }))
        .mockReturnValueOnce(chainQuery({ data: [], error: null }));

      const result = await service.getPortfolioSummary(
        'portfolio-1',
        'org-1',
        'actor-1',
      );

      expect(result.skipped_plan_count).toBe(0);
      expect(result.budget_by_currency).toEqual([
        { currency: 'USD', planned_budget: 1500 },
      ]);
      expect(result.totals.planned_budget).toBe(1500);
      expect(result.employees[0]).toMatchObject({
        planned_budget: 1500,
        budget_by_currency: [{ currency: 'USD', planned_budget: 1500 }],
      });
    });

    it('isolates an unexpected per-plan error instead of failing the whole portfolio', async () => {
      const planOk = plan('plan-ok');
      const planBad = plan('plan-bad', { space_id: 'space-2' });
      permissions.isAdminOrOwner
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error('unexpected db hiccup'));

      from
        .mockReturnValueOnce(chainQuery({ data: portfolio, error: null }))
        .mockReturnValueOnce(
          chainQuery({
            data: [
              { plan_id: 'plan-ok', plan: planOk },
              { plan_id: 'plan-bad', plan: planBad },
            ],
            error: null,
          }),
        )
        .mockReturnValueOnce(
          chainQuery({
            data: [
              {
                ...planAllocBase,
                id: 'alloc-ok',
                plan_id: 'plan-ok',
                planned_hours: 10,
                planned_budget: 1000,
                user: { id: 'user-1' },
              },
            ],
            error: null,
          }),
        )
        .mockReturnValueOnce(chainQuery({ data: [], error: null }))
        .mockReturnValueOnce(chainQuery({ data: [], error: null }));

      const result = await service.getPortfolioSummary(
        'portfolio-1',
        'org-1',
        'actor-1',
      );

      expect(result.skipped_plan_count).toBe(1);
      expect(result.employees).toHaveLength(1);
      expect(result.totals.planned_hours).toBe(10);
    });

    it('excludes archived plans from the portfolio summary by default', async () => {
      permissions.isAdminOrOwner.mockResolvedValue(true);
      const planOk = plan('plan-ok');
      const planArchived = plan('plan-archived', { is_archived: true });

      from
        .mockReturnValueOnce(chainQuery({ data: portfolio, error: null }))
        .mockReturnValueOnce(
          chainQuery({
            data: [
              { plan_id: 'plan-ok', plan: planOk },
              { plan_id: 'plan-archived', plan: planArchived },
            ],
            error: null,
          }),
        )
        .mockReturnValueOnce(
          chainQuery({
            data: [
              {
                ...planAllocBase,
                id: 'alloc-ok',
                plan_id: 'plan-ok',
                planned_hours: 10,
                planned_budget: 1000,
                user: { id: 'user-1' },
              },
            ],
            error: null,
          }),
        )
        .mockReturnValueOnce(chainQuery({ data: [], error: null }))
        .mockReturnValueOnce(chainQuery({ data: [], error: null }));

      const result = await service.getPortfolioSummary(
        'portfolio-1',
        'org-1',
        'actor-1',
      );

      expect(result.skipped_plan_count).toBe(1);
      expect(result.employees).toHaveLength(1);
      expect(result.totals.planned_budget).toBe(1000);
    });

    it('batches the allocations fetch into a single query instead of one per plan', async () => {
      permissions.isAdminOrOwner.mockResolvedValue(true);
      const plans = ['plan-1', 'plan-2', 'plan-3'].map((id) => plan(id));
      const allocChain = chainQuery({ data: [], error: null });

      from
        .mockReturnValueOnce(chainQuery({ data: portfolio, error: null }))
        .mockReturnValueOnce(
          chainQuery({
            data: plans.map((p) => ({ plan_id: p.id, plan: p })),
            error: null,
          }),
        )
        .mockReturnValueOnce(allocChain)
        .mockReturnValueOnce(chainQuery({ data: [], error: null }))
        .mockReturnValueOnce(chainQuery({ data: [], error: null }));

      await service.getPortfolioSummary('portfolio-1', 'org-1', 'actor-1');

      const allocCalls = from.mock.calls.filter(
        ([table]) => table === 'plan_resource_allocations',
      );
      expect(allocCalls).toHaveLength(1);
      expect(allocChain.in).toHaveBeenCalledWith('plan_id', [
        'plan-1',
        'plan-2',
        'plan-3',
      ]);
    });
  });

  describe('bulkUpdateCapacity', () => {
    type Row = Record<string, unknown>;
    const ORG = 'org-1';
    const ACTOR = 'actor-1';
    let db: Record<string, Row[]>;
    let upserts: unknown[];
    let deletes: { eq: [string, unknown][]; in?: [string, unknown[]] }[];
    let rejectUpsertFor: string | undefined;

    /** In-memory stand-in for the PostgREST chains the capacity writes use. */
    function fakeFrom(table: string) {
      const eq: [string, unknown][] = [];
      let inFilter: [string, unknown[]] | undefined;
      let op: 'select' | 'upsert' | 'delete' = 'select';
      let payload: unknown;

      const run = () => {
        if (op === 'upsert') {
          upserts.push(payload);
          const bad = ([] as Row[])
            .concat(payload as Row)
            .some((r) => r.user_id === rejectUpsertFor);
          return bad
            ? { data: null, error: { message: 'boom' } }
            : { data: payload, error: null };
        }
        if (op === 'delete') {
          deletes.push({ eq, in: inFilter });
          return { data: null, error: null };
        }
        const data = (db[table] ?? []).filter(
          (r) =>
            eq.every(([k, v]) => r[k] === v) &&
            (!inFilter || inFilter[1].includes(r[inFilter[0]])),
        );
        return { data, error: null };
      };

      const query: Record<string, unknown> = {
        select: () => query,
        eq: (k: string, v: unknown) => {
          eq.push([k, v]);
          return query;
        },
        in: (k: string, v: unknown[]) => {
          inFilter = [k, v];
          return query;
        },
        upsert: (p: unknown) => {
          op = 'upsert';
          payload = p;
          return query;
        },
        delete: () => {
          op = 'delete';
          return query;
        },
        maybeSingle: () => {
          const r = run();
          const data = Array.isArray(r.data) ? (r.data[0] ?? null) : r.data;
          return Promise.resolve({ ...r, data });
        },
        then: (
          onFulfilled: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => Promise.resolve(run()).then(onFulfilled, onRejected),
      };
      query.single = query.maybeSingle;
      return query;
    }

    const row = (user_id: string, values: Row = {}): Row => ({
      organization_id: ORG,
      user_id,
      weekly_capacity_hours: 40,
      cost_rate: null,
      currency: null,
      is_active: true,
      created_by: 'creator-1',
      ...values,
    });
    const values = (
      weekly: number,
      rate: number | null,
      currency: string | null,
    ) => ({
      weekly_capacity_hours: weekly,
      cost_rate: rate,
      currency,
      is_active: true,
    });
    const bulk = (dto: Partial<BulkUpdateCapacityDto>) =>
      service.bulkUpdateCapacity(ORG, ACTOR, dto as BulkUpdateCapacityDto);

    beforeEach(() => {
      const ids = ['u1', 'u2', 'u3', 'u4'];
      db = {
        organization_members: ids.map((user_id) => ({
          organization_id: ORG,
          user_id,
        })),
        users: ids.map((id) => ({ id, is_active: true })),
        employee_capacity: [],
      };
      upserts = [];
      deletes = [];
      rejectUpsertFor = undefined;
      from.mockImplementation(fakeFrom);
    });

    it('setting only rate and currency keeps the weekly hours of each employee', async () => {
      db.employee_capacity = [
        row('u1'),
        row('u2', { weekly_capacity_hours: '20.00' }),
        row('u3', { cost_rate: '50', currency: 'USD' }),
      ];

      const result = await bulk({
        action: 'update',
        user_ids: ['u1', 'u2', 'u3'],
        changes: { cost_rate: 90, currency: 'EUR' },
      });

      expect(result).toEqual({
        updated: ['u1', 'u2', 'u3'],
        unchanged: [],
        skipped: [],
        failed: [],
      });
      expect(upserts).toEqual([
        [40, 20, 40].map((weekly, i) =>
          expect.objectContaining({
            user_id: `u${i + 1}`,
            weekly_capacity_hours: weekly,
            cost_rate: 90,
            currency: 'EUR',
          }),
        ),
      ]);
    });

    it('sorts a mixed selection into one list each and audits only the written employee', async () => {
      db.organization_members.push({ organization_id: 'org-2', user_id: 'u9' });
      db.users[3].is_active = false;
      db.employee_capacity = [
        row('u1'),
        row('u3', { cost_rate: '90.00', currency: 'EUR' }),
        row('u4'),
      ];

      const result = await bulk({
        action: 'update',
        user_ids: ['u1', 'u2', 'u3', 'u4', 'u9'],
        changes: { cost_rate: 90, currency: 'EUR' },
      });

      expect(result).toEqual({
        updated: ['u1'],
        unchanged: ['u3'],
        skipped: [{ user_id: 'u4', reason: 'deactivated' }],
        failed: [
          {
            user_id: 'u2',
            reason: 'weekly_capacity_required',
            message:
              'Enter a weekly capacity for employees without their own values',
          },
          {
            user_id: 'u9',
            reason: 'not_member',
            message: 'User is not a member of this organization',
          },
        ],
      });
      expect(upserts).toEqual([[expect.objectContaining({ user_id: 'u1' })]]);
      expect(audit.logAction).toHaveBeenCalledTimes(1);
      expect(audit.logAction).toHaveBeenCalledWith(
        ORG,
        ACTOR,
        'employee_capacity',
        'u1',
        'update',
        {
          user_id: 'u1',
          source: 'bulk',
          before: values(40, null, null),
          after: values(40, 90, 'EUR'),
        },
      );
    });

    it('requires a currency when the rate is touched and the employee has none', async () => {
      db.employee_capacity = [row('u1'), row('u2', { currency: 'USD' })];

      const result = await bulk({
        action: 'update',
        user_ids: ['u1', 'u2'],
        changes: { cost_rate: 50 },
      });

      expect(result.updated).toEqual(['u2']);
      expect(result.failed).toEqual([
        {
          user_id: 'u1',
          reason: 'currency_required_for_rate',
          message: CURRENCY_REQUIRED_FOR_RATE_MESSAGE,
        },
      ]);
    });

    it('treats string numerics equal to the change as unchanged, with no write or audit', async () => {
      db.employee_capacity = [
        row('u1', {
          weekly_capacity_hours: '40.00',
          cost_rate: '90.00',
          currency: 'EUR',
        }),
      ];

      const result = await bulk({
        action: 'update',
        user_ids: ['u1'],
        changes: { weekly_capacity_hours: 40, cost_rate: 90, currency: 'EUR' },
      });

      expect(result.unchanged).toEqual(['u1']);
      expect(upserts).toHaveLength(0);
      expect(audit.logAction).not.toHaveBeenCalled();
    });

    it('reset deletes only existing rows and leaves Fallback employees unchanged', async () => {
      db.employee_capacity = [row('u1', { cost_rate: 10, currency: 'USD' })];

      const result = await bulk({ action: 'reset', user_ids: ['u1', 'u2'] });

      expect(result).toMatchObject({ updated: ['u1'], unchanged: ['u2'] });
      expect(deletes).toEqual([
        { eq: [['organization_id', ORG]], in: ['user_id', ['u1']] },
      ]);
      expect(audit.logAction).toHaveBeenCalledWith(
        ORG,
        ACTOR,
        'employee_capacity',
        'u1',
        'delete',
        {
          user_id: 'u1',
          source: 'bulk',
          before: values(40, 10, 'USD'),
          after: null,
        },
      );
    });

    it('retries a failed batch per row so only the bad row is write_failed', async () => {
      db.employee_capacity = [row('u1'), row('u2'), row('u3')];
      rejectUpsertFor = 'u2';

      const result = await bulk({
        action: 'update',
        user_ids: ['u1', 'u2', 'u3'],
        changes: { weekly_capacity_hours: 10 },
      });

      expect(result.updated).toEqual(['u1', 'u3']);
      expect(result.failed).toEqual([
        { user_id: 'u2', reason: 'write_failed', message: 'boom' },
      ]);
      expect(upserts).toHaveLength(4);
      expect(audit.logAction).toHaveBeenCalledTimes(2);
    });

    it('keeps created_by on existing rows and sets the actor on new ones', async () => {
      db.employee_capacity = [row('u1'), row('u3', { created_by: null })];

      await bulk({
        action: 'update',
        user_ids: ['u1', 'u2', 'u3'],
        changes: { weekly_capacity_hours: 32 },
      });

      expect(upserts).toEqual([
        [
          expect.objectContaining({
            user_id: 'u1',
            created_by: 'creator-1',
            updated_by: ACTOR,
          }),
          expect.objectContaining({
            user_id: 'u2',
            created_by: ACTOR,
            is_active: true,
          }),
          expect.objectContaining({ user_id: 'u3', created_by: null }),
        ],
      ]);
      expect(audit.logAction).toHaveBeenCalledWith(
        ORG,
        ACTOR,
        'employee_capacity',
        'u2',
        'create',
        {
          user_id: 'u2',
          source: 'bulk',
          before: null,
          after: values(32, null, null),
        },
      );
    });

    it.each([
      ['reset with changes', { action: 'reset', changes: {} }],
      ['update without changes', { action: 'update' }],
      [
        'update with no defined change',
        { action: 'update', changes: { weekly_capacity_hours: undefined } },
      ],
    ] as const)('rejects %s', async (_, dto) => {
      await expect(
        bulk({ ...dto, user_ids: ['u1'] } as Partial<BulkUpdateCapacityDto>),
      ).rejects.toThrow(BadRequestException);
      expect(from).not.toHaveBeenCalled();
    });

    it('upsertCapacity audits the single edit with before and after values', async () => {
      db.employee_capacity = [row('u1')];

      await service.upsertCapacity(ORG, ACTOR, 'u1', {
        weekly_capacity_hours: 20,
      });

      expect(audit.logAction).toHaveBeenCalledWith(
        ORG,
        ACTOR,
        'employee_capacity',
        'u1',
        'update',
        {
          user_id: 'u1',
          source: 'single',
          before: values(40, null, null),
          after: values(20, null, null),
        },
      );
    });
  });
});
