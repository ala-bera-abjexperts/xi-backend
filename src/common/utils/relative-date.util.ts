/**
 * @fileoverview Canonical relative-date vocabulary shared by every rule evaluator.
 *
 * Pure and dependency-free so it is directly testable and can be mirrored verbatim on the
 * frontend (`src/utils/relative-date.ts`), the same twin convention as the filter query engines.
 *
 * WHY THIS EXISTS: the codebase grew FOUR evaluators with THREE incompatible relative-date
 * dialects — the filters engines understood seven snake_case presets, the board evaluator eleven
 * camelCase ones, and the automations evaluator none at all. A board quick filter authored in the
 * shared FilterQueryBuilder stored `last_7_days`, which the board evaluator did not recognise and
 * silently failed closed. Meanwhile the JQL transpiler could only translate the exact forms that
 * happened to exist in both preset tables, so customer JQL like `updated >= -1d` fell back to
 * verbatim text with a disclaimer.
 *
 * TWO VALUE SHAPES, ONE RESOLVER:
 *  - WINDOW tokens (strings) — bounded or open date ranges for UI presets: the legacy snake and
 *    camel names plus the parameterised `last_<n>_<unit>` / `next_<n>_<unit>` family.
 *  - CUTOFF objects — `{ kind: 'cutoff', anchor, offsetMinutes?, periods?, op }`. This is the
 *    EXACT translation of JQL relative comparisons: `updated >= -1d` is a comparison against the
 *    instant `now − 1 day`, not a bounded window. Windows only ever approximated these; cutoffs
 *    remove the approximation (and with it the transpiler's `only ">="` and due-date refusals).
 *
 * COMPATIBILITY CONTRACT: for the legacy tokens this module reproduces each evaluator's historic
 * semantics bit-for-bit — including their divergence: snake `last_7_days` is a rolling open-ended
 * `now − 7d` cutoff (how the filters engines always behaved), while camel `last7Days` is the
 * day-bucketed bounded window `[startOfDay − 7d, endOfDay]` (how the board always behaved).
 * Unifying those two would silently change what existing saved filters and boards match.
 */

export type RelativeAnchor =
  | 'now'
  | 'start_of_day'
  | 'end_of_day'
  | 'start_of_week'
  | 'end_of_week'
  | 'start_of_month'
  | 'end_of_month'
  | 'start_of_year'
  | 'end_of_year';

export interface RelativeCutoff {
  kind: 'cutoff';
  anchor: RelativeAnchor;
  /** Fixed shift applied AFTER the anchor resolves (e.g. `-1d` → anchor 'now', -1440). */
  offsetMinutes?: number;
  /**
   * Calendar-period shift applied to period anchors BEFORE the fixed offset —
   * `startOfMonth(-1)` is "start of LAST month", which no fixed minute count can express.
   */
  periods?: number;
  /** The original comparison, folded into the value because `operator` is 'relative'. */
  op: 'gt' | 'gte' | 'lt' | 'lte';
}

export interface RelativeWindow {
  /** Inclusive start, or null for an open lower bound. */
  start: Date | null;
  /** EXCLUSIVE end, or null for an open upper bound. */
  end: Date | null;
}

const MINUTE = 60_000;
const DAY = 86_400_000;

/** `last_3_days` / `next_2_weeks` / `last_45_minutes` … */
const PARAMETERIZED_RE = /^(last|next)_(\d+)_(minutes?|hours?|days?|weeks?)$/;

const UNIT_MINUTES: Record<string, number> = {
  minute: 1,
  hour: 60,
  day: 1440,
  week: 10_080,
};

export function isRelativeCutoff(value: unknown): value is RelativeCutoff {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'cutoff' &&
    typeof (value as { anchor?: unknown }).anchor === 'string' &&
    typeof (value as { op?: unknown }).op === 'string'
  );
}

/** Local start of day for `now` — all legacy tokens are local-time. */
function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Local start of week, SUNDAY-based — matching the board evaluator's historic `getDay()` math. */
function startOfWeek(now: Date): Date {
  const sod = startOfDay(now);

  return new Date(sod.getTime() - now.getDay() * DAY);
}

function startOfMonth(now: Date, shiftMonths = 0): Date {
  return new Date(now.getFullYear(), now.getMonth() + shiftMonths, 1);
}

function startOfYear(now: Date, shiftYears = 0): Date {
  return new Date(now.getFullYear() + shiftYears, 0, 1);
}

/**
 * Resolve a WINDOW token to `[start, end)`. Returns null for unknown tokens — callers keep their
 * historic unknown-token behaviour (engines drop the rule, the board fails closed).
 *
 * Legacy snake semantics (filters engines, unchanged): `today`/`yesterday`/`last_month` bounded;
 * `last_7_days`/`last_30_days` ROLLING from the current instant, open-ended; `this_month`/
 * `this_year` open-ended above.
 * Legacy camel semantics (board evaluator, unchanged): every token a bounded day-bucketed window.
 * New tokens (both dialects): `tomorrow`, `this_week`, `last_week`, `last_year`,
 * `next_7_days`/`next_30_days`, and the parameterised `last_N_*` / `next_N_*` family.
 */
export function resolveRelativeWindow(
  token: string,
  now: Date = new Date(),
): RelativeWindow | null {
  const sod = startOfDay(now);
  const sodMs = sod.getTime();

  switch (token) {
    // ── legacy snake (filters engines) ──
    case 'today':
      return { start: sod, end: new Date(sodMs + DAY) };
    case 'yesterday':
      return { start: new Date(sodMs - DAY), end: sod };
    case 'last_7_days':
      return { start: new Date(now.getTime() - 7 * DAY), end: null };
    case 'last_30_days':
      return { start: new Date(now.getTime() - 30 * DAY), end: null };
    case 'this_month':
      return { start: startOfMonth(now), end: null };
    case 'last_month':
      return { start: startOfMonth(now, -1), end: startOfMonth(now) };
    case 'this_year':
      return { start: startOfYear(now), end: null };

    // ── legacy camel (board evaluator) — bounded day-bucket windows ──
    case 'tomorrow':
      return { start: new Date(sodMs + DAY), end: new Date(sodMs + 2 * DAY) };
    case 'thisWeek': {
      const ws = startOfWeek(now);

      return { start: ws, end: new Date(ws.getTime() + 7 * DAY) };
    }
    case 'lastWeek': {
      const ws = new Date(startOfWeek(now).getTime() - 7 * DAY);

      return { start: ws, end: new Date(ws.getTime() + 7 * DAY) };
    }
    case 'thisMonth':
      return { start: startOfMonth(now), end: startOfMonth(now, 1) };
    case 'lastMonth':
      return { start: startOfMonth(now, -1), end: startOfMonth(now) };
    case 'last7Days':
      return { start: new Date(sodMs - 7 * DAY), end: new Date(sodMs + DAY) };
    case 'last30Days':
      return { start: new Date(sodMs - 30 * DAY), end: new Date(sodMs + DAY) };
    case 'next7Days':
      return { start: sod, end: new Date(sodMs + 8 * DAY) };
    case 'next30Days':
      return { start: sod, end: new Date(sodMs + 31 * DAY) };

    // ── new tokens, both dialects ──
    case 'this_week': {
      const ws = startOfWeek(now);

      return { start: ws, end: new Date(ws.getTime() + 7 * DAY) };
    }
    case 'last_week': {
      const ws = new Date(startOfWeek(now).getTime() - 7 * DAY);

      return { start: ws, end: new Date(ws.getTime() + 7 * DAY) };
    }
    case 'last_year':
      return { start: startOfYear(now, -1), end: startOfYear(now) };
    case 'next_7_days':
      return { start: now, end: new Date(now.getTime() + 7 * DAY) };
    case 'next_30_days':
      return { start: now, end: new Date(now.getTime() + 30 * DAY) };

    default: {
      const m = PARAMETERIZED_RE.exec(token);

      if (!m) return null;

      const n = Number(m[2]);
      const unit = m[3].replace(/s$/, '');
      const span = n * UNIT_MINUTES[unit] * MINUTE;

      if (!Number.isFinite(span) || span <= 0) return null;

      return m[1] === 'last'
        ? { start: new Date(now.getTime() - span), end: null }
        : { start: now, end: new Date(now.getTime() + span) };
    }
  }
}

/** Resolve a CUTOFF to the concrete instant it compares against. */
export function resolveCutoff(
  cutoff: RelativeCutoff,
  now: Date = new Date(),
): Date {
  const periods = cutoff.periods ?? 0;
  let base: Date;

  switch (cutoff.anchor) {
    case 'now':
      base = now;
      break;
    case 'start_of_day':
      base = new Date(startOfDay(now).getTime() + periods * DAY);
      break;
    case 'end_of_day':
      base = new Date(startOfDay(now).getTime() + (periods + 1) * DAY);
      break;
    case 'start_of_week':
      base = new Date(startOfWeek(now).getTime() + periods * 7 * DAY);
      break;
    case 'end_of_week':
      base = new Date(startOfWeek(now).getTime() + (periods + 1) * 7 * DAY);
      break;
    case 'start_of_month':
      base = startOfMonth(now, periods);
      break;
    case 'end_of_month':
      base = startOfMonth(now, periods + 1);
      break;
    case 'start_of_year':
      base = startOfYear(now, periods);
      break;
    case 'end_of_year':
      base = startOfYear(now, periods + 1);
      break;
    default:
      base = now;
  }

  const offset = cutoff.offsetMinutes ?? 0;

  return offset === 0 ? base : new Date(base.getTime() + offset * MINUTE);
}

/**
 * Evaluate a relative value (window token or cutoff object) against one timestamp, in memory.
 * Used by the board and automations evaluators. Returns null when the value is unrecognised so
 * each caller keeps its historic unknown-value default.
 */
export function matchesRelativeValue(
  fieldTime: number,
  value: unknown,
  now: Date = new Date(),
): boolean | null {
  if (isRelativeCutoff(value)) {
    const at = resolveCutoff(value, now).getTime();

    switch (value.op) {
      case 'gt':
        return fieldTime > at;
      case 'gte':
        return fieldTime >= at;
      case 'lt':
        return fieldTime < at;
      case 'lte':
        return fieldTime <= at;
      default:
        return null;
    }
  }

  // Accept plain tokens and the board's historic `{ preset }` / `{ value }` wrappers.
  const token =
    typeof value === 'string'
      ? value
      : ((value as { preset?: string; value?: string } | null)?.preset ??
        (value as { preset?: string; value?: string } | null)?.value ??
        '');

  const window = resolveRelativeWindow(token, now);

  if (!window) return null;

  if (window.start && fieldTime < window.start.getTime()) return false;
  if (window.end && fieldTime >= window.end.getTime()) return false;

  return true;
}
