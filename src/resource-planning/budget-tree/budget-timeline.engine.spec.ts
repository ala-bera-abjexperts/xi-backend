import type { WorkingCalendarContext } from '../calendar/working-calendar.engine';
import {
  buildBudgetTimeline,
  createLocalDateReader,
  monthsBetween,
  spreadTotal,
  type TimelineAllocation,
  type TimelineEntry,
  type TimelineInput,
  type TimelineTask,
} from './budget-timeline.engine';

const task = (
  id: string,
  overrides: Partial<TimelineTask> = {},
): TimelineTask => ({
  id,
  parent_task_id: null,
  planned_start: null,
  planned_end: null,
  is_done: false,
  done_date: null,
  ...overrides,
});

const entry = (
  task_id: string,
  amount: number,
  start_date: string | null = null,
  end_date: string | null = null,
  currency = 'EUR',
): TimelineEntry => ({ task_id, amount, currency, start_date, end_date });

const allocation = (
  overrides: Partial<TimelineAllocation>,
): TimelineAllocation => ({
  task_id: 't1',
  user_id: 'u1',
  allocation_mode: 'total_hours',
  planned_hours: 0,
  weekly_hours: null,
  capacity_percent: null,
  start_date: null,
  end_date: null,
  ...overrides,
});

function run(overrides: Partial<TimelineInput>) {
  return buildBudgetTimeline({
    tasks: [],
    entries: [],
    allocations: [],
    from: '2027-01',
    to: '2027-12',
    budgetCalendar: null,
    calendarFor: () => null,
    weeklyCapacity: () => 0,
    ...overrides,
  });
}

/** Mon-Fri 8h calendar over [from, to]. */
function weekdayCalendar(from: string, to: string): WorkingCalendarContext {
  const dayHours = new Map<string, number>();
  for (
    let day = new Date(`${from}T00:00:00Z`);
    day <= new Date(`${to}T00:00:00Z`);
    day = new Date(day.getTime() + 86_400_000)
  ) {
    const weekday = day.getUTCDay();
    dayHours.set(
      day.toISOString().slice(0, 10),
      weekday === 0 || weekday === 6 ? 0 : 8,
    );
  }
  return { dayHours, workingDaysPerWeek: 5 };
}

const sum = (values: number[]) =>
  Math.round(values.reduce((total, value) => total + value, 0) * 100) / 100;

describe('budget timeline engine', () => {
  it('keeps December and January adjacent across the year boundary', () => {
    expect(monthsBetween('2026-11', '2027-02')).toEqual([
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
    ]);
  });

  it('reads month boundaries in the given time zone', () => {
    const vienna = createLocalDateReader('Europe/Vienna');
    const utc = createLocalDateReader('UTC');
    // 31 Jan 23:30 in Vienna is 22:30Z: January in both.
    expect(vienna('2027-01-31T22:30:00Z')).toBe('2027-01-31');
    // Vienna midnight 1 Oct (CEST) is 30 Sep 22:00Z.
    expect(vienna('2026-09-30T22:00:00+00:00')).toBe('2026-10-01');
    expect(utc('2026-09-30T22:00:00+00:00')).toBe('2026-09-30');
    expect(vienna(null)).toBeNull();
    expect(vienna('not a date')).toBeNull();
  });

  it('AC: an epic from Jan to Mar shows a bar across Jan..Mar', () => {
    const { byTask } = run({
      tasks: [
        task('epic', {
          planned_start: '2027-01-04',
          planned_end: '2027-03-30',
        }),
      ],
      entries: [entry('epic', 900)],
    });
    expect(byTask.get('epic')!.bar).toEqual({
      start: '2027-01-04',
      end: '2027-03-30',
    });
  });

  it('AC: 3,000 EUR from 1 Jan to 31 Mar adds up exactly, by working day', () => {
    const calendar = weekdayCalendar('2027-01-01', '2027-03-31');
    const { byTask } = run({
      tasks: [task('t1')],
      entries: [entry('t1', 3000, '2027-01-01', '2027-03-31')],
      budgetCalendar: calendar,
    });
    const months = byTask.get('t1')!.months;
    // 21 + 20 + 23 working days.
    expect(months.get('2027-01')!.budget.EUR).toBeCloseTo((3000 * 21) / 64, 1);
    expect(months.get('2027-02')!.budget.EUR).toBeCloseTo((3000 * 20) / 64, 1);
    expect(sum([...months.values()].map((month) => month.budget.EUR))).toBe(
      3000,
    );
  });

  it('spreads by calendar day when no working calendar exists, still summing exactly', () => {
    const result = spreadTotal(
      3000,
      { start: '2027-01-01', end: '2027-03-31' },
      null,
      { start: '2027-01-01', end: '2027-12-31' },
    );
    expect([...result.entries()]).toEqual([
      ['2027-01', 1033.33],
      ['2027-02', 933.33],
      ['2027-03', 1033.34],
    ]);
  });

  it('falls back to calendar days when the window has no working day', () => {
    const calendar = weekdayCalendar('2027-01-02', '2027-01-03');
    const result = spreadTotal(
      100,
      { start: '2027-01-02', end: '2027-01-03' },
      calendar,
      { start: '2027-01-01', end: '2027-12-31' },
    );
    expect(result.get('2027-01')).toBe(100);
  });

  it('AC: 60 hours over Jan..Mar add up to 60 h', () => {
    const { byTask } = run({
      tasks: [task('t1')],
      allocations: [
        allocation({
          planned_hours: 60,
          start_date: '2027-01-01',
          end_date: '2027-03-31',
        }),
      ],
      calendarFor: () => weekdayCalendar('2027-01-01', '2027-03-31'),
    });
    const months = byTask.get('t1')!.months;
    expect(sum([...months.values()].map((month) => month.hours))).toBe(60);
    expect(months.size).toBe(3);
  });

  it('converts hours_per_week and capacity_percent like the Schedule', () => {
    const calendar = weekdayCalendar('2027-01-01', '2027-12-31');
    const { byTask } = run({
      tasks: [task('t1')],
      allocations: [
        allocation({
          allocation_mode: 'hours_per_week',
          weekly_hours: 10,
          start_date: '2027-01-01',
          end_date: '2027-01-31',
        }),
        allocation({
          allocation_mode: 'capacity_percent',
          capacity_percent: 50,
          start_date: '2027-02-01',
          end_date: '2027-02-28',
        }),
      ],
      calendarFor: () => calendar,
      weeklyCapacity: () => 40,
    });
    const months = byTask.get('t1')!.months;
    // 21 working days x 10/5 h; 20 working days x 40/5 h x 50%.
    expect(months.get('2027-01')!.hours).toBe(42);
    expect(months.get('2027-02')!.hours).toBe(80);
  });

  it('AC: a task planned until March but done in February ends in February', () => {
    const { byTask } = run({
      tasks: [
        task('t1', {
          planned_start: '2027-01-01',
          planned_end: '2027-03-31',
          is_done: true,
          done_date: '2027-02-10',
        }),
      ],
      entries: [entry('t1', 900)],
    });
    const result = byTask.get('t1')!;
    expect(result.bar).toEqual({ start: '2027-01-01', end: '2027-02-10' });
    expect([...result.months.keys()]).toEqual(['2027-01', '2027-02']);
  });

  it('AC: a planned budget without any date goes to Unscheduled with its total', () => {
    const { byTask } = run({
      tasks: [task('t1')],
      entries: [entry('t1', 1200), entry('t1', 300, null, null, 'usd')],
      allocations: [allocation({ planned_hours: 16 })],
    });
    const result = byTask.get('t1')!;
    expect(result.bar).toBeNull();
    expect(result.months.size).toBe(0);
    expect(result.unscheduled).toEqual({
      budget: { EUR: 1200, USD: 300 },
      hours: 16,
    });
  });

  it('AC: the range cuts a Nov..Feb task to Jan and Feb, the bar keeps its real start', () => {
    const { months, byTask } = run({
      tasks: [
        task('t1', { planned_start: '2026-11-01', planned_end: '2027-02-28' }),
      ],
      entries: [entry('t1', 1200)],
    });
    const result = byTask.get('t1')!;
    expect(months[0]).toBe('2027-01');
    expect(result.bar!.start).toBe('2026-11-01');
    expect([...result.months.keys()]).toEqual(['2027-01', '2027-02']);
  });

  it('only a due date gives a one-month bar holding the whole budget', () => {
    const { byTask } = run({
      tasks: [task('t1', { planned_end: '2027-05-20' })],
      entries: [entry('t1', 500)],
    });
    const result = byTask.get('t1')!;
    expect(result.bar).toEqual({ start: '2027-05-20', end: '2027-05-20' });
    expect(result.months.get('2027-05')!.budget.EUR).toBe(500);
  });

  it('start after end uses the start month only and warns', () => {
    const { byTask } = run({
      tasks: [
        task('t1', { planned_start: '2027-04-10', planned_end: '2027-02-01' }),
      ],
      entries: [entry('t1', 100)],
    });
    const result = byTask.get('t1')!;
    expect(result.warnings).toEqual(['start_after_end']);
    expect(result.bar).toEqual({ start: '2027-04-10', end: '2027-04-10' });
    expect([...result.months.keys()]).toEqual(['2027-04']);
  });

  it('places an entry by its own dates before the task dates', () => {
    const { byTask } = run({
      tasks: [
        task('t1', { planned_start: '2027-01-01', planned_end: '2027-01-31' }),
      ],
      entries: [entry('t1', 100, '2027-06-01', '2027-06-30')],
    });
    expect([...byTask.get('t1')!.months.keys()]).toEqual(['2027-06']);
  });

  it('a done epic cuts its open children, and parents sum children per currency', () => {
    const { byTask } = run({
      tasks: [
        task('epic', {
          planned_start: '2027-01-01',
          planned_end: '2027-03-31',
          is_done: true,
          done_date: '2027-01-20',
        }),
        task('a', {
          parent_task_id: 'epic',
          planned_start: '2027-01-01',
          planned_end: '2027-03-31',
        }),
        task('b', {
          parent_task_id: 'epic',
          planned_start: '2027-01-01',
          planned_end: '2027-01-31',
        }),
      ],
      entries: [entry('a', 900), entry('b', 50, null, null, 'USD')],
    });
    expect(byTask.get('a')!.bar).toEqual({
      start: '2027-01-01',
      end: '2027-01-20',
    });
    expect([...byTask.get('a')!.months.keys()]).toEqual(['2027-01']);
    expect(byTask.get('epic')!.months.get('2027-01')!.budget).toEqual({
      EUR: byTask.get('a')!.months.get('2027-01')!.budget.EUR,
      USD: 50,
    });
    expect(byTask.get('epic')!.has_plan).toBe(false);
  });

  it('a child starting after the done epic collapses to the epic done date', () => {
    const { byTask } = run({
      tasks: [
        task('epic', { is_done: true, done_date: '2027-01-20' }),
        task('a', {
          parent_task_id: 'epic',
          planned_start: '2027-03-01',
          planned_end: '2027-04-30',
        }),
      ],
      entries: [entry('a', 900)],
    });
    expect(byTask.get('a')!.bar).toEqual({
      start: '2027-01-20',
      end: '2027-01-20',
    });
    expect(byTask.get('a')!.months.size).toBe(0);
  });

  it('a not-done task ignores a done date; a done task without one warns and is not cut', () => {
    const { byTask } = run({
      tasks: [
        task('open', {
          planned_start: '2027-01-01',
          planned_end: '2027-03-31',
          done_date: '2027-01-05',
        }),
        task('done', {
          planned_start: '2027-01-01',
          planned_end: '2027-03-31',
          is_done: true,
        }),
      ],
      entries: [entry('open', 90), entry('done', 90)],
    });
    expect(byTask.get('open')!.bar!.end).toBe('2027-03-31');
    expect(byTask.get('done')!.warnings).toEqual(['done_date_unknown']);
    expect(byTask.get('done')!.months.size).toBe(3);
  });

  it('keeps absurd windows fast and inside the range', () => {
    const started = Date.now();
    const { byTask } = run({
      tasks: [task('t1')],
      entries: [entry('t1', 1_000_000, '1000-01-01', '9999-12-31')],
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(byTask.get('t1')!.months.size).toBe(12);
  });
});
