import { resolveEventWindow } from './google-calendar';

describe('resolveEventWindow', () => {
  const START = '2026-06-01T10:00:00Z';

  it('passes a valid end through untouched', () => {
    // Guards the non-regression case: an already-working config must produce the exact same
    // request body it did before the duration fallback existed.
    expect(
      resolveEventWindow({ start: START, end: '2026-06-01T11:30:00Z' }),
    ).toEqual({ start: START, end: '2026-06-01T11:30:00Z' });
  });

  it('derives the end from the default duration when end is missing', () => {
    expect(resolveEventWindow({ start: START })).toEqual({
      start: START,
      end: '2026-06-01T11:00:00.000Z',
    });
  });

  it('honours an explicit durationMinutes', () => {
    expect(resolveEventWindow({ start: START, durationMinutes: 15 })).toEqual({
      start: START,
      end: '2026-06-01T10:15:00.000Z',
    });
  });

  it('replaces an end equal to the start', () => {
    // The exact shape of the five built-in templates, and what produced the reported
    // "The specified time range is empty" failure.
    const { end } = resolveEventWindow({ start: START, end: START });

    expect(end).toBe('2026-06-01T11:00:00.000Z');
  });

  it('replaces an end that falls before the start', () => {
    const { end } = resolveEventWindow({
      start: START,
      end: '2026-05-30T09:00:00Z',
    });

    expect(end).toBe('2026-06-01T11:00:00.000Z');
  });

  it('replaces an end left as an unresolved placeholder', () => {
    const { end } = resolveEventWindow({
      start: START,
      end: '{{ trigger.task.due_date }}',
    });

    expect(end).toBe('2026-06-01T11:00:00.000Z');
  });

  it('keeps a derived end in the same frame as an offset-less start', () => {
    // An offset-less start is wall-clock in the event's timeZone. Emitting a Z-suffixed end here
    // would make the event the wrong length by that zone's offset.
    expect(
      resolveEventWindow({ start: '2026-06-01T10:00:00', durationMinutes: 30 }),
    ).toEqual({ start: '2026-06-01T10:00:00', end: '2026-06-01T10:30:00' });
  });

  it('throws naming the field when start is an unresolved placeholder', () => {
    expect(() =>
      resolveEventWindow({ start: '{{ trigger.task.due_date }}' }),
    ).toThrow(/"Start" is empty/);
  });

  it('throws when start is blank', () => {
    expect(() => resolveEventWindow({ start: '   ' })).toThrow(
      /"Start" is empty/,
    );
  });

  it('throws when start is not a parseable date', () => {
    expect(() => resolveEventWindow({ start: 'next tuesday' })).toThrow(
      /not a valid date\/time/,
    );
  });
});
