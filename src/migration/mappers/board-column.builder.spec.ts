/**
 * Tests for board column construction (pure — no DI, no jsdom).
 *
 * Every case here corresponds to a real database constraint or a real property of the live KAN
 * board. The fixtures are the actual Greenhopper response for board 2 at 167.233.94.130:8080, which
 * is why the two columns both named "Backlog" appear: that is not a contrived edge case, it is what
 * a default Jira Kanban board looks like, and it is what makes a name-based backlog rule fail.
 */

import { buildBoardColumns } from './board-column.builder';
import type { NormalizedBoardColumn } from '../model/normalized';

/** The live KAN board, as the Greenhopper editmodel reports it. */
const KAN_COLUMNS: NormalizedBoardColumn[] = [
  {
    name: 'Backlog',
    statusSourceIds: [],
    isKanbanBacklog: true,
    statuses: [],
  },
  {
    name: 'Backlog',
    statusSourceIds: ['10002'],
    isKanbanBacklog: false,
    statuses: [
      {
        sourceId: '10002',
        name: 'Backlog',
        categoryKey: 'new',
        isResolutionDone: false,
      },
    ],
  },
  {
    name: 'Selected for Development',
    statusSourceIds: ['10003'],
    statuses: [
      {
        sourceId: '10003',
        name: 'Selected for Development',
        categoryKey: 'new',
        isResolutionDone: false,
      },
    ],
  },
  {
    name: 'In Progress',
    statusSourceIds: ['3'],
    statuses: [
      {
        sourceId: '3',
        name: 'In Progress',
        categoryKey: 'indeterminate',
        isResolutionDone: false,
      },
    ],
  },
  {
    name: 'Done',
    statusSourceIds: ['10001'],
    statuses: [
      {
        sourceId: '10001',
        name: 'Done',
        categoryKey: 'done',
        isResolutionDone: true,
      },
    ],
  },
];

describe('buildBoardColumns — the live KAN board', () => {
  it('produces one write per column, in source order', () => {
    const { writes } = buildBoardColumns(KAN_COLUMNS);

    expect(writes.map((w) => w.name)).toEqual([
      'Backlog',
      'Backlog',
      'Selected for Development',
      'In Progress',
      'Done',
    ]);
    expect(writes.map((w) => w.sort_order)).toEqual([0, 1, 2, 3, 4]);
  });

  it('flags exactly ONE Kanban backlog, and it is the kanplan column not the named one', () => {
    const { writes } = buildBoardColumns(KAN_COLUMNS);
    const flagged = writes.filter((w) => w.is_kanban_backlog);

    expect(flagged).toHaveLength(1);
    // Both columns are called "Backlog"; only index 0 is the real kanplan column.
    expect(writes[0].is_kanban_backlog).toBe(true);
    expect(writes[1].is_kanban_backlog).toBe(false);
  });

  it('marks only the Done column as done', () => {
    const { writes } = buildBoardColumns(KAN_COLUMNS);

    expect(writes.filter((w) => w.is_done).map((w) => w.name)).toEqual([
      'Done',
    ]);
  });

  it('does NOT mark the empty kanplan column as done (the [].every() trap)', () => {
    // `[].every(fn)` is true, so a missing length guard would classify the statusless backlog
    // column as done and make every card look complete.
    const { writes } = buildBoardColumns(KAN_COLUMNS);

    expect(writes[0].is_done).toBe(false);
    expect(writes[0].doneEvidence).toBe('none');
  });

  it('never sets is_backlog, which is the Scrum sprint-backlog flag', () => {
    const { writes } = buildBoardColumns(KAN_COLUMNS);

    expect(writes.every((w) => w.is_backlog === false)).toBe(true);
  });

  it('reports no corrective notes for a healthy board', () => {
    expect(buildBoardColumns(KAN_COLUMNS).notes).toEqual([]);
  });
});

describe('the one-per-board partial unique indexes', () => {
  it('keeps only the FIRST kanban backlog when the source reports two', () => {
    const columns: NormalizedBoardColumn[] = [
      { name: 'A', statusSourceIds: [], isKanbanBacklog: true },
      { name: 'B', statusSourceIds: [], isKanbanBacklog: true },
    ];
    const { writes, notes } = buildBoardColumns(columns);

    expect(writes.map((w) => w.is_kanban_backlog)).toEqual([true, false]);
    expect(notes.join(' ')).toContain('second Kanban backlog');
  });

  it('treats a missing flag as false rather than undefined', () => {
    // The column write goes straight into an insert; undefined would drop the column default.
    const { writes } = buildBoardColumns([
      { name: 'A', statusSourceIds: ['1'] },
    ]);

    expect(writes[0].is_kanban_backlog).toBe(false);
  });
});

describe('WIP limits and board_columns_wip_check', () => {
  it('passes through a valid min/max pair', () => {
    const { writes } = buildBoardColumns([
      { name: 'A', statusSourceIds: [], minWip: 2, maxWip: 5 },
    ]);

    expect(writes[0]).toMatchObject({ min_wip: 2, max_wip: 5 });
  });

  it.each([
    ['an empty string (Greenhopper "unset")', ''],
    ['null', null],
    ['undefined', undefined],
    ['-1', -1],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['an object', {}],
  ])('coerces %s to 0', (_label, value) => {
    const { writes } = buildBoardColumns([
      {
        name: 'A',
        statusSourceIds: [],
        minWip: value as number,
        maxWip: value as number,
      },
    ]);

    expect(writes[0].min_wip).toBe(0);
    expect(writes[0].max_wip).toBe(0);
  });

  it('parses numeric strings, which Greenhopper sometimes sends', () => {
    const { writes } = buildBoardColumns([
      {
        name: 'A',
        statusSourceIds: [],
        minWip: '1' as unknown as number,
        maxWip: '4' as unknown as number,
      },
    ]);

    expect(writes[0]).toMatchObject({ min_wip: 1, max_wip: 4 });
  });

  it('floors a fractional limit rather than sending it to an integer column', () => {
    const { writes } = buildBoardColumns([
      { name: 'A', statusSourceIds: [], maxWip: 3.7 },
    ]);

    expect(writes[0].max_wip).toBe(3);
  });

  it('resolves an inverted pair by keeping the max and clearing the min', () => {
    const { writes, notes } = buildBoardColumns([
      { name: 'A', statusSourceIds: [], minWip: 9, maxWip: 2 },
    ]);

    expect(writes[0]).toMatchObject({ min_wip: 0, max_wip: 2 });
    expect(notes.join(' ')).toContain('WIP min 9 exceeded max 2');
  });

  it('never emits a pair that violates the CHECK constraint', () => {
    const nasty: NormalizedBoardColumn[] = [
      { name: 'a', statusSourceIds: [], minWip: 9, maxWip: 2 },
      { name: 'b', statusSourceIds: [], minWip: -5, maxWip: -5 },
      { name: 'c', statusSourceIds: [], minWip: 0, maxWip: 7 },
      { name: 'd', statusSourceIds: [], minWip: 3, maxWip: 0 },
    ];

    for (const w of buildBoardColumns(nasty).writes) {
      expect(w.min_wip).toBeGreaterThanOrEqual(0);
      expect(w.max_wip).toBeGreaterThanOrEqual(0);
      expect(w.max_wip === 0 || w.min_wip === 0 || w.max_wip >= w.min_wip).toBe(
        true,
      );
    }
  });
});

describe('is_done evidence', () => {
  it('uses resolution evidence when Jira reports it', () => {
    const { writes } = buildBoardColumns([
      {
        name: 'Done',
        statusSourceIds: ['1'],
        statuses: [{ sourceId: '1', isResolutionDone: true }],
      },
    ]);

    expect(writes[0]).toMatchObject({
      is_done: true,
      doneEvidence: 'resolution',
    });
  });

  it('falls back to the status category when resolution evidence is absent', () => {
    // The degraded path: no `isResolutionDone`, but the category still says done.
    const { writes } = buildBoardColumns([
      {
        name: 'Done',
        statusSourceIds: ['1'],
        statuses: [{ sourceId: '1', categoryKey: 'done' }],
      },
    ]);

    expect(writes[0]).toMatchObject({
      is_done: true,
      doneEvidence: 'category',
    });
  });

  it('requires EVERY status in the column to be done', () => {
    // A column holding both Done and In Progress is not a done column.
    const { writes } = buildBoardColumns([
      {
        name: 'Mixed',
        statusSourceIds: ['1', '2'],
        statuses: [
          { sourceId: '1', isResolutionDone: true },
          { sourceId: '2', isResolutionDone: false },
        ],
      },
    ]);

    expect(writes[0].is_done).toBe(false);
  });

  it('is false when no status evidence was reported at all', () => {
    // Jira Cloud, where the Greenhopper editmodel does not exist.
    const { writes } = buildBoardColumns([
      { name: 'Done', statusSourceIds: ['1'] },
    ]);

    expect(writes[0]).toMatchObject({ is_done: false, doneEvidence: 'none' });
  });
});

describe('empty input', () => {
  it('returns empty writes and no notes', () => {
    expect(buildBoardColumns([])).toEqual({ writes: [], notes: [] });
  });
});
