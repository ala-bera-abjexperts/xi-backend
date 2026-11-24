/**
 * @fileoverview Dates in the invoker's own day (plan 2f). Pure.
 *
 * "Today" is the calendar day at `now` in the invoker's IANA timezone (Intl), so 23:30 in Vienna
 * is still that day even when UTC has moved on. From there everything is whole-day arithmetic on
 * civil dates (held as UTC midnights), which no daylight-saving change can shift.
 *
 * 1.13 uses this for the prompt calendar and the "bis übermorgen" check (ROB-16 AC-2);
 * 1.14 uses resolveDateWords for due dates.
 * @module src/chat-agent/pipeline/agent-dates
 */

export interface DateContext {
  timezone: string;
  now: Date;
}

export interface CalendarDay {
  /** YYYY-MM-DD */
  date: string;
  en: string;
  de: string;
}

const DAY_MS = 86_400_000;

const WEEKDAYS_EN = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
const WEEKDAYS_DE = [
  'Sonntag',
  'Montag',
  'Dienstag',
  'Mittwoch',
  'Donnerstag',
  'Freitag',
  'Samstag',
];

// Index = month - 1. Austrian Jänner/Feber beside the German and English names.
const MONTH_WORDS = [
  ['jänner', 'januar', 'january', 'jan'],
  ['feber', 'februar', 'february', 'feb'],
  ['märz', 'maerz', 'march', 'mar'],
  ['april', 'apr'],
  ['mai', 'may'],
  ['juni', 'june', 'jun'],
  ['juli', 'july', 'jul'],
  ['august', 'aug'],
  ['september', 'sept', 'sep'],
  ['oktober', 'october', 'okt', 'oct'],
  ['november', 'nov'],
  ['dezember', 'december', 'dez', 'dec'],
];

/** The invoker's calendar day at `now`, as a UTC midnight. */
function localToday({ timezone, now }: DateContext): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
}

const addDays = (day: Date, n: number) => new Date(day.getTime() + n * DAY_MS);
const iso = (day: Date) => day.toISOString().slice(0, 10);

/** Today plus the next `days - 1` days, in the invoker's timezone. */
export function calendarDays(
  timezone: string,
  now: Date,
  days = 43,
): CalendarDay[] {
  const today = localToday({ timezone, now });
  return Array.from({ length: days }, (_, i) => {
    const day = addDays(today, i);
    const wd = day.getUTCDay();
    return { date: iso(day), en: WEEKDAYS_EN[wd], de: WEEKDAYS_DE[wd] };
  });
}

// \b is ASCII-only, so "morgen" would match inside "übermorgen"; letters decide word edges here.
const word = (alternatives: string) =>
  new RegExp(`(?<!\\p{L})(?:${alternatives})(?!\\p{L})`, 'u');

const RELATIVE: [RegExp, number][] = [
  [word('übermorgen|uebermorgen|day after tomorrow'), 2],
  [word('vorgestern|day before yesterday'), -2],
  [word('heute|today'), 0],
  [word('morgen|tomorrow'), 1],
  [word('gestern|yesterday'), -1],
];

const END_OF_MONTH = word(
  'ende des monats|monatsende|ende (?:dieses|des) monats|end of (?:the )?month',
);

const WEEKDAY_WORDS = [...WEEKDAYS_EN, ...WEEKDAYS_DE].map((d) =>
  d.toLowerCase(),
);
const WEEKDAY = word(`${WEEKDAY_WORDS.join('|')}`);

const MONTH_ALT = MONTH_WORDS.flat().join('|');
// "15. März", "15 march", "15th of March", "March 15", "march 15th"
// A year right after: "15 Oct 2028", "15. März 2026", "March 15, 2027".
const YEAR = `(?:,?\\s*(\\d{4})(?!\\d))?`;
const DAY_MONTH = word(
  `(?<!\\d)(\\d{1,2})(?:\\.|st|nd|rd|th)?\\s*(?:of\\s+)?(${MONTH_ALT})\\.?${YEAR}`,
);
// The day never runs into more digits: "June 2027" is a month and a year, not 20 June.
const MONTH_DAY = word(
  `(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?${YEAR}`,
);
// A week counted forward ("nächste Woche Freitag", "in 2 Wochen", "übernächsten Freitag",
// "Friday next week"): the words alone do not say which day, so the model's date stands.
const WEEKS_AHEAD = word(
  'nächste[nrs]? woche|naechste[nrs]? woche|kommende[nrs]? woche|übernächste[nrs]?|uebernaechste[nrs]?|in (?:\\d+|zwei|drei|vier|two|three|four) (?:wochen|weeks?)|next week|week after next',
);

function monthIndex(name: string): number {
  return MONTH_WORDS.findIndex((names) => names.includes(name));
}

/**
 * The next date (today included) with this month and day, or the date in the year said; null when
 * the day does not exist.
 */
function nextDayOfMonth(
  today: Date,
  month: number,
  day: number,
  said?: string,
): string | null {
  if (said) {
    const date = new Date(Date.UTC(Number(said), month, day));
    return date.getUTCMonth() === month ? iso(date) : null;
  }
  for (const year of [today.getUTCFullYear(), today.getUTCFullYear() + 1]) {
    const date = new Date(Date.UTC(year, month, day));
    if (date.getUTCMonth() !== month) continue; // 30 February, or 29 February off a leap year
    if (date >= today) return iso(date);
  }
  return null;
}

/**
 * The date one German, Austrian or English phrase means, in the invoker's timezone, or null.
 * A weekday ("Freitag", "bis Freitag", "nächsten Freitag", "next Friday") is the next one after
 * today, so said on a Friday it is a week away. A day and month is the next such date, today
 * included. "Ende des Monats" / "end of month" is the last day of the current month.
 * ponytail: the first match wins and "Guten Morgen" reads as tomorrow; 1.14 shows the words it
 * read beside the date ("said"), which is where a wrong guess gets corrected.
 */
export function resolveDateWords(
  text: string,
  ctx: DateContext,
): string | null {
  const lower = text.normalize('NFC').toLowerCase();
  const today = localToday(ctx);

  if (WEEKS_AHEAD.test(lower)) return null;

  const dm = DAY_MONTH.exec(lower);
  if (dm) return nextDayOfMonth(today, monthIndex(dm[2]), Number(dm[1]), dm[3]);
  const md = MONTH_DAY.exec(lower);
  if (md) return nextDayOfMonth(today, monthIndex(md[1]), Number(md[2]), md[3]);

  if (END_OF_MONTH.test(lower)) {
    return iso(
      new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)),
    );
  }

  for (const [pattern, offset] of RELATIVE) {
    if (pattern.test(lower)) return iso(addDays(today, offset));
  }

  const wd = WEEKDAY.exec(lower);
  if (wd) {
    const target = WEEKDAY_WORDS.indexOf(wd[0]) % 7;
    const ahead = (target - today.getUTCDay() + 7) % 7 || 7;
    return iso(addDays(today, ahead));
  }
  return null;
}
