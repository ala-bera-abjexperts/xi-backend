/**
 * Robert 1.23: suggested dates. Worked out here, never by the model: working days are Monday to
 * Friday minus the organization's holidays; every date says where it comes from.
 */
import { addWorkingDays, suggestDates, workingDayOnOrAfter, type DateEdge, type DateItem } from './agent-plan-dates';

const item = (taskId: string, over: Partial<DateItem> = {}): DateItem => ({
  taskId,
  key: taskId.toUpperCase(),
  summary: taskId,
  itemType: 'task',
  start: null,
  end: null,
  duration: null,
  estimatedMinutes: null,
  robert: true,
  ...over,
});
const fs = (source: string, target: string, card: number | null = null): DateEdge => ({ source, target, type: 'finish_to_start', card });
const plan = { start: '2026-12-01', end: '2027-02-26' };
const none = new Set<string>();

describe('working days', () => {
  it('skips weekends and holidays', () => {
    expect(workingDayOnOrAfter('2026-12-05', none)).toBe('2026-12-07'); // Saturday → Monday
    expect(addWorkingDays('2026-12-04', 1, none)).toBe('2026-12-07'); // Friday + 1
    expect(addWorkingDays('2026-12-07', 0, none)).toBe('2026-12-07');
    expect(addWorkingDays('2026-12-23', 2, new Set(['2026-12-24', '2026-12-25']))).toBe('2026-12-29');
  });
});

describe('suggestDates', () => {
  it('an estimate from the plan start: 40 h = 5 working days, weekends skipped', () => {
    const out = suggestDates([item('a', { estimatedMinutes: 40 * 60 })], [], plan, none);
    expect(out.get('a')).toMatchObject({ state: 'robert', start: '2026-12-01', end: '2026-12-07', duration: 6 });
    expect(out.get('a')?.sources.map((s) => s.kind)).toEqual(['plan_start', 'estimate']);
    expect(out.get('a')?.sources[1]).toMatchObject({ hours: 40, days: 5 });
  });

  it('after a dated predecessor ends (finish to start), the next working day', () => {
    const items = [item('build', { start: '2026-12-01', end: '2026-12-11', robert: false }), item('pen', { estimatedMinutes: 16 * 60 })];
    const out = suggestDates(items, [fs('build', 'pen')], plan, none);
    expect(out.get('build')?.state).toBe('has_dates');
    expect(out.get('pen')).toMatchObject({ start: '2026-12-14', end: '2026-12-15' });
    expect(out.get('pen')?.sources[0]).toMatchObject({ kind: 'after_end', item: 'BUILD', date: '2026-12-11' });
  });

  it('a chain of undated items, and the dependency cards it relies on', () => {
    const items = [item('a', { estimatedMinutes: 480 }), item('b', { estimatedMinutes: 960 }), item('c', { itemType: 'milestone' })];
    const out = suggestDates(items, [fs('a', 'b', 4), fs('b', 'c', 5)], plan, none);
    expect(out.get('a')).toMatchObject({ start: '2026-12-01', end: '2026-12-01' });
    expect(out.get('b')).toMatchObject({ start: '2026-12-02', end: '2026-12-03', cards: [4] });
    // A milestone gets one date.
    expect(out.get('c')).toMatchObject({ start: '2026-12-04', end: '2026-12-04', duration: 0, cards: [5] });
  });

  it('the latest constraint wins; start to start, finish to finish and start to finish', () => {
    const items = [
      item('x', { start: '2026-12-07', end: '2026-12-18', robert: false }),
      item('y', { start: '2026-12-01', end: '2026-12-22', robert: false }),
      item('ss', { estimatedMinutes: 480 }),
      item('ff', { estimatedMinutes: 2 * 480 }),
      item('both', { estimatedMinutes: 480 }),
    ];
    const edges: DateEdge[] = [
      { source: 'x', target: 'ss', type: 'start_to_start', card: null },
      { source: 'y', target: 'ff', type: 'finish_to_finish', card: null },
      fs('x', 'both'),
      { source: 'y', target: 'both', type: 'start_to_start', card: null },
    ];
    const out = suggestDates(items, edges, plan, none);
    expect(out.get('ss')).toMatchObject({ start: '2026-12-07', end: '2026-12-07' });
    expect(out.get('ff')).toMatchObject({ start: '2026-12-21', end: '2026-12-22' });
    expect(out.get('both')).toMatchObject({ start: '2026-12-21' });
  });

  it('nothing to base a date on; a dependency without an estimate asks for the end', () => {
    const items = [item('lone'), item('dated', { start: '2026-12-01', end: '2026-12-02', robert: false }), item('noest')];
    const out = suggestDates(items, [fs('dated', 'noest')], plan, none);
    expect(out.get('lone')).toMatchObject({ state: 'nothing', start: null, end: null });
    expect(out.get('noest')).toMatchObject({ state: 'needs_end', start: '2026-12-03', end: null });
  });

  it("a person's item is worked out but marked as theirs (D3), and feeds what follows", () => {
    const items = [item('theirs', { robert: false, estimatedMinutes: 480 }), item('mine', { estimatedMinutes: 480 })];
    const out = suggestDates(items, [fs('theirs', 'mine')], plan, none);
    expect(out.get('theirs')).toMatchObject({ state: 'person', start: '2026-12-01' });
    expect(out.get('mine')).toMatchObject({ state: 'robert', start: '2026-12-02' });
  });

  it('an existing duration is in calendar days, as the plan stores it', () => {
    const out = suggestDates([item('d', { duration: 10 })], [], plan, none);
    expect(out.get('d')).toMatchObject({ start: '2026-12-01', end: '2026-12-11', duration: 10 });
    expect(out.get('d')?.sources[1]).toMatchObject({ kind: 'duration', days: 10 });
  });

  it('no plan start and no dependency: nothing; a cycle gets nothing and never loops', () => {
    expect(suggestDates([item('a', { estimatedMinutes: 480 })], [], { start: null, end: null }, none).get('a')?.state).toBe('nothing');
    const out = suggestDates([item('a', { estimatedMinutes: 480 }), item('b', { estimatedMinutes: 480 })], [fs('a', 'b'), fs('b', 'a')], plan, none);
    expect(out.get('a')?.state).toBe('nothing');
    expect(out.get('b')?.state).toBe('nothing');
  });

  it('an item after one that gets no date gets none either', () => {
    const out = suggestDates([item('lone'), item('after', { estimatedMinutes: 480 })], [fs('lone', 'after')], plan, none);
    expect(out.get('lone')?.state).toBe('nothing');
    expect(out.get('after')).toMatchObject({ state: 'nothing', start: null, end: null });
  });

  it('300 items in one pass', () => {
    const items = Array.from({ length: 300 }, (_, i) => item(`t${i}`, { estimatedMinutes: 480 }));
    const edges = items.slice(1).map((it, i) => fs(`t${i}`, it.taskId));
    const out = suggestDates(items, edges, plan, none);
    expect(out.get('t299')?.start).toBeTruthy();
  });
});
