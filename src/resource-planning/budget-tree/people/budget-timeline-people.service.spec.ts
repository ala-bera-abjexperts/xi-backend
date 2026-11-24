import { BadRequestException } from '@nestjs/common';
import type { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import type { ScheduleService } from '../../schedule/schedule.service';
import type {
  ScheduleBucket,
  ScheduleUserRow,
} from '../../schedule/schedule.types';
import type {
  BudgetTreeService,
  ScopedBudgetTree,
  TaskTreeRow,
} from '../budget-tree.service';
import { BudgetTimelinePeopleService } from './budget-timeline-people.service';

type Tables = Record<string, unknown[]>;

/** Chainable client: filters are ignored, the first page returns the table's rows. */
function fakeClient(tables: Tables) {
  return {
    from: jest.fn((table: string) => {
      const query: Record<string, unknown> = {};
      for (const method of [
        'select',
        'eq',
        'in',
        'not',
        'lte',
        'gte',
        'order',
      ]) {
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

function tree(rows: TaskTreeRow[]): ScopedBudgetTree {
  return {
    depth: 3,
    rootTask: {
      id: rows[0].id,
      key: rows[0].key,
      summary: rows[0].summary,
      organization_id: 'org-1',
      process_id: null,
      space_id: 'space-a',
    },
    scope: { allowedSpaceIds: new Set(['space-a']), allowsNullSpace: true },
    included: new Map(rows.map((item) => [item.id, item])),
    truncated: false,
    hiddenCount: 0,
    otherSpaceCount: 0,
    detailById: new Map(),
    childrenByParentId: new Map(),
    spaceByTaskId: new Map(),
  };
}

const bucket = (
  month: string,
  planned: number,
  capacity: number | null,
): ScheduleBucket => ({
  bucket_start: `${month}-01`,
  planned_hours: planned,
  capacity_hours: capacity,
  over_allocated: capacity !== null && planned > capacity,
});

const person = (
  userId: string,
  buckets: ScheduleBucket[],
  taskHours: Record<string, Record<string, number>>,
): ScheduleUserRow => ({
  user_id: userId,
  display_name: `Name ${userId}`,
  avatar_url: null,
  unit_ids: [],
  buckets,
  assignments: [],
  default_capacity: null,
  capacity_periods: [],
  task_hours: taskHours,
});

const taskRow = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  status_id: 'open',
  completed_at: null,
  resolved_at: null,
  ...overrides,
});

interface Setup {
  trees?: Record<string, ScopedBudgetTree>;
  tables?: Tables;
  schedule?: ScheduleUserRow[];
}

function buildService({ trees = {}, tables = {}, schedule = [] }: Setup) {
  const resolveScopedTree = jest.fn((rootId: string) =>
    Promise.resolve(trees[rootId]),
  );
  const getSchedule = jest.fn<
    Promise<ScheduleResponse>,
    Parameters<ScheduleService['getSchedule']>
  >();
  getSchedule.mockResolvedValue({
    range: { from: '', to: '', granularity: 'month' },
    truncated_users: false,
    users: schedule,
  });
  const service = new BudgetTimelinePeopleService(
    { getClient: () => fakeClient(tables) } as unknown as SupabaseAdminService,
    { resolveScopedTree } as unknown as BudgetTreeService,
    { getSchedule } as unknown as ScheduleService,
  );
  return { service, resolveScopedTree, getSchedule };
}

const baseTables = (userIds: string[], taskIds: string[]): Tables => ({
  task_resource_allocations: userIds.map((userId) => ({ user_id: userId })),
  tasks: taskIds.map((id) => taskRow(id)),
  task_statuses: [
    { id: 'open', is_completed: false },
    { id: 'done', is_completed: true },
  ],
  users: userIds.map((id) => ({ id, is_active: true })),
  organization_members: userIds.map((id) => ({ user_id: id })),
  time_entries: [],
});

describe('BudgetTimelinePeopleService', () => {
  const rootTree = tree([
    row('epic', 0, null),
    row('t1', 1, 'epic'),
    row('t2', 1, 'epic'),
  ]);

  it("sums one person's hours over the tree's tasks and lists each task (AC1)", async () => {
    const { service, getSchedule, resolveScopedTree } = buildService({
      trees: { epic: rootTree },
      tables: baseTables(['anna'], ['epic', 't1', 't2']),
      schedule: [
        person('anna', [bucket('2027-01', 180, 160)], {
          t1: { '2027-01-01': 40 },
          t2: { '2027-01-01': 20 },
        }),
      ],
    });

    const result = await service.getPeople('org-1', 'viewer', {
      taskIds: ['epic'],
      depth: 2,
      spaceId: 'space-a',
      from: '2027-01',
      to: '2027-02',
      tz: 'Europe/Vienna',
    });

    expect(resolveScopedTree).toHaveBeenCalledWith('epic', 'org-1', 'viewer', {
      depth: 2,
      spaceId: 'space-a',
    });
    expect(getSchedule).toHaveBeenCalledWith(
      'org-1',
      {
        from: '2027-01-01',
        to: '2027-02-28',
        granularity: 'month',
        userIds: ['anna'],
        taskBreakdownIds: new Set(['epic', 't1', 't2']),
        trustedUserIds: true,
      },
      'viewer',
    );
    expect(result.from).toBe('2027-01');
    expect(result.timezone).toBe('Europe/Vienna');
    expect(result.months).toEqual([
      {
        month: '2027-01',
        planned_hours: 60,
        people: [
          {
            user_id: 'anna',
            display_name: 'Name anna',
            avatar_url: null,
            is_active: true,
            planned_hours: 60,
            actual_hours: 0,
            total_planned_hours: 180,
            capacity_hours: 160,
            over_allocated: true,
            tasks: [
              {
                task_id: 't1',
                key: 'T1',
                summary: 'Task t1',
                planned_hours: 40,
                actual_hours: 0,
              },
              {
                task_id: 't2',
                key: 'T2',
                summary: 'Task t2',
                planned_hours: 20,
                actual_hours: 0,
              },
            ],
          },
        ],
      },
      { month: '2027-02', planned_hours: 0, people: [] },
    ]);
  });

  it('keeps unknown capacity null and never flags it', async () => {
    const { service } = buildService({
      trees: { epic: rootTree },
      tables: baseTables(['ben'], ['epic', 't1', 't2']),
      schedule: [
        person('ben', [bucket('2027-01', 500, null)], {
          t1: { '2027-01-01': 500 },
        }),
      ],
    });

    const [january] = (
      await service.getPeople('org-1', 'viewer', {
        taskIds: ['epic'],
        from: '2027-01',
        to: '2027-01',
      })
    ).months;

    expect(january.people[0]).toMatchObject({
      capacity_hours: null,
      over_allocated: false,
      total_planned_hours: 500,
    });
  });

  it('returns every month empty without calling the Schedule when nobody is planned', async () => {
    const { service, getSchedule } = buildService({
      trees: { epic: rootTree },
      tables: { ...baseTables([], ['epic', 't1', 't2']) },
    });

    const result = await service.getPeople('org-1', 'viewer', {
      taskIds: ['epic'],
      from: '2027-01',
      to: '2027-03',
    });

    expect(getSchedule).not.toHaveBeenCalled();
    expect(
      result.months.map((month) => [
        month.month,
        month.people.length,
        month.planned_hours,
      ]),
    ).toEqual([
      ['2027-01', 0, 0],
      ['2027-02', 0, 0],
      ['2027-03', 0, 0],
    ]);
  });

  it('drops hours after the done month, also for descendants of a done ticket', async () => {
    const tables = baseTables(['anna'], []);
    tables.tasks = [
      taskRow('epic'),
      // Done 31 Jan 23:30 in Vienna (22:30Z): January.
      taskRow('t1', {
        status_id: 'done',
        completed_at: '2027-01-31T22:30:00Z',
      }),
      taskRow('child'),
      taskRow('t2', { status_id: 'done', resolved_at: null }),
    ];
    const { service } = buildService({
      trees: {
        epic: tree([
          row('epic', 0, null),
          row('t1', 1, 'epic'),
          row('t2', 1, 'epic'),
          row('child', 2, 't1'),
        ]),
      },
      tables,
      schedule: [
        person(
          'anna',
          [bucket('2027-01', 30, 160), bucket('2027-02', 30, 160)],
          {
            t1: { '2027-01-01': 10, '2027-02-01': 10 },
            child: { '2027-01-01': 5, '2027-02-01': 5 },
            // Done without a date: no cutoff.
            t2: { '2027-01-01': 15, '2027-02-01': 15 },
          },
        ),
      ],
    });

    const [january, february] = (
      await service.getPeople('org-1', 'viewer', {
        taskIds: ['epic'],
        from: '2027-01',
        to: '2027-02',
        tz: 'Europe/Vienna',
      })
    ).months;

    expect(
      january.people[0].tasks.map((task) => [task.task_id, task.planned_hours]),
    ).toEqual([
      ['t2', 15],
      ['t1', 10],
      ['child', 5],
    ]);
    expect(
      february.people[0].tasks.map((task) => [
        task.task_id,
        task.planned_hours,
      ]),
    ).toEqual([['t2', 15]]);
    expect(february.planned_hours).toBe(15);
  });

  it('marks deactivated users and people who left the organization', async () => {
    const tables = baseTables(['anna', 'ben', 'cleo'], ['epic', 't1', 't2']);
    tables.users = [
      { id: 'anna', is_active: true },
      { id: 'ben', is_active: false },
      { id: 'cleo', is_active: true },
    ];
    tables.organization_members = [{ user_id: 'anna' }, { user_id: 'ben' }];
    const planned = { t1: { '2027-01-01': 8 } };
    const { service } = buildService({
      trees: { epic: rootTree },
      tables,
      schedule: [
        person('anna', [bucket('2027-01', 8, 160)], planned),
        person('ben', [bucket('2027-01', 8, 160)], planned),
        person('cleo', [bucket('2027-01', 8, 160)], planned),
      ],
    });

    const [january] = (
      await service.getPeople('org-1', 'viewer', {
        taskIds: ['epic'],
        from: '2027-01',
        to: '2027-01',
      })
    ).months;

    expect(
      Object.fromEntries(
        january.people.map((item) => [item.user_id, item.is_active]),
      ),
    ).toEqual({ anna: true, ben: false, cleo: false });
  });

  it('sorts people by planned hours and merges several roots into one set', async () => {
    const other = tree([row('other', 0, null), row('o1', 1, 'other')]);
    const tables = baseTables(
      ['anna', 'ben'],
      ['epic', 't1', 't2', 'other', 'o1'],
    );
    const { service, getSchedule } = buildService({
      trees: { epic: rootTree, other },
      tables,
      schedule: [
        person('anna', [bucket('2027-01', 10, 160)], {
          t1: { '2027-01-01': 10 },
        }),
        person('ben', [bucket('2027-01', 30, 160)], {
          t1: { '2027-01-01': 12 },
          o1: { '2027-01-01': 18 },
        }),
      ],
    });

    const [january] = (
      await service.getPeople('org-1', 'viewer', {
        taskIds: ['epic', 'other', 'epic'],
        from: '2027-01',
        to: '2027-01',
      })
    ).months;

    expect(getSchedule.mock.calls[0][1].taskBreakdownIds).toEqual(
      new Set(['epic', 't1', 't2', 'other', 'o1']),
    );
    expect(
      january.people.map((item) => [item.user_id, item.planned_hours]),
    ).toEqual([
      ['ben', 30],
      ['anna', 10],
    ]);
    expect(january.planned_hours).toBe(40);
  });

  it('adds actual hours per task in the local month, only for planned people', async () => {
    const tables = baseTables(['anna'], ['epic', 't1', 't2']);
    tables.time_entries = [
      // 23:30 Vienna on 31 Jan counts for January.
      {
        task_id: 't1',
        user_id: 'anna',
        duration_minutes: 90,
        logged_at: '2027-01-31T22:30:00Z',
      },
      // 00:30 Vienna on 1 Feb counts for February.
      {
        task_id: 't2',
        user_id: 'anna',
        duration_minutes: 60,
        logged_at: '2027-01-31T23:30:00Z',
      },
      {
        task_id: 't1',
        user_id: 'stranger',
        duration_minutes: 600,
        logged_at: '2027-01-15T10:00:00Z',
      },
    ];
    const { service } = buildService({
      trees: { epic: rootTree },
      tables,
      schedule: [
        person('anna', [bucket('2027-01', 8, 160), bucket('2027-02', 8, 160)], {
          t1: { '2027-01-01': 8, '2027-02-01': 8 },
        }),
      ],
    });

    const [january, february] = (
      await service.getPeople('org-1', 'viewer', {
        taskIds: ['epic'],
        from: '2027-01',
        to: '2027-02',
        tz: 'Europe/Vienna',
      })
    ).months;

    expect(january.people[0]).toMatchObject({ actual_hours: 1.5 });
    expect(february.people[0].actual_hours).toBe(1);
    expect(february.people[0].tasks).toEqual([
      {
        task_id: 't1',
        key: 'T1',
        summary: 'Task t1',
        planned_hours: 8,
        actual_hours: 0,
      },
      {
        task_id: 't2',
        key: 'T2',
        summary: 'Task t2',
        planned_hours: 0,
        actual_hours: 1,
      },
    ]);
  });

  it('asks the Schedule in batches of 500 people', async () => {
    const userIds = Array.from({ length: 501 }, (_, index) => `u${index}`);
    const { service, getSchedule } = buildService({
      trees: { epic: rootTree },
      tables: baseTables(userIds, ['epic', 't1', 't2']),
    });

    await service.getPeople('org-1', 'viewer', {
      taskIds: ['epic'],
      from: '2027-01',
      to: '2027-01',
    });

    expect(
      getSchedule.mock.calls.map((call) => call[1].userIds.length),
    ).toEqual([500, 1]);
  });

  it('rejects an invalid month range before loading anything', async () => {
    const { service, resolveScopedTree } = buildService({});

    await expect(
      service.getPeople('org-1', 'viewer', {
        taskIds: ['epic'],
        from: '2027-05',
        to: '2027-01',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(resolveScopedTree).not.toHaveBeenCalled();
  });
});
