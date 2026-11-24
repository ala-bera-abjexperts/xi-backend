import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import type { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { WorkingCalendarService } from '../calendar/working-calendar.service';
import type { PermissionsService } from '../../permissions/permissions.service';
import type { ResourcePlanningService } from '../resource-planning.service';
import { ResourcePlanningReportService } from './resource-planning-report.service';
import { buildResourcePlanningReport } from './resource-planning-report.engine';
import type {
  NormalizedResourcePlanningReportQuery,
  ResourcePlanningReportDataset,
} from './resource-planning-report.types';

/** Mirrors the chainable query mock used in resource-planning.service.spec.ts. */
function chainQuery(result: { data: unknown; error: unknown }) {
  const query: Record<string, unknown> = {};
  const self = jest.fn(() => query);
  query.select = self;
  query.eq = self;
  query.lte = self;
  query.gte = self;
  query.or = self;
  query.in = self;
  query.maybeSingle = jest.fn().mockResolvedValue(result);
  query.range = jest.fn().mockResolvedValue(result);
  return query;
}

const emptyDataset: ResourcePlanningReportDataset = {
  users: [],
  units: [],
  unitMemberships: [],
  capacities: [],
  capacityPeriods: [],
  plans: [],
  allocations: [],
  planTasks: [],
  portfolioPlans: [],
  portfolios: [],
  timeEntries: [],
  budgetEntries: [],
};

describe('ResourcePlanningReportService', () => {
  const supabase = { getClient: jest.fn() } as unknown as SupabaseAdminService;
  const modules = {
    isEnabled: jest.fn(),
  } as unknown as jest.Mocked<OrganizationModulesService>;
  // No org has configured a scheme in these tests — the dataset builder
  // must skip calendar resolution entirely, matching pre-Phase-1 behavior.
  const workingCalendar = {
    hasAnySchemeConfigured: jest.fn().mockResolvedValue(false),
    resolveCalendarContext: jest.fn().mockResolvedValue(null),
  } as unknown as WorkingCalendarService;
  // Defaults to "full access" so every pre-existing test below (none of
  // which cares about the new access check) keeps its original behavior.
  const resourcePlanningService = {
    canExposePlan: jest.fn().mockResolvedValue(true),
    // Every space allowed, so the space-scope filter is a no-op for them too.
    resolveSpaceScope: jest.fn().mockResolvedValue({
      allowedSpaceIds: { has: () => true },
      allowsNullSpace: true,
    }),
  } as unknown as jest.Mocked<ResourcePlanningService>;
  // Defaults to "has every permission" so the pre-existing tests below, none of
  // which cares about the group_by=portfolio permission check, behave as before.
  const permissions = {
    hasAllPermissions: jest.fn().mockResolvedValue(true),
  } as unknown as jest.Mocked<PermissionsService>;

  beforeEach(() => jest.clearAllMocks());

  it('blocks direct consumers when the organization module is disabled', async () => {
    modules.isEnabled.mockResolvedValue(false);
    const service = new ResourcePlanningReportService(
      supabase,
      modules,
      workingCalendar,
      resourcePlanningService,
      permissions,
    );

    await expect(
      service.getReport('org-1', {}, 'user-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect((supabase.getClient as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('normalizes filters and returns the shared report shape', async () => {
    modules.isEnabled.mockResolvedValue(true);
    const service = new ResourcePlanningReportService(
      supabase,
      modules,
      workingCalendar,
      resourcePlanningService,
      permissions,
    );
    const loadDataset = jest
      .spyOn(
        service as unknown as {
          loadDataset: jest.Mock<Promise<ResourcePlanningReportDataset>>;
        },
        'loadDataset',
      )
      .mockResolvedValue(emptyDataset);

    const report = await service.getReport(
      'org-1',
      {
        from: '2026-08-01',
        to: '2026-08-31',
        bucket: 'month',
        group_by: 'portfolio',
      },
      'user-1',
    );

    expect(loadDataset).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({
        from: '2026-08-01',
        to: '2026-08-31',
        bucket: 'month',
        group_by: 'portfolio',
      }),
      'user-1',
    );
    expect(report).toEqual(
      expect.objectContaining({
        range: {
          from: '2026-08-01',
          to: '2026-08-31',
          bucket: 'month',
          group_by: 'portfolio',
        },
        rows: [],
      }),
    );
  });

  it('allows exactly 10,000 source rows and probes once for overflow', async () => {
    modules.isEnabled.mockResolvedValue(true);
    const service = new ResourcePlanningReportService(
      supabase,
      modules,
      workingCalendar,
      resourcePlanningService,
      permissions,
    );
    const page = Array.from({ length: 1_000 }, (_, index) => ({ index }));
    const load = jest.fn().mockImplementation((from: number) =>
      Promise.resolve({
        data: from < 10_000 ? page : [],
        error: null,
      }),
    );
    const internal = service as unknown as {
      fetchPaged<T>(
        label: string,
        loader: (
          from: number,
          to: number,
        ) => Promise<{
          data: T[];
          error: null;
        }>,
      ): Promise<T[]>;
    };

    await expect(internal.fetchPaged('rows', load)).resolves.toHaveLength(
      10_000,
    );
    expect(load).toHaveBeenLastCalledWith(10_000, 10_000);
  });

  it('does not suppress source query failures', async () => {
    const service = new ResourcePlanningReportService(
      supabase,
      modules,
      workingCalendar,
      resourcePlanningService,
      permissions,
    );
    const internal = service as unknown as {
      fetchPaged<T>(
        label: string,
        loader: () => Promise<{
          data: T[] | null;
          error: { message: string } | null;
        }>,
      ): Promise<T[]>;
    };

    await expect(
      internal.fetchPaged('time entries', () =>
        Promise.resolve({ data: null, error: { message: 'database down' } }),
      ),
    ).rejects.toThrow('Unable to load time entries: database down');
  });

  it('404s when group_by=portfolio and group_id matches no portfolio in the organization', async () => {
    modules.isEnabled.mockResolvedValue(true);
    const portfolioLookup = chainQuery({ data: null, error: null });
    (supabase.getClient as jest.Mock).mockReturnValue({
      from: jest.fn().mockReturnValue(portfolioLookup),
    });
    const service = new ResourcePlanningReportService(
      supabase,
      modules,
      workingCalendar,
      resourcePlanningService,
      permissions,
    );
    const loadDataset = jest.spyOn(
      service as unknown as {
        loadDataset: jest.Mock<Promise<ResourcePlanningReportDataset>>;
      },
      'loadDataset',
    );

    await expect(
      service.getReport(
        'org-1',
        {
          group_by: 'portfolio',
          group_id: '11111111-1111-1111-1111-111111111111',
        },
        'user-1',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(loadDataset).not.toHaveBeenCalled();
  });

  it('loads the report when group_by=portfolio and group_id matches a portfolio in the organization', async () => {
    modules.isEnabled.mockResolvedValue(true);
    const portfolioLookup = chainQuery({
      data: { id: 'pf-1' },
      error: null,
    });
    (supabase.getClient as jest.Mock).mockReturnValue({
      from: jest.fn().mockReturnValue(portfolioLookup),
    });
    const service = new ResourcePlanningReportService(
      supabase,
      modules,
      workingCalendar,
      resourcePlanningService,
      permissions,
    );
    jest
      .spyOn(
        service as unknown as {
          loadDataset: jest.Mock<Promise<ResourcePlanningReportDataset>>;
        },
        'loadDataset',
      )
      .mockResolvedValue(emptyDataset);

    await expect(
      service.getReport(
        'org-1',
        { group_by: 'portfolio', group_id: 'pf-1' },
        'user-1',
      ),
    ).resolves.toEqual(expect.objectContaining({ rows: [] }));
  });

  it('does not check portfolio existence when group_by=portfolio has no group_id', async () => {
    modules.isEnabled.mockResolvedValue(true);
    const getClient = supabase.getClient as jest.Mock;
    const service = new ResourcePlanningReportService(
      supabase,
      modules,
      workingCalendar,
      resourcePlanningService,
      permissions,
    );
    jest
      .spyOn(
        service as unknown as {
          loadDataset: jest.Mock<Promise<ResourcePlanningReportDataset>>;
        },
        'loadDataset',
      )
      .mockResolvedValue(emptyDataset);

    await expect(
      service.getReport('org-1', { group_by: 'portfolio' }, 'user-1'),
    ).resolves.toEqual(expect.objectContaining({ rows: [] }));
    expect(getClient).not.toHaveBeenCalled();
  });

  describe('group_by=portfolio entitlement (D7)', () => {
    it('blocks it when the portfolio module is off, while RP itself is on', async () => {
      modules.isEnabled.mockImplementation((_org: string, key: string) =>
        Promise.resolve(key === 'resource_planning'),
      );
      const service = new ResourcePlanningReportService(
        supabase,
        modules,
        workingCalendar,
        resourcePlanningService,
        permissions,
      );

      await expect(
        service.getReport('org-1', { group_by: 'portfolio' }, 'user-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(supabase.getClient as jest.Mock).not.toHaveBeenCalled();
    });

    it('blocks it when the caller lacks can_view_portfolios', async () => {
      modules.isEnabled.mockResolvedValue(true);
      (permissions.hasAllPermissions as jest.Mock).mockResolvedValue(false);
      const service = new ResourcePlanningReportService(
        supabase,
        modules,
        workingCalendar,
        resourcePlanningService,
        permissions,
      );

      await expect(
        service.getReport('org-1', { group_by: 'portfolio' }, 'user-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(permissions.hasAllPermissions).toHaveBeenCalledWith(
        'user-1',
        'org-1',
        ['can_view_portfolios'],
      );
    });

    it('leaves the other groupings alone when portfolio entitlement is absent', async () => {
      modules.isEnabled.mockImplementation((_org: string, key: string) =>
        Promise.resolve(key === 'resource_planning'),
      );
      (permissions.hasAllPermissions as jest.Mock).mockResolvedValue(false);
      const service = new ResourcePlanningReportService(
        supabase,
        modules,
        workingCalendar,
        resourcePlanningService,
        permissions,
      );
      jest
        .spyOn(
          service as unknown as {
            loadDataset: jest.Mock<Promise<ResourcePlanningReportDataset>>;
          },
          'loadDataset',
        )
        .mockResolvedValue(emptyDataset);

      for (const group_by of ['user', 'unit', 'plan'] as const) {
        await expect(
          service.getReport('org-1', { group_by }, 'user-1'),
        ).resolves.toEqual(expect.objectContaining({ rows: [] }));
      }
      expect(permissions.hasAllPermissions).not.toHaveBeenCalled();
    });
  });

  it('404s when portfolio_id matches no portfolio in the organization', async () => {
    modules.isEnabled.mockResolvedValue(true);
    const portfolioLookup = chainQuery({ data: null, error: null });
    (supabase.getClient as jest.Mock).mockReturnValue({
      from: jest.fn().mockReturnValue(portfolioLookup),
    });
    const service = new ResourcePlanningReportService(
      supabase,
      modules,
      workingCalendar,
      resourcePlanningService,
      permissions,
    );
    const loadDataset = jest.spyOn(
      service as unknown as {
        loadDataset: jest.Mock<Promise<ResourcePlanningReportDataset>>;
      },
      'loadDataset',
    );

    await expect(
      service.getReport(
        'org-1',
        {
          group_by: 'unit',
          portfolio_id: '11111111-1111-1111-1111-111111111111',
        },
        'user-1',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(loadDataset).not.toHaveBeenCalled();
  });

  it('loads the report when portfolio_id matches a portfolio in the organization', async () => {
    modules.isEnabled.mockResolvedValue(true);
    const portfolioLookup = chainQuery({
      data: { id: 'pf-1' },
      error: null,
    });
    (supabase.getClient as jest.Mock).mockReturnValue({
      from: jest.fn().mockReturnValue(portfolioLookup),
    });
    const service = new ResourcePlanningReportService(
      supabase,
      modules,
      workingCalendar,
      resourcePlanningService,
      permissions,
    );
    jest
      .spyOn(
        service as unknown as {
          loadDataset: jest.Mock<Promise<ResourcePlanningReportDataset>>;
        },
        'loadDataset',
      )
      .mockResolvedValue(emptyDataset);

    await expect(
      service.getReport(
        'org-1',
        { group_by: 'unit', portfolio_id: 'pf-1' },
        'user-1',
      ),
    ).resolves.toEqual(expect.objectContaining({ rows: [] }));
  });

  it('does not check portfolio existence when portfolio_id is unset', async () => {
    modules.isEnabled.mockResolvedValue(true);
    const getClient = supabase.getClient as jest.Mock;
    const service = new ResourcePlanningReportService(
      supabase,
      modules,
      workingCalendar,
      resourcePlanningService,
      permissions,
    );
    jest
      .spyOn(
        service as unknown as {
          loadDataset: jest.Mock<Promise<ResourcePlanningReportDataset>>;
        },
        'loadDataset',
      )
      .mockResolvedValue(emptyDataset);

    await expect(
      service.getReport('org-1', { group_by: 'unit' }, 'user-1'),
    ).resolves.toEqual(expect.objectContaining({ rows: [] }));
    expect(getClient).not.toHaveBeenCalled();
  });

  it('filters resource_budget_entries to aggregation=manual at the query level', async () => {
    modules.isEnabled.mockResolvedValue(true);
    const budgetEntriesQuery = chainQuery({ data: [], error: null });
    const from = jest.fn((table: string) =>
      table === 'resource_budget_entries'
        ? budgetEntriesQuery
        : chainQuery({ data: [], error: null }),
    );
    (supabase.getClient as jest.Mock).mockReturnValue({ from });
    const service = new ResourcePlanningReportService(
      supabase,
      modules,
      workingCalendar,
      resourcePlanningService,
      permissions,
    );
    const internal = service as unknown as {
      loadDataset(
        organizationId: string,
        query: NormalizedResourcePlanningReportQuery,
      ): Promise<ResourcePlanningReportDataset>;
    };

    await internal.loadDataset('org-1', {
      from: '2026-08-01',
      to: '2026-08-31',
      bucket: 'week',
      group_by: 'portfolio',
      include_archived: false,
    });

    // D9 filter: a rollup-flagged budget row is a placeholder, not a cost
    // fact, and must be excluded from the dataset at the query level.
    expect(budgetEntriesQuery.eq).toHaveBeenCalledWith('aggregation', 'manual');
  });

  it('drops plans, allocations and entries from spaces outside the RP scope', async () => {
    modules.isEnabled.mockResolvedValue(true);
    const rows: Record<string, unknown[]> = {
      plans: [
        { id: 'plan-on', name: 'On', space_id: 'space-on', is_archived: false },
        {
          id: 'plan-off',
          name: 'Off',
          space_id: 'space-off',
          is_archived: false,
        },
      ],
      plan_resource_allocations: [
        { id: 'a-on', plan_id: 'plan-on', user_id: 'u1', planned_hours: 1 },
        { id: 'a-off', plan_id: 'plan-off', user_id: 'u1', planned_hours: 1 },
      ],
      time_entries: [
        {
          id: 'te-on',
          task_id: 'task-on',
          user_id: 'u1',
          duration_minutes: 60,
        },
        {
          id: 'te-off',
          task_id: 'task-off',
          user_id: 'u1',
          duration_minutes: 60,
        },
      ],
      resource_budget_entries: [
        {
          id: 'be-plan-off',
          plan_id: 'plan-off',
          task_id: null,
          currency: 'EUR',
        },
        {
          id: 'be-task-null',
          plan_id: null,
          task_id: 'task-null',
          currency: 'EUR',
        },
      ],
      tasks: [
        { id: 'task-on', space_id: 'space-on' },
        { id: 'task-off', space_id: 'space-off' },
        { id: 'task-null', space_id: null },
      ],
    };
    const from = jest.fn((table: string) =>
      chainQuery({ data: rows[table] ?? [], error: null }),
    );
    (supabase.getClient as jest.Mock).mockReturnValue({ from });
    (
      resourcePlanningService.resolveSpaceScope as jest.Mock
    ).mockResolvedValueOnce({
      allowedSpaceIds: new Set(['space-on']),
      allowsNullSpace: true,
    });
    const service = new ResourcePlanningReportService(
      supabase,
      modules,
      workingCalendar,
      resourcePlanningService,
      permissions,
    );
    const internal = service as unknown as {
      loadDataset(
        organizationId: string,
        query: NormalizedResourcePlanningReportQuery,
        userId: string,
      ): Promise<ResourcePlanningReportDataset>;
    };

    const dataset = await internal.loadDataset(
      'org-1',
      {
        from: '2026-08-01',
        to: '2026-08-31',
        bucket: 'week',
        group_by: 'user',
        include_archived: false,
      },
      'user-1',
    );

    expect(dataset.plans.map((item) => item.id)).toEqual(['plan-on']);
    expect(dataset.allocations.map((item) => item.id)).toEqual(['a-on']);
    expect(dataset.timeEntries.map((item) => item.id)).toEqual(['te-on']);
    expect(dataset.budgetEntries.map((item) => item.id)).toEqual([
      'be-task-null',
    ]);
  });

  it('does not throw when a resource_budget_entries row has a null currency', async () => {
    modules.isEnabled.mockResolvedValue(true);
    const budgetEntriesQuery = chainQuery({
      data: [
        {
          id: 'be-1',
          plan_id: 'plan-1',
          task_id: null,
          entry_type: 'planned',
          amount: 100,
          currency: null,
          effective_date: '2026-08-05',
        },
      ],
      error: null,
    });
    // plan-1 must exist: entries of plans outside the RP space scope are dropped.
    const from = jest.fn((table: string) =>
      table === 'resource_budget_entries'
        ? budgetEntriesQuery
        : chainQuery({
            data: table === 'plans' ? [{ id: 'plan-1', space_id: 's1' }] : [],
            error: null,
          }),
    );
    (supabase.getClient as jest.Mock).mockReturnValue({ from });
    const service = new ResourcePlanningReportService(
      supabase,
      modules,
      workingCalendar,
      resourcePlanningService,
      permissions,
    );
    const internal = service as unknown as {
      loadDataset(
        organizationId: string,
        query: NormalizedResourcePlanningReportQuery,
      ): Promise<ResourcePlanningReportDataset>;
    };

    // Previously `item.currency.toUpperCase()` threw a TypeError here; the
    // fix falls back to '' so the engine's own normalizeCurrency() buckets
    // it downstream instead.
    const dataset = await internal.loadDataset('org-1', {
      from: '2026-08-01',
      to: '2026-08-31',
      bucket: 'week',
      group_by: 'plan',
      include_archived: false,
    });

    expect(dataset.budgetEntries).toEqual([
      expect.objectContaining({ id: 'be-1', currency: '' }),
    ]);
  });

  describe('group_by=portfolio per-plan access check', () => {
    const planRows = [
      {
        id: 'p1',
        name: 'One',
        currency: 'EUR',
        start_date: null,
        end_date: null,
        is_archived: false,
        space_id: 's1',
      },
      {
        id: 'p2',
        name: 'Two',
        currency: 'EUR',
        start_date: null,
        end_date: null,
        is_archived: false,
        space_id: 's2',
      },
    ];
    const portfolioRows = [
      { id: 'pf1', name: 'Portfolio', is_archived: false },
    ];
    const portfolioPlanRows = [
      { portfolio_id: 'pf1', plan_id: 'p1' },
      { portfolio_id: 'pf1', plan_id: 'p2' },
    ];

    function mockClientFor(table: string, data: unknown[]) {
      return jest.fn((requestedTable: string) =>
        requestedTable === table
          ? chainQuery({ data, error: null })
          : chainQuery({ data: [], error: null }),
      );
    }

    function buildInternal(service: ResourcePlanningReportService) {
      return service as unknown as {
        loadDataset(
          organizationId: string,
          query: NormalizedResourcePlanningReportQuery,
          userId: string,
        ): Promise<ResourcePlanningReportDataset>;
      };
    }

    it('reuses ResourcePlanningService.canExposePlan, per plan linked to the requested portfolio(s), and excludes a plan the user cannot access', async () => {
      modules.isEnabled.mockResolvedValue(true);
      const from = jest.fn((table: string) => {
        if (table === 'plans')
          return chainQuery({ data: planRows, error: null });
        if (table === 'portfolios')
          return chainQuery({ data: portfolioRows, error: null });
        if (table === 'portfolio_plans')
          return chainQuery({ data: portfolioPlanRows, error: null });
        return chainQuery({ data: [], error: null });
      });
      (supabase.getClient as jest.Mock).mockReturnValue({ from });
      resourcePlanningService.canExposePlan.mockImplementation(
        (planId: string) => Promise.resolve(planId !== 'p2'),
      );
      const service = new ResourcePlanningReportService(
        supabase,
        modules,
        workingCalendar,
        resourcePlanningService,
        permissions,
      );

      const dataset = await buildInternal(service).loadDataset(
        'org-1',
        {
          from: '2026-08-03',
          to: '2026-08-09',
          bucket: 'week',
          group_by: 'portfolio',
          include_archived: false,
        },
        'user-1',
      );

      expect(resourcePlanningService.canExposePlan).toHaveBeenNthCalledWith(
        1,
        'p1',
        'org-1',
        'user-1',
        's1',
      );
      expect(resourcePlanningService.canExposePlan).toHaveBeenNthCalledWith(
        2,
        'p2',
        'org-1',
        'user-1',
        's2',
      );
      expect(dataset.accessiblePlanIds).toEqual(new Set(['p1']));
    });

    it('logs and excludes the plan when an access check fails unexpectedly, instead of failing the whole report', async () => {
      modules.isEnabled.mockResolvedValue(true);
      const from = jest.fn((table: string) => {
        if (table === 'plans')
          return chainQuery({ data: planRows, error: null });
        if (table === 'portfolios')
          return chainQuery({ data: portfolioRows, error: null });
        if (table === 'portfolio_plans')
          return chainQuery({ data: portfolioPlanRows, error: null });
        return chainQuery({ data: [], error: null });
      });
      (supabase.getClient as jest.Mock).mockReturnValue({ from });
      // Not a ForbiddenException: canExposePlan rethrows these, so they reach
      // computeAccessiblePlanIds' catch -- e.g. a transient DB failure.
      resourcePlanningService.canExposePlan.mockImplementation(
        (planId: string) =>
          planId === 'p2'
            ? Promise.reject(new Error('connection terminated'))
            : Promise.resolve(true),
      );
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const service = new ResourcePlanningReportService(
        supabase,
        modules,
        workingCalendar,
        resourcePlanningService,
        permissions,
      );

      const dataset = await buildInternal(service).loadDataset(
        'org-1',
        {
          from: '2026-08-03',
          to: '2026-08-09',
          bucket: 'week',
          group_by: 'portfolio',
          include_archived: false,
        },
        'user-1',
      );

      expect(dataset.accessiblePlanIds).toEqual(new Set(['p1']));
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('connection terminated'),
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('p2'));
      warn.mockRestore();
    });

    it('never checks plan access for group_by=user/unit/plan (unaffected scope)', async () => {
      modules.isEnabled.mockResolvedValue(true);
      (supabase.getClient as jest.Mock).mockReturnValue({
        from: mockClientFor('plans', planRows),
      });
      const service = new ResourcePlanningReportService(
        supabase,
        modules,
        workingCalendar,
        resourcePlanningService,
        permissions,
      );

      for (const groupBy of ['user', 'unit', 'plan'] as const) {
        const dataset = await buildInternal(service).loadDataset(
          'org-1',
          {
            from: '2026-08-03',
            to: '2026-08-09',
            bucket: 'week',
            group_by: groupBy,
            include_archived: false,
          },
          'user-1',
        );
        expect(dataset.accessiblePlanIds).toBeUndefined();
      }
      expect(resourcePlanningService.canExposePlan).not.toHaveBeenCalled();
    });

    it('candidates a portfolio-less plan when group_id is unset, and drops it from the candidate set when group_id is set (Fix 2b trap)', async () => {
      modules.isEnabled.mockResolvedValue(true);
      // p3 has no portfolio_plans row at all -- portfolioPlanRows is
      // unchanged from the p1/p2-only fixture above.
      const planRowsWithOrphan = [
        ...planRows,
        {
          id: 'p3',
          name: 'Orphan',
          currency: 'EUR',
          start_date: null,
          end_date: null,
          is_archived: false,
          space_id: 's3',
        },
      ];
      const from = jest.fn((table: string) => {
        if (table === 'plans')
          return chainQuery({ data: planRowsWithOrphan, error: null });
        if (table === 'portfolios')
          return chainQuery({ data: portfolioRows, error: null });
        if (table === 'portfolio_plans')
          return chainQuery({ data: portfolioPlanRows, error: null });
        return chainQuery({ data: [], error: null });
      });
      (supabase.getClient as jest.Mock).mockReturnValue({ from });
      resourcePlanningService.canExposePlan.mockResolvedValue(true);
      const service = new ResourcePlanningReportService(
        supabase,
        modules,
        workingCalendar,
        resourcePlanningService,
        permissions,
      );

      const withoutGroupId = await buildInternal(service).loadDataset(
        'org-1',
        {
          from: '2026-08-03',
          to: '2026-08-09',
          bucket: 'week',
          group_by: 'portfolio',
          include_archived: false,
        },
        'user-1',
      );
      expect(withoutGroupId.accessiblePlanIds).toEqual(
        new Set(['p1', 'p2', 'p3']),
      );
      expect(resourcePlanningService.canExposePlan).toHaveBeenCalledWith(
        'p3',
        'org-1',
        'user-1',
        's3',
      );

      resourcePlanningService.canExposePlan.mockClear();
      const withGroupId = await buildInternal(service).loadDataset(
        'org-1',
        {
          from: '2026-08-03',
          to: '2026-08-09',
          bucket: 'week',
          group_by: 'portfolio',
          group_id: 'pf1',
          include_archived: false,
        },
        'user-1',
      );
      // p3 is not linked to pf1 (or any portfolio) -- excluded from the
      // candidate set entirely, matching the pre-2b behavior for group_id.
      expect(withGroupId.accessiblePlanIds).toEqual(new Set(['p1', 'p2']));
      expect(resourcePlanningService.canExposePlan).not.toHaveBeenCalledWith(
        'p3',
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('portfolio_id dataset scoping', () => {
    const unitRows = [
      { id: 'leaf', parent_id: null, name: 'Platform', is_active: true },
    ];
    const membershipRows = [
      {
        unit_id: 'leaf',
        user_id: 'u1',
        effective_from: '2026-01-01',
        effective_to: null,
      },
    ];
    const memberRows = [
      {
        user_id: 'u1',
        user: { id: 'u1', first_name: 'Ada', last_name: '', email: 'ada@x.io' },
      },
    ];
    const capacityRows = [
      {
        user_id: 'u1',
        weekly_capacity_hours: '40',
        cost_rate: '100',
        currency: 'EUR',
        is_active: true,
      },
    ];
    const planRows = [
      {
        id: 'p1',
        name: 'In portfolio',
        currency: 'EUR',
        start_date: '2026-08-03',
        end_date: '2026-08-09',
        is_archived: false,
        space_id: 's1',
      },
      {
        id: 'p2',
        name: 'Sibling outside',
        currency: 'EUR',
        start_date: '2026-08-03',
        end_date: '2026-08-09',
        is_archived: false,
        space_id: 's2',
      },
    ];
    const allocationRows = [
      {
        id: 'a1',
        plan_id: 'p1',
        user_id: 'u1',
        allocation_mode: 'total_hours',
        planned_hours: '20',
        planned_budget: '0',
        weekly_hours: null,
        capacity_percent: null,
        start_date: '2026-08-03',
        end_date: '2026-08-09',
      },
      {
        id: 'a2',
        plan_id: 'p2',
        user_id: 'u1',
        allocation_mode: 'total_hours',
        planned_hours: '99',
        planned_budget: '0',
        weekly_hours: null,
        capacity_percent: null,
        start_date: '2026-08-03',
        end_date: '2026-08-09',
      },
    ];
    const portfolioRows = [
      { id: 'pf1', name: 'Portfolio', is_archived: false },
    ];
    const portfolioPlanRows = [{ portfolio_id: 'pf1', plan_id: 'p1' }];
    const planTaskRows = [
      { plan_id: 'p1', task_id: 't1' },
      { plan_id: 'p2', task_id: 't2' },
    ];
    const timeEntryRows = [
      {
        id: 'te1',
        task_id: 't1',
        user_id: 'u1',
        duration_minutes: '120',
        logged_at: '2026-08-04T10:00:00Z',
      },
      {
        id: 'te2',
        task_id: 't2',
        user_id: 'u1',
        duration_minutes: '60',
        logged_at: '2026-08-04T10:00:00Z',
      },
    ];
    const budgetEntryRows = [
      {
        id: 'be1',
        plan_id: 'p1',
        task_id: null,
        entry_type: 'actual',
        amount: '10',
        currency: 'EUR',
        effective_date: '2026-08-05',
      },
      {
        id: 'be2',
        plan_id: 'p2',
        task_id: null,
        entry_type: 'actual',
        amount: '50',
        currency: 'EUR',
        effective_date: '2026-08-05',
      },
    ];

    function mockClient() {
      const from = jest.fn((table: string) => {
        switch (table) {
          case 'organization_members':
            return chainQuery({ data: memberRows, error: null });
          case 'organization_units':
            return chainQuery({ data: unitRows, error: null });
          case 'organization_unit_memberships':
            return chainQuery({ data: membershipRows, error: null });
          case 'employee_capacity':
            return chainQuery({ data: capacityRows, error: null });
          case 'plans':
            return chainQuery({ data: planRows, error: null });
          // Task spaces for the RP space-scope filter on time entries.
          case 'tasks':
            return chainQuery({
              data: [
                { id: 't1', space_id: 's1' },
                { id: 't2', space_id: 's2' },
              ],
              error: null,
            });
          case 'plan_resource_allocations':
            return chainQuery({ data: allocationRows, error: null });
          case 'portfolios':
            return chainQuery({ data: portfolioRows, error: null });
          case 'plan_tasks':
            return chainQuery({ data: planTaskRows, error: null });
          case 'portfolio_plans':
            return chainQuery({ data: portfolioPlanRows, error: null });
          case 'time_entries':
            return chainQuery({ data: timeEntryRows, error: null });
          case 'resource_budget_entries':
            return chainQuery({ data: budgetEntryRows, error: null });
          default:
            return chainQuery({ data: [], error: null });
        }
      });
      (supabase.getClient as jest.Mock).mockReturnValue({ from });
    }

    function buildInternal(service: ResourcePlanningReportService) {
      return service as unknown as {
        loadDataset(
          organizationId: string,
          query: NormalizedResourcePlanningReportQuery,
          userId: string,
        ): Promise<ResourcePlanningReportDataset>;
      };
    }

    const scopedQuery = {
      from: '2026-08-03',
      to: '2026-08-09',
      bucket: 'week' as const,
      group_by: 'unit' as const,
      include_archived: false,
      portfolio_id: 'pf1',
    };

    it('restricts all plan-scoped data to the requested portfolio with group_by=unit', async () => {
      modules.isEnabled.mockResolvedValue(true);
      mockClient();
      resourcePlanningService.canExposePlan.mockResolvedValue(true);
      const service = new ResourcePlanningReportService(
        supabase,
        modules,
        workingCalendar,
        resourcePlanningService,
        permissions,
      );

      const dataset = await buildInternal(service).loadDataset(
        'org-1',
        scopedQuery,
        'user-1',
      );

      // Only p1 is linked to pf1, and only it was access-checked.
      expect(resourcePlanningService.canExposePlan).toHaveBeenCalledWith(
        'p1',
        'org-1',
        'user-1',
        's1',
      );
      expect(resourcePlanningService.canExposePlan).not.toHaveBeenCalledWith(
        'p2',
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
      expect(dataset.plans.map((plan) => plan.id)).toEqual(['p1']);
      expect(dataset.allocations.map((item) => item.id)).toEqual(['a1']);
      expect(dataset.planTasks).toEqual([{ plan_id: 'p1', task_id: 't1' }]);
      expect(dataset.timeEntries.map((item) => item.id)).toEqual(['te1']);
      expect(dataset.budgetEntries.map((item) => item.id)).toEqual(['be1']);

      // The sibling plan contributes nothing: its hours never reach u1's unit.
      const report = buildResourcePlanningReport(dataset, scopedQuery);
      expect(report.rows).toHaveLength(1);
      expect(report.rows[0]).toEqual(
        expect.objectContaining({
          group_id: 'leaf',
          group_name: 'Platform',
          group_type: 'unit',
          currency: 'EUR',
          planned_hours: 20,
          actual_hours: 2,
        }),
      );
      expect(report.totals_by_currency).toHaveLength(1);
      expect(report.totals_by_currency[0]).toEqual(
        expect.objectContaining({
          currency: 'EUR',
          planned_hours: 20,
          actual_hours: 2,
        }),
      );
    });

    it('returns the empty-report dataset when the portfolio has no accessible plans', async () => {
      modules.isEnabled.mockResolvedValue(true);
      mockClient();
      resourcePlanningService.canExposePlan.mockResolvedValue(false);
      const service = new ResourcePlanningReportService(
        supabase,
        modules,
        workingCalendar,
        resourcePlanningService,
        permissions,
      );

      const dataset = await buildInternal(service).loadDataset(
        'org-1',
        scopedQuery,
        'user-1',
      );

      expect(dataset).toEqual(emptyDataset);
      const report = buildResourcePlanningReport(dataset, scopedQuery);
      expect(report.rows).toEqual([]);
      expect(report.totals_by_currency).toEqual([]);
      expect(report.exceptions).toEqual({
        ambiguous_time_entry_count: 0,
        unallocated_time_entry_count: 0,
        ambiguous_actual_hours: 0,
        unallocated_actual_hours: 0,
        missing_rate_hours: 0,
        undated_allocation_count: 0,
      });
    });
  });

  describe('space_id fixed-space view', () => {
    const member = (id: string) => ({
      user_id: id,
      user: { id, first_name: id, last_name: null, email: `${id}@x.io` },
    });
    const rows: Record<string, unknown[]> = {
      organization_members: ['u-plan', 'u-time', 'u-other', 'u-null'].map(
        member,
      ),
      employee_capacity: [
        {
          user_id: 'u-other',
          weekly_capacity_hours: 40,
          cost_rate: null,
          currency: 'EUR',
          is_active: true,
        },
      ],
      plans: [
        { id: 'plan-on', name: 'On', space_id: 'space-on', is_archived: false },
        {
          id: 'plan-other',
          name: 'Other',
          space_id: 'space-other',
          is_archived: false,
        },
        { id: 'plan-null', name: 'Null', space_id: null, is_archived: false },
      ],
      plan_resource_allocations: [
        { id: 'a-on', plan_id: 'plan-on', user_id: 'u-plan', planned_hours: 1 },
        {
          id: 'a-other',
          plan_id: 'plan-other',
          user_id: 'u-other',
          planned_hours: 1,
        },
        {
          id: 'a-null',
          plan_id: 'plan-null',
          user_id: 'u-null',
          planned_hours: 1,
        },
      ],
      time_entries: [
        { id: 'te-on', task_id: 'task-on', user_id: 'u-time' },
        { id: 'te-other', task_id: 'task-other', user_id: 'u-other' },
        { id: 'te-null', task_id: 'task-null', user_id: 'u-null' },
      ],
      resource_budget_entries: [
        { id: 'be-plan-on', plan_id: 'plan-on', task_id: null },
        { id: 'be-plan-other', plan_id: 'plan-other', task_id: null },
        { id: 'be-plan-null', plan_id: 'plan-null', task_id: null },
        { id: 'be-task-on', plan_id: null, task_id: 'task-on' },
        { id: 'be-task-other', plan_id: null, task_id: 'task-other' },
        { id: 'be-task-null', plan_id: null, task_id: 'task-null' },
      ],
      tasks: [
        { id: 'task-on', space_id: 'space-on' },
        { id: 'task-other', space_id: 'space-other' },
        { id: 'task-null', space_id: null },
      ],
    };
    const query: NormalizedResourcePlanningReportQuery = {
      from: '2026-08-01',
      to: '2026-08-31',
      bucket: 'week',
      group_by: 'user',
      include_archived: false,
    };

    function setup() {
      const from = jest.fn((table: string) =>
        chainQuery({ data: rows[table] ?? [], error: null }),
      );
      (supabase.getClient as jest.Mock).mockReturnValue({ from });
      // Both spaces are visible, so only the exact space_id match can drop space-other.
      (
        resourcePlanningService.resolveSpaceScope as jest.Mock
      ).mockResolvedValueOnce({
        allowedSpaceIds: new Set(['space-on', 'space-other']),
        allowsNullSpace: true,
      });
      const service = new ResourcePlanningReportService(
        supabase,
        modules,
        workingCalendar,
        resourcePlanningService,
        permissions,
      );
      const internal = service as unknown as {
        loadDataset(
          organizationId: string,
          query: NormalizedResourcePlanningReportQuery,
          userId: string,
        ): Promise<ResourcePlanningReportDataset>;
      };
      return { from, internal };
    }

    const ids = (items: Array<{ id: string }>) => items.map((item) => item.id);

    it('403s a space outside the caller scope before reading any table', async () => {
      const { from, internal } = setup();

      await expect(
        internal.loadDataset(
          'org-1',
          { ...query, space_id: 'space-x' },
          'user-1',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(from).not.toHaveBeenCalled();
    });

    it('keeps only rows of the requested space and narrows people to its contributors', async () => {
      const { internal } = setup();

      const dataset = await internal.loadDataset(
        'org-1',
        { ...query, space_id: 'space-on' },
        'user-1',
      );

      expect(resourcePlanningService.resolveSpaceScope).toHaveBeenCalledTimes(
        1,
      );
      expect(ids(dataset.plans)).toEqual(['plan-on']);
      expect(ids(dataset.allocations)).toEqual(['a-on']);
      expect(ids(dataset.timeEntries)).toEqual(['te-on']);
      expect(ids(dataset.budgetEntries)).toEqual(['be-plan-on', 'be-task-on']);
      expect(ids(dataset.users)).toEqual(['u-plan', 'u-time']);
      // Capacity rows stay as loaded -- the engine only reports people present.
      expect(dataset.capacities.map((item) => item.user_id)).toEqual([
        'u-other',
      ]);
    });

    it('keeps the multi-space result when space_id is absent', async () => {
      const { internal } = setup();

      const dataset = await internal.loadDataset('org-1', query, 'user-1');

      expect(ids(dataset.plans)).toEqual(['plan-on', 'plan-other', 'plan-null']);
      expect(ids(dataset.allocations)).toEqual(['a-on', 'a-other', 'a-null']);
      expect(ids(dataset.timeEntries)).toEqual([
        'te-on',
        'te-other',
        'te-null',
      ]);
      expect(ids(dataset.budgetEntries)).toHaveLength(6);
      expect(ids(dataset.users)).toEqual([
        'u-plan',
        'u-time',
        'u-other',
        'u-null',
      ]);
    });

    it('carries space_id from the report query into loadDataset', async () => {
      modules.isEnabled.mockResolvedValue(true);
      const service = new ResourcePlanningReportService(
        supabase,
        modules,
        workingCalendar,
        resourcePlanningService,
        permissions,
      );
      const loadDataset = jest
        .spyOn(
          service as unknown as {
            loadDataset: jest.Mock<Promise<ResourcePlanningReportDataset>>;
          },
          'loadDataset',
        )
        .mockResolvedValue(emptyDataset);
      const spaceId = '11111111-1111-4111-8111-111111111111';

      await service.getReport('org-1', { space_id: spaceId }, 'user-1');

      expect(loadDataset).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({ space_id: spaceId }),
        'user-1',
      );
    });
  });
});
