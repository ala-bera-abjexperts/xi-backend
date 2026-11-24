/**
 * @fileoverview Pure, DB-free working-day calendar engine for Resource Planning 2.0.
 * Computes per-day working hours from a workload scheme (per-weekday hours) and a
 * holiday scheme (fixed-annual or one-off non-working dates). No Supabase access —
 * see working-calendar.service.ts for the loader that resolves schemes per org/user
 * and calls into this module.
 *
 * A `null` return from `buildDayHoursMap` is the opt-in legacy signal: it means "no
 * workload scheme configured", and callers must fall back to the existing 7-calendar-
 * day math unchanged. This module never itself decides to fall back — that decision
 * belongs to the caller, so the signal is unambiguous.
 * @module src/resource-planning/calendar/working-calendar.engine
 */

export interface WorkloadSchemeHours {
  monday_hours: number;
  tuesday_hours: number;
  wednesday_hours: number;
  thursday_hours: number;
  friday_hours: number;
  saturday_hours: number;
  sunday_hours: number;
}

export type HolidayRecurrence = 'fixed_annual' | 'one_off';

export interface HolidayDay {
  recurrence: HolidayRecurrence;
  /** 1-12, fixed_annual only. */
  month?: number | null;
  /** 1-31, fixed_annual only. */
  day?: number | null;
  /** YYYY-MM-DD, one_off only. */
  holiday_date?: string | null;
  /** Consecutive calendar days the entry covers, starting at the anchor date. */
  duration_days: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_FIELDS: readonly (keyof WorkloadSchemeHours)[] = [
  'sunday_hours',
  'monday_hours',
  'tuesday_hours',
  'wednesday_hours',
  'thursday_hours',
  'friday_hours',
  'saturday_hours',
];

function toUtcDayMs(dateStr: string): number | null {
  const ms = new Date(`${dateStr}T00:00:00.000Z`).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function formatUtcDate(ms: number): string {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function hoursForWeekday(scheme: WorkloadSchemeHours, dayMs: number): number {
  const weekday = new Date(dayMs).getUTCDay(); // 0 = Sunday
  const value = Number(scheme[WEEKDAY_FIELDS[weekday]]);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Constructs a UTC date from a calendar (year, month, day) and returns null if the
 * combination does not exist — e.g. month=2 day=30, or month=2 day=29 in a non-leap
 * year. This is what makes 29 February expand only in leap years: no special-casing
 * needed, the round-trip check rejects it in every other year.
 */
function safeUtcDate(
  year: number,
  month1to12: number,
  day: number,
): number | null {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month1to12) ||
    !Number.isInteger(day) ||
    month1to12 < 1 ||
    month1to12 > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  const ms = Date.UTC(year, month1to12 - 1, day);
  const d = new Date(ms);
  const roundTrips =
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month1to12 - 1 &&
    d.getUTCDate() === day;
  return roundTrips ? ms : null;
}

/**
 * Expands one holiday entry into the set of concrete UTC-midnight timestamps it
 * covers within [fromMs, toMs]. fixed_annual entries are expanded once per calendar
 * year that could plausibly intersect the range (including a one-year pad on each
 * side, since a late-December anchor with a long duration can spill into January).
 */
function expandHolidayDay(
  holiday: HolidayDay,
  fromMs: number,
  toMs: number,
): number[] {
  const durationDays = Math.max(1, Math.trunc(holiday.duration_days) || 1);
  const spanMs = (durationDays - 1) * DAY_MS;
  const anchors: number[] = [];

  if (holiday.recurrence === 'one_off') {
    if (holiday.holiday_date) {
      const anchor = toUtcDayMs(holiday.holiday_date);
      if (anchor != null) anchors.push(anchor);
    }
  } else {
    const month = holiday.month;
    const day = holiday.day;
    if (month != null && day != null) {
      const fromYear = new Date(fromMs).getUTCFullYear();
      const toYear = new Date(toMs).getUTCFullYear();
      for (let year = fromYear - 1; year <= toYear + 1; year += 1) {
        const anchor = safeUtcDate(year, month, day);
        if (anchor != null) anchors.push(anchor);
      }
    }
  }

  const covered: number[] = [];
  for (const anchor of anchors) {
    const spanStart = anchor;
    const spanEnd = anchor + spanMs;
    if (spanEnd < fromMs || spanStart > toMs) continue;
    const start = Math.max(spanStart, fromMs);
    const end = Math.min(spanEnd, toMs);
    for (let ms = start; ms <= end; ms += DAY_MS) covered.push(ms);
  }
  return covered;
}

/**
 * Builds every holiday-covered date in [from, to] as a deduplicated set of
 * YYYY-MM-DD strings. Using a Set is what prevents duplicate/overlapping holiday
 * rows from being processed more than once — there is nothing to double-subtract
 * because a date is either a holiday (0 hours) or it is not; two rows covering the
 * same date collapse to one membership test, not two subtractions.
 */
function buildHolidayDateSet(
  holidays: HolidayDay[],
  fromMs: number,
  toMs: number,
): Set<string> {
  const set = new Set<string>();
  for (const holiday of holidays) {
    for (const ms of expandHolidayDay(holiday, fromMs, toMs)) {
      set.add(formatUtcDate(ms));
    }
  }
  return set;
}

/**
 * Builds a day -> working-hours map for [from, to] (inclusive, UTC date strings).
 *
 * Returns null when `scheme` is null — this is the opt-in legacy signal callers
 * must check for before doing anything else. A non-null scheme with all-zero
 * weekday hours is NOT the same as no scheme: it is a real, deliberately-configured
 * zero-capacity calendar, and callers must preserve that distinction (0 means
 * "genuinely no capacity, can be over-allocated"; the null return means "unknown,
 * never flag over-allocation").
 *
 * A holiday date always yields 0 hours for that day regardless of the scheme's
 * weekday value — including a holiday that lands on an already-zero-hour weekday,
 * which is simply 0 again, not a negative number.
 */
export function buildDayHoursMap(
  scheme: WorkloadSchemeHours | null,
  holidays: HolidayDay[],
  from: string,
  to: string,
): Map<string, number> | null {
  if (!scheme) return null;
  const fromMs = toUtcDayMs(from);
  const toMs = toUtcDayMs(to);
  if (fromMs == null || toMs == null || toMs < fromMs) return new Map();

  const holidayDates = buildHolidayDateSet(holidays, fromMs, toMs);
  const map = new Map<string, number>();
  for (let ms = fromMs; ms <= toMs; ms += DAY_MS) {
    const dateStr = formatUtcDate(ms);
    map.set(
      dateStr,
      holidayDates.has(dateStr) ? 0 : hoursForWeekday(scheme, ms),
    );
  }
  return map;
}

/** Number of dates in the map with more than zero working hours. */
export function countWorkingDays(
  dayHoursMap: ReadonlyMap<string, number>,
): number {
  let count = 0;
  for (const hours of dayHoursMap.values()) if (hours > 0) count += 1;
  return count;
}

/** Sum of working hours across every date in the map. */
export function sumWorkingHours(
  dayHoursMap: ReadonlyMap<string, number>,
): number {
  let total = 0;
  for (const hours of dayHoursMap.values()) total += hours;
  return total;
}

/**
 * Sums working hours for the sub-range [from, to] within an already-built map.
 * Dates outside the map (never built) are treated as contributing 0 — callers
 * should build the map wide enough to cover every range they intend to query.
 */
export function sumWorkingHoursInRange(
  dayHoursMap: ReadonlyMap<string, number>,
  from: string,
  to: string,
): number {
  const fromMs = toUtcDayMs(from);
  const toMs = toUtcDayMs(to);
  if (fromMs == null || toMs == null || toMs < fromMs) return 0;
  let total = 0;
  for (let ms = fromMs; ms <= toMs; ms += DAY_MS) {
    total += dayHoursMap.get(formatUtcDate(ms)) ?? 0;
  }
  return total;
}

/**
 * Number of dates with more than zero working hours within the sub-range
 * [from, to] of an already-built map. Dates outside the map are treated as 0
 * (not working) — same convention as sumWorkingHoursInRange.
 */
export function countWorkingDaysInRange(
  dayHoursMap: ReadonlyMap<string, number>,
  from: string,
  to: string,
): number {
  const fromMs = toUtcDayMs(from);
  const toMs = toUtcDayMs(to);
  if (fromMs == null || toMs == null || toMs < fromMs) return 0;
  let count = 0;
  for (let ms = fromMs; ms <= toMs; ms += DAY_MS) {
    if ((dayHoursMap.get(formatUtcDate(ms)) ?? 0) > 0) count += 1;
  }
  return count;
}

/**
 * Scales a weekly-capacity figure onto working days in a sub-range, replacing the
 * legacy (calendarDays / 7) proration. Guards workingDaysPerWeek === 0 (an
 * all-zero-hours scheme) so this never divides by zero or produces NaN/Infinity —
 * with no working days defined at all, the contribution is 0, matching the 0 (not
 * null) capacity value that scheme already produces everywhere else.
 */
export function ratioContribution(
  weeklyCapacity: number,
  workingDaysInSubRange: number,
  workingDaysPerWeek: number,
): number {
  if (workingDaysPerWeek <= 0) return 0;
  return (workingDaysInSubRange / workingDaysPerWeek) * weeklyCapacity;
}

export function totalWeeklyHours(scheme: WorkloadSchemeHours): number {
  return WEEKDAY_FIELDS.reduce(
    (sum, field) => sum + (Number(scheme[field]) || 0),
    0,
  );
}

/**
 * Count of weekdays in a normal week that carry more than zero hours (typically 5
 * for a Mon-Fri scheme, but a custom scheme may define fewer or more). This is the
 * denominator capacity math uses to generalize a "weekly_capacity_hours" figure
 * onto a real calendar: (working days in range / workingDaysPerWeek) * weeklyCapacity,
 * replacing the legacy (calendar days / 7) * weeklyCapacity proration.
 */
export function workingDaysPerWeekOf(scheme: WorkloadSchemeHours): number {
  let count = 0;
  for (const field of WEEKDAY_FIELDS) {
    if ((Number(scheme[field]) || 0) > 0) count += 1;
  }
  return count;
}

/**
 * The (dayHours, workingDaysPerWeek) pair capacity math needs, bundled so it stays
 * a single optional parameter at call sites.
 */
export interface WorkingCalendarContext {
  dayHours: ReadonlyMap<string, number>;
  workingDaysPerWeek: number;
}
