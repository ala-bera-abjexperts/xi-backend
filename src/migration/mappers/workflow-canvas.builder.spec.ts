/**
 * P5 workflow-canvas builder unit tests (pure — no DB, no DI).
 *
 * These encode constraints that are otherwise only discoverable at runtime, each verified against
 * real code:
 *  - `upsert_workflow_canvas` DELETEs every node before inserting → the auto start node from
 *    `WorkflowsService.create()` is destroyed, so the payload MUST carry its own.
 *  - `CanvasTransitionSourceDto.from_node_id` is a non-nullable `@IsUUID()` → "from anywhere" can
 *    only be expressed by the ABSENCE of a source row.
 *  - `SaveCanvasDto` caps transitions at 1000 → a pairwise O(N²) expansion blows it at ~32 statuses.
 *  - `SaveCanvasDto` requires `version` and `decision_branches`; nodes require position_x/position_y.
 *  - Omitting `initial_status_id` NULLs it, which later 422s `WorkflowAssignmentsService.create`.
 */

import {
  buildWorkflowCanvas,
  type CanvasStatusInput,
} from './workflow-canvas.builder';

const MAX_TRANSITIONS = 1000; // save-canvas.dto.ts:27
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const status = (
  statusId: string,
  name: string,
  sortOrder: number,
  isCompleted = false,
): CanvasStatusInput => ({ statusId, name, isCompleted, sortOrder });

const THREE: CanvasStatusInput[] = [
  status('s-open', 'Open', 0),
  status('s-prog', 'In Progress', 1),
  status('s-done', 'Done', 2, true),
];

describe('P5 workflow canvas builder', () => {
  it('throws rather than emit a canvas with no statuses', () => {
    expect(() => buildWorkflowCanvas([], null)).toThrow(/no statuses/i);
  });

  describe('start node (upsert_workflow_canvas wipes the auto-created one)', () => {
    it('emits exactly one start node, so the workflow keeps an entry point', () => {
      const c = buildWorkflowCanvas(THREE, null);
      const starts = c.nodes.filter((n) => n.kind === 'start');

      expect(starts).toHaveLength(1);
      expect(starts[0].status_id).toBeNull();
    });

    it('emits one status node per status, each with a real status_id and numeric positions', () => {
      const c = buildWorkflowCanvas(THREE, null);
      const statusNodes = c.nodes.filter((n) => n.kind === 'status');

      expect(statusNodes).toHaveLength(3);
      expect(statusNodes.map((n) => n.status_id).sort()).toEqual([
        's-done',
        's-open',
        's-prog',
      ]);

      // position_x/position_y are REQUIRED @IsNumber on the DTO — validation rejects before the
      // RPC's COALESCE could save us.
      for (const n of c.nodes) {
        expect(typeof n.position_x).toBe('number');
        expect(typeof n.position_y).toBe('number');
        expect(Number.isFinite(n.position_x)).toBe(true);
        expect(Number.isFinite(n.position_y)).toBe(true);
      }
    });

    it('mints valid UUIDs for every node id', () => {
      const c = buildWorkflowCanvas(THREE, null);

      for (const n of c.nodes) expect(n.id).toMatch(UUID_RE);
    });
  });

  describe('initial status (null → assignments 422 later)', () => {
    it('picks the first non-completed status by sort order', () => {
      const c = buildWorkflowCanvas(THREE, null);

      expect(c.initialStatusId).toBe('s-open');
      expect(c.initial_status_id).toBe('s-open');
    });

    it('falls back to the first status when every status is completed', () => {
      const allDone = [
        status('a', 'Done', 0, true),
        status('b', 'Closed', 1, true),
      ];

      expect(buildWorkflowCanvas(allDone, null).initial_status_id).toBe('a');
    });

    it('respects sortOrder, not array order', () => {
      const shuffled = [status('z', 'Later', 5), status('a', 'First', 0)];

      expect(buildWorkflowCanvas(shuffled, null).initial_status_id).toBe('a');
    });

    it('always emits a non-null initial_status_id', () => {
      expect(buildWorkflowCanvas(THREE, null).initial_status_id).toBeTruthy();
    });
  });

  describe('initial transition', () => {
    it('emits exactly one initial transition, pointing at the initial status', () => {
      const c = buildWorkflowCanvas(THREE, null);
      const initial = c.transitions.filter((t) => t.kind === 'initial');
      const openNode = c.nodes.find((n) => n.status_id === 's-open')!;

      expect(initial).toHaveLength(1);
      expect(initial[0].to_node_id).toBe(openNode.id);
    });

    it('gives the initial transition NO source row (from_node_id is non-nullable)', () => {
      const c = buildWorkflowCanvas(THREE, null);
      const initial = c.transitions.find((t) => t.kind === 'initial')!;

      expect(
        c.transition_sources.some((s) => s.transition_id === initial.id),
      ).toBe(false);
    });
  });

  describe('Server (transitions: null) → one GLOBAL transition per status, O(N)', () => {
    it('emits one global per status plus the initial, and zero source rows', () => {
      const c = buildWorkflowCanvas(THREE, null);

      expect(c.transitions.filter((t) => t.kind === 'global')).toHaveLength(3);
      expect(c.transitions).toHaveLength(4); // 3 global + 1 initial
      expect(c.transition_sources).toEqual([]);
    });

    it('stays O(N): 40 statuses fit the 1000 cap that a pairwise expansion would blow', () => {
      const many = Array.from({ length: 40 }, (_, i) =>
        status(`s${i}`, `S${i}`, i),
      );
      const c = buildWorkflowCanvas(many, null);

      // Pairwise would be 40*39 = 1560 > 1000 → the whole save would fail DTO validation.
      expect(c.transitions.length).toBe(41);
      expect(c.transitions.length).toBeLessThanOrEqual(MAX_TRANSITIONS);
      expect(c.transition_sources).toEqual([]);
    });
  });

  describe('Cloud (real graph) — target-side ids, sources only for non-global edges', () => {
    it('emits a source row for a regular edge and none for a global edge', () => {
      const c = buildWorkflowCanvas(THREE, [
        { fromStatusId: 's-open', toStatusId: 's-prog', name: 'Start' },
        { fromStatusId: null, toStatusId: 's-done', name: 'Resolve' },
      ]);
      const regular = c.transitions.find((t) => t.name === 'Start')!;
      const global = c.transitions.find((t) => t.name === 'Resolve')!;
      const openNode = c.nodes.find((n) => n.status_id === 's-open')!;

      expect(regular.kind).toBe('regular');
      expect(c.transition_sources).toContainEqual({
        transition_id: regular.id,
        from_node_id: openNode.id,
      });

      expect(global.kind).toBe('global');
      expect(
        c.transition_sources.some((s) => s.transition_id === global.id),
      ).toBe(false);
    });

    it('every transition_sources.from_node_id is a real node id (FK-safe, never null)', () => {
      const c = buildWorkflowCanvas(THREE, [
        { fromStatusId: 's-open', toStatusId: 's-prog', name: 'Start' },
        { fromStatusId: 's-prog', toStatusId: 's-done', name: 'Finish' },
      ]);
      const nodeIds = new Set(c.nodes.map((n) => n.id));

      expect(c.transition_sources).toHaveLength(2);
      for (const s of c.transition_sources) {
        expect(nodeIds.has(s.from_node_id)).toBe(true);
        expect(s.from_node_id).toMatch(UUID_RE);
      }
    });

    it('reports dropped edges instead of losing them silently (the id-space trap)', () => {
      const dropped: string[] = [];

      // '10001' is a Jira SOURCE id — the old field name (fromStatusSourceId) invited exactly this.
      const c = buildWorkflowCanvas(
        THREE,
        [{ fromStatusId: '10001', toStatusId: 's-done', name: 'Ghost' }],
        1,
        (r) => dropped.push(r),
      );

      expect(c.transitions.filter((t) => t.kind === 'regular')).toHaveLength(0);
      expect(dropped).toHaveLength(1);
      expect(dropped[0]).toContain('10001');
    });

    it('reports an edge dropped for an unknown to-status', () => {
      const dropped: string[] = [];

      buildWorkflowCanvas(
        THREE,
        [
          {
            fromStatusId: 's-open',
            toStatusId: 'not-in-workflow',
            name: 'Nowhere',
          },
        ],
        1,
        (r) => dropped.push(r),
      );

      expect(dropped).toHaveLength(1);
      expect(dropped[0]).toContain('not-in-workflow');
    });
  });

  describe('SaveCanvasDto required fields', () => {
    it('carries version (min 1) and defaults to 1 for a freshly created workflow', () => {
      expect(buildWorkflowCanvas(THREE, null).version).toBe(1);
      expect(buildWorkflowCanvas(THREE, null, 7).version).toBe(7);
    });

    it('always includes decision_branches (required; [] is valid)', () => {
      expect(buildWorkflowCanvas(THREE, null).decision_branches).toEqual([]);
    });

    it('gives every transition a unique UUID id', () => {
      const c = buildWorkflowCanvas(THREE, null);
      const ids = c.transitions.map((t) => t.id);

      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(UUID_RE);
    });
  });
});
