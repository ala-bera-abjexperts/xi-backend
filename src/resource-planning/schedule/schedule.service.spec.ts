import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ScheduleService, type ScheduleQuery } from './schedule.service';
import type { ScheduleUserRow } from './schedule.types';
import type { WorkingCalendarContext } from '../calendar/working-calendar.engine';

const DAY_MS = 86_400_000;

// Duck-typed mirrors of schedule.service.ts's internal row shapes (not exported from that file
// on purpose -- these exist only so the private-method access below is fully typed instead of
// `any`, not to widen schedule.service.ts's public surface).
interface TestUserRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  avatar_url: string | null;
}
interface TestMembershipRow {
  user_id: string;
  unit_id: string;
  effective_from: string;
  effective_to: string | null;
  allocation_percent: number | null;
}
interface TestCapacityPeriodRow {
  user_id: string;
  effective_from: string;
  effective_to: string | null;
  weekly_capacity_hours: number;
  is_active: boolean;
}
interface TestCapacityDefaultRow {
  user_id: string;
  weekly_capacity_hours: number;
  is_active: boolean;
}
interface TestPlanAllocationRow {
  id: string;
  user_id: string;
  planned_hours: number;
  allocation_mode: 'total_hours' | 'hours_per_week' | 'capacity_percent';
  weekly_hours: number | null;
  capacity_percent: number | null;
  start_date: string | null;
  end_date: string | null;
  plans: { name: string } | { name: string }[] | null;
}
interface TestTaskAllocationRow {
  id: string;
  task_id?: string;
  user_id: string;
  planned_hours: number;
  allocation_mode?: 'total_hours' | 'hours_per_week' | 'capacity_percent';
  weekly_hours?: number | null;
  capacity_percent?: number | null;
  start_date: string | null;
  end_date: string | null;
  tasks: { summary: string } | { summary: string }[] | null;
}

interface ScheduleServiceInternals {
  buildUserRow(
    userId: string,
    user: TestUserRow | undefined,
    days: string[],
    query: ScheduleQuery,
    memberships: TestMembershipRow[] | undefined,
    capacityPeriods: TestCapacityPeriodRow[] | undefined,
    capacityDefault: TestCapacityDefaultRow | undefined,
    calendar: WorkingCalendarContext | null,
    planAllocations: TestPlanAllocationRow[],
    taskAllocations: TestTaskAllocationRow[],
  ): ScheduleUserRow;
  resolveUserIds(
    organizationId: string,
    query: ScheduleQuery,
  ): Promise<{ userIds: string[]; truncated: boolean }>;
}

// Mirrors the private dateRange() in schedule.service.ts -- buildUserRow takes its `days`
// argument pre-computed by the caller, so tests calling it directly must build that argument
// themselves rather than reaching into the private helper.
function inclusiveDays(from: string, to: string): string[] {
  const days: string[] = [];
  for (
    let ms = new Date(`${from}T00:00:00.000Z`).getTime(),
      end = new Date(`${to}T00:00:00.000Z`).getTime();
    ms <= end;
    ms += DAY_MS
  ) {
    days.push(new Date(ms).toISOString().slice(0, 10));
  }
  return days;
}

// Chainable Supabase query-builder stub: every method returns itself so `.from().select()
// .eq().in()`-style chains compile, and `.in(column, values)` captures the queried ids so the
// final `await` resolves as if every requested id is a real organization_members row -- lets
// tests exercise resolveUserIds()'s own filtering/truncation logic without asserting on a
// specific membership table shape.
function createFakeSupabaseAdmin() {
  const chain: any = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    in: (_column: string, values: string[]) => {
      chain.__captured = values;
      return chain;
    },
    then: (resolve: any, reject: any) =>
      Promise.resolve({
        data: (chain.__captured ?? []).map((id: string) => ({ user_id: id })),
        error: null,
      }).then(resolve, reject),
  };
  return { getClient: () => chain } as any;
}

const service = new ScheduleService(
  createFakeSupabaseAdmin(),
  {} as any,
  { isEnabled: async () => true } as any,
  {
    resolveSpaceScope: () =>
      Promise.resolve({
        allowedSpaceIds: new Set<string>(),
        allowsNullSpace: true,
      }),
  } as any,
);
const internals = service as unknown as ScheduleServiceInternals;

describe('schedule service', () => {
  it('buckets by ISO week and clamps bucket boundaries to the query range', () => {
    const query: ScheduleQuery = {
      from: '2026-08-12',
      to: '2026-08-20',
      granularity: 'week',
    };
    const row = internals.buildUserRow(
      'u1',
      undefined,
      inclusiveDays(query.from, query.to),
      query,
      undefined,
      undefined,
      { user_id: 'u1', weekly_capacity_hours: 35, is_active: true },
      null,
      [],
      [],
    );

    expect(row.buckets).toEqual([
      {
        bucket_start: '2026-08-12',
        capacity_hours: 25,
        planned_hours: 0,
        over_allocated: false,
      },
      {
        bucket_start: '2026-08-17',
        capacity_hours: 20,
        planned_hours: 0,
        over_allocated: false,
      },
    ]);
  });

  it('prorates an hours_per_week plan allocation across its dated window', () => {
    const query: ScheduleQuery = {
      from: '2026-08-12',
      to: '2026-08-12',
      granularity: 'day',
    };
    const row = internals.buildUserRow(
      'u1',
      undefined,
      inclusiveDays(query.from, query.to),
      query,
      undefined,
      undefined,
      undefined,
      null,
      [
        {
          id: 'a1',
          user_id: 'u1',
          planned_hours: 0,
          allocation_mode: 'hours_per_week',
          weekly_hours: 14,
          capacity_percent: null,
          start_date: '2026-08-12',
          end_date: '2026-08-12',
          plans: null,
        },
      ],
      [],
    );

    expect(row.buckets).toEqual([
      {
        bucket_start: '2026-08-12',
        capacity_hours: null,
        planned_hours: 2,
        over_allocated: false,
      },
    ]);
  });

  it("prorates a capacity_percent plan allocation off the day's effective capacity", () => {
    const query: ScheduleQuery = {
      from: '2026-08-12',
      to: '2026-08-12',
      granularity: 'day',
    };
    const row = internals.buildUserRow(
      'u1',
      undefined,
      inclusiveDays(query.from, query.to),
      query,
      undefined,
      undefined,
      { user_id: 'u1', weekly_capacity_hours: 35, is_active: true },
      null,
      [
        {
          id: 'a1',
          user_id: 'u1',
          planned_hours: 0,
          allocation_mode: 'capacity_percent',
          weekly_hours: null,
          capacity_percent: 50,
          start_date: '2026-08-12',
          end_date: '2026-08-12',
          plans: null,
        },
      ],
      [],
    );

    expect(row.buckets).toEqual([
      {
        bucket_start: '2026-08-12',
        capacity_hours: 5,
        planned_hours: 2.5,
        over_allocated: false,
      },
    ]);
  });

  it('prorates a total_hours plan allocation evenly across its own window', () => {
    const query: ScheduleQuery = {
      from: '2026-08-10',
      to: '2026-08-14',
      granularity: 'day',
    };
    const row = internals.buildUserRow(
      'u1',
      undefined,
      inclusiveDays(query.from, query.to),
      query,
      undefined,
      undefined,
      undefined,
      null,
      [
        {
          id: 'a1',
          user_id: 'u1',
          planned_hours: 50,
          allocation_mode: 'total_hours',
          weekly_hours: null,
          capacity_percent: null,
          start_date: '2026-08-10',
          end_date: '2026-08-14',
          plans: null,
        },
      ],
      [],
    );

    expect(row.buckets.map((b) => b.planned_hours)).toEqual([
      10, 10, 10, 10, 10,
    ]);
  });

  it('prorates a task allocation evenly across its own dated window', () => {
    const query: ScheduleQuery = {
      from: '2026-08-01',
      to: '2026-08-07',
      granularity: 'day',
    };
    const row = internals.buildUserRow(
      'u1',
      undefined,
      inclusiveDays(query.from, query.to),
      query,
      undefined,
      undefined,
      undefined,
      null,
      [],
      [
        {
          id: 't1',
          user_id: 'u1',
          planned_hours: 21,
          start_date: '2026-08-01',
          end_date: '2026-08-07',
          tasks: null,
        },
      ],
    );

    expect(row.buckets.map((b) => b.planned_hours)).toEqual([
      3, 3, 3, 3, 3, 3, 3,
    ]);
  });

  it("prorates off the allocation's own window even when the query range only partially overlaps it", () => {
    const query: ScheduleQuery = {
      from: '2026-08-14',
      to: '2026-08-18',
      granularity: 'day',
    };
    const row = internals.buildUserRow(
      'u1',
      undefined,
      inclusiveDays(query.from, query.to),
      query,
      undefined,
      undefined,
      undefined,
      null,
      [
        {
          id: 'a1',
          user_id: 'u1',
          planned_hours: 70,
          allocation_mode: 'total_hours',
          weekly_hours: null,
          capacity_percent: null,
          start_date: '2026-08-10',
          end_date: '2026-08-16',
          plans: null,
        },
      ],
      [],
    );

    expect(
      row.buckets.map((b) => ({
        bucket_start: b.bucket_start,
        planned_hours: b.planned_hours,
      })),
    ).toEqual([
      { bucket_start: '2026-08-14', planned_hours: 10 },
      { bucket_start: '2026-08-15', planned_hours: 10 },
      { bucket_start: '2026-08-16', planned_hours: 10 },
      { bucket_start: '2026-08-17', planned_hours: 0 },
      { bucket_start: '2026-08-18', planned_hours: 0 },
    ]);
  });

  it('lets an effective capacity period override the flat capacity default', () => {
    const query: ScheduleQuery = {
      from: '2026-08-12',
      to: '2026-08-12',
      granularity: 'day',
    };
    const row = internals.buildUserRow(
      'u1',
      undefined,
      inclusiveDays(query.from, query.to),
      query,
      undefined,
      [
        {
          user_id: 'u1',
          effective_from: '2026-08-01',
          effective_to: '2026-08-31',
          weekly_capacity_hours: 20,
          is_active: true,
        },
      ],
      { user_id: 'u1', weekly_capacity_hours: 40, is_active: true },
      null,
      [],
      [],
    );

    expect(row.buckets).toEqual([
      {
        bucket_start: '2026-08-12',
        capacity_hours: 2.857143,
        planned_hours: 0,
        over_allocated: false,
      },
    ]);
  });

  it('falls through to the active capacity default when the effective capacity period is inactive', () => {
    // Bug-fix case: an inactive period must not blank out capacity_hours -- it must fall
    // through and be treated the same as having no period at all.
    const query: ScheduleQuery = {
      from: '2026-08-12',
      to: '2026-08-12',
      granularity: 'day',
    };
    const row = internals.buildUserRow(
      'u1',
      undefined,
      inclusiveDays(query.from, query.to),
      query,
      undefined,
      [
        {
          user_id: 'u1',
          effective_from: '2026-08-01',
          effective_to: '2026-08-31',
          weekly_capacity_hours: 20,
          is_active: false,
        },
      ],
      { user_id: 'u1', weekly_capacity_hours: 40, is_active: true },
      null,
      [],
      [],
    );

    expect(row.buckets).toEqual([
      {
        bucket_start: '2026-08-12',
        capacity_hours: 5.714286,
        planned_hours: 0,
        over_allocated: false,
      },
    ]);
  });

  it('reports capacity_hours as null, never 0, when no capacity source exists -- and never flags over-allocation', () => {
    const query: ScheduleQuery = {
      from: '2026-08-12',
      to: '2026-08-12',
      granularity: 'day',
    };
    const row = internals.buildUserRow(
      'u1',
      undefined,
      inclusiveDays(query.from, query.to),
      query,
      undefined,
      undefined,
      undefined,
      null,
      [
        {
          id: 'a1',
          user_id: 'u1',
          planned_hours: 10,
          allocation_mode: 'total_hours',
          weekly_hours: null,
          capacity_percent: null,
          start_date: '2026-08-12',
          end_date: '2026-08-12',
          plans: null,
        },
      ],
      [],
    );

    expect(row.buckets).toEqual([
      {
        bucket_start: '2026-08-12',
        capacity_hours: null,
        planned_hours: 10,
        over_allocated: false,
      },
    ]);
  });

  it('keeps capacity_hours null under a unit filter with allocation_percent scaling when no capacity source exists', () => {
    // The allocation_percent scaling block is itself guarded by `dayCapacity !== null`, so a
    // missing capacity source short-circuits it -- null is never multiplied into 0.
    const query: ScheduleQuery = {
      from: '2026-08-12',
      to: '2026-08-12',
      granularity: 'day',
      unitIds: ['unit1'],
    };
    const row = internals.buildUserRow(
      'u1',
      undefined,
      inclusiveDays(query.from, query.to),
      query,
      [
        {
          user_id: 'u1',
          unit_id: 'unit1',
          effective_from: '2026-08-01',
          effective_to: null,
          allocation_percent: 50,
        },
      ],
      undefined,
      undefined,
      null,
      [],
      [],
    );

    expect(row.buckets).toEqual([
      {
        bucket_start: '2026-08-12',
        capacity_hours: null,
        planned_hours: 0,
        over_allocated: false,
      },
    ]);
  });

  it('treats a null allocation_percent as 100% when scoping to a unit filter', () => {
    const query: ScheduleQuery = {
      from: '2026-08-12',
      to: '2026-08-12',
      granularity: 'day',
      unitIds: ['unit1'],
    };
    const row = internals.buildUserRow(
      'u1',
      undefined,
      inclusiveDays(query.from, query.to),
      query,
      [
        {
          user_id: 'u1',
          unit_id: 'unit1',
          effective_from: '2026-08-01',
          effective_to: null,
          allocation_percent: null,
        },
      ],
      undefined,
      { user_id: 'u1', weekly_capacity_hours: 35, is_active: true },
      null,
      [],
      [],
    );

    expect(row.buckets).toEqual([
      {
        bucket_start: '2026-08-12',
        capacity_hours: 5,
        planned_hours: 0,
        over_allocated: false,
      },
    ]);
  });

  it('sums allocation_percent across multiple filtered-unit memberships without capping at 100%', () => {
    const query: ScheduleQuery = {
      from: '2026-08-12',
      to: '2026-08-12',
      granularity: 'day',
      unitIds: ['unit1', 'unit2'],
    };
    const row = internals.buildUserRow(
      'u1',
      undefined,
      inclusiveDays(query.from, query.to),
      query,
      [
        {
          user_id: 'u1',
          unit_id: 'unit1',
          effective_from: '2026-08-01',
          effective_to: null,
          allocation_percent: 70,
        },
        {
          user_id: 'u1',
          unit_id: 'unit2',
          effective_from: '2026-08-01',
          effective_to: null,
          allocation_percent: 70,
        },
      ],
      undefined,
      { user_id: 'u1', weekly_capacity_hours: 35, is_active: true },
      null,
      [],
      [],
    );

    expect(row.buckets).toEqual([
      {
        bucket_start: '2026-08-12',
        capacity_hours: 7,
        planned_hours: 0,
        over_allocated: false,
      },
    ]);
  });

  it("zeroes a user's filtered capacity contribution for days after their membership ends", () => {
    const query: ScheduleQuery = {
      from: '2026-08-10',
      to: '2026-08-12',
      granularity: 'day',
      unitIds: ['unit1'],
    };
    const row = internals.buildUserRow(
      'u1',
      undefined,
      inclusiveDays(query.from, query.to),
      query,
      [
        {
          user_id: 'u1',
          unit_id: 'unit1',
          effective_from: '2026-08-01',
          effective_to: '2026-08-10',
          allocation_percent: 100,
        },
      ],
      undefined,
      { user_id: 'u1', weekly_capacity_hours: 35, is_active: true },
      null,
      [],
      [],
    );

    expect(row.buckets).toEqual([
      {
        bucket_start: '2026-08-10',
        capacity_hours: 5,
        planned_hours: 0,
        over_allocated: false,
      },
      {
        bucket_start: '2026-08-11',
        capacity_hours: 0,
        planned_hours: 0,
        over_allocated: false,
      },
      {
        bucket_start: '2026-08-12',
        capacity_hours: 0,
        planned_hours: 0,
        over_allocated: false,
      },
    ]);
  });

  it("merges plan and task allocations into assignments using each allocation's raw planned_hours", () => {
    const query: ScheduleQuery = {
      from: '2026-08-12',
      to: '2026-08-12',
      granularity: 'day',
    };
    const row = internals.buildUserRow(
      'u1',
      undefined,
      inclusiveDays(query.from, query.to),
      query,
      undefined,
      undefined,
      undefined,
      null,
      [
        {
          id: 'plan-a1',
          user_id: 'u1',
          planned_hours: 30,
          allocation_mode: 'total_hours',
          weekly_hours: null,
          capacity_percent: null,
          start_date: '2026-08-12',
          end_date: '2026-08-12',
          plans: { name: 'Plan A' },
        },
      ],
      [
        {
          id: 'task-t1',
          user_id: 'u1',
          planned_hours: 15,
          start_date: '2026-08-12',
          end_date: '2026-08-12',
          tasks: { summary: 'Task T1' },
        },
      ],
    );

    expect(row.assignments).toEqual([
      {
        source: 'plan',
        id: 'plan-a1',
        name: 'Plan A',
        start: '2026-08-12',
        end: '2026-08-12',
        hours: 30,
      },
      {
        source: 'task',
        id: 'task-t1',
        name: 'Task T1',
        start: '2026-08-12',
        end: '2026-08-12',
        hours: 15,
      },
    ]);
  });

  it('excludes undated allocations from both buckets and assignments', () => {
    const query: ScheduleQuery = {
      from: '2026-08-12',
      to: '2026-08-12',
      granularity: 'day',
    };
    const row = internals.buildUserRow(
      'u1',
      undefined,
      inclusiveDays(query.from, query.to),
      query,
      undefined,
      undefined,
      undefined,
      null,
      [
        {
          id: 'a1',
          user_id: 'u1',
          planned_hours: 40,
          allocation_mode: 'total_hours',
          weekly_hours: null,
          capacity_percent: null,
          start_date: null,
          end_date: null,
          plans: null,
        },
      ],
      [
        {
          id: 't1',
          user_id: 'u1',
          planned_hours: 40,
          start_date: null,
          end_date: null,
          tasks: null,
        },
      ],
    );

    expect(row.buckets).toEqual([
      {
        bucket_start: '2026-08-12',
        capacity_hours: null,
        planned_hours: 0,
        over_allocated: false,
      },
    ]);
    expect(row.assignments).toEqual([]);
  });

  it('rejects a day-granularity range over 92 days', async () => {
    const from = '2026-01-01';
    const to = new Date(Date.UTC(2026, 0, 1) + 92 * DAY_MS)
      .toISOString()
      .slice(0, 10);

    await expect(
      service.getSchedule('org1', { from, to, granularity: 'day' }, 'user-1'),
    ).rejects.toThrow(BadRequestException);
  });

  it('accepts a day-granularity range at exactly 92 days', async () => {
    const from = '2026-01-01';
    const to = new Date(Date.UTC(2026, 0, 1) + 91 * DAY_MS)
      .toISOString()
      .slice(0, 10);

    let dayGranularityError: unknown;
    try {
      await service.getSchedule(
        'org1',
        { from, to, granularity: 'day' },
        'user-1',
      );
    } catch (err) {
      if (
        err instanceof BadRequestException &&
        /day granularity/i.test(err.message)
      ) {
        dayGranularityError = err;
      }
    }
    expect(dayGranularityError).toBeUndefined();
  });

  it('rejects a range over 731 days even at week granularity', async () => {
    const from = '2026-01-01';
    const to = new Date(Date.UTC(2026, 0, 1) + 731 * DAY_MS)
      .toISOString()
      .slice(0, 10);

    await expect(
      service.getSchedule('org1', { from, to, granularity: 'week' }, 'user-1'),
    ).rejects.toThrow(BadRequestException);
  });

  it('truncates resolved user ids to 500 and reports truncated at 501 but not at exactly 500', async () => {
    const makeIds = (count: number) =>
      Array.from(
        { length: count },
        (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
      );

    const at500 = await internals.resolveUserIds('org1', {
      from: '2026-08-01',
      to: '2026-08-01',
      granularity: 'week',
      userIds: makeIds(500),
    });
    expect(at500.truncated).toBe(false);
    expect(at500.userIds.length).toBe(500);

    const at501 = await internals.resolveUserIds('org1', {
      from: '2026-08-01',
      to: '2026-08-01',
      granularity: 'week',
      userIds: makeIds(501),
    });
    expect(at501.truncated).toBe(true);
    expect(at501.userIds.length).toBe(500);
  });

  it('prorates an hours_per_week task allocation per day instead of spreading planned_hours', () => {
    const row = internals.buildUserRow(
      'u1',
      undefined,
      inclusiveDays('2026-08-03', '2026-08-09'),
      { from: '2026-08-03', to: '2026-08-09', granularity: 'week' },
      [],
      [],
      { user_id: 'u1', weekly_capacity_hours: 40, is_active: true },
      null,
      [],
      [
        {
          id: 't1',
          user_id: 'u1',
          planned_hours: 0,
          allocation_mode: 'hours_per_week',
          weekly_hours: 7,
          capacity_percent: null,
          start_date: '2026-08-03',
          end_date: '2026-08-09',
          tasks: null,
        },
      ],
    );

    expect(row.buckets[0].planned_hours).toBe(7);
    // Bar label is the effective total, not the stored planned_hours (0 for dated modes).
    expect(row.assignments[0].hours).toBe(7);
  });

  it('breaks bucket hours down per requested task with the same day math, only when asked', () => {
    const allocations: TestTaskAllocationRow[] = [
      {
        id: 'a1',
        task_id: 't1',
        user_id: 'u1',
        planned_hours: 0,
        allocation_mode: 'hours_per_week',
        weekly_hours: 7,
        capacity_percent: null,
        start_date: '2026-01-01',
        end_date: '2026-02-28',
        tasks: null,
      },
      {
        id: 'a2',
        task_id: 't2',
        user_id: 'u1',
        planned_hours: 31,
        start_date: '2026-01-01',
        end_date: '2026-01-31',
        tasks: null,
      },
      {
        id: 'a3',
        task_id: 't3',
        user_id: 'u1',
        planned_hours: 28,
        start_date: '2026-02-01',
        end_date: '2026-02-28',
        tasks: null,
      },
    ];
    const query: ScheduleQuery = {
      from: '2026-01-01',
      to: '2026-02-28',
      granularity: 'month',
      taskBreakdownIds: new Set(['t1', 't2']),
    };
    const build = (q: ScheduleQuery) =>
      internals.buildUserRow(
        'u1',
        undefined,
        inclusiveDays(q.from, q.to),
        q,
        undefined,
        undefined,
        undefined,
        null,
        [],
        allocations,
      );

    const row = build(query);
    expect(row.task_hours).toEqual({
      t1: { '2026-01-01': 31, '2026-02-01': 28 },
      t2: { '2026-01-01': 31 },
    });
    expect(row.buckets.map((b) => b.planned_hours)).toEqual([62, 56]);

    const plain = build({ ...query, taskBreakdownIds: undefined });
    expect(plain).not.toHaveProperty('task_hours');
    expect(plain.buckets).toEqual(row.buckets);
  });

  it('keeps trusted user ids without the org-member lookup', async () => {
    const trusted = new ScheduleService(
      createFakeSupabaseAdmin() as never,
      {} as never,
      { isEnabled: () => Promise.resolve(true) } as never,
      {} as never,
    );
    const loadOrgMemberIds = jest.fn().mockResolvedValue([]);
    Object.assign(trusted, { loadOrgMemberIds });
    const trustedInternals = trusted as unknown as ScheduleServiceInternals;
    const query: ScheduleQuery = {
      from: '2026-08-01',
      to: '2026-08-01',
      granularity: 'month',
      userIds: ['left-org', 'active'],
    };

    await expect(
      trustedInternals.resolveUserIds('org1', {
        ...query,
        trustedUserIds: true,
      }),
    ).resolves.toEqual({ userIds: ['left-org', 'active'], truncated: false });
    expect(loadOrgMemberIds).not.toHaveBeenCalled();

    await expect(
      trustedInternals.resolveUserIds('org1', query),
    ).resolves.toEqual({ userIds: [], truncated: false });
    expect(loadOrgMemberIds).toHaveBeenCalledTimes(1);
  });

  it('drops assignments from spaces outside the RP scope and keeps null-space ones', async () => {
    const scoped = new ScheduleService(
      createFakeSupabaseAdmin(),
      { hasAnySchemeConfigured: () => Promise.resolve(false) } as any,
      { isEnabled: () => Promise.resolve(true) } as any,
      {
        resolveSpaceScope: () =>
          Promise.resolve({
            allowedSpaceIds: new Set(['space-on']),
            allowsNullSpace: true,
          }),
      } as any,
    );
    const plan = (id: string, space_id: string) => ({
      id,
      user_id: 'u1',
      planned_hours: 5,
      allocation_mode: 'total_hours',
      weekly_hours: null,
      capacity_percent: null,
      start_date: '2026-08-03',
      end_date: '2026-08-07',
      role: null,
      plans: { name: id, start_date: null, end_date: null, space_id },
    });
    const task = (id: string, space_id: string | null) => ({
      id,
      user_id: 'u1',
      planned_hours: 5,
      allocation_mode: 'total_hours',
      weekly_hours: null,
      capacity_percent: null,
      start_date: '2026-08-03',
      end_date: '2026-08-07',
      role: null,
      tasks: {
        summary: id,
        key: id,
        status_id: null,
        space_id,
        task_statuses: null,
      },
    });
    Object.assign(scoped as any, {
      resolveUserIds: () =>
        Promise.resolve({ userIds: ['u1'], truncated: false }),
      loadUsers: () => Promise.resolve([]),
      loadMemberships: () => Promise.resolve([]),
      loadCapacityDefaults: () => Promise.resolve([]),
      loadCapacityPeriods: () => Promise.resolve([]),
      loadPlanAllocations: () =>
        Promise.resolve([plan('p-on', 'space-on'), plan('p-off', 'space-off')]),
      loadTaskAllocations: () =>
        Promise.resolve([task('t-null', null), task('t-off', 'space-off')]),
    });

    const result = await scoped.getSchedule(
      'org1',
      { from: '2026-08-03', to: '2026-08-07', granularity: 'week' },
      'user-1',
    );

    expect(result.users[0].assignments.map((a) => a.id).sort()).toEqual([
      'p-on',
      't-null',
    ]);
  });

  describe('spaceId fixed-space view', () => {
    const range = {
      from: '2026-08-03',
      to: '2026-08-07',
      granularity: 'week' as const,
    };
    const allocation = (id: string, user_id: string) => ({
      id,
      user_id,
      planned_hours: 5,
      allocation_mode: 'total_hours',
      weekly_hours: null,
      capacity_percent: null,
      start_date: '2026-08-03',
      end_date: '2026-08-07',
      role: null,
    });
    const plan = (id: string, user_id: string, space_id: string) => ({
      ...allocation(id, user_id),
      plans: { name: id, start_date: null, end_date: null, space_id },
    });
    const task = (id: string, user_id: string, space_id: string | null) => ({
      ...allocation(id, user_id),
      tasks: {
        summary: id,
        key: id,
        status_id: null,
        space_id,
        task_statuses: null,
      },
    });

    // Both spaces are visible, so only the exact spaceId match can drop space-other.
    function buildScoped() {
      const resolveSpaceScope = jest.fn(() =>
        Promise.resolve({
          allowedSpaceIds: new Set(['space-on', 'space-other']),
          allowsNullSpace: true,
        }),
      );
      const scoped = new ScheduleService(
        createFakeSupabaseAdmin(),
        { hasAnySchemeConfigured: () => Promise.resolve(false) } as any,
        { isEnabled: () => Promise.resolve(true) } as any,
        { resolveSpaceScope } as any,
      );
      return { scoped, resolveSpaceScope };
    }

    it('403s a space outside the caller scope before resolving any user', async () => {
      const { scoped } = buildScoped();
      const resolveUserIds = jest.fn();
      Object.assign(scoped as any, { resolveUserIds });

      await expect(
        scoped.getSchedule('org1', { ...range, spaceId: 'space-x' }, 'user-1'),
      ).rejects.toThrow(ForbiddenException);
      expect(resolveUserIds).not.toHaveBeenCalled();
    });

    it('defaults to the people assigned in the space and intersects explicit user_ids with them', async () => {
      const { scoped } = buildScoped();
      const loadAllCapacityUserIds = jest.fn();
      const loadSpaceAssignedUserIds = jest.fn(() =>
        Promise.resolve(['u1', 'u2']),
      );
      Object.assign(scoped as any, {
        loadAllCapacityUserIds,
        loadSpaceAssignedUserIds,
      });
      const scopedInternals = scoped as unknown as ScheduleServiceInternals;
      const query: ScheduleQuery = { ...range, spaceId: 'space-on' };

      await expect(
        scopedInternals.resolveUserIds('org1', query),
      ).resolves.toEqual({ userIds: ['u1', 'u2'], truncated: false });
      expect(loadSpaceAssignedUserIds).toHaveBeenCalledWith(
        'org1',
        'space-on',
        '2026-08-03',
        '2026-08-07',
      );
      expect(loadAllCapacityUserIds).not.toHaveBeenCalled();

      // The fake client answers every requested id as an org member, so only the space narrows.
      await expect(
        scopedInternals.resolveUserIds('org1', {
          ...query,
          userIds: ['u1', 'u3'],
        }),
      ).resolves.toEqual({ userIds: ['u1'], truncated: false });
    });

    it('keeps the capacity roster when spaceId is absent', async () => {
      const { scoped } = buildScoped();
      const loadSpaceAssignedUserIds = jest.fn();
      Object.assign(scoped as any, {
        loadAllCapacityUserIds: () => Promise.resolve(['u1', 'u9']),
        loadSpaceAssignedUserIds,
      });

      await expect(
        (scoped as unknown as ScheduleServiceInternals).resolveUserIds(
          'org1',
          range,
        ),
      ).resolves.toEqual({ userIds: ['u1', 'u9'], truncated: false });
      expect(loadSpaceAssignedUserIds).not.toHaveBeenCalled();
    });

    it('keeps only assignments of that space, drops users left empty and resolves the scope once', async () => {
      const { scoped, resolveSpaceScope } = buildScoped();
      Object.assign(scoped as any, {
        resolveUserIds: () =>
          Promise.resolve({ userIds: ['u1', 'u2', 'u3'], truncated: false }),
        loadUsers: () => Promise.resolve([]),
        loadMemberships: () => Promise.resolve([]),
        loadCapacityDefaults: () => Promise.resolve([]),
        loadCapacityPeriods: () => Promise.resolve([]),
        loadPlanAllocations: () =>
          Promise.resolve([
            plan('p-on', 'u1', 'space-on'),
            plan('p-other', 'u1', 'space-other'),
          ]),
        loadTaskAllocations: () =>
          Promise.resolve([
            task('t-null', 'u1', null),
            task('t-other', 'u2', 'space-other'),
          ]),
      });

      const inSpace = await scoped.getSchedule(
        'org1',
        { ...range, spaceId: 'space-on' },
        'user-1',
      );

      expect(resolveSpaceScope).toHaveBeenCalledTimes(1);
      expect(inSpace.users.map((u) => u.user_id)).toEqual(['u1']);
      expect(inSpace.users[0].assignments.map((a) => a.id)).toEqual(['p-on']);

      // Same data without spaceId: multi-space rules, and u3 keeps its empty row.
      const unscoped = await scoped.getSchedule('org1', range, 'user-1');

      expect(unscoped.users.map((u) => u.user_id)).toEqual(['u1', 'u2', 'u3']);
      expect(unscoped.users[0].assignments.map((a) => a.id).sort()).toEqual([
        'p-on',
        'p-other',
        't-null',
      ]);
      expect(unscoped.users[2].assignments).toEqual([]);
    });

    it('pages the space roster per table with tenant and space filters until a short page', async () => {
      const calls: Array<{ table: string; ops: unknown[][] }> = [];
      const pageSizes: Record<string, number[]> = {
        task_resource_allocations: [1000, 2],
        plan_resource_allocations: [1],
      };
      const client = {
        from: (table: string) => {
          const ops: unknown[][] = [];
          calls.push({ table, ops });
          const chain: any = {};
          for (const op of [
            'select',
            'eq',
            'not',
            'lte',
            'gte',
            'or',
            'order',
          ]) {
            chain[op] = (...args: unknown[]) => {
              ops.push([op, ...args]);
              return chain;
            };
          }
          chain.range = (start: number, end: number) => {
            ops.push(['range', start, end]);
            const page = start / 1000;
            const size = pageSizes[table][page] ?? 0;
            return Promise.resolve({
              data: Array.from({ length: size }, (_, i) => ({
                user_id: `${table[0]}${page}-${i % 3}`,
              })),
              error: null,
            });
          };
          return chain;
        },
      };
      const scoped = new ScheduleService(
        { getClient: () => client } as any,
        {} as any,
        {} as any,
        {} as any,
      ) as unknown as {
        loadSpaceAssignedUserIds(
          organizationId: string,
          spaceId: string,
          from: string,
          to: string,
        ): Promise<string[]>;
      };

      const userIds = await scoped.loadSpaceAssignedUserIds(
        'org1',
        'space-on',
        '2026-08-03',
        '2026-08-07',
      );

      expect(userIds).toEqual(['p0-0', 't0-0', 't0-1', 't0-2', 't1-0', 't1-1']);
      expect(calls.map((c) => c.table)).toEqual([
        'task_resource_allocations',
        'task_resource_allocations',
        'plan_resource_allocations',
      ]);
      for (const { table, ops } of calls) {
        expect(ops).toContainEqual(['eq', 'organization_id', 'org1']);
        expect(ops).toContainEqual([
          'eq',
          table === 'plan_resource_allocations'
            ? 'plans.space_id'
            : 'tasks.space_id',
          'space-on',
        ]);
      }
    });
  });
});
