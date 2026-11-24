/**
 * Tests for the projectconfig workflow-graph parser (pure — no DI, no jsdom).
 *
 * The primary fixture is the REAL response for "MIGTEST - SDP Complex Workflow v1", captured live
 * from Jira Server 8.22.4 and trimmed to the fields the parser reads. Its shape is the contract:
 * 16 statuses, 24 edges, 2 self-loops, no common/global transitions, a disconnected status, and no
 * explicit create transition. If Jira ever changes the payload, this suite fails before a live run
 * does.
 */

import { parseProjectConfigWorkflow } from './jira-workflow-graph.util';
import * as MIGTEST from './__fixtures__/projectconfig-workflow.migtest.json';

describe('parseProjectConfigWorkflow — the real MIGTEST fixture', () => {
  const parsed = parseProjectConfigWorkflow(MIGTEST);

  it('finds all 16 statuses, sources and targets alike', () => {
    expect(parsed.statusSourceIds).toHaveLength(16);
  });

  it('emits all 24 transitions — the faithful graph, not the all-to-all guess', () => {
    expect(parsed.transitions).toHaveLength(24);
  });

  it('preserves the two real self-loops', () => {
    const loops = parsed.transitions.filter(
      (t) => t.fromStatusSourceId === t.toStatusSourceId,
    );

    expect(loops.map((t) => t.name).sort()).toEqual([
      'Refresh QA Evidence',
      'Update Triage Notes',
    ]);
  });

  it('collapses nothing to global on this workflow — no transition covers every status', () => {
    expect(
      parsed.transitions.filter((t) => t.fromStatusSourceId === null),
    ).toHaveLength(0);
  });

  it('keeps real transition names, not invented "To X" labels', () => {
    const names = parsed.transitions.map((t) => t.name);

    expect(names).toContain('Begin Complex Lifecycle');
    expect(names).toContain('Submit for Triage');
    expect(names).toContain('Reject at Triage');
    expect(names.some((n) => n.startsWith('To '))).toBe(false);
  });

  it('infers the entry status: outgoing edges, no incoming ones ("To Do", id 10000)', () => {
    // The payload has NO create transition; the only faithful inference is the status work leaves
    // from but never returns to. On this workflow that is the classic "To Do".
    expect(parsed.initialStatusSourceId).toBe('10000');
  });

  it('records the screen per transition for the migration report', () => {
    expect(parsed.screensByTransition['Reject at Triage']).toBe(
      'Resolve Issue Screen',
    );
    // "Accept into Backlog" genuinely has no screen in the source.
    expect(parsed.screensByTransition['Accept into Backlog']).toBeUndefined();
  });

  it('parses the live fixture without warnings', () => {
    expect(parsed.warnings).toEqual([]);
  });

  it('keeps the disconnected status — the customer really built an unreachable "Escalated"', () => {
    // Faithfulness cuts both ways: a status with no edges at all still belongs to the workflow.
    const inEdges = new Set(
      parsed.transitions.flatMap((t) => [
        t.fromStatusSourceId,
        t.toStatusSourceId,
      ]),
    );
    const disconnected = parsed.statusSourceIds.filter(
      (id) => !inEdges.has(id),
    );

    expect(disconnected.length).toBeGreaterThan(0);
  });
});

describe('global collapse', () => {
  /** A 3-status graph where "Abort" is available from EVERY status. */
  const withGlobal = {
    sources: [
      {
        fromStatus: { id: 1, name: 'A' },
        targets: [
          { toStatus: { id: 2, name: 'B' }, transitionName: 'Advance' },
          { toStatus: { id: 3, name: 'C' }, transitionName: 'Abort' },
        ],
      },
      {
        fromStatus: { id: 2, name: 'B' },
        targets: [{ toStatus: { id: 3, name: 'C' }, transitionName: 'Abort' }],
      },
      {
        fromStatus: { id: 3, name: 'C' },
        targets: [{ toStatus: { id: 3, name: 'C' }, transitionName: 'Abort' }],
      },
    ],
  };

  it('collapses a transition reported from EVERY status into one global', () => {
    const parsed = parseProjectConfigWorkflow(withGlobal);
    const globals = parsed.transitions.filter(
      (t) => t.fromStatusSourceId === null,
    );

    expect(globals).toHaveLength(1);
    expect(globals[0]).toMatchObject({ name: 'Abort', toStatusSourceId: '3' });
    // The N per-source copies are gone; only Advance remains as a regular edge.
    expect(parsed.transitions).toHaveLength(2);
  });

  it('does NOT collapse at partial coverage — that would widen the workflow', () => {
    const partial = {
      sources: [
        {
          fromStatus: { id: 1 },
          targets: [{ toStatus: { id: 3 }, transitionName: 'Abort' }],
        },
        {
          fromStatus: { id: 2 },
          targets: [{ toStatus: { id: 3 }, transitionName: 'Abort' }],
        },
        // Status 3 exists but does NOT offer Abort: 2 of 3 sources is not global.
        { fromStatus: { id: 3 }, targets: [] },
      ],
    };
    const parsed = parseProjectConfigWorkflow(partial);

    expect(
      parsed.transitions.filter((t) => t.fromStatusSourceId === null),
    ).toHaveLength(0);
    expect(parsed.transitions).toHaveLength(2);
  });

  it('never collapses on a single-status graph, where "every status" is vacuous', () => {
    const single = {
      sources: [
        {
          fromStatus: { id: 1 },
          targets: [{ toStatus: { id: 1 }, transitionName: 'Spin' }],
        },
      ],
    };
    const parsed = parseProjectConfigWorkflow(single);

    expect(parsed.transitions[0].fromStatusSourceId).toBe('1');
  });
});

describe('tolerant reading — a malformed payload degrades, never throws', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty object', {}],
    ['a string', 'nope'],
    ['sources not an array', { sources: 42 }],
  ])('returns an empty graph for %s', (_label, raw) => {
    const parsed = parseProjectConfigWorkflow(raw);

    expect(parsed.transitions).toEqual([]);
    expect(parsed.statusSourceIds).toEqual([]);
    expect(parsed.initialStatusSourceId).toBeNull();
  });

  it('skips a source with no fromStatus id and says so', () => {
    const parsed = parseProjectConfigWorkflow({
      sources: [
        { targets: [{ toStatus: { id: 2 }, transitionName: 'X' }] },
        {
          fromStatus: { id: 1 },
          targets: [{ toStatus: { id: 2 }, transitionName: 'Go' }],
        },
      ],
    });

    expect(parsed.transitions).toHaveLength(1);
    expect(parsed.warnings.join(' ')).toContain('no fromStatus id');
  });

  it('skips a nameless or targetless transition and says so', () => {
    const parsed = parseProjectConfigWorkflow({
      sources: [
        {
          fromStatus: { id: 1 },
          targets: [
            { toStatus: { id: 2 } },
            { transitionName: 'Nowhere' },
            { toStatus: { id: 2 }, transitionName: 'Fine' },
          ],
        },
      ],
    });

    expect(parsed.transitions).toHaveLength(1);
    expect(parsed.transitions[0].name).toBe('Fine');
    expect(parsed.warnings).toHaveLength(2);
  });

  it('coerces numeric ids to strings, the crosswalk key space', () => {
    const parsed = parseProjectConfigWorkflow({
      sources: [
        {
          fromStatus: { id: 10004 },
          targets: [{ toStatus: { id: 3 }, transitionName: 'Go' }],
        },
      ],
    });

    expect(parsed.transitions[0]).toMatchObject({
      fromStatusSourceId: '10004',
      toStatusSourceId: '3',
    });
  });

  it('returns a null initial for a fully cyclic graph rather than guessing', () => {
    const parsed = parseProjectConfigWorkflow({
      sources: [
        {
          fromStatus: { id: 1 },
          targets: [{ toStatus: { id: 2 }, transitionName: 'A' }],
        },
        {
          fromStatus: { id: 2 },
          targets: [{ toStatus: { id: 1 }, transitionName: 'B' }],
        },
      ],
    });

    expect(parsed.initialStatusSourceId).toBeNull();
  });
});
