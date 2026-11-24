import { BadRequestException } from '@nestjs/common';
import {
  buildResourcePlanningReport,
  normalizeResourcePlanningReportQuery,
} from './resource-planning-report.engine';
import type { ResourcePlanningReportDataset } from './resource-planning-report.types';

const emptyDataset = (): ResourcePlanningReportDataset => ({
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
});

describe('resource planning report engine', () => {
  it('defaults to the current UTC month and rejects reversed or oversized ranges', () => {
    expect(
      normalizeResourcePlanningReportQuery(
        {},
        new Date('2026-08-14T09:00:00Z'),
      ),
    ).toEqual({
      from: '2026-08-01',
      to: '2026-08-31',
      bucket: 'week',
      group_by: 'user',
      group_id: undefined,
      include_archived: false,
    });

    expect(() =>
      normalizeResourcePlanningReportQuery({
        from: '2026-08-02',
        to: '2026-08-01',
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      normalizeResourcePlanningReportQuery({
        from: '2024-01-01',
        to: '2026-01-02',
      }),
    ).toThrow('cannot exceed 2 years');
    expect(() =>
      normalizeResourcePlanningReportQuery({
        from: '2026-02-30',
        to: '2026-03-02',
      }),
    ).toThrow('Invalid report date');
  });

  it('keeps currencies separate and derives planned/actual labor by effective rates', () => {
    const data = emptyDataset();
    data.users = [
      { id: 'u1', name: 'Ada Lovelace' },
      { id: 'u2', name: 'Grace Hopper' },
    ];
    data.capacities = [
      {
        user_id: 'u1',
        weekly_capacity_hours: 40,
        cost_rate: 100,
        currency: 'EUR',
        is_active: true,
      },
      {
        user_id: 'u2',
        weekly_capacity_hours: 40,
        cost_rate: 50,
        currency: 'USD',
        is_active: true,
      },
    ];
    data.plans = [
      {
        id: 'p1',
        name: 'Migration',
        currency: 'EUR',
        start_date: '2026-08-03',
        end_date: '2026-08-09',
        is_archived: false,
      },
    ];
    data.allocations = [
      {
        id: 'a1',
        plan_id: 'p1',
        user_id: 'u1',
        allocation_mode: 'hours_per_week',
        planned_hours: 0,
        planned_budget: 0,
        weekly_hours: 20,
        capacity_percent: null,
        start_date: '2026-08-03',
        end_date: '2026-08-09',
      },
      {
        id: 'a2',
        plan_id: 'p1',
        user_id: 'u2',
        allocation_mode: 'hours_per_week',
        planned_hours: 0,
        planned_budget: 0,
        weekly_hours: 10,
        capacity_percent: null,
        start_date: '2026-08-03',
        end_date: '2026-08-09',
      },
    ];
    data.planTasks = [{ plan_id: 'p1', task_id: 't1' }];
    data.timeEntries = [
      {
        id: 'te1',
        task_id: 't1',
        user_id: 'u1',
        duration_minutes: 120,
        logged_at: '2026-08-04T10:00:00Z',
      },
      {
        id: 'te2',
        task_id: 't1',
        user_id: 'u2',
        duration_minutes: 60,
        logged_at: '2026-08-04T10:00:00Z',
      },
    ];

    const report = buildResourcePlanningReport(data, {
      from: '2026-08-03',
      to: '2026-08-09',
      bucket: 'week',
      group_by: 'plan',
      include_archived: false,
    });

    expect(report.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          group_id: 'p1',
          currency: 'EUR',
          planned_hours: 20,
          actual_hours: 2,
          planned_labor_cost: 2000,
          actual_labor_cost: 200,
        }),
        expect.objectContaining({
          group_id: 'p1',
          currency: 'USD',
          planned_hours: 10,
          actual_hours: 1,
          planned_labor_cost: 500,
          actual_labor_cost: 50,
        }),
      ]),
    );
    expect(
      report.totals_by_currency.map((item) => item.currency).sort(),
    ).toEqual(['EUR', 'USD']);
  });

  it('uses dated capacity/rate overrides and flags over-allocation', () => {
    const data = emptyDataset();
    data.users = [{ id: 'u1', name: 'Ada' }];
    data.capacities = [
      {
        user_id: 'u1',
        weekly_capacity_hours: 40,
        cost_rate: 100,
        currency: 'EUR',
        is_active: true,
      },
    ];
    data.capacityPeriods = [
      {
        user_id: 'u1',
        effective_from: '2026-08-05',
        effective_to: '2026-08-09',
        weekly_capacity_hours: 20,
        cost_rate: 200,
        currency: 'USD',
        is_active: true,
      },
    ];
    data.plans = [
      {
        id: 'p1',
        name: 'Plan',
        currency: 'EUR',
        start_date: '2026-08-03',
        end_date: '2026-08-09',
        is_archived: false,
      },
    ];
    data.allocations = [
      {
        id: 'a1',
        plan_id: 'p1',
        user_id: 'u1',
        allocation_mode: 'hours_per_week',
        planned_hours: 0,
        planned_budget: 0,
        weekly_hours: 50,
        capacity_percent: null,
        start_date: '2026-08-03',
        end_date: '2026-08-09',
      },
    ];

    const report = buildResourcePlanningReport(data, {
      from: '2026-08-03',
      to: '2026-08-09',
      bucket: 'week',
      group_by: 'user',
      include_archived: false,
    });

    expect(report.rows.some((row) => row.over_allocated)).toBe(true);
    expect(
      report.rows.reduce((sum, row) => sum + row.capacity_hours, 0),
    ).toBeCloseTo(25.714286, 5);
  });

  describe('unknown capacity vs configured zero capacity', () => {
    // Both report capacity_hours 0. Only a configured 0 may flag
    // over-allocation -- unknown means "never flag", per the invariant on
    // buildWorkingDayHours in calendar/working-calendar.engine.ts.
    const datasetWithAllocation = (): ResourcePlanningReportDataset => {
      const data = emptyDataset();
      data.users = [{ id: 'u1', name: 'Ada' }];
      data.plans = [
        {
          id: 'p1',
          name: 'Plan',
          currency: 'EUR',
          start_date: '2026-08-03',
          end_date: '2026-08-09',
          is_archived: false,
        },
      ];
      data.allocations = [
        {
          id: 'a1',
          plan_id: 'p1',
          user_id: 'u1',
          allocation_mode: 'total_hours',
          planned_hours: 20,
          planned_budget: 0,
          weekly_hours: null,
          capacity_percent: null,
          start_date: '2026-08-03',
          end_date: '2026-08-09',
        },
      ];
      return data;
    };

    const runReport = (data: ResourcePlanningReportDataset) =>
      buildResourcePlanningReport(data, {
        from: '2026-08-03',
        to: '2026-08-09',
        bucket: 'week',
        group_by: 'user',
        include_archived: false,
      });

    it('does not flag over-allocation when the user has no capacity record', () => {
      const report = runReport(datasetWithAllocation());

      expect(report.rows.length).toBeGreaterThan(0);
      expect(report.rows.every((row) => row.over_allocated)).toBe(false);
      expect(report.rows.some((row) => row.over_allocated)).toBe(false);
      expect(report.rows.every((row) => row.utilization_percent === null)).toBe(
        true,
      );
      expect(report.totals_by_currency.some((t) => t.over_allocated)).toBe(
        false,
      );
    });

    it('still flags over-allocation for an explicitly configured zero capacity', () => {
      const data = datasetWithAllocation();
      data.capacities = [
        {
          user_id: 'u1',
          weekly_capacity_hours: 0,
          cost_rate: 0,
          currency: 'EUR',
          is_active: true,
        },
      ];

      const report = runReport(data);

      expect(report.rows.some((row) => row.over_allocated)).toBe(true);
    });

    it('still flags over-allocation for a normal capacity that is exceeded', () => {
      const data = datasetWithAllocation();
      data.capacities = [
        {
          user_id: 'u1',
          weekly_capacity_hours: 5,
          cost_rate: 100,
          currency: 'EUR',
          is_active: true,
        },
      ];

      const report = runReport(data);

      expect(report.rows.some((row) => row.over_allocated)).toBe(true);
    });
  });

  it('counts ambiguous and unallocated actuals once but excludes them from plan rows', () => {
    const data = emptyDataset();
    data.users = [{ id: 'u1', name: 'Ada' }];
    data.capacities = [
      {
        user_id: 'u1',
        weekly_capacity_hours: 40,
        cost_rate: null,
        currency: null,
        is_active: true,
      },
    ];
    data.plans = [
      { id: 'p1', name: 'One', currency: 'EUR', is_archived: false },
      { id: 'p2', name: 'Two', currency: 'EUR', is_archived: false },
    ];
    data.planTasks = [
      { plan_id: 'p1', task_id: 'shared' },
      { plan_id: 'p2', task_id: 'shared' },
    ];
    data.timeEntries = [
      {
        id: 'ambiguous',
        task_id: 'shared',
        user_id: 'u1',
        duration_minutes: 90,
        logged_at: '2026-08-04T10:00:00Z',
      },
      {
        id: 'unallocated',
        task_id: 'none',
        user_id: 'u1',
        duration_minutes: 30,
        logged_at: '2026-08-04T10:00:00Z',
      },
    ];

    const planReport = buildResourcePlanningReport(data, {
      from: '2026-08-03',
      to: '2026-08-09',
      bucket: 'week',
      group_by: 'plan',
      include_archived: false,
    });
    const userReport = buildResourcePlanningReport(data, {
      from: '2026-08-03',
      to: '2026-08-09',
      bucket: 'week',
      group_by: 'user',
      include_archived: false,
    });

    expect(
      planReport.rows.reduce((sum, row) => sum + row.actual_hours, 0),
    ).toBe(0);
    expect(planReport.exceptions).toEqual(
      expect.objectContaining({
        ambiguous_time_entry_count: 1,
        ambiguous_actual_hours: 1.5,
        unallocated_time_entry_count: 1,
        unallocated_actual_hours: 0.5,
      }),
    );
    expect(
      userReport.rows.reduce((sum, row) => sum + row.actual_hours, 0),
    ).toBe(2);
    expect(userReport.exceptions.missing_rate_hours).toBe(2);
  });

  it('buckets a budget entry with no currency (post-null-fallback) as UNSPECIFIED', () => {
    const data = emptyDataset();
    data.plans = [
      { id: 'p1', name: 'One', currency: 'EUR', is_archived: false },
    ];
    // Mirrors what loadDataset now produces for a DB row with currency: null
    // (`(item.currency ?? '').toUpperCase()`) instead of throwing.
    data.budgetEntries = [
      {
        id: 'be1',
        plan_id: 'p1',
        task_id: null,
        entry_type: 'planned',
        amount: 100,
        currency: '',
        effective_date: '2026-08-05',
      },
    ];

    const report = buildResourcePlanningReport(data, {
      from: '2026-08-03',
      to: '2026-08-09',
      bucket: 'week',
      group_by: 'plan',
      include_archived: false,
    });

    expect(report.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          group_id: 'p1',
          currency: 'UNSPECIFIED',
          planned_non_labor_cost: 100,
        }),
      ]),
    );
  });

  it('rolls descendant memberships into a selected unit without double counting', () => {
    const data = emptyDataset();
    data.users = [{ id: 'u1', name: 'Ada' }];
    data.units = [
      { id: 'parent', parent_id: null, name: 'Engineering', is_active: true },
      { id: 'leaf', parent_id: 'parent', name: 'Platform', is_active: true },
    ];
    data.unitMemberships = [
      {
        unit_id: 'leaf',
        user_id: 'u1',
        effective_from: '2026-01-01',
        effective_to: null,
      },
    ];
    data.capacities = [
      {
        user_id: 'u1',
        weekly_capacity_hours: 35,
        cost_rate: 10,
        currency: 'EUR',
        is_active: true,
      },
    ];

    const report = buildResourcePlanningReport(data, {
      from: '2026-08-03',
      to: '2026-08-09',
      bucket: 'week',
      group_by: 'unit',
      group_id: 'parent',
      include_archived: false,
    });

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toEqual(
      expect.objectContaining({ group_id: 'parent', capacity_hours: 35 }),
    );
  });

  it('counts a contributor capacity once when multiple plans share a portfolio', () => {
    const data = emptyDataset();
    data.users = [{ id: 'u1', name: 'Ada' }];
    data.capacities = [
      {
        user_id: 'u1',
        weekly_capacity_hours: 35,
        cost_rate: 10,
        currency: 'EUR',
        is_active: true,
      },
    ];
    data.plans = [
      { id: 'p1', name: 'One', currency: 'EUR', is_archived: false },
      { id: 'p2', name: 'Two', currency: 'EUR', is_archived: false },
    ];
    data.portfolios = [{ id: 'pf1', name: 'Portfolio', is_archived: false }];
    data.portfolioPlans = [
      { portfolio_id: 'pf1', plan_id: 'p1' },
      { portfolio_id: 'pf1', plan_id: 'p2' },
    ];
    data.allocations = [
      {
        id: 'a1',
        plan_id: 'p1',
        user_id: 'u1',
        allocation_mode: 'hours_per_week',
        planned_hours: 0,
        planned_budget: 0,
        weekly_hours: 10,
        capacity_percent: null,
        start_date: '2026-08-03',
        end_date: '2026-08-09',
      },
      {
        id: 'a2',
        plan_id: 'p2',
        user_id: 'u1',
        allocation_mode: 'hours_per_week',
        planned_hours: 0,
        planned_budget: 0,
        weekly_hours: 10,
        capacity_percent: null,
        start_date: '2026-08-03',
        end_date: '2026-08-09',
      },
    ];

    const report = buildResourcePlanningReport(data, {
      from: '2026-08-03',
      to: '2026-08-09',
      bucket: 'week',
      group_by: 'portfolio',
      include_archived: false,
    });

    expect(report.rows.reduce((sum, row) => sum + row.capacity_hours, 0)).toBe(
      35,
    );
    expect(report.rows.reduce((sum, row) => sum + row.planned_hours, 0)).toBe(
      20,
    );
  });

  it('does not duplicate totals when one plan belongs to multiple portfolios', () => {
    const data = emptyDataset();
    data.users = [{ id: 'u1', name: 'Ada' }];
    data.capacities = [
      {
        user_id: 'u1',
        weekly_capacity_hours: 35,
        cost_rate: 10,
        currency: 'EUR',
        is_active: true,
      },
    ];
    data.plans = [
      {
        id: 'p1',
        name: 'Shared plan',
        currency: 'EUR',
        is_archived: false,
      },
    ];
    data.portfolios = [
      { id: 'pf1', name: 'Portfolio one', is_archived: false },
      { id: 'pf2', name: 'Portfolio two', is_archived: false },
    ];
    data.portfolioPlans = [
      { portfolio_id: 'pf1', plan_id: 'p1' },
      { portfolio_id: 'pf2', plan_id: 'p1' },
    ];
    data.allocations = [
      {
        id: 'a1',
        plan_id: 'p1',
        user_id: 'u1',
        allocation_mode: 'hours_per_week',
        planned_hours: 0,
        planned_budget: 0,
        weekly_hours: 14,
        capacity_percent: null,
        start_date: '2026-08-03',
        end_date: '2026-08-09',
      },
    ];

    const all = buildResourcePlanningReport(data, {
      from: '2026-08-03',
      to: '2026-08-09',
      bucket: 'week',
      group_by: 'portfolio',
      include_archived: false,
    });
    const selected = buildResourcePlanningReport(data, {
      from: '2026-08-03',
      to: '2026-08-09',
      bucket: 'week',
      group_by: 'portfolio',
      group_id: 'pf1',
      include_archived: false,
    });

    expect(all.rows).toHaveLength(2);
    expect(all.rows.reduce((sum, row) => sum + row.planned_hours, 0)).toBe(28);
    expect(all.totals_by_currency[0].planned_hours).toBe(14);
    expect(selected.rows).toHaveLength(1);
    expect(selected.totals_by_currency[0].planned_hours).toBe(14);
  });

  it('excludes archived plans/portfolios by default and includes them when requested', () => {
    const data = emptyDataset();
    data.users = [{ id: 'u1', name: 'Ada' }];
    data.capacities = [
      {
        user_id: 'u1',
        weekly_capacity_hours: 35,
        cost_rate: 10,
        currency: 'EUR',
        is_active: true,
      },
    ];
    data.plans = [
      { id: 'p1', name: 'Archived plan', currency: 'EUR', is_archived: true },
    ];
    data.portfolios = [
      { id: 'pf1', name: 'Archived portfolio', is_archived: true },
    ];
    data.portfolioPlans = [{ portfolio_id: 'pf1', plan_id: 'p1' }];
    data.allocations = [
      {
        id: 'a1',
        plan_id: 'p1',
        user_id: 'u1',
        allocation_mode: 'hours_per_week',
        planned_hours: 0,
        planned_budget: 0,
        weekly_hours: 10,
        capacity_percent: null,
        start_date: '2026-08-03',
        end_date: '2026-08-09',
      },
    ];

    const excluded = buildResourcePlanningReport(data, {
      from: '2026-08-03',
      to: '2026-08-09',
      bucket: 'week',
      group_by: 'portfolio',
      include_archived: false,
    });
    expect(excluded.rows).toHaveLength(0);
    expect(excluded.totals_by_currency).toHaveLength(0);

    const included = buildResourcePlanningReport(data, {
      from: '2026-08-03',
      to: '2026-08-09',
      bucket: 'week',
      group_by: 'portfolio',
      include_archived: true,
    });
    expect(included.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group_id: 'pf1', planned_hours: 10 }),
      ]),
    );
    expect(included.totals_by_currency[0].planned_hours).toBe(10);
  });

  it('uses indexed effective-value lookups instead of scanning each source per day', () => {
    const data = emptyDataset();
    data.users = [{ id: 'u1', name: 'Ada' }];
    const forbidFind = <T>(items: T[]): T[] =>
      new Proxy(items, {
        get(target, property, receiver) {
          if (property === 'find') {
            throw new Error('per-day linear scan attempted');
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
    data.capacities = forbidFind([
      {
        user_id: 'u1',
        weekly_capacity_hours: 35,
        cost_rate: 10,
        currency: 'EUR',
        is_active: true,
      },
    ]);
    data.capacityPeriods = forbidFind(
      Array.from({ length: 2_000 }, (_, index) => ({
        user_id: `unused-${index}`,
        effective_from: '2026-01-01',
        effective_to: null,
        weekly_capacity_hours: 40,
        cost_rate: 1,
        currency: 'EUR',
        is_active: true,
      })),
    );
    data.unitMemberships = forbidFind([
      {
        user_id: 'u1',
        unit_id: 'unit-1',
        effective_from: '2026-01-01',
        effective_to: null,
      },
    ]);
    data.units = [
      {
        id: 'unit-1',
        parent_id: null,
        name: 'Engineering',
        is_active: true,
      },
    ];

    expect(() =>
      buildResourcePlanningReport(data, {
        from: '2026-01-01',
        to: '2026-12-31',
        bucket: 'month',
        group_by: 'unit',
        include_archived: false,
      }),
    ).not.toThrow();
  });

  describe('group_by=portfolio per-plan access restriction (accessiblePlanIds)', () => {
    // Shared fixture: one user on one unit, contributing to two plans (p1,
    // p2) both linked to the same portfolio. Only group_by=portfolio ever
    // reads dataset.accessiblePlanIds -- these tests prove that directly.
    const buildFixture = (): ResourcePlanningReportDataset => {
      const data = emptyDataset();
      data.users = [{ id: 'u1', name: 'Ada' }];
      data.units = [
        { id: 'unit1', parent_id: null, name: 'Engineering', is_active: true },
      ];
      data.unitMemberships = [
        {
          unit_id: 'unit1',
          user_id: 'u1',
          effective_from: '2026-01-01',
          effective_to: null,
        },
      ];
      data.capacities = [
        {
          user_id: 'u1',
          weekly_capacity_hours: 35,
          cost_rate: 10,
          currency: 'EUR',
          is_active: true,
        },
      ];
      data.plans = [
        { id: 'p1', name: 'Accessible', currency: 'EUR', is_archived: false },
        { id: 'p2', name: 'Restricted', currency: 'EUR', is_archived: false },
      ];
      data.portfolios = [{ id: 'pf1', name: 'Portfolio', is_archived: false }];
      data.portfolioPlans = [
        { portfolio_id: 'pf1', plan_id: 'p1' },
        { portfolio_id: 'pf1', plan_id: 'p2' },
      ];
      data.allocations = [
        {
          id: 'a1',
          plan_id: 'p1',
          user_id: 'u1',
          allocation_mode: 'hours_per_week',
          planned_hours: 0,
          planned_budget: 0,
          weekly_hours: 10,
          capacity_percent: null,
          start_date: '2026-08-03',
          end_date: '2026-08-09',
        },
        {
          id: 'a2',
          plan_id: 'p2',
          user_id: 'u1',
          allocation_mode: 'hours_per_week',
          planned_hours: 0,
          planned_budget: 0,
          weekly_hours: 15,
          capacity_percent: null,
          start_date: '2026-08-03',
          end_date: '2026-08-09',
        },
      ];
      return data;
    };
    const range = {
      from: '2026-08-03',
      to: '2026-08-09',
      bucket: 'week' as const,
      include_archived: false,
    };

    it('excludes a plan the user cannot access from group_by=portfolio rows and totals', () => {
      const data = buildFixture();
      data.accessiblePlanIds = new Set(['p1']);

      const report = buildResourcePlanningReport(data, {
        ...range,
        group_by: 'portfolio',
      });

      expect(report.rows.reduce((sum, row) => sum + row.planned_hours, 0)).toBe(
        10,
      );
      expect(report.totals_by_currency[0].planned_hours).toBe(10);
      // The accessible plan's contributor still contributes their full
      // capacity once -- only the restricted plan's data is dropped.
      expect(
        report.rows.reduce((sum, row) => sum + row.capacity_hours, 0),
      ).toBe(35);
    });

    it('is byte-identical to the unrestricted report when the user can access every plan in the portfolio', () => {
      const withoutRestriction = buildResourcePlanningReport(buildFixture(), {
        ...range,
        group_by: 'portfolio',
      });
      const fullAccessData = buildFixture();
      fullAccessData.accessiblePlanIds = new Set(['p1', 'p2']);
      const withFullAccess = buildResourcePlanningReport(fullAccessData, {
        ...range,
        group_by: 'portfolio',
      });

      expect(withFullAccess).toEqual(withoutRestriction);
      expect(
        withoutRestriction.rows.reduce(
          (sum, row) => sum + row.planned_hours,
          0,
        ),
      ).toBe(25);
    });

    it('leaves group_by=user, group_by=unit, and group_by=plan completely unaffected by accessiblePlanIds', () => {
      for (const groupBy of ['user', 'unit', 'plan'] as const) {
        const restrictedData = buildFixture();
        restrictedData.accessiblePlanIds = new Set(['p1']);
        const restricted = buildResourcePlanningReport(restrictedData, {
          ...range,
          group_by: groupBy,
        });
        const unrestricted = buildResourcePlanningReport(buildFixture(), {
          ...range,
          group_by: groupBy,
        });

        expect(restricted).toEqual(unrestricted);
      }

      // Sanity: these modes really do carry both plans' hours (25 = 10 + 15)
      // -- proving the equality above isn't vacuously true over empty data.
      const planReport = buildResourcePlanningReport(buildFixture(), {
        ...range,
        group_by: 'plan',
      });
      expect(
        planReport.rows.reduce((sum, row) => sum + row.planned_hours, 0),
      ).toBe(25);
    });
  });

  describe('group_by=portfolio Unallocated bucket (Fix 2b)', () => {
    // p1 is linked to pf1; p2 has no portfolio_plans link at all.
    const buildFixture = (): ResourcePlanningReportDataset => {
      const data = emptyDataset();
      data.users = [
        { id: 'u1', name: 'Ada' },
        { id: 'u2', name: 'Grace' },
      ];
      data.capacities = [
        {
          user_id: 'u1',
          weekly_capacity_hours: 35,
          cost_rate: 10,
          currency: 'EUR',
          is_active: true,
        },
        {
          user_id: 'u2',
          weekly_capacity_hours: 35,
          cost_rate: 10,
          currency: 'EUR',
          is_active: true,
        },
      ];
      data.plans = [
        { id: 'p1', name: 'In portfolio', currency: 'EUR', is_archived: false },
        { id: 'p2', name: 'Orphan plan', currency: 'EUR', is_archived: false },
      ];
      data.portfolios = [{ id: 'pf1', name: 'Portfolio', is_archived: false }];
      data.portfolioPlans = [{ portfolio_id: 'pf1', plan_id: 'p1' }];
      data.allocations = [
        {
          id: 'a1',
          plan_id: 'p1',
          user_id: 'u1',
          allocation_mode: 'hours_per_week',
          planned_hours: 0,
          planned_budget: 0,
          weekly_hours: 10,
          capacity_percent: null,
          start_date: '2026-08-03',
          end_date: '2026-08-09',
        },
        {
          id: 'a2',
          plan_id: 'p2',
          user_id: 'u2',
          allocation_mode: 'hours_per_week',
          planned_hours: 0,
          planned_budget: 0,
          weekly_hours: 15,
          capacity_percent: null,
          start_date: '2026-08-03',
          end_date: '2026-08-09',
        },
      ];
      return data;
    };
    const range = {
      from: '2026-08-03',
      to: '2026-08-09',
      bucket: 'week' as const,
      include_archived: false,
    };

    it('surfaces a portfolio-less plan as an Unallocated row and folds it into totals_by_currency', () => {
      const report = buildResourcePlanningReport(buildFixture(), {
        ...range,
        group_by: 'portfolio',
      });

      const unallocatedRows = report.rows.filter(
        (row) => row.group_name === 'Unallocated',
      );
      expect(unallocatedRows.length).toBeGreaterThan(0);
      expect(
        unallocatedRows.every((row) => row.group_type === 'portfolio'),
      ).toBe(true);
      expect(
        unallocatedRows.reduce((sum, row) => sum + row.planned_hours, 0),
      ).toBe(15);
      // Would be 10 (only the in-portfolio plan) if the orphan plan were
      // still silently dropped, per the pre-fix behavior.
      expect(report.rows.reduce((sum, row) => sum + row.planned_hours, 0)).toBe(
        25,
      );
      expect(report.totals_by_currency[0].planned_hours).toBe(25);
    });

    it('does not surface the portfolio-less plan when group_id targets a real portfolio', () => {
      const report = buildResourcePlanningReport(buildFixture(), {
        ...range,
        group_by: 'portfolio',
        group_id: 'pf1',
      });

      expect(report.rows.some((row) => row.group_name === 'Unallocated')).toBe(
        false,
      );
      expect(report.rows.reduce((sum, row) => sum + row.planned_hours, 0)).toBe(
        10,
      );
    });

    it('never surfaces an inaccessible portfolio-less plan in the Unallocated bucket', () => {
      const data = buildFixture();
      // p1 accessible, p2 (the orphan) is not.
      data.accessiblePlanIds = new Set(['p1']);

      const report = buildResourcePlanningReport(data, {
        ...range,
        group_by: 'portfolio',
      });

      expect(report.rows.some((row) => row.group_name === 'Unallocated')).toBe(
        false,
      );
      expect(report.rows.reduce((sum, row) => sum + row.planned_hours, 0)).toBe(
        10,
      );
      expect(report.totals_by_currency[0].planned_hours).toBe(10);
    });
  });

  describe('restricted_plan_count (Fix 2c)', () => {
    // p1/p2 both linked to pf1; p3 is archived (excluded by default, unrelated
    // to access) -- proves archived exclusions don't inflate the count.
    const buildFixture = (): ResourcePlanningReportDataset => {
      const data = emptyDataset();
      data.plans = [
        { id: 'p1', name: 'Accessible', currency: 'EUR', is_archived: false },
        { id: 'p2', name: 'Restricted', currency: 'EUR', is_archived: false },
        { id: 'p3', name: 'Archived', currency: 'EUR', is_archived: true },
      ];
      data.portfolios = [{ id: 'pf1', name: 'Portfolio', is_archived: false }];
      data.portfolioPlans = [
        { portfolio_id: 'pf1', plan_id: 'p1' },
        { portfolio_id: 'pf1', plan_id: 'p2' },
        { portfolio_id: 'pf1', plan_id: 'p3' },
      ];
      return data;
    };
    const range = {
      from: '2026-08-03',
      to: '2026-08-09',
      bucket: 'week' as const,
      include_archived: false,
    };

    it('counts only access-restricted plans for group_by=portfolio, not archived-plan exclusions', () => {
      const data = buildFixture();
      // p2 is access-restricted (missing from accessiblePlanIds). p3 is also
      // missing, but it's archived -- it was never an eligible candidate in
      // the first place, so it must not add a second count to the total.
      data.accessiblePlanIds = new Set(['p1']);

      const report = buildResourcePlanningReport(data, {
        ...range,
        group_by: 'portfolio',
      });

      expect(report.restricted_plan_count).toBe(1);
    });

    it('is undefined for group_by=user', () => {
      const data = buildFixture();
      data.accessiblePlanIds = new Set(['p1']);

      const report = buildResourcePlanningReport(data, {
        ...range,
        group_by: 'user',
      });

      expect(report.restricted_plan_count).toBeUndefined();
    });
  });

  // allocation_percent had no coverage at all before this block, so nothing
  // caught that group_by=unit posted a multi-team person's FULL work into every
  // one of their teams while splitting only their capacity.
  describe('multi-team allocation_percent shares', () => {
    const multiTeam = (
      percents: Array<{ unit: string; percent: number | null }>,
    ): ResourcePlanningReportDataset => {
      const data = emptyDataset();

      data.users = [{ id: 'u1', name: 'Ada' }];
      data.units = [
        { id: 'eng', parent_id: null, name: 'Engineering', is_active: true },
        { id: 'be', parent_id: 'eng', name: 'Backend', is_active: true },
        { id: 'fe', parent_id: 'eng', name: 'Frontend', is_active: true },
      ];
      data.unitMemberships = percents.map((item) => ({
        unit_id: item.unit,
        user_id: 'u1',
        effective_from: '2026-01-01',
        effective_to: null,
        allocation_percent: item.percent,
      }));
      data.capacities = [
        {
          user_id: 'u1',
          weekly_capacity_hours: 70,
          cost_rate: 10,
          currency: 'EUR',
          is_active: true,
        },
      ];
      data.plans = [
        {
          id: 'p1',
          name: 'Plan',
          currency: 'EUR',
          start_date: '2026-08-03',
          end_date: '2026-08-09',
          is_archived: false,
        },
      ];
      data.allocations = [
        {
          id: 'a1',
          plan_id: 'p1',
          user_id: 'u1',
          allocation_mode: 'total_hours',
          planned_hours: 70,
          planned_budget: 0,
          weekly_hours: null,
          capacity_percent: null,
          start_date: '2026-08-03',
          end_date: '2026-08-09',
        },
      ];

      return data;
    };

    const week = {
      from: '2026-08-03',
      to: '2026-08-09',
      bucket: 'week' as const,
      include_archived: false,
    };

    const byUnit = (report: { rows: Array<Record<string, unknown>> }) =>
      Object.fromEntries(
        report.rows.map((row) => [row.group_id, row.planned_hours]),
      );

    it('splits work by share instead of posting it in full to every team', () => {
      const report = buildResourcePlanningReport(
        multiTeam([
          { unit: 'be', percent: 60 },
          { unit: 'fe', percent: 40 },
        ]),
        { ...week, group_by: 'unit', group_id: undefined },
      );

      // 70 planned hours split 60/40 -- and critically, summing to 70, not 140.
      expect(byUnit(report)).toEqual({ be: 42, fe: 28 });
      expect(report.rows.reduce((sum, row) => sum + row.planned_hours, 0)).toBe(
        70,
      );
    });

    it('splits capacity by the same share', () => {
      const report = buildResourcePlanningReport(
        multiTeam([
          { unit: 'be', percent: 60 },
          { unit: 'fe', percent: 40 },
        ]),
        { ...week, group_by: 'unit', group_id: undefined },
      );

      const capacity = Object.fromEntries(
        report.rows.map((row) => [row.group_id, row.capacity_hours]),
      );

      expect(capacity).toEqual({ be: 42, fe: 28 });
    });

    it('normalises an over-committed set so the person is counted once', () => {
      // 100% + 100% across two units is legal: the DB exclusion constraint is
      // scoped per unit, so this shape exists in real data.
      const report = buildResourcePlanningReport(
        multiTeam([
          { unit: 'be', percent: null },
          { unit: 'fe', percent: null },
        ]),
        { ...week, group_by: 'unit', group_id: undefined },
      );

      expect(byUnit(report)).toEqual({ be: 35, fe: 35 });
      expect(report.rows.reduce((sum, row) => sum + row.planned_hours, 0)).toBe(
        70,
      );
    });

    it('keeps ancestor roll-up counting the work exactly once', () => {
      // Regression guard: resolveUnitGroupShares SUMS shares onto the requested
      // ancestor, so scaling work by that sum without normalising would report
      // 140 here for the 100/100 case.
      for (const percents of [
        [
          { unit: 'be', percent: 60 },
          { unit: 'fe', percent: 40 },
        ],
        [
          { unit: 'be', percent: null },
          { unit: 'fe', percent: null },
        ],
      ]) {
        const report = buildResourcePlanningReport(multiTeam(percents), {
          ...week,
          group_by: 'unit',
          group_id: 'eng',
        });

        expect(report.rows).toHaveLength(1);
        expect(report.rows[0].group_id).toBe('eng');
        expect(report.rows[0].planned_hours).toBe(70);
        expect(report.rows[0].capacity_hours).toBe(70);
      }
    });

    it('leaves an under-committed set alone, reporting only the assigned share', () => {
      const report = buildResourcePlanningReport(
        multiTeam([{ unit: 'be', percent: 50 }]),
        { ...week, group_by: 'unit', group_id: undefined },
      );

      expect(byUnit(report)).toEqual({ be: 35 });
    });
  });
});
