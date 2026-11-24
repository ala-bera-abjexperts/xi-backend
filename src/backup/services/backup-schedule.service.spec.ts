/**
 * @fileoverview Cron arithmetic tests. The timezone and DST cases are the reason this file exists.
 * @module src/backup/services/backup-schedule.service.spec
 *
 * Every date here is a fixed instant. A test that reads the wall clock would pass for eleven months
 * of the year and fail on the clock-change weekend — which is exactly the weekend that matters.
 */

import { BadRequestException } from '@nestjs/common';
import {
  assertScheduleValid,
  computeNextRunAt,
  countMissedOccurrences,
  cronFingerprint,
  isValidTimezone,
  resolveMisfire,
} from './backup-schedule.service';

const BERLIN = { cronExpression: '0 2 * * *', timezone: 'Europe/Berlin' };

/** Renders an instant in a zone, so a DST assertion reads as the wall-clock time an admin expects. */
function localTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(date);
}

describe('isValidTimezone', () => {
  it('accepts real IANA zones', () => {
    expect(isValidTimezone('Europe/Berlin')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Asia/Kolkata')).toBe(true);
  });

  // A numeric UTC offset is a legal `timeZone` under ECMA-402 on the ICU this runtime ships, and
  // cron-parser resolves it correctly (`0 3 * * *` at `+02:00` → 01:00Z). It used to be rejected
  // only because older ICU threw on it. The guard's job is to reject what would explode inside the
  // scheduler, and this does not — so it belongs here, not in the reject list below.
  it('accepts a numeric UTC offset', () => {
    expect(isValidTimezone('+02:00')).toBe(true);
  });

  // Each of these is accepted by CronExpressionParser.parse() and throws only when the iterator is
  // advanced — i.e. inside the scheduler, not at save time.
  it.each([
    ['a trailing space', 'Europe/Berlin '],
    ['a POSIX-style offset', 'GMT+2'],
    ['a nonexistent zone', 'Not/AZone'],
    ['an empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(isValidTimezone(value)).toBe(false);
  });
});

describe('assertScheduleValid', () => {
  it('accepts an ordinary nightly schedule', () => {
    expect(() => assertScheduleValid(BERLIN)).not.toThrow();
  });

  it('rejects an unknown time zone at save time, not at 02:00', () => {
    expect(() =>
      assertScheduleValid({ ...BERLIN, timezone: 'Europe/Berlin ' }),
    ).toThrow(BadRequestException);
  });

  it('rejects a six-field expression', () => {
    // '*' + '/10 * * * * *' — a seconds field. Parses cleanly, so only this check stops it.
    expect(() =>
      assertScheduleValid({
        cronExpression: '*/10 * * * * *',
        timezone: 'UTC',
      }),
    ).toThrow(/five cron fields/);
  });

  it('rejects a schedule that fires faster than the floor', () => {
    expect(() =>
      assertScheduleValid({ cronExpression: '* * * * *', timezone: 'UTC' }),
    ).toThrow(/minimum interval/);
  });

  it('accepts a five-minute schedule, which is unusual but legitimate', () => {
    expect(() =>
      assertScheduleValid({ cronExpression: '*/5 * * * *', timezone: 'UTC' }),
    ).not.toThrow();
  });

  it('rejects a malformed expression', () => {
    expect(() =>
      assertScheduleValid({ cronExpression: 'not a cron', timezone: 'UTC' }),
    ).toThrow(BadRequestException);
  });
});

describe('computeNextRunAt', () => {
  it('returns an instant strictly after the base', () => {
    const base = new Date('2026-08-03T12:00:00Z');

    expect(computeNextRunAt(BERLIN, base).getTime()).toBeGreaterThan(
      base.getTime(),
    );
  });

  it('does not return the same slot when the base sits 1ms before a boundary', () => {
    // cron-parser returns the first occurrence AFTER currentDate, so a base one millisecond early
    // yields that very boundary. Harmless here, fatal if the base is a lagging process clock.
    const justBefore = new Date('2026-08-03T23:59:59.999Z');
    const next = computeNextRunAt(
      { cronExpression: '0 0 * * *', timezone: 'UTC' },
      justBefore,
    );

    expect(next.getTime()).toBeGreaterThan(justBefore.getTime());
  });

  describe('DST — Europe/Berlin, 02:00 nightly', () => {
    it('spring forward: fires once at the next valid instant, never skipping the day', () => {
      // 2026-03-29 has no 02:00 local — the clock jumps 01:59:59 CET to 03:00:00 CEST.
      const next = computeNextRunAt(
        BERLIN,
        new Date('2026-03-28T12:00:00.000Z'),
      );

      expect(next.toISOString()).toBe('2026-03-29T01:00:00.000Z');
      expect(localTime(next, 'Europe/Berlin')).toContain('03:00:00');
    });

    it('fall back: fires once, not twice, on the repeated hour', () => {
      // 2026-10-25 has 02:00 local twice. Only one instant is ever stored as next_run_at.
      const first = computeNextRunAt(
        BERLIN,
        new Date('2026-10-24T12:00:00.000Z'),
      );

      expect(first.toISOString()).toBe('2026-10-25T00:00:00.000Z');

      // Recomputing FROM that instant lands on the next day, not the second 02:00.
      const second = computeNextRunAt(BERLIN, first);

      expect(second.toISOString()).toBe('2026-10-26T01:00:00.000Z');
      expect(localTime(second, 'Europe/Berlin')).toContain('02:00:00');
    });

    it('leaves zones without this transition untouched on the same dates', () => {
      const utc = { cronExpression: '0 2 * * *', timezone: 'UTC' };

      expect(
        computeNextRunAt(utc, new Date('2026-03-28T12:00:00Z')).toISOString(),
      ).toBe('2026-03-29T02:00:00.000Z');
      expect(
        computeNextRunAt(utc, new Date('2026-10-24T12:00:00Z')).toISOString(),
      ).toBe('2026-10-25T02:00:00.000Z');
    });
  });
});

describe('countMissedOccurrences', () => {
  it('counts the windows that elapsed during an outage', () => {
    // Nightly, down from the 4th to the 7th: windows on the 5th, 6th and 7th.
    const count = countMissedOccurrences(
      { cronExpression: '0 2 * * *', timezone: 'UTC' },
      new Date('2026-08-04T02:00:00Z'),
      new Date('2026-08-07T09:00:00Z'),
    );

    expect(count).toBe(3);
  });

  it('returns 0 when nothing elapsed', () => {
    expect(
      countMissedOccurrences(
        { cronExpression: '0 2 * * *', timezone: 'UTC' },
        new Date('2026-08-04T02:00:00Z'),
        new Date('2026-08-04T03:00:00Z'),
      ),
    ).toBe(0);
  });

  it('is bounded, so a long outage cannot spin', () => {
    const count = countMissedOccurrences(
      { cronExpression: '*/5 * * * *', timezone: 'UTC' },
      new Date('2020-01-01T00:00:00Z'),
      new Date('2026-01-01T00:00:00Z'),
    );

    expect(count).toBeLessThanOrEqual(500);
  });
});

describe('resolveMisfire', () => {
  const schedule = { cronExpression: '0 2 * * *', timezone: 'UTC' };

  it('runs the catch-up when the window is still inside the grace period', () => {
    const decision = resolveMisfire({
      schedule,
      dueAt: new Date('2026-08-04T02:00:00Z'),
      now: new Date('2026-08-04T02:10:00Z'),
    });

    expect(decision.action).toBe('run');
    expect(decision.missedOccurrences).toBe(0);
  });

  it('skips once — never queues one run per missed window', () => {
    // A week of downtime is seven missed windows and exactly one decision.
    const decision = resolveMisfire({
      schedule,
      dueAt: new Date('2026-08-04T02:00:00Z'),
      now: new Date('2026-08-11T09:00:00Z'),
    });

    expect(decision.action).toBe('skip');
    expect(decision.missedOccurrences).toBeGreaterThan(1);
  });

  it('always moves the schedule forward, on both branches', () => {
    const now = new Date('2026-08-11T09:00:00Z');

    for (const dueAt of [
      new Date('2026-08-11T08:55:00Z'),
      new Date('2026-08-04T02:00:00Z'),
    ]) {
      const decision = resolveMisfire({ schedule, dueAt, now });

      // A next_run_at left in the past re-claims the scheme on every tick, forever.
      expect(decision.nextRunAt.getTime()).toBeGreaterThan(now.getTime());
    }
  });
});

describe('cronFingerprint', () => {
  it('changes when the timezone changes, so a corrected zone forces a recompute', () => {
    expect(cronFingerprint(BERLIN)).not.toBe(
      cronFingerprint({ ...BERLIN, timezone: 'UTC' }),
    );
  });

  it('changes when the expression changes', () => {
    expect(cronFingerprint(BERLIN)).not.toBe(
      cronFingerprint({ ...BERLIN, cronExpression: '0 3 * * *' }),
    );
  });

  it('is stable for the same definition', () => {
    expect(cronFingerprint(BERLIN)).toBe(cronFingerprint({ ...BERLIN }));
  });
});
