import {
  advanceBusinessMilliseconds as advance,
  businessMilliseconds as elapsed,
  validateCalendar,
  workingWindows,
} from './sla-clock';
import { SlaCalendar } from './sla.types';
const ms = Date.parse;
const hour = 3600000;
const calendar = (
  timezone = 'UTC',
  startMinute = 480,
  endMinute = 1020,
): SlaCalendar => ({
  timezone,
  weekly: Object.fromEntries(
    [1, 2, 3, 4, 5].map((d) => [d, [{ startMinute, endMinute }]]),
  ),
  holidays: [],
});
describe('SLA business clock', () => {
  it('advances across weekends and holidays', () => {
    const from = ms('2026-09-04T16:00Z');
    expect(advance(calendar(), from, 4 * hour, ms('2026-10-01Z'))).toBe(
      ms('2026-09-07T11:00Z'),
    );
    expect(
      advance(
        { ...calendar(), holidays: ['2026-09-07'] },
        from,
        4 * hour,
        ms('2026-10-01Z'),
      ),
    ).toBe(ms('2026-09-08T11:00Z'));
  });
  it('honors split shifts, exact milliseconds, midnight, and exhausted horizons', () => {
    const c = {
      ...calendar(),
      weekly: {
        1: [
          { startMinute: 480, endMinute: 720 },
          { startMinute: 780, endMinute: 1020 },
        ],
      },
    };
    const from = ms('2026-09-07T11:59:59.999Z');
    expect(advance(c, from, 2, ms('2026-09-08Z'))).toBe(
      ms('2026-09-07T13:00:00.001Z'),
    );
    expect(elapsed(c, from, ms('2026-09-07T13:00:00.001Z'))).toBe(2);
    expect(advance(c, from, 10 * hour, ms('2026-09-08Z'))).toBeNull();
    expect(advance(c, from, 0, from)).toBe(from);
    expect(workingWindows(c, from, from)).toEqual([]);
  });
  it.each([
    ['America/New_York', '2026-11-01T00:00Z', '2026-11-02T00:00Z', 90, 105, 30],
    ['America/New_York', '2026-03-08T00:00Z', '2026-03-09T00:00Z', 120, 150, 0],
    [
      'Australia/Lord_Howe',
      '2026-04-04T12:00Z',
      '2026-04-05T12:00Z',
      100,
      110,
      20,
    ],
    ['Asia/Kathmandu', '2026-09-06T18:15Z', '2026-09-07T18:15Z', 0, 60, 60],
  ])(
    'handles %s wall-clock transitions',
    (zone, from, to, start, end, minutes) => {
      const c = {
        ...calendar(zone),
        weekly: Object.fromEntries(
          [0, 1, 2, 3, 4, 5, 6].map((d) => [
            d,
            [{ startMinute: start, endMinute: end }],
          ]),
        ),
      };
      expect(elapsed(c, ms(from), ms(to))).toBe(minutes * 60000);
    },
  );
  it('handles 24/7 leap days and DST as actual elapsed time', () => {
    const c = {
      ...calendar('America/New_York'),
      weekly: Object.fromEntries(
        [0, 1, 2, 3, 4, 5, 6].map((d) => [
          d,
          [{ startMinute: 0, endMinute: 1440 }],
        ]),
      ),
    };
    expect(elapsed(c, ms('2024-02-28Z'), ms('2024-03-01Z'))).toBe(48 * hour);
    expect(elapsed(c, ms('2026-11-01T00:00Z'), ms('2026-11-02T00:00Z'))).toBe(
      24 * hour,
    );
  });
  it('rejects invalid calendars and inputs', () => {
    for (const value of [
      null,
      { ...calendar(), timezone: 'Invalid/X' },
      { ...calendar(), holidays: ['2026-02-30'] },
      { ...calendar(), weekly: { 1: [{ startMinute: 800, endMinute: 700 }] } },
      { ...calendar(), weekly: { 7: [] } },
    ])
      expect(() => validateCalendar(value)).toThrow();
    expect(() => elapsed(calendar(), NaN, 0)).toThrow();
    expect(() => advance(calendar(), 0, -1, 1)).toThrow();
  });
});
