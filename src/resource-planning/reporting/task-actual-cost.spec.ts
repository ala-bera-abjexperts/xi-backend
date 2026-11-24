import {
  buildResourcePlanningReport,
  createCapacityResolver,
  normalizeResourcePlanningReportQuery,
} from './resource-planning-report.engine';
import type {
  ResourcePlanningReportCapacity,
  ResourcePlanningReportCapacityPeriod,
  ResourcePlanningReportDataset,
} from './resource-planning-report.types';
import {
  computeActualCostByTask,
  type TaskActualCost,
} from './task-actual-cost';

type Input = Parameters<typeof computeActualCostByTask>[0];

const capacity = (
  user_id: string,
  cost_rate: number | null,
  currency: string | null = 'EUR',
): ResourcePlanningReportCapacity => ({
  user_id,
  weekly_capacity_hours: 40,
  cost_rate,
  currency,
  is_active: true,
});

const period = (
  user_id: string,
  effective_from: string,
  effective_to: string | null,
  cost_rate: number | null,
): ResourcePlanningReportCapacityPeriod => ({
  ...capacity(user_id, cost_rate),
  effective_from,
  effective_to,
});

const time = (
  task_id: string,
  user_id: string,
  minutes: number,
  day: string,
) => ({
  task_id,
  user_id,
  duration_minutes: minutes,
  logged_at: `${day}T09:00:00+00:00`,
});

const entry = (
  task_id: string | null,
  amount: number,
  currency: string | null,
  values: Partial<Input['budgetEntries'][number]> = {},
): Input['budgetEntries'][number] => ({
  task_id,
  entry_type: 'actual',
  aggregation: 'manual',
  amount,
  currency,
  ...values,
});

const cost = (values: Partial<TaskActualCost>): TaskActualCost => ({
  actual_hours: 0,
  labor_cost: 0,
  non_labor_cost: 0,
  missing_rate_hours: 0,
  ...values,
});

function run({
  timeEntries = [],
  budgetEntries = [],
  capacities = [],
  periods = [],
}: Partial<Pick<Input, 'timeEntries' | 'budgetEntries'>> & {
  capacities?: ResourcePlanningReportCapacity[];
  periods?: ResourcePlanningReportCapacityPeriod[];
}) {
  return computeActualCostByTask({
    timeEntries,
    budgetEntries,
    resolveCapacity: createCapacityResolver(capacities, periods),
  });
}

describe('computeActualCostByTask', () => {
  it('applies a period rate on its effective dates only', () => {
    const result = run({
      capacities: [capacity('u1', 100)],
      periods: [period('u1', '2026-08-05', '2026-08-06', 150)],
      timeEntries: [
        time('before', 'u1', 60, '2026-08-04'),
        time('during', 'u1', 60, '2026-08-05'),
        time('during', 'u1', 30, '2026-08-06'),
        time('after', 'u1', 60, '2026-08-07'),
      ],
    });

    expect(result).toEqual(
      new Map([
        [
          'before',
          new Map([['EUR', cost({ actual_hours: 1, labor_cost: 100 })]]),
        ],
        [
          'during',
          new Map([['EUR', cost({ actual_hours: 1.5, labor_cost: 225 })]]),
        ],
        [
          'after',
          new Map([['EUR', cost({ actual_hours: 1, labor_cost: 100 })]]),
        ],
      ]),
    );
  });

  it('uses the default capacity without a period, and a null rate counts as missing', () => {
    const result = run({
      capacities: [capacity('u1', 80), capacity('u2', null)],
      timeEntries: [
        time('t1', 'u1', 90, '2026-08-04'),
        time('t2', 'u2', 120, '2026-08-04'),
      ],
    });

    expect(result.get('t1')).toEqual(
      new Map([['EUR', cost({ actual_hours: 1.5, labor_cost: 120 })]]),
    );
    expect(result.get('t2')).toEqual(
      new Map([['EUR', cost({ actual_hours: 2, missing_rate_hours: 2 })]]),
    );
  });

  it('normalizes currencies, with UNSPECIFIED when there is none', () => {
    const result = run({
      capacities: [capacity('u1', 10, ' usd ')],
      timeEntries: [
        time('t1', 'u1', 60, '2026-08-04'),
        // No capacity at all: no rate and no currency.
        time('t1', 'u2', 60, '2026-08-04'),
      ],
      budgetEntries: [
        entry('t1', 5, 'eur'),
        entry('t1', 7, null),
        entry('t1', 3, '  '),
      ],
    });

    expect(result.get('t1')).toEqual(
      new Map([
        ['USD', cost({ actual_hours: 1, labor_cost: 10 })],
        [
          'UNSPECIFIED',
          cost({ actual_hours: 1, missing_rate_hours: 1, non_labor_cost: 10 }),
        ],
        ['EUR', cost({ non_labor_cost: 5 })],
      ]),
    );
  });

  it('ignores planned, rollup and task-less entries', () => {
    const result = run({
      budgetEntries: [
        entry('t1', 10, 'EUR', { entry_type: 'planned' }),
        entry('t1', 20, 'EUR', { aggregation: 'rollup' }),
        entry(null, 30, 'EUR'),
      ],
    });

    expect(result.size).toBe(0);
  });

  it('keeps each currency of a task separate', () => {
    const result = run({
      capacities: [capacity('u1', 100)],
      timeEntries: [
        time('t1', 'u1', 60, '2026-08-04'),
        time('t1', 'u1', 30, '2026-08-05'),
      ],
      budgetEntries: [entry('t1', 20, 'EUR'), entry('t1', 30, 'USD')],
    });

    expect(result.get('t1')).toEqual(
      new Map([
        [
          'EUR',
          cost({ actual_hours: 1.5, labor_cost: 150, non_labor_cost: 20 }),
        ],
        ['USD', cost({ non_labor_cost: 30 })],
      ]),
    );
  });

  it('matches the report engine actual labor totals', () => {
    const capacities = [
      capacity('u1', 100),
      capacity('u2', 50, 'USD'),
      capacity('u3', null),
    ];
    const periods = [period('u1', '2026-08-05', '2026-08-06', 150)];
    // Every task is in exactly one plan whose currency is its users' currency.
    const timeEntries = [
      time('t1', 'u1', 120, '2026-08-04'),
      time('t1', 'u1', 90, '2026-08-05'),
      time('t2', 'u2', 45, '2026-08-06'),
      time('t3', 'u3', 30, '2026-08-07'),
      time('t3', 'u1', 50, '2026-08-20'),
    ];
    const dataset: ResourcePlanningReportDataset = {
      users: [
        { id: 'u1', name: 'Ada' },
        { id: 'u2', name: 'Grace' },
        { id: 'u3', name: 'Linus' },
      ],
      units: [],
      unitMemberships: [],
      capacities,
      capacityPeriods: periods,
      plans: [
        { id: 'p-eur', name: 'EUR', currency: 'EUR', is_archived: false },
        { id: 'p-usd', name: 'USD', currency: 'USD', is_archived: false },
      ],
      allocations: [],
      planTasks: [
        { plan_id: 'p-eur', task_id: 't1' },
        { plan_id: 'p-usd', task_id: 't2' },
        { plan_id: 'p-eur', task_id: 't3' },
      ],
      portfolioPlans: [],
      portfolios: [],
      timeEntries: timeEntries.map((item, index) => ({
        id: `te-${index}`,
        ...item,
      })),
      budgetEntries: [],
    };
    const report = buildResourcePlanningReport(
      dataset,
      normalizeResourcePlanningReportQuery({
        from: '2026-08-01',
        to: '2026-08-31',
        group_by: 'user',
      }),
    );

    const summed = new Map<string, { hours: number; labor: number }>();
    let missingRateHours = 0;
    for (const byCurrency of run({
      timeEntries,
      capacities,
      periods,
    }).values()) {
      for (const [currency, item] of byCurrency) {
        const total = summed.get(currency) ?? { hours: 0, labor: 0 };
        total.hours += item.actual_hours;
        total.labor += item.labor_cost;
        summed.set(currency, total);
        missingRateHours += item.missing_rate_hours;
      }
    }

    expect(report.totals_by_currency.map((total) => total.currency)).toEqual(
      [...summed.keys()].sort(),
    );
    for (const total of report.totals_by_currency) {
      expect(total.actual_hours).toBeCloseTo(
        summed.get(total.currency)!.hours,
        6,
      );
      expect(total.actual_labor_cost).toBeCloseTo(
        summed.get(total.currency)!.labor,
        6,
      );
    }
    expect(report.exceptions.missing_rate_hours).toBeCloseTo(
      missingRateHours,
      6,
    );
    // Not vacuous: 2h x 100 + 1.5h x 150 (period) + 50min x 100.
    expect(summed.get('EUR')!.labor).toBeCloseTo(
      200 + 225 + (50 / 60) * 100,
      6,
    );
    expect(summed.get('USD')!.labor).toBeCloseTo(37.5, 6);
  });
});
