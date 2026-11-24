import { BadRequestException } from '@nestjs/common';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { WorkingCalendarService } from '../calendar/working-calendar.service';
import {
  BudgetTimelineService,
  resolveMonthRange,
} from './budget-timeline.service';
import type {
  BudgetTreeService,
  ScopedBudgetTree,
  TaskTreeRow,
} from './budget-tree.service';

type Tables = Record<string, unknown[]>;

/** Chainable client: filters are ignored, the first page returns the table's rows. */
function fakeClient(tables: Tables) {
  return {
    from: jest.fn((table: string) => {
      const query: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'in', 'not', 'order']) {
        query[method] = jest.fn(() => query);
      }
      query.range = jest.fn((from: number) =>
        Promise.resolve({
          data: from === 0 ? (tables[table] ?? []) : [],
          error: null,
        }),
      );
      return query;
    }),
  };
}

const row = (
  id: string,
  level: number,
  parent: string | null,
): TaskTreeRow => ({
  id,
  key: id.toUpperCase(),
  summary: `Task ${id}`,
  level,
  parent_task_id: parent,
});

/** root -> a (space-a) -> deep (beyond depth); root -> other (space-b). */
function scopedTree(): ScopedBudgetTree {
  return {
    depth: 1,
    rootTask: {
      id: 'root',
      key: 'ROOT',
      summary: 'Task root',
      organization_id: 'org-1',
      process_id: null,
      space_id: 'space-a',
    },
    scope: { allowedSpaceIds: new Set(['space-a']), allowsNullSpace: true },
    included: new Map([
      ['root', row('root', 0, null)],
      ['a', row('a', 1, 'root')],
    ]),
    truncated: false,
    hiddenCount: 0,
    otherSpaceCount: 1,
    detailById: new Map([
      [
        'a',
        {
          id: 'a',
          key: 'A',
          summary: 'Task a',
          parent_task_id: 'root',
          space_id: 'space-a',
        },
      ],
      [
        'deep',
        {
          id: 'deep',
          key: 'DEEP',
          summary: 'Task deep',
          parent_task_id: 'a',
          space_id: 'space-a',
        },
      ],
      [
        'other',
        {
          id: 'other',
          key: 'OTHER',
          summary: 'Task other',
          parent_task_id: 'root',
          space_id: 'space-b',
        },
      ],
    ]),
    childrenByParentId: new Map([
      ['root', ['a', 'other']],
      ['a', ['deep']],
    ]),
    spaceByTaskId: new Map([
      ['root', 'space-a'],
      ['a', 'space-a'],
    ]),
  };
}

const taskRow = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  start_date: null,
  due_date: null,
  end_date: null,
  completed_at: null,
  resolved_at: null,
  status_id: 'open',
  task_type_id: 'task',
  ...overrides,
});

function buildService(tables: Tables, hasCalendar = false) {
  const resolveScopedTree = jest.fn().mockResolvedValue(scopedTree());
  const calendar = {
    hasAnySchemeConfigured: jest.fn().mockResolvedValue(hasCalendar),
    resolveCalendarContext: jest.fn().mockResolvedValue(null),
  };
  const service = new BudgetTimelineService(
    { getClient: () => fakeClient(tables) } as unknown as SupabaseAdminService,
    { resolveScopedTree } as unknown as BudgetTreeService,
    calendar as unknown as WorkingCalendarService,
  );
  return { service, resolveScopedTree, calendar };
}

describe('resolveMonthRange', () => {
  const now = new Date('2026-09-15T10:00:00Z');

  it('defaults to the current month and the next 11', () => {
    expect(resolveMonthRange(undefined, undefined, now)).toEqual({
      from: '2026-09',
      to: '2027-08',
    });
  });

  it('rejects a reversed or longer than 24 month range', () => {
    expect(() => resolveMonthRange('2027-02', '2027-01', now)).toThrow(
      BadRequestException,
    );
    expect(() => resolveMonthRange('2027-01', '2029-01', now)).toThrow(
      BadRequestException,
    );
    expect(resolveMonthRange('2027-01', '2028-12', now).to).toBe('2028-12');
  });
});

describe('BudgetTimelineService', () => {
  it('validates the range before touching the tree', async () => {
    const { service, resolveScopedTree } = buildService({});
    await expect(
      service.getTimeline('root', 'org-1', 'user-1', {
        from: '2027-05',
        to: '2027-01',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(resolveScopedTree).not.toHaveBeenCalled();
  });

  it('builds rows for the shown tree and rolls up the whole visible subtree in the viewer time zone', async () => {
    const { service, resolveScopedTree, calendar } = buildService({
      tasks: [
        taskRow('root', {
          start_date: '2026-12-31T23:00:00+00:00',
          due_date: '2027-03-30T22:00:00+00:00',
          task_type_id: 'epic',
        }),
        taskRow('a', {
          start_date: '2027-01-01T00:00:00+00:00',
          end_date: '2027-02-27T23:00:00+00:00',
          status_id: 'done',
          completed_at: null,
          resolved_at: '2027-02-14T23:30:00+00:00',
        }),
        taskRow('deep', {
          start_date: '2027-01-10T00:00:00+00:00',
          end_date: '2027-01-20T00:00:00+00:00',
        }),
      ],
      task_statuses: [
        { id: 'open', is_completed: false },
        { id: 'done', is_completed: true },
      ],
      resource_budget_entries: [
        {
          id: 'e1',
          task_id: 'deep',
          currency: 'eur',
          amount: '400',
          start_date: null,
          end_date: null,
        },
        {
          id: 'e2',
          task_id: 'other',
          currency: 'EUR',
          amount: '999',
          start_date: '2027-01-01',
          end_date: '2027-01-31',
        },
      ],
      task_resource_allocations: [
        {
          id: 'r1',
          task_id: 'a',
          user_id: 'u1',
          allocation_mode: 'total_hours',
          planned_hours: '10',
          weekly_hours: null,
          capacity_percent: null,
          start_date: null,
          end_date: null,
        },
      ],
    });

    const result = await service.getTimeline('root', 'org-1', 'user-1', {
      depth: 1,
      spaceId: 'space-a',
      from: '2027-01',
      to: '2027-03',
      tz: 'Europe/Vienna',
    });

    expect(resolveScopedTree).toHaveBeenCalledWith(
      'root',
      'org-1',
      'user-1',
      expect.objectContaining({ depth: 1, spaceId: 'space-a' }),
    );
    expect(calendar.resolveCalendarContext).not.toHaveBeenCalled();
    expect(result.working_calendar).toBe(false);
    expect(result.months).toEqual(['2027-01', '2027-02', '2027-03']);
    expect(result.nodes.map((node) => node.task_id)).toEqual(['root', 'a']);

    const [root, a] = result.nodes;
    // Vienna: 31 Dec 23:00Z is 1 Jan; due 30 Mar 22:00Z is 31 Mar.
    expect(root.planned_start).toBe('2027-01-01');
    expect(root.planned_end).toBe('2027-03-31');
    expect(root.task_type_id).toBe('epic');
    // Done via the status, dated by resolved_at (15 Feb in Vienna).
    expect(a.is_done).toBe(true);
    expect(a.done_date).toBe('2027-02-15');
    expect(a.bar).toEqual({ start: '2027-01-01', end: '2027-02-15' });
    // Same rule as the graph: `deep` exists below the shown depth.
    expect(a.has_hidden_children).toBe(true);
    // `deep` is below the shown depth but its entry rolls into a and root;
    // the other-space ticket's entry never counts.
    expect(a.months['2027-01'].budget).toEqual({ EUR: 400 });
    expect(root.months['2027-01'].budget).toEqual({ EUR: 400 });
    expect(a.months['2027-01'].hours + a.months['2027-02'].hours).toBe(10);
    expect(root.months['2027-03']).toBeUndefined();
    expect(result.unscheduled).toEqual([]);
    expect(result.other_space_count).toBe(1);
  });

  it('lists planned figures without dates in Unscheduled', async () => {
    const { service } = buildService({
      tasks: [taskRow('root'), taskRow('a'), taskRow('deep')],
      task_statuses: [{ id: 'open', is_completed: false }],
      resource_budget_entries: [
        {
          id: 'e1',
          task_id: 'deep',
          currency: 'EUR',
          amount: 250,
          start_date: null,
          end_date: null,
        },
      ],
    });

    const result = await service.getTimeline('root', 'org-1', 'user-1', {
      from: '2027-01',
      to: '2027-02',
    });

    expect(result.unscheduled).toEqual([
      {
        task_id: 'deep',
        key: 'DEEP',
        summary: 'Task deep',
        budget: { EUR: 250 },
        hours: 0,
      },
    ]);
    expect(result.nodes[0].months).toEqual({});
  });
});
