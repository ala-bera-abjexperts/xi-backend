import { SlaCalendar } from './sla.types';

const DAY = 86400000;
const HOUR = 3600000;
const MINUTE = 60000;
// Bounded caches include the entire calendar snapshot, never a mutable revision id.
const windowsCache = new Map<string, [number, number][]>();
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  const existing = formatters.get(timezone);
  if (existing) return existing;
  const result = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  if (formatters.size >= 128) formatters.clear();
  formatters.set(timezone, result);
  return result;
}

export function validateCalendar(input: unknown): SlaCalendar {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid SLA calendar');
  const calendar = input as SlaCalendar;
  if (
    typeof calendar.timezone !== 'string' ||
    !calendar.timezone ||
    /^[+-]/.test(calendar.timezone)
  )
    throw new Error('An IANA timezone is required');
  formatter(calendar.timezone);
  if (
    !calendar.weekly ||
    typeof calendar.weekly !== 'object' ||
    Array.isArray(calendar.weekly)
  )
    throw new Error('Invalid weekly intervals');
  for (const [day, intervals] of Object.entries(calendar.weekly)) {
    if (
      !/^[0-6]$/.test(day) ||
      !Array.isArray(intervals) ||
      intervals.length > 48
    )
      throw new Error('Invalid calendar day');
    const sorted = [...intervals].sort(
      (a, b) => a?.startMinute - b?.startMinute,
    );
    sorted.forEach((interval, index) => {
      if (
        !interval ||
        !Number.isInteger(interval.startMinute) ||
        !Number.isInteger(interval.endMinute) ||
        interval.startMinute < 0 ||
        interval.endMinute > 1440 ||
        interval.startMinute >= interval.endMinute ||
        (index > 0 && sorted[index - 1].endMinute > interval.startMinute)
      )
        throw new Error(
          'Invalid or overlapping working intervals; split overnight shifts across days',
        );
    });
  }
  if (
    !Array.isArray(calendar.holidays) ||
    calendar.holidays.length > 10000 ||
    calendar.holidays.some(
      (date) =>
        typeof date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date,
    )
  )
    throw new Error('Invalid holiday date');
  return {
    ...structuredClone(calendar),
    weekly: Object.fromEntries(
      Object.entries(calendar.weekly).map(([day, intervals]) => [
        day,
        [...intervals].sort((a, b) => a.startMinute - b.startMinute),
      ]),
    ),
  };
}

function offsetAt(format: Intl.DateTimeFormat, instant: number): number {
  const p = Object.fromEntries(
    format.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  const local = new Date(0);
  local.setUTCFullYear(Number(p.year), Number(p.month) - 1, Number(p.day));
  local.setUTCHours(Number(p.hour), Number(p.minute), Number(p.second), 0);
  return local.getTime() - Math.floor(instant / 1000) * 1000;
}

function dayWindows(
  calendar: SlaCalendar,
  day: number,
  key: string,
): [number, number][] {
  const cacheKey = `${key}:${day}`;
  const cached = windowsCache.get(cacheKey);
  if (cached) return cached;
  const format = formatter(calendar.timezone);
  const result: [number, number][] = [];
  let cursor = day;
  // IANA offset transitions are isolated by hourly probes; locate their exact ms.
  while (cursor < day + DAY) {
    const offset = offsetAt(format, cursor);
    let end = Math.min(cursor + HOUR, day + DAY);
    if (offsetAt(format, end - 1) !== offset) {
      let low = cursor,
        high = end - 1;
      while (low + 1 < high) {
        const mid = Math.floor((low + high) / 2);
        if (offsetAt(format, mid) === offset) low = mid;
        else high = mid;
      }
      end = high;
    }
    const localStart = cursor + offset;
    const localEnd = end + offset;
    for (
      let localDay = Math.floor(localStart / DAY) * DAY;
      localDay < localEnd;
      localDay += DAY
    ) {
      const date = new Date(localDay);
      if (calendar.holidays.includes(date.toISOString().slice(0, 10))) continue;
      for (const interval of calendar.weekly[date.getUTCDay()] ?? []) {
        const start = Math.max(
          cursor,
          localDay + interval.startMinute * MINUTE - offset,
        );
        const finish = Math.min(
          end,
          localDay + interval.endMinute * MINUTE - offset,
        );
        if (start < finish) result.push([start, finish]);
      }
    }
    cursor = end;
  }
  const merged = mergeWindows(result);
  if (windowsCache.size >= 4096) windowsCache.clear();
  windowsCache.set(cacheKey, merged);
  return merged;
}

function mergeWindows(windows: [number, number][]): [number, number][] {
  return [...windows]
    .sort((a, b) => a[0] - b[0])
    .reduce<[number, number][]>((all, window) => {
      const last = all[all.length - 1];
      return last && last[1] >= window[0]
        ? [...all.slice(0, -1), [last[0], Math.max(last[1], window[1])]]
        : [...all, window];
    }, []);
}

function validateRange(fromMs: number, toMs: number): void {
  if (
    ![fromMs, toMs].every(
      (n) => Number.isSafeInteger(n) && Math.abs(n) <= 8.64e15,
    ) ||
    toMs < fromMs ||
    toMs - fromMs > 36600 * DAY
  )
    throw new Error('Invalid SLA clock range (maximum 100 years)');
}

export function workingWindows(
  calendar: SlaCalendar,
  fromMs: number,
  toMs: number,
): [number, number][] {
  const validated = validateCalendar(calendar);
  validateRange(fromMs, toMs);
  if (fromMs === toMs) return [];
  const key = JSON.stringify(validated);
  const windows: [number, number][] = [];
  for (let day = Math.floor(fromMs / DAY) * DAY; day < toMs; day += DAY) {
    for (const [start, end] of dayWindows(validated, day, key)) {
      if (end > fromMs && start < toMs)
        windows.push([Math.max(start, fromMs), Math.min(end, toMs)]);
    }
  }
  return mergeWindows(windows);
}

export function businessMilliseconds(
  calendar: SlaCalendar,
  fromMs: number,
  toMs: number,
): number {
  return workingWindows(calendar, fromMs, toMs).reduce(
    (sum, [start, end]) => sum + end - start,
    0,
  );
}

export function advanceBusinessMilliseconds(
  calendar: SlaCalendar,
  fromMs: number,
  remainingMs: number,
  searchUntilMs: number,
): number | null {
  const validated = validateCalendar(calendar);
  validateRange(fromMs, searchUntilMs);
  if (!Number.isSafeInteger(remainingMs) || remainingMs < 0)
    throw new Error('Invalid remaining SLA milliseconds');
  if (remainingMs === 0) return fromMs;
  let remaining = remainingMs;
  const key = JSON.stringify(validated);
  for (
    let day = Math.floor(fromMs / DAY) * DAY;
    day < searchUntilMs;
    day += DAY
  ) {
    for (const [begin, finish] of dayWindows(validated, day, key)) {
      const start = Math.max(begin, fromMs),
        end = Math.min(finish, searchUntilMs);
      if (start >= end) continue;
      if (remaining <= end - start) return start + remaining;
      remaining -= end - start;
    }
  }
  return null;
}
