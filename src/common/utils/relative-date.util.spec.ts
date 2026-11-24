/**
 * Canonical relative-date resolver tests (pure, no DI).
 *
 * The compatibility rows pin each legacy dialect's HISTORIC semantics, including the deliberate
 * divergence between snake `last_7_days` (rolling cutoff from the current instant, open-ended —
 * the filters engines) and camel `last7Days` (day-bucketed bounded window — the board evaluator).
 * If either row ever fails, existing saved filters or boards changed meaning.
 */

import {
  isRelativeCutoff,
  matchesRelativeValue,
  resolveCutoff,
  resolveRelativeWindow,
} from './relative-date.util';

// Wednesday 2026-07-22 14:30 local. getDay() = 3.
const NOW = new Date(2026, 6, 22, 14, 30, 0);
const DAY = 86_400_000;

const sod = new Date(2026, 6, 22).getTime();

describe('resolveRelativeWindow', () => {
  describe('legacy snake tokens keep the filters engines semantics', () => {
    it('today is the bounded local day', () => {
      const w = resolveRelativeWindow('today', NOW)!;

      expect(w.start!.getTime()).toBe(sod);
      expect(w.end!.getTime()).toBe(sod + DAY);
    });

    it('last_7_days is ROLLING from the current instant and open-ended', () => {
      const w = resolveRelativeWindow('last_7_days', NOW)!;

      expect(w.start!.getTime()).toBe(NOW.getTime() - 7 * DAY);
      expect(w.end).toBeNull();
    });

    it('last_month is the bounded previous calendar month', () => {
      const w = resolveRelativeWindow('last_month', NOW)!;

      expect(w.start!.getTime()).toBe(new Date(2026, 5, 1).getTime());
      expect(w.end!.getTime()).toBe(new Date(2026, 6, 1).getTime());
    });

    it('this_year is open-ended above', () => {
      const w = resolveRelativeWindow('this_year', NOW)!;

      expect(w.start!.getTime()).toBe(new Date(2026, 0, 1).getTime());
      expect(w.end).toBeNull();
    });
  });

  describe('legacy camel tokens keep the board evaluator semantics', () => {
    it('last7Days is DAY-BUCKETED and bounded, unlike snake last_7_days', () => {
      const w = resolveRelativeWindow('last7Days', NOW)!;

      expect(w.start!.getTime()).toBe(sod - 7 * DAY);
      expect(w.end!.getTime()).toBe(sod + DAY);
    });

    it('thisWeek starts on the SUNDAY of the current week', () => {
      const w = resolveRelativeWindow('thisWeek', NOW)!;

      // 2026-07-22 is a Wednesday (getDay 3) — Sunday is the 19th.
      expect(w.start!.getTime()).toBe(new Date(2026, 6, 19).getTime());
      expect(w.end!.getTime()).toBe(new Date(2026, 6, 19).getTime() + 7 * DAY);
    });

    it('next7Days spans today through the next seven days', () => {
      const w = resolveRelativeWindow('next7Days', NOW)!;

      expect(w.start!.getTime()).toBe(sod);
      expect(w.end!.getTime()).toBe(sod + 8 * DAY);
    });
  });

  describe('new tokens available to every dialect', () => {
    it('snake this_week mirrors the board thisWeek window', () => {
      expect(resolveRelativeWindow('this_week', NOW)).toEqual(
        resolveRelativeWindow('thisWeek', NOW),
      );
    });

    it('last_year is the bounded previous calendar year', () => {
      const w = resolveRelativeWindow('last_year', NOW)!;

      expect(w.start!.getTime()).toBe(new Date(2025, 0, 1).getTime());
      expect(w.end!.getTime()).toBe(new Date(2026, 0, 1).getTime());
    });

    it.each([
      ['last_1_days', NOW.getTime() - DAY],
      ['last_2_weeks', NOW.getTime() - 14 * DAY],
      ['last_45_minutes', NOW.getTime() - 45 * 60_000],
      ['last_6_hours', NOW.getTime() - 6 * 3_600_000],
    ])(
      'parameterised %s starts at the exact rolling offset',
      (token, start) => {
        const w = resolveRelativeWindow(token, NOW)!;

        expect(w.start!.getTime()).toBe(start);
        expect(w.end).toBeNull();
      },
    );

    it('parameterised next_N is bounded from the current instant', () => {
      const w = resolveRelativeWindow('next_3_days', NOW)!;

      expect(w.start!.getTime()).toBe(NOW.getTime());
      expect(w.end!.getTime()).toBe(NOW.getTime() + 3 * DAY);
    });

    it('singular units parse too (last_1_day)', () => {
      expect(resolveRelativeWindow('last_1_day', NOW)).not.toBeNull();
    });
  });

  it('unknown tokens return null so callers keep their historic defaults', () => {
    expect(resolveRelativeWindow('sometime_recent', NOW)).toBeNull();
    expect(resolveRelativeWindow('last_0_days', NOW)).toBeNull();
    expect(resolveRelativeWindow('', NOW)).toBeNull();
  });
});

describe('resolveCutoff', () => {
  it('anchor now with a negative offset is the exact JQL "-1d" instant', () => {
    const at = resolveCutoff(
      { kind: 'cutoff', anchor: 'now', offsetMinutes: -1440, op: 'gte' },
      NOW,
    );

    expect(at.getTime()).toBe(NOW.getTime() - DAY);
  });

  it('start_of_week resolves to the local Sunday', () => {
    const at = resolveCutoff(
      { kind: 'cutoff', anchor: 'start_of_week', op: 'gte' },
      NOW,
    );

    expect(at.getTime()).toBe(new Date(2026, 6, 19).getTime());
  });

  it('period shifts move CALENDAR periods, which minutes cannot express', () => {
    // startOfMonth(-1) across July→June: 30-day month, not a fixed minute count.
    const at = resolveCutoff(
      { kind: 'cutoff', anchor: 'start_of_month', periods: -1, op: 'gte' },
      NOW,
    );

    expect(at.getTime()).toBe(new Date(2026, 5, 1).getTime());
  });

  it('end_of_month is the START of the next month (exclusive-bound convention)', () => {
    const at = resolveCutoff(
      { kind: 'cutoff', anchor: 'end_of_month', op: 'lte' },
      NOW,
    );

    expect(at.getTime()).toBe(new Date(2026, 7, 1).getTime());
  });
});

describe('matchesRelativeValue', () => {
  it('evaluates cutoffs with the folded comparison op', () => {
    const cutoff = {
      kind: 'cutoff',
      anchor: 'now',
      offsetMinutes: -1440,
      op: 'gte',
    } as const;

    expect(matchesRelativeValue(NOW.getTime() - DAY + 1, cutoff, NOW)).toBe(
      true,
    );
    expect(matchesRelativeValue(NOW.getTime() - DAY - 1, cutoff, NOW)).toBe(
      false,
    );
  });

  it('a cutoff INCLUDES future values — the reason "due >= -7d" is now exact', () => {
    const cutoff = {
      kind: 'cutoff',
      anchor: 'now',
      offsetMinutes: -7 * 1440,
      op: 'gte',
    } as const;

    // A due date one year out: inside `>= now-7d` in JQL, outside every bounded window preset.
    expect(matchesRelativeValue(NOW.getTime() + 365 * DAY, cutoff, NOW)).toBe(
      true,
    );
  });

  it('accepts the board evaluator historic { preset } wrapper', () => {
    expect(matchesRelativeValue(NOW.getTime(), { preset: 'today' }, NOW)).toBe(
      true,
    );
  });

  it('returns null for unknown values so each caller keeps its own default', () => {
    expect(
      matchesRelativeValue(NOW.getTime(), 'no_such_token', NOW),
    ).toBeNull();
    expect(
      matchesRelativeValue(NOW.getTime(), { kind: 'cutoff' }, NOW),
    ).toBeNull();
  });
});

describe('isRelativeCutoff', () => {
  it('narrows only well-formed cutoff objects', () => {
    expect(isRelativeCutoff({ kind: 'cutoff', anchor: 'now', op: 'gte' })).toBe(
      true,
    );
    expect(isRelativeCutoff('last_7_days')).toBe(false);
    expect(isRelativeCutoff({ kind: 'cutoff' })).toBe(false);
    expect(isRelativeCutoff(null)).toBe(false);
  });
});
