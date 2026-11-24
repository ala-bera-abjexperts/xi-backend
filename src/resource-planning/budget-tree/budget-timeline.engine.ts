/**
 * @fileoverview Month timeline of the Ressource Tree (RP 2.0, time component).
 * Pure: data in, figures out. Per task a bar from planned start to planned end,
 * cut at its own done date and at a done ancestor's, and per month inside the
 * requested range the planned budget per currency and the planned hours, own
 * plus descendants. Weekly allocation modes reuse the report engine's
 * perDayFromWeekly, so a month here sums the same hours as the Schedule; fixed
 * totals (budget entries, total_hours allocations) are spread pro rata by
 * working day of the calendar (every day weighs 1 without one, like Reports).
 * @module src/resource-planning/budget-tree/budget-timeline.engine
 */

import { roundCents } from '../budget-split/budget-split.analysis';
import type { WorkingCalendarContext } from '../calendar/working-calendar.engine';
import {
  dateRange,
  normalizeCurrency,
  perDayFromWeekly,
} from '../reporting/resource-planning-report.engine';
import type { AllocationMode } from '../resource-planning.validation';
import type {
  BudgetTimelineFigures,
  BudgetTimelineWarning,
} from './budget-tree.types';

const DAY_MS = 86_400_000;
export const MAX_TIMELINE_MONTHS = 24;
/** A fixed total over a longer window (bad data) skips the calendar and the day walk. */
export const MAX_SPREAD_DAYS = 3660;

export interface TimelineWindow {
  start: string;
  end: string;
}

export interface TimelineTask {
  id: string;
  parent_task_id: string | null;
  /** Local dates (YYYY-MM-DD). */
  planned_start: string | null;
  planned_end: string | null;
  is_done: boolean;
  done_date: string | null;
}

export interface TimelineEntry {
  task_id: string;
  currency: string | null;
  amount: number;
  start_date: string | null;
  end_date: string | null;
}

export interface TimelineAllocation {
  task_id: string;
  user_id: string;
  allocation_mode: AllocationMode;
  planned_hours: number;
  weekly_hours: number | null;
  capacity_percent: number | null;
  start_date: string | null;
  end_date: string | null;
}

export interface TimelineInput {
  /** The visible subtree; a task whose parent is not listed is a root. */
  tasks: TimelineTask[];
  entries: TimelineEntry[];
  allocations: TimelineAllocation[];
  /** YYYY-MM, inclusive. */
  from: string;
  to: string;
  /** Org default calendar for budget entries; null = every day weighs 1. */
  budgetCalendar: WorkingCalendarContext | null;
  calendarFor: (userId: string) => WorkingCalendarContext | null;
  weeklyCapacity: (userId: string, day: string) => number;
}

export interface TimelineTaskResult {
  bar: TimelineWindow | null;
  warnings: BudgetTimelineWarning[];
  has_plan: boolean;
  /** Own + descendants, only months inside the range and up to the cutoff. */
  months: Map<string, BudgetTimelineFigures>;
  /** Own figures with no usable date at all; null when there are none. */
  unscheduled: BudgetTimelineFigures | null;
}

export function addMonths(month: string, count: number): string {
  const [year, monthNumber] = month.split('-').map(Number);
  const index = year * 12 + monthNumber - 1 + count;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** Inclusive month list, e.g. 2026-12..2027-01 -> ['2026-12', '2027-01']. */
export function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  for (let month = from; month <= to; month = addMonths(month, 1)) {
    months.push(month);
  }
  return months;
}

export function monthEnd(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
}

/**
 * Reads a timestamptz as a local date in `timeZone`, so a task ending
 * 31 Jan 23:30 in Vienna (22:30Z) stays in January. Invalid values give null.
 */
export function createLocalDateReader(
  timeZone: string,
): (value: string | null | undefined) => string | null {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return (value) => {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const parts = format.formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  };
}

function dayNumber(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`) / DAY_MS;
}

/** Inclusive day count of a window. */
export function windowDays(window: TimelineWindow): number {
  return dayNumber(window.end) - dayNumber(window.start) + 1;
}

function monthOf(day: string): string {
  return day.slice(0, 7);
}

function earlier(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function overlapDays(window: TimelineWindow, month: string): number {
  const start = Math.max(dayNumber(window.start), dayNumber(`${month}-01`));
  const end = Math.min(dayNumber(window.end), dayNumber(monthEnd(month)));
  return Math.max(0, end - start + 1);
}

/**
 * Spreads a fixed total over a window by day weight (a working day of the
 * calendar weighs 1, other days 0; no calendar or no working day at all: every
 * day weighs 1) and rounds per month. The rounding remainder goes to the last
 * weighted month, so the months add up to the total exactly.
 */
export function spreadTotal(
  total: number,
  window: TimelineWindow,
  calendar: WorkingCalendarContext | null,
  range: TimelineWindow,
): Map<string, number> {
  const result = new Map<string, number>();
  if (!total) return result;
  const length = windowDays(window);
  if (length > MAX_SPREAD_DAYS) {
    // ponytail: bad-data windows (> 10 years) weigh calendar days and only the
    // range's months are computed (no remainder fix); walk them by day if such
    // windows ever become real plans.
    for (const month of monthsBetween(
      monthOf(range.start),
      monthOf(range.end),
    )) {
      const overlap = overlapDays(window, month);
      if (overlap > 0)
        result.set(month, roundCents((total * overlap) / length));
    }
    return result;
  }

  const weightByMonth = new Map<string, number>();
  let weightSum = 0;
  for (const day of dateRange(window.start, window.end)) {
    if (calendar && (calendar.dayHours.get(day) ?? 0) <= 0) continue;
    weightByMonth.set(monthOf(day), (weightByMonth.get(monthOf(day)) ?? 0) + 1);
    weightSum += 1;
  }
  if (weightSum === 0) return spreadTotal(total, window, null, range);

  let roundedSum = 0;
  let lastMonth = '';
  for (const [month, weight] of weightByMonth) {
    const value = roundCents((total * weight) / weightSum);
    result.set(month, value);
    roundedSum += value;
    lastMonth = month;
  }
  result.set(
    lastMonth,
    roundCents((result.get(lastMonth) ?? 0) + total - roundedSum),
  );
  return result;
}

/** Weekly modes have no fixed total, so only days in both the window and the range are walked. */
function spreadPerDay(
  window: TimelineWindow,
  range: TimelineWindow,
  perDay: (day: string) => number,
): Map<string, number> {
  const result = new Map<string, number>();
  const start = window.start > range.start ? window.start : range.start;
  const end = window.end < range.end ? window.end : range.end;
  if (start > end) return result;
  for (const day of dateRange(start, end)) {
    const hours = perDay(day);
    if (hours)
      result.set(monthOf(day), (result.get(monthOf(day)) ?? 0) + hours);
  }
  for (const [month, hours] of result) result.set(month, roundCents(hours));
  return result;
}

function emptyFigures(): BudgetTimelineFigures {
  return { budget: {}, hours: 0 };
}

function addFigures(
  target: BudgetTimelineFigures,
  source: BudgetTimelineFigures,
): void {
  for (const [currency, amount] of Object.entries(source.budget)) {
    target.budget[currency] = roundCents(
      (target.budget[currency] ?? 0) + amount,
    );
  }
  target.hours = roundCents(target.hours + source.hours);
}

export function buildBudgetTimeline(input: TimelineInput): {
  months: string[];
  byTask: Map<string, TimelineTaskResult>;
} {
  const months = monthsBetween(input.from, input.to);
  const range: TimelineWindow = {
    start: `${input.from}-01`,
    end: monthEnd(input.to),
  };
  const ids = new Set(input.tasks.map((task) => task.id));
  const childrenOf = new Map<string, TimelineTask[]>();
  const roots: TimelineTask[] = [];
  for (const task of input.tasks) {
    if (task.parent_task_id && ids.has(task.parent_task_id)) {
      const list = childrenOf.get(task.parent_task_id) ?? [];
      list.push(task);
      childrenOf.set(task.parent_task_id, list);
    } else {
      roots.push(task);
    }
  }
  const entriesByTask = groupBy(input.entries, (entry) => entry.task_id);
  const allocationsByTask = groupBy(input.allocations, (row) => row.task_id);
  const byTask = new Map<string, TimelineTaskResult>();

  const visit = (task: TimelineTask, ancestorCutoff: string | null): void => {
    if (byTask.has(task.id)) return;
    const warnings: BudgetTimelineWarning[] = [];
    const start = task.planned_start ?? task.planned_end;
    let end = task.planned_end ?? task.planned_start;
    if (start && end && start > end) {
      warnings.push('start_after_end');
      end = start;
    }
    const window = start && end ? { start, end } : null;
    const ownDone = task.is_done ? task.done_date : null;
    if (task.is_done && !task.done_date) warnings.push('done_date_unknown');
    const cutoff = earlier(ancestorCutoff, ownDone);

    let bar: TimelineWindow | null = null;
    if (window) {
      const barEnd = earlier(ownDone ?? window.end, ancestorCutoff) as string;
      bar = {
        start: window.start > barEnd ? barEnd : window.start,
        end: barEnd,
      };
    }

    const figures = new Map<string, BudgetTimelineFigures>();
    const cutoffMonth = cutoff ? monthOf(cutoff) : null;
    const monthFigures = (month: string): BudgetTimelineFigures | null => {
      if (month < input.from || month > input.to) return null;
      if (cutoffMonth && month > cutoffMonth) return null;
      const value = figures.get(month) ?? emptyFigures();
      figures.set(month, value);
      return value;
    };
    let unscheduled: BudgetTimelineFigures | null = null;

    const ownEntries = entriesByTask.get(task.id) ?? [];
    for (const entry of ownEntries) {
      const amount = Number(entry.amount) || 0;
      if (!amount) continue;
      const currency = normalizeCurrency(entry.currency);
      const entryWindow =
        entry.start_date && entry.end_date
          ? { start: entry.start_date, end: entry.end_date }
          : window;
      if (!entryWindow) {
        unscheduled ??= emptyFigures();
        addFigures(unscheduled, { budget: { [currency]: amount }, hours: 0 });
        continue;
      }
      for (const [month, value] of spreadTotal(
        amount,
        entryWindow,
        input.budgetCalendar,
        range,
      )) {
        const target = monthFigures(month);
        if (target)
          addFigures(target, { budget: { [currency]: value }, hours: 0 });
      }
    }

    const ownAllocations = allocationsByTask.get(task.id) ?? [];
    for (const allocation of ownAllocations) {
      const allocationWindow =
        allocation.start_date && allocation.end_date
          ? { start: allocation.start_date, end: allocation.end_date }
          : window;
      const calendar = input.calendarFor(allocation.user_id);
      let hoursByMonth: Map<string, number>;
      if (allocation.allocation_mode === 'total_hours') {
        const plannedHours = Number(allocation.planned_hours) || 0;
        if (!plannedHours) continue;
        if (!allocationWindow) {
          unscheduled ??= emptyFigures();
          addFigures(unscheduled, { budget: {}, hours: plannedHours });
          continue;
        }
        hoursByMonth = spreadTotal(
          plannedHours,
          allocationWindow,
          calendar,
          range,
        );
      } else {
        // Dated modes always carry both dates (DB mode_shape_check).
        if (!allocationWindow) continue;
        const perDay =
          allocation.allocation_mode === 'hours_per_week'
            ? (day: string) =>
                perDayFromWeekly(allocation.weekly_hours ?? 0, day, calendar)
            : (day: string) =>
                perDayFromWeekly(
                  input.weeklyCapacity(allocation.user_id, day),
                  day,
                  calendar,
                ) *
                ((allocation.capacity_percent ?? 0) / 100);
        hoursByMonth = spreadPerDay(allocationWindow, range, perDay);
      }
      for (const [month, hours] of hoursByMonth) {
        const target = monthFigures(month);
        if (target) addFigures(target, { budget: {}, hours });
      }
    }

    const result: TimelineTaskResult = {
      bar,
      warnings,
      has_plan: ownEntries.length > 0 || ownAllocations.length > 0,
      months: figures,
      unscheduled,
    };
    byTask.set(task.id, result);

    for (const child of childrenOf.get(task.id) ?? []) {
      visit(child, cutoff);
      for (const [month, childFigures] of byTask.get(child.id)!.months) {
        const target = figures.get(month) ?? emptyFigures();
        addFigures(target, childFigures);
        figures.set(month, target);
      }
    }
    for (const [month, value] of figures) {
      if (value.hours === 0 && Object.values(value.budget).every((v) => !v)) {
        figures.delete(month);
      }
    }
  };

  for (const root of roots) visit(root, null);
  return { months, byTask };
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const list = result.get(key(row)) ?? [];
    list.push(row);
    result.set(key(row), list);
  }
  return result;
}
