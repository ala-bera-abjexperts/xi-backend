import { calendarDays, resolveDateWords } from './agent-dates';

const VIENNA = 'Europe/Vienna';
const BERLIN = 'Europe/Berlin';
// Thursday 2026-10-22, 12:00 in Vienna (CEST, UTC+2).
const THURSDAY_NOON = new Date('2026-10-22T10:00:00Z');

const at = (now: string, timezone = VIENNA) => ({
  timezone,
  now: new Date(now),
});

describe('resolveDateWords', () => {
  const ctx = { timezone: VIENNA, now: THURSDAY_NOON };

  it.each([
    ['heute', '2026-10-22'],
    ['today', '2026-10-22'],
    ['heute morgen', '2026-10-22'],
    ['morgen früh', '2026-10-23'],
    ['tomorrow', '2026-10-23'],
    ['übermorgen', '2026-10-24'],
    ['uebermorgen', '2026-10-24'],
    ['the day after tomorrow', '2026-10-24'],
    ['gestern', '2026-10-21'],
    ['yesterday', '2026-10-21'],
  ])('reads the relative word "%s"', (text, date) => {
    expect(resolveDateWords(text, ctx)).toBe(date);
  });

  it.each([
    ['bis Freitag', '2026-10-23'],
    ['nächsten Montag', '2026-10-26'],
    ['next Friday', '2026-10-23'],
    ['am Sonntag', '2026-10-25'],
    // Said on a Thursday, "Donnerstag" is a week away, never today.
    ['bis Donnerstag', '2026-10-29'],
    ['Thursday', '2026-10-29'],
  ])('reads the weekday in "%s"', (text, date) => {
    expect(resolveDateWords(text, ctx)).toBe(date);
  });

  it.each([
    ['bis 15. Jänner', '2027-01-15'],
    ['15. Januar', '2027-01-15'],
    ['am 3. November', '2026-11-03'],
    ['1 Feber', '2027-02-01'],
    ['10. März', '2027-03-10'],
    ['March 15th', '2027-03-15'],
    ['the 4th of December', '2026-12-04'],
    ['22. Oktober', '2026-10-22'],
    ['21. Oktober', '2027-10-21'],
  ])('reads the day and month in "%s"', (text, date) => {
    expect(resolveDateWords(text, ctx)).toBe(date);
  });

  // Audit 2026-11-10: a year said is a year meant, also one in the past (the card warns then).
  it.each([
    ['15 Oct 2028', '2028-10-15'],
    ['bis 15. März 2026', '2026-03-15'],
    ['am 3. November 2025', '2025-11-03'],
    ['March 15th 2027', '2027-03-15'],
    ['March 15, 2027', '2027-03-15'],
    ['the 4th of December 2029', '2029-12-04'],
  ])('keeps the year said in "%s"', (text, date) => {
    expect(resolveDateWords(text, ctx)).toBe(date);
  });

  it.each([
    // A month and a year, no day: never the year's first two digits as the day.
    'by June 2027',
    'bis März 2028',
    'in October 2026',
    // A week counted forward: the words alone cannot say which day; the model's date is used.
    'nächste Woche Freitag',
    'Freitag nächste Woche',
    'next week Friday',
    'Friday next week',
    'übernächsten Freitag',
    'heute in 2 Wochen',
    'in two weeks',
    'in 3 Wochen am Montag',
    'the week after next',
  ])('leaves "%s" to the model', (text) => {
    expect(resolveDateWords(text, ctx)).toBeNull();
  });

  it('rejects a day the month does not have', () => {
    expect(resolveDateWords('30. Februar', ctx)).toBeNull();
    expect(resolveDateWords('32 Dezember', ctx)).toBeNull();
  });

  it('does not take the last digit of a longer number as the day', () => {
    expect(resolveDateWords('115 März', ctx)).toBeNull();
  });

  it.each([
    'Ende des Monats',
    'bis Monatsende',
    'by end of month',
    'end of the month',
  ])('reads "%s" as the last day of this month', (text) => {
    expect(resolveDateWords(text, ctx)).toBe('2026-10-31');
  });

  it('returns null when there is no date word', () => {
    expect(resolveDateWords('Was haben wir vereinbart?', ctx)).toBeNull();
    expect(resolveDateWords('Montagewerk prüfen', ctx)).toBeNull();
  });

  it('uses the invoker’s day near local midnight, not the UTC day', () => {
    // 23:30 UTC on the 22nd is already 01:30 on Friday the 23rd in Vienna.
    expect(resolveDateWords('heute', at('2026-10-22T23:30:00Z'))).toBe(
      '2026-10-23',
    );
    // 03:00 UTC on the 23rd is still 23:00 on Thursday the 22nd in New York.
    expect(
      resolveDateWords('today', at('2026-10-23T03:00:00Z', 'America/New_York')),
    ).toBe('2026-10-22');
    expect(
      resolveDateWords('Ende des Monats', at('2026-10-31T23:30:00Z')),
    ).toBe('2026-11-30');
  });

  describe('ROB-16 AC-2: "bis übermorgen" across the DST change on 2026-10-25', () => {
    it.each([
      // Friday 23:30 CEST → Sunday, the day the clocks go back.
      [VIENNA, '2026-10-23T21:30:00Z', '2026-10-25'],
      [BERLIN, '2026-10-23T21:30:00Z', '2026-10-25'],
      // Saturday 23:30 CEST → Monday.
      [VIENNA, '2026-10-24T21:30:00Z', '2026-10-26'],
      // Sunday 00:30 CEST, before the change (UTC is still on the 24th).
      [BERLIN, '2026-10-24T22:30:00Z', '2026-10-27'],
      // Sunday 23:30 CET, after the change: UTC+2 arithmetic would say Monday.
      [VIENNA, '2026-10-25T22:30:00Z', '2026-10-27'],
      [BERLIN, '2026-10-25T22:30:00Z', '2026-10-27'],
      // Monday 00:30 CET.
      [VIENNA, '2026-10-25T23:30:00Z', '2026-10-28'],
    ])('%s at %s → %s', (timezone, now, date) => {
      expect(resolveDateWords('bis übermorgen', at(now, timezone))).toBe(date);
    });
  });
});

describe('calendarDays', () => {
  it('lists today plus 42 days with English and German weekday names', () => {
    const days = calendarDays(VIENNA, THURSDAY_NOON);
    expect(days).toHaveLength(43);
    expect(days[0]).toEqual({
      date: '2026-10-22',
      en: 'Thursday',
      de: 'Donnerstag',
    });
    expect(days[42]).toEqual({
      date: '2026-12-03',
      en: 'Thursday',
      de: 'Donnerstag',
    });
  });

  it.each([VIENNA, BERLIN])(
    'has every day exactly once across the DST change in %s',
    (timezone) => {
      const days = calendarDays(timezone, new Date('2026-10-24T22:30:00Z'));
      expect(days.slice(0, 3)).toEqual([
        { date: '2026-10-25', en: 'Sunday', de: 'Sonntag' },
        { date: '2026-10-26', en: 'Monday', de: 'Montag' },
        { date: '2026-10-27', en: 'Tuesday', de: 'Dienstag' },
      ]);
      const dates = days.map((d) => d.date);
      expect(new Set(dates).size).toBe(43);
      for (let i = 1; i < dates.length; i++) {
        expect(Date.parse(dates[i]) - Date.parse(dates[i - 1])).toBe(
          86_400_000,
        );
      }
    },
  );

  it('handles the spring change too', () => {
    const days = calendarDays(BERLIN, new Date('2027-03-27T23:30:00Z'), 3);
    expect(days.map((d) => d.date)).toEqual([
      '2027-03-28',
      '2027-03-29',
      '2027-03-30',
    ]);
  });

  it('starts on the invoker’s day near local midnight', () => {
    expect(calendarDays(VIENNA, new Date('2026-10-22T22:30:00Z'), 1)).toEqual([
      { date: '2026-10-23', en: 'Friday', de: 'Freitag' },
    ]);
  });
});
