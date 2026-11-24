import { InternalServerErrorException } from '@nestjs/common';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { BudgetUsageService } from './budget-usage.service';

type Row = Record<string, unknown>;

const ORG = 'org-1';
const OTHER_ORG = 'org-2';

describe('BudgetUsageService', () => {
  let service: BudgetUsageService;
  let db: Record<string, Row[]>;
  /** Every table query with its eq filters, for asserting org scoping. */
  let calls: { table: string; eq: [string, unknown][] }[];
  let rpc: jest.Mock;
  let failingTable: string | undefined;

  /** In-memory stand-in for the PostgREST chains the service reads with. */
  function fakeFrom(table: string) {
    const eq: [string, unknown][] = [];
    const inFilters: [string, unknown[]][] = [];
    let columns: string[] = [];
    let range: [number, number] = [0, Number.MAX_SAFE_INTEGER];

    const run = () => {
      calls.push({ table, eq });
      if (table === failingTable) {
        return { data: null, error: { message: 'boom' } };
      }
      const rows = (db[table] ?? []).filter(
        (row) =>
          eq.every(([key, value]) => row[key] === value) &&
          inFilters.every(([key, values]) => values.includes(row[key])),
      );
      return {
        data: rows
          .slice(range[0], range[1] + 1)
          .map((row) => Object.fromEntries(columns.map((c) => [c, row[c]]))),
        error: null,
      };
    };

    const query: Record<string, unknown> = {
      select: (value: string) => {
        columns = value.split(',').map((c) => c.trim());
        return query;
      },
      eq: (key: string, value: unknown) => {
        eq.push([key, value]);
        return query;
      },
      in: (key: string, values: unknown[]) => {
        inFilters.push([key, values]);
        return query;
      },
      // Rows are already in insertion order; the service orders by id for stable paging.
      order: () => query,
      range: (from: number, to: number) => {
        range = [from, to];
        return query;
      },
      then: (
        onFulfilled: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => Promise.resolve(run()).then(onFulfilled, onRejected),
    };
    return query;
  }

  /** Same as the SQL function: descendants at any depth, roots excluded. */
  function descendantIds(
    _name: string,
    args: { p_root_ids: string[]; p_organization_id: string },
  ) {
    const tasks = (db.tasks ?? []).filter(
      (task) => task.organization_id === args.p_organization_id,
    );
    const found = new Set<string>();
    let parents = args.p_root_ids;
    while (parents.length > 0) {
      parents = tasks
        .filter(
          (task) =>
            parents.includes(task.parent_task_id as string) &&
            !found.has(task.id as string),
        )
        .map((task) => task.id as string);
      parents.forEach((id) => found.add(id));
    }
    return Promise.resolve({ data: [...found], error: null });
  }

  const budget = (id: string, amount: number, currency = 'EUR', org = ORG) => ({
    id,
    organization_id: org,
    amount: amount.toFixed(2),
    currency,
  });
  const split = (budgetId: string, taskId: string, amount: number) => ({
    organization_id: ORG,
    overall_budget_id: budgetId,
    task_id: taskId,
    amount: amount.toFixed(2),
  });
  const task = (id: string, parentId: string | null = null) => ({
    id,
    organization_id: ORG,
    parent_task_id: parentId,
  });
  const time = (taskId: string, userId: string, hours: number, org = ORG) => ({
    organization_id: org,
    task_id: taskId,
    user_id: userId,
    duration_minutes: hours * 60,
    logged_at: '2026-08-03T10:00:00+00:00',
  });
  const rate = (
    userId: string,
    costRate: number | null,
    currency: string | null = 'EUR',
  ) => ({
    organization_id: ORG,
    user_id: userId,
    weekly_capacity_hours: '40.00',
    cost_rate: costRate === null ? null : costRate.toFixed(2),
    currency,
    is_active: true,
  });
  const actual = (
    taskId: string,
    amount: number,
    currency: string | null = 'EUR',
    values: Row = {},
  ) => ({
    organization_id: ORG,
    task_id: taskId,
    entry_type: 'actual',
    aggregation: 'manual',
    amount: amount.toFixed(2),
    currency,
    ...values,
  });

  const zero = {
    used_amount: 0,
    used_percent: 0,
    used_other_currencies: [],
    missing_rate_hours: 0,
  };

  /** Budget 01 (40000 EUR): 12000 on Epic 01, 8000 on Epic 02. */
  function seedTicket() {
    db.overall_budgets = [budget('b1', 40000)];
    db.budget_splits = [
      split('b1', 'epic-1', 12000),
      split('b1', 'epic-2', 8000),
    ];
    db.tasks = [task('epic-1'), task('epic-2'), task('story-1', 'epic-1')];
    db.employee_capacity = [rate('u1', 100)];
    // 50 h x 100 EUR on a child of Epic 01.
    db.time_entries = [time('story-1', 'u1', 50)];
    db.resource_budget_entries = [
      actual('epic-1', 400),
      actual('epic-2', 600),
      actual('epic-1', 9999, 'EUR', { entry_type: 'planned' }),
      actual('epic-2', 9999, 'EUR', { aggregation: 'rollup' }),
    ];
  }

  const usage = (ids: string[]) => service.usedByBudget(ORG, ids);

  beforeEach(() => {
    db = {};
    calls = [];
    failingTable = undefined;
    rpc = jest.fn(descendantIds);
    service = new BudgetUsageService({
      getClient: () => ({ from: fakeFrom, rpc }),
    } as unknown as SupabaseAdminService);
  });

  it('uses 15% of Budget 01 for 5000 EUR of time and 1000 EUR of actual entries', async () => {
    seedTicket();

    expect((await usage(['b1'])).get('b1')).toEqual({
      used_amount: 6000,
      used_percent: 15,
      used_other_currencies: [],
      missing_rate_hours: 0,
    });
  });

  it('counts subtasks at any depth, once, even under nested splits of one budget', async () => {
    db.overall_budgets = [budget('b1', 1000)];
    db.budget_splits = [split('b1', 'epic', 600), split('b1', 'story', 200)];
    db.tasks = [
      task('epic'),
      task('story', 'epic'),
      task('subtask', 'story'),
      task('unfunded'),
    ];
    db.employee_capacity = [rate('u1', 100)];
    db.time_entries = [
      time('subtask', 'u1', 1),
      time('epic', 'u1', 0.5),
      time('unfunded', 'u1', 5),
    ];

    expect((await usage(['b1'])).get('b1')).toMatchObject({
      used_amount: 150,
      used_percent: 15,
    });
  });

  it('shares a task funded by two budgets pro-rata by their nearest splits', async () => {
    db.overall_budgets = [budget('a', 20000), budget('b', 10000)];
    // A funds the epic, so its weight on the story is the epic's 12000.
    db.budget_splits = [split('a', 'epic', 12000), split('b', 'story', 8000)];
    db.tasks = [task('epic'), task('story', 'epic')];
    db.resource_budget_entries = [actual('story', 1000), actual('epic', 100)];

    const result = await usage(['a', 'b']);

    expect(result.get('a')).toMatchObject({
      used_amount: 700,
      used_percent: 3.5,
    });
    expect(result.get('b')).toMatchObject({
      used_amount: 400,
      used_percent: 4,
    });
  });

  it('shares equally when the funding budgets have different currencies', async () => {
    db.overall_budgets = [budget('a', 10000, 'EUR'), budget('b', 10000, 'USD')];
    db.budget_splits = [split('a', 't1', 12000), split('b', 't1', 8000)];
    db.tasks = [task('t1')];
    db.resource_budget_entries = [actual('t1', 1000, 'EUR')];

    const result = await usage(['a', 'b']);

    expect(result.get('a')).toEqual({
      ...zero,
      used_amount: 500,
      used_percent: 5,
    });
    expect(result.get('b')).toEqual({
      ...zero,
      used_other_currencies: [{ currency: 'EUR', amount: 500 }],
    });
  });

  it('keeps other currencies and UNSPECIFIED out of used_amount', async () => {
    db.overall_budgets = [budget('b1', 1000)];
    db.budget_splits = [split('b1', 't1', 500)];
    db.tasks = [task('t1')];
    db.employee_capacity = [rate('u2', 50, 'USD')];
    db.time_entries = [time('t1', 'u2', 1)];
    db.resource_budget_entries = [
      actual('t1', 10, ' usd '),
      actual('t1', 20, null),
    ];

    expect((await usage(['b1'])).get('b1')).toEqual({
      ...zero,
      used_other_currencies: [
        { currency: 'UNSPECIFIED', amount: 20 },
        { currency: 'USD', amount: 60 },
      ],
    });
  });

  it('reports hours without a cost rate as missing_rate_hours', async () => {
    db.overall_budgets = [budget('b1', 1000)];
    db.budget_splits = [split('b1', 't1', 500)];
    db.tasks = [task('t1')];
    db.employee_capacity = [rate('u3', null)];
    // u4 has no capacity at all: an UNSPECIFIED 0 cost, which is not listed.
    db.time_entries = [time('t1', 'u3', 1.5), time('t1', 'u4', 0.5)];

    expect((await usage(['b1'])).get('b1')).toEqual({
      ...zero,
      missing_rate_hours: 2,
    });
  });

  it('gives a budget without splits zeros and skips budgets of other organizations', async () => {
    db.overall_budgets = [
      budget('b1', 1000),
      budget('foreign', 1000, 'EUR', OTHER_ORG),
    ];

    const result = await usage(['b1', 'foreign', 'missing']);

    expect([...result]).toEqual([['b1', zero]]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('makes no reads for no budget ids', async () => {
    expect((await usage([])).size).toBe(0);
    expect(calls).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('filters every read by organization', async () => {
    seedTicket();
    db.time_entries.push(time('story-1', 'u1', 100, OTHER_ORG));

    expect((await usage(['b1'])).get('b1')?.used_amount).toBe(6000);
    expect(new Set(calls.map((call) => call.table))).toEqual(
      new Set([
        'overall_budgets',
        'budget_splits',
        'tasks',
        'time_entries',
        'resource_budget_entries',
        'employee_capacity',
        'employee_capacity_periods',
      ]),
    );
    for (const call of calls) {
      expect(call.eq).toContainEqual(['organization_id', ORG]);
    }
    expect(rpc).toHaveBeenCalledWith('get_task_descendant_ids', {
      p_root_ids: ['epic-1', 'epic-2'],
      p_organization_id: ORG,
    });
  });

  it('throws on a read error', async () => {
    seedTicket();
    failingTable = 'time_entries';

    await expect(usage(['b1'])).rejects.toThrow(InternalServerErrorException);
  });
});
