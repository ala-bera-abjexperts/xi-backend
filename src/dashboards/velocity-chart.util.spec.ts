import {
  buildVelocityBars,
  orderStartedSprints,
  parseStoryPoints,
  pickVelocitySprint,
  previousVelocityAverage,
  velocityWindow,
  type VelocitySprint,
} from './velocity-chart.util';

const sprint = (
  id: string,
  status: string,
  completed_at: string | null,
  start_date: string | null = null,
): VelocitySprint => ({
  id,
  name: `Sprint ${id}`,
  status,
  completed_at,
  start_date,
  created_at: '2026-01-01T00:00:00Z',
});

describe('velocity chart', () => {
  it('reads numbers and numeric strings, and rejects everything else', () => {
    expect(parseStoryPoints(5)).toBe(5);
    expect(parseStoryPoints(0)).toBe(0);
    expect(parseStoryPoints('2.5')).toBe(2.5);

    for (const bad of [null, undefined, '', ' ', 'abc', -1, true, {}, NaN]) {
      expect(parseStoryPoints(bad)).toBeNull();
    }
  });

  it('orders by date instead of sprint number and leaves out planning sprints', () => {
    const ordered = orderStartedSprints([
      sprint('active', 'active', null, '2026-03-01'),
      sprint('planned', 'planning', null),
      sprint('second', 'completed', '2026-02-01'),
      sprint('first', 'completed', '2026-01-15'),
    ]);

    expect(ordered.map((s) => s.id)).toEqual(['first', 'second', 'active']);
  });

  it('selects the requested sprint, then the latest completed, then the latest', () => {
    const first = sprint('first', 'completed', '2026-01-15');
    const active = sprint('active', 'active', null, '2026-03-01');

    expect(pickVelocitySprint([first, active], 'active')).toBe(active);
    expect(pickVelocitySprint([first, active], 'other-board')).toBe(first);
    expect(pickVelocitySprint([first, active])).toBe(first);
    expect(pickVelocitySprint([active])).toBe(active);
    expect(pickVelocitySprint([])).toBeUndefined();
  });

  it('charts the selected sprint and up to 9 before it, never later ones', () => {
    const ordered = Array.from({ length: 13 }, (_, i) =>
      sprint(
        String(i),
        'completed',
        `2026-01-${String(i + 1).padStart(2, '0')}`,
      ),
    );

    expect(velocityWindow(ordered, ordered[11]).map((s) => s.id)).toEqual([
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
      '11',
    ]);
    expect(velocityWindow(ordered, ordered[2]).map((s) => s.id)).toEqual([
      '0',
      '1',
      '2',
    ]);
  });

  it('tells a real 0 apart from missing estimates', () => {
    const bars = buildVelocityBars(
      [
        sprint('empty', 'completed', '2026-01-01'),
        sprint('missing', 'completed', '2026-01-02'),
        sprint('partial', 'completed', '2026-01-03'),
        sprint('zero', 'completed', '2026-01-04'),
      ],
      new Map<string, unknown[]>([
        ['missing', [null, undefined, 'abc']],
        ['partial', [3, '2', null]],
        ['zero', [0]],
      ]),
    );

    expect(
      bars.map((b) => [b.points, b.completedTasks, b.unestimatedTasks]),
    ).toEqual([
      [0, 0, 0],
      [null, 3, 3],
      [5, 3, 1],
      [0, 1, 0],
    ]);
  });

  it('adds fractional points without floating point noise', () => {
    const [bar] = buildVelocityBars(
      [sprint('a', 'completed', '2026-01-01')],
      new Map([['a', [0.1, 0.2]]]),
    );

    expect(bar.points).toBe(0.3);
  });

  it('averages earlier completed sprints with data, leaving out the selected one', () => {
    const bar = (points: number | null, status = 'completed') => ({
      id: 'x',
      name: 'x',
      status,
      points,
      completedTasks: 1,
      unestimatedTasks: 0,
    });

    expect(
      previousVelocityAverage([
        bar(10),
        bar(null),
        bar(99, 'active'),
        bar(20),
        bar(1000),
      ]),
    ).toBe(15);
    expect(previousVelocityAverage([bar(1000)])).toBeNull();
    expect(previousVelocityAverage([bar(null), bar(1000)])).toBeNull();
  });
});
