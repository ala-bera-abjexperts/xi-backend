/**
 * @fileoverview Robert 1.23: dates for plan items without any, worked out from the dependencies,
 * each item's duration or estimate, and the plan's start. Never by the model. Working days are
 * Monday to Friday minus the organization's holidays (when it has a holiday calendar). Every date
 * carries where it came from, for the card.
 */
import type { AgentDependencyType } from '../agent-resolver.service';

export interface DateItem {
  taskId: string;
  key: string | null;
  summary: string;
  itemType: string;
  start: string | null;
  end: string | null;
  /** tasks.duration: calendar days, as the plan stores it. */
  duration: number | null;
  /** tasks.estimated_time: minutes. */
  estimatedMinutes: number | null;
  /** Robert created it (a task origin exists). Only these may be dated (D3). */
  robert: boolean;
}

/** A dependency: existing (card null) or a suggestion card of this request (its ordinal). */
export interface DateEdge {
  source: string;
  target: string;
  type: AgentDependencyType;
  card: number | null;
}

export type DateSource =
  | { kind: 'after_end' | 'with_start' | 'with_end' | 'before_start'; item: string; date: string; suggested?: boolean }
  | { kind: 'plan_start'; date: string }
  | { kind: 'estimate'; hours: number; days: number }
  | { kind: 'duration'; days: number }
  | { kind: 'milestone' };

export interface DateSuggestion {
  taskId: string;
  /**
   * robert: may be confirmed; person: someone's item (shown, never written, D3); has_dates: left
   * as it is (D1); needs_end / needs_start: one date known; nothing: nothing to base a date on.
   */
  state: 'robert' | 'person' | 'has_dates' | 'needs_end' | 'needs_start' | 'nothing';
  start: string | null;
  end: string | null;
  /** Calendar days between start and end, as the human plan routes count it (0 for a milestone). */
  duration: number | null;
  sources: DateSource[];
  /** The dependency cards of this request the dates rely on. */
  cards: number[];
}

const DAY = 86_400_000;
const toTime = (day: string) => Date.parse(`${day}T00:00:00Z`);
const toDay = (time: number) => new Date(time).toISOString().slice(0, 10);
const shift = (day: string, n: number) => toDay(toTime(day) + n * DAY);
const isWorking = (day: string, holidays: Set<string>) => {
  const weekday = new Date(toTime(day)).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays.has(day);
};

export function workingDayOnOrAfter(day: string, holidays: Set<string>): string {
  let d = day;
  for (let i = 0; i < 400 && !isWorking(d, holidays); i++) d = shift(d, 1);
  return d;
}

/** The n-th working day after day (n = 0: day itself, or the next working day). */
export function addWorkingDays(day: string, n: number, holidays: Set<string>): string {
  let d = workingDayOnOrAfter(day, holidays);
  for (let i = 0; i < n; i++) d = workingDayOnOrAfter(shift(d, 1), holidays);
  return d;
}

function subtractWorkingDays(day: string, n: number, holidays: Set<string>): string {
  let d = day;
  for (let i = 0; i < 400 && !isWorking(d, holidays); i++) d = shift(d, -1);
  for (let i = 0; i < n; i++) {
    d = shift(d, -1);
    for (let j = 0; j < 400 && !isWorking(d, holidays); j++) d = shift(d, -1);
  }
  return d;
}

const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);
const span = (start: string, end: string) => Math.max(0, Math.round((toTime(end) - toTime(start)) / DAY));

/**
 * One pass in dependency order over the plan. An item that has dates keeps them (and feeds what
 * follows); an item in a cycle, or after one that gets no dates, gets none.
 */
export function suggestDates(
  items: DateItem[],
  edges: DateEdge[],
  plan: { start: string | null; end: string | null },
  holidays: Set<string>,
): Map<string, DateSuggestion> {
  const byId = new Map(items.map((i) => [i.taskId, i]));
  const into = new Map<string, DateEdge[]>();
  const indegree = new Map(items.map((i) => [i.taskId, 0]));
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target) || e.source === e.target) continue;
    into.set(e.target, [...(into.get(e.target) ?? []), e]);
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  }
  const out = new Map<string, DateSuggestion>();
  const known = new Map<string, { start: string | null; end: string | null; suggested: boolean }>();

  const decide = (it: DateItem): DateSuggestion => {
    const base = { taskId: it.taskId, cards: [] as number[], sources: [] as DateSource[] };
    if (it.start || it.end) {
      known.set(it.taskId, { start: it.start, end: it.end, suggested: false });
      return { ...base, state: 'has_dates', start: it.start, end: it.end, duration: it.duration };
    }
    const milestone = it.itemType === 'milestone';
    // How long: its own duration (calendar days), else its estimate in working days of 8 h.
    const hours = it.estimatedMinutes ? it.estimatedMinutes / 60 : null;
    const length: DateSource | null = milestone
      ? { kind: 'milestone' }
      : it.duration !== null && it.duration > 0
        ? { kind: 'duration', days: it.duration }
        : hours
          ? { kind: 'estimate', hours: Math.round(hours * 10) / 10, days: Math.max(1, Math.ceil(hours / 8)) }
          : null;
    const endFrom = (start: string) =>
      !length ? null : length.kind === 'milestone' ? start : length.kind === 'duration' ? shift(start, length.days) : addWorkingDays(start, length.days - 1, holidays);
    const startFrom = (end: string) =>
      !length ? null : length.kind === 'milestone' ? end : length.kind === 'duration' ? shift(end, -length.days) : subtractWorkingDays(end, length.days - 1, holidays);

    let start: string | null = null;
    let end: string | null = null;
    const sources: DateSource[] = [];
    const cards: number[] = [];
    const preds = into.get(it.taskId) ?? [];
    let blocked = false;
    for (const e of preds) {
      const p = known.get(e.source);
      const name = byId.get(e.source)?.key ?? byId.get(e.source)?.summary ?? '';
      const pick = (day: string | null | undefined) => {
        if (!day) blocked = true;
        return day ?? null;
      };
      if (!p) {
        blocked = true;
        continue;
      }
      if (e.type === 'finish_to_start') {
        const d = pick(p.end);
        if (d) {
          const s = addWorkingDays(d, 1, holidays);
          if (!start || s > start) start = s;
          sources.push({ kind: 'after_end', item: name, date: d, ...(p.suggested && { suggested: true }) });
        }
      } else if (e.type === 'start_to_start') {
        const d = pick(p.start);
        if (d) {
          start = later(start, workingDayOnOrAfter(d, holidays));
          sources.push({ kind: 'with_start', item: name, date: d, ...(p.suggested && { suggested: true }) });
        }
      } else {
        const d = pick(e.type === 'finish_to_finish' ? p.end : p.start);
        if (d) {
          end = later(end, d);
          sources.push({ kind: e.type === 'finish_to_finish' ? 'with_end' : 'before_start', item: name, date: d, ...(p.suggested && { suggested: true }) });
        }
      }
      if (e.card !== null && !cards.includes(e.card)) cards.push(e.card);
    }
    if (blocked) return { ...base, state: 'nothing', start: null, end: null, duration: null };

    if (!preds.length) {
      if (!length || !plan.start) return { ...base, state: 'nothing', start: null, end: null, duration: null };
      start = workingDayOnOrAfter(plan.start.slice(0, 10), holidays);
      sources.push({ kind: 'plan_start', date: plan.start.slice(0, 10) });
    }
    // An end constraint moves the start too, when the length is known.
    if (end && length) {
      const s = startFrom(end);
      if (s && (!start || s > start)) start = s;
    }
    if (start) end = later(end, endFrom(start));
    if (length) sources.push(length);

    const state: DateSuggestion['state'] = !start ? 'needs_start' : !end ? 'needs_end' : it.robert ? 'robert' : 'person';
    if (start && end) known.set(it.taskId, { start, end, suggested: true });
    return {
      ...base,
      state,
      start,
      end,
      duration: start && end ? (milestone ? 0 : span(start, end)) : null,
      sources,
      cards,
    };
  };

  // Kahn's order: an item is decided once everything before it is.
  const queue = items.filter((i) => (indegree.get(i.taskId) ?? 0) === 0).map((i) => i.taskId);
  const left = new Map(indegree);
  while (queue.length) {
    const id = queue.shift() as string;
    out.set(id, decide(byId.get(id) as DateItem));
    for (const e of edges) {
      if (e.source !== id || !byId.has(e.target) || e.target === id) continue;
      const n = (left.get(e.target) ?? 0) - 1;
      left.set(e.target, n);
      if (n === 0) queue.push(e.target);
    }
  }
  // What is left sits in a cycle (or after one): nothing to base a date on.
  for (const it of items)
    if (!out.has(it.taskId))
      out.set(it.taskId, {
        taskId: it.taskId,
        state: it.start || it.end ? 'has_dates' : 'nothing',
        start: it.start,
        end: it.end,
        duration: it.duration,
        sources: [],
        cards: [],
      });
  return out;
}
