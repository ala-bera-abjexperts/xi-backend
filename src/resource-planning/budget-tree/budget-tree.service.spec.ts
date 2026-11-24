import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { WorkingCalendarService } from '../calendar/working-calendar.service';
import type { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { ResourcePlanningService } from '../resource-planning.service';
import { BudgetSplitService } from '../budget-split/budget-split.service';
import type { BudgetUsageService } from '../overall-budget/budget-usage.service';
import { BudgetTreeService, pickLinkedTasks } from './budget-tree.service';
import type { BudgetTreeNode } from './budget-tree.types';

type TableData = Record<string, { rows?: unknown[]; single?: unknown }>;

/** Chainable client: every filter returns the query; awaiting it yields the table's rows. */
function fakeClient(tables: TableData, descendantIds: string[]) {
  return {
    from: jest.fn((table: string) => {
      const config = tables[table] ?? {};
      const query: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'in', 'not']) {
        query[method] = jest.fn(() => query);
      }
      query.maybeSingle = jest
        .fn()
        .mockResolvedValue({ data: config.single ?? null, error: null });
      query.then = (
        resolve: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown,
      ) =>
        Promise.resolve({ data: config.rows ?? [], error: null }).then(
          resolve,
          reject,
        );
      return query;
    }),
    rpc: jest.fn().mockResolvedValue({ data: descendantIds, error: null }),
  };
}

const task = (id: string, space_id: string | null, parent: string | null) => ({
  id,
  key: id.toUpperCase(),
  summary: id,
  parent_task_id: parent,
  space_id,
  organization_id: 'org-1',
  process_id: null,
});

const entry = (task_id: string, amount: number, aggregation = 'manual') => ({
  task_id,
  cost_category_id: 'cat-1',
  currency: 'EUR',
  quantity: 1,
  unit_cost: amount,
  amount,
  aggregation,
  start_date: null,
  end_date: null,
});

function buildService(
  tables: TableData,
  descendantIds: string[],
  allowedSpaceIds = ['space-a'],
  usedByBudget: jest.Mock = jest.fn().mockResolvedValue(new Map()),
) {
  const client = fakeClient(tables, descendantIds);
  const supabaseAdmin = {
    getClient: () => client,
  } as unknown as SupabaseAdminService;
  const orgModules = {
    isEnabled: jest.fn().mockResolvedValue(true),
  } as unknown as OrganizationModulesService;
  const resourcePlanning = {
    resolveSpaceScope: jest.fn().mockResolvedValue({
      allowedSpaceIds: new Set(allowedSpaceIds),
      allowsNullSpace: true,
    }),
    assertSpaceAllowed: jest.fn().mockResolvedValue(undefined),
  } as unknown as ResourcePlanningService;
  return new BudgetTreeService(
    supabaseAdmin,
    orgModules,
    resourcePlanning,
    {
      resolveCalendarContext: jest.fn().mockResolvedValue(null),
    } as unknown as WorkingCalendarService,
    // The real split service on the same fake client: tables without rows
    // (budget_splits, overall_budgets) come back empty.
    new BudgetSplitService(
      supabaseAdmin,
      orgModules,
      resourcePlanning,
      {} as AuditLogsService,
    ),
    { usedByBudget } as unknown as BudgetUsageService,
  );
}

/** Every node of a tree, linked ones included. */
function allNodes(node: BudgetTreeNode): BudgetTreeNode[] {
  return [
    node,
    ...node.children.flatMap(allNodes),
    ...node.linked.flatMap(allNodes),
  ];
}

// The fake ignores filters, so every budget row comes back for every read;
// the service still has to drop out-of-scope budgets itself.
const budgetRow = (
  id: string,
  space_id: string,
  amount: string,
  currency = 'EUR',
) => ({ id, name: `Budget ${id}`, amount, currency, space_id });

const splitRow = (
  id: string,
  overall_budget_id: string,
  task_id: string,
  amount: string,
) => ({ id, overall_budget_id, task_id, amount, note: null });

describe('BudgetTreeService space scope', () => {
  it('404s a root outside the requested space and 403s a space outside the scope', async () => {
    const service = buildService(
      { tasks: { single: task('root', 'space-b', null) } },
      ['root'],
    );

    await expect(
      service.getBudgetTree('root', 'org-1', 'user-1', { spaceId: 'space-a' }),
    ).rejects.toThrow(NotFoundException);
    await expect(
      service.getBudgetTree('root', 'org-1', 'user-1', { spaceId: 'space-z' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('drops a child in another space from the tree and from rollup totals', async () => {
    const service = buildService(
      {
        tasks: {
          single: task('root', 'space-a', null),
          rows: [
            task('root', 'space-a', null),
            task('child-a', 'space-a', 'root'),
            task('child-b', 'space-b', 'root'),
          ],
        },
        resource_budget_entries: {
          rows: [
            entry('root', 0, 'rollup_sum'),
            entry('child-a', 100),
            entry('child-b', 50),
          ],
        },
      },
      ['root', 'child-a', 'child-b'],
    );

    const result = await service.getBudgetTree('root', 'org-1', 'user-1', {
      spaceId: 'space-a',
    });

    expect(result.other_space_count).toBe(1);
    expect(result.tree.children.map((node) => node.task_id)).toEqual([
      'child-a',
    ]);
    expect(result.tree.own_by_category[0].effective_amount).toBe(100);
    expect(result.tree.linked).toEqual([]);
  });

  it('attaches a dependency-linked ticket without feeding it into any rollup', async () => {
    const service = buildService(
      {
        tasks: {
          single: task('root', 'space-a', null),
          rows: [
            task('root', 'space-a', null),
            task('child-a', 'space-a', 'root'),
            task('x', 'space-a', null),
          ],
        },
        resource_budget_entries: {
          rows: [
            entry('root', 0, 'rollup_sum'),
            entry('child-a', 100),
            entry('x', 999),
          ],
        },
        relation_types: {
          rows: [
            {
              id: 'rt-blocks',
              name: 'Blocks',
              outward_description: 'blocks',
              inward_description: 'is blocked by',
            },
          ],
        },
        task_relationships: {
          rows: [
            {
              source_id: 'child-a',
              target_id: 'x',
              relation_type_id: 'rt-blocks',
            },
          ],
        },
      },
      ['root', 'child-a'],
    );

    const result = await service.getBudgetTree('root', 'org-1', 'user-1', {
      includeDependencies: true,
    });

    expect(result.tree.own_by_category[0].effective_amount).toBe(100);
    const [linked] = result.tree.children[0].linked;
    expect(linked.task_id).toBe('x');
    expect(linked.link).toEqual({
      relation_type_name: 'Blocks',
      label: 'blocks',
    });
    expect(linked.children).toEqual([]);
    expect(result.node_count).toBe(3);
  });
});

describe('BudgetTreeService budget splits', () => {
  const tasks = {
    single: task('root', 'space-a', null),
    rows: [
      task('root', 'space-a', null),
      task('child-a', 'space-a', 'root'),
      task('grandchild', 'space-a', 'child-a'),
      task('child-b', 'space-b', 'root'),
    ],
  };
  const descendants = ['root', 'child-a', 'grandchild', 'child-b'];

  it('has empty splits and funding on every node of a tree without splits', async () => {
    const usedByBudget = jest.fn();
    const service = buildService(
      { tasks, resource_budget_entries: { rows: [entry('child-a', 100)] } },
      descendants,
      ['space-a'],
      usedByBudget,
    );

    const result = await service.getBudgetTree('root', 'org-1', 'user-1');

    const nodes = allNodes(result.tree);
    expect(nodes.map((node) => node.task_id)).toEqual([
      'root',
      'child-a',
      'grandchild',
    ]);
    for (const node of nodes) {
      expect(node.budget_splits).toEqual([]);
      expect(node.funding).toEqual([]);
      expect(node.funding_other_currency).toBe(false);
    }
    expect(result.budgets).toEqual([]);
    expect(usedByBudget).not.toHaveBeenCalled();
  });

  it('attaches splits with percent, nesting and children_exceed', async () => {
    const service = buildService(
      {
        tasks,
        overall_budgets: { rows: [budgetRow('b1', 'space-a', '1000.00')] },
        budget_splits: {
          rows: [
            splitRow('s-root', 'b1', 'root', '800.00'),
            // Nested under s-root through child-a, which has no split.
            splitRow('s-grandchild', 'b1', 'grandchild', '900.00'),
          ],
        },
      },
      descendants,
    );

    const result = await service.getBudgetTree('root', 'org-1', 'user-1');

    expect(result.tree.budget_splits).toEqual([
      {
        id: 's-root',
        overall_budget_id: 'b1',
        budget_name: 'Budget b1',
        budget_space_id: 'space-a',
        currency: 'EUR',
        amount: 800,
        budget_amount: 1000,
        percent_of_budget: 80,
        note: null,
        parent_split_id: null,
        children_amount: 900,
        children_exceed_by: 100,
        budget_over_allocated_by: 0,
        warnings: ['children_exceed'],
      },
    ]);
    expect(result.tree.children[0].budget_splits).toEqual([]);
    expect(result.tree.children[0].children[0].budget_splits[0]).toMatchObject({
      id: 's-grandchild',
      percent_of_budget: 90,
      parent_split_id: 's-root',
      warnings: [],
    });
    expect(result.budgets).toEqual([
      {
        ...budgetRow('b1', 'space-a', '1000.00'),
        amount: 1000,
        allocated_amount: 800,
        over_allocated_by: 0,
        used_amount: 0,
        used_percent: 0,
        used_other_currencies: [],
        missing_rate_hours: 0,
        has_hidden_funded_tasks: false,
      },
    ]);
  });

  it('adds used figures and flags a budget funding a task outside the scope', async () => {
    const usedByBudget = jest.fn().mockResolvedValue(
      new Map([
        [
          'b1',
          {
            used_amount: 250,
            used_percent: 25,
            used_other_currencies: [{ currency: 'USD', amount: 10 }],
            missing_rate_hours: 1.5,
          },
        ],
      ]),
    );
    const service = buildService(
      {
        tasks,
        overall_budgets: {
          rows: [
            budgetRow('b1', 'space-a', '1000.00'),
            budgetRow('b2', 'space-a', '1000.00'),
          ],
        },
        budget_splits: {
          rows: [
            splitRow('s-root', 'b1', 'root', '100.00'),
            // child-b is in space-b, outside the viewer's scope.
            splitRow('s-hidden', 'b1', 'child-b', '100.00'),
            splitRow('s-child', 'b2', 'child-a', '100.00'),
          ],
        },
      },
      descendants,
      ['space-a'],
      usedByBudget,
    );

    const result = await service.getBudgetTree('root', 'org-1', 'user-1');

    expect(usedByBudget).toHaveBeenCalledTimes(1);
    expect(usedByBudget).toHaveBeenCalledWith('org-1', ['b1', 'b2']);
    expect(result.budgets).toEqual([
      expect.objectContaining({
        id: 'b1',
        used_amount: 250,
        used_percent: 25,
        used_other_currencies: [{ currency: 'USD', amount: 10 }],
        missing_rate_hours: 1.5,
        has_hidden_funded_tasks: true,
      }),
      expect.objectContaining({
        id: 'b2',
        used_amount: 0,
        used_percent: 0,
        used_other_currencies: [],
        missing_rate_hours: 0,
        has_hidden_funded_tasks: false,
      }),
    ]);
  });

  describe('budget scope', () => {
    const build = () =>
      buildService(
        {
          tasks,
          overall_budgets: {
            rows: [
              budgetRow('b-root', 'space-a', '500.00'),
              budgetRow('b-c', 'space-c', '100.00'),
              budgetRow('b-hidden', 'space-b', '100.00'),
            ],
          },
          budget_splits: {
            rows: [
              splitRow('s-c', 'b-c', 'child-a', '150.00'),
              splitRow('s-hidden', 'b-hidden', 'root', '50.00'),
            ],
          },
        },
        descendants,
        ['space-a', 'space-c'],
      );

    it('drops a split whose budget is out of scope and lists zero-split root-space budgets', async () => {
      const result = await build().getBudgetTree('root', 'org-1', 'user-1');

      expect(result.tree.budget_splits).toEqual([]);
      expect(result.tree.funding).toEqual([]);
      expect(result.budgets.map((budget) => budget.id)).toEqual([
        'b-c',
        'b-root',
      ]);
      expect(result.budgets[1]).toMatchObject({
        allocated_amount: 0,
        over_allocated_by: 0,
      });
    });

    it('warns about a budget from another space and over-allocation', async () => {
      const result = await build().getBudgetTree('root', 'org-1', 'user-1');

      expect(result.tree.children[0].budget_splits).toEqual([
        expect.objectContaining({
          id: 's-c',
          budget_space_id: 'space-c',
          percent_of_budget: 150,
          budget_over_allocated_by: 50,
          warnings: ['budget_over_allocated', 'budget_other_space'],
        }),
      ]);
    });
  });

  it('compares planned subtree amounts with funding, per currency', async () => {
    const service = buildService(
      {
        tasks,
        overall_budgets: {
          rows: [
            budgetRow('b-eur', 'space-a', '1000.00'),
            budgetRow('b-usd', 'space-a', '1000.00', 'USD'),
          ],
        },
        budget_splits: {
          rows: [
            splitRow('s-root', 'b-eur', 'root', '400.00'),
            splitRow('s-child', 'b-usd', 'child-a', '50.00'),
          ],
        },
        resource_budget_entries: {
          rows: [
            entry('child-a', 300),
            // Below the requested depth: still planned in the subtree.
            entry('grandchild', 200),
            // Hidden child (space-b): not in the subtree.
            entry('child-b', 1000),
          ],
        },
      },
      descendants,
    );

    const result = await service.getBudgetTree('root', 'org-1', 'user-1', {
      depth: 1,
    });

    expect(result.tree.funding).toEqual([
      {
        currency: 'EUR',
        planned_amount: 500,
        funded_amount: 400,
        underfunded_by: 100,
      },
    ]);
    expect(result.tree.funding_other_currency).toBe(false);
    const [child] = result.tree.children;
    expect(child.funding).toEqual([
      {
        currency: 'USD',
        planned_amount: 0,
        funded_amount: 50,
        underfunded_by: 0,
      },
    ]);
    expect(child.funding_other_currency).toBe(true);
  });
});

describe('pickLinkedTasks', () => {
  const levelById = new Map([
    ['root', 0],
    ['child', 1],
  ]);
  const rows = [
    { source_id: 'root', target_id: 'x', relation_type_id: 'blocks' },
    // Same ticket again from a deeper anchor: that anchor wins, x appears once.
    { source_id: 'x', target_id: 'child', relation_type_id: 'depends' },
    // Both ends already in the tree: skipped, so a link back cannot loop.
    { source_id: 'child', target_id: 'root', relation_type_id: 'blocks' },
    // Two hops out: skipped.
    { source_id: 'x', target_id: 'y', relation_type_id: 'blocks' },
  ];

  it('dedupes, keeps one hop, and never loops back into the tree', () => {
    expect(pickLinkedTasks(rows, levelById, 10)).toEqual([
      {
        anchorId: 'child',
        linkedId: 'x',
        relationTypeId: 'depends',
        anchorIsSource: false,
      },
    ]);
  });

  it('respects the remaining node budget', () => {
    expect(pickLinkedTasks(rows, levelById, 0)).toEqual([]);
  });
});
