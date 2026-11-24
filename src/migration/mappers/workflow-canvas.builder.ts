/**
 * @fileoverview Builds a `saveCanvas` payload from migrated statuses (+ an optional transition
 * graph). Pure — no DB, no DI — so the graph shape is unit-testable without a database.
 *
 * Two source realities, one builder:
 *  - **Jira Server** DOES expose the transition graph — but only through
 *    `/rest/projectconfig/1/workflow?workflowName=` (verified live against 8.22.4: 16 statuses, 24
 *    named transitions for the MIGTEST workflow). The public `/rest/api/2/workflow` still reports
 *    only `{name, description, steps, default}`, which is what an earlier version of this header
 *    took for the whole story. `jira-workflow-graph.util.ts` parses the projectconfig payload;
 *    `transitions: null` remains the fallback when that endpoint is unreadable, yielding the
 *    all-to-all graph — the honest reading of "we don't know the restrictions, so restrict nothing".
 *  - **Jira Cloud** exposes real transitions over its public REST → pass them the same way.
 *
 * All-to-all is modelled as one **global** transition per status ("available from any node"), not as
 * N×(N-1) regular edges. Same semantics, but O(N) instead of O(N²) — a literal pairwise expansion
 * blows the DTO's 1000-transition cap at ~32 statuses. Global transitions carry NO source rows:
 * `CanvasTransitionSourceDto.from_node_id` is a non-nullable UUID, so "from anywhere" can only be
 * expressed by the absence of sources.
 *
 * Node/transition ids are minted here; `upsert_workflow_canvas` DELETEs every existing node before
 * inserting this payload, so the start node auto-created by `WorkflowsService.create` is replaced by
 * the one below — it must be emitted, or the workflow would be left with no entry point.
 */

import { randomUUID } from 'node:crypto';

export interface CanvasStatusInput {
  /** Target `task_statuses.id` (already resolved through the crosswalk). */
  statusId: string;
  name: string;
  isCompleted: boolean;
  sortOrder: number;
}

export interface CanvasTransitionInput {
  /**
   * TARGET-side `task_statuses.id` the edge leaves from — the SAME id-space as `toStatusId` and
   * `CanvasStatusInput.statusId`, i.e. already resolved through the crosswalk by the caller.
   * `null` = a Jira global transition (available from every status).
   *
   * Named `fromStatusId`, not `fromStatusSourceId`: the old name implied a Jira SOURCE id, but the
   * lookup below resolves it against `nodeIdByStatus`, which is keyed by TARGET ids. A caller who
   * believed the old name would have every non-global edge silently dropped by the `!fromNode`
   * guard, leaving a workflow with only its `Create` transition.
   */
  fromStatusId: string | null;
  toStatusId: string;
  name: string;
}

interface CanvasNode {
  id: string;
  kind: 'status' | 'decision' | 'start';
  status_id: string | null;
  label: string | null;
  position_x: number;
  position_y: number;
  properties: Record<string, unknown>;
}

interface CanvasTransition {
  id: string;
  name: string;
  kind:
    | 'regular'
    | 'common'
    | 'global'
    | 'self_loop'
    | 'global_loop'
    | 'initial';
  to_node_id: string;
  screen_field_group_id: string | null;
  conditions: unknown[];
  validators: unknown[];
  post_functions: unknown[];
  triggers: unknown[];
  properties: Record<string, unknown>;
  sort_order: number;
}

export interface BuiltCanvas {
  /** The workflow's initial status — `workflow_assignments` 422s if this is null. */
  initialStatusId: string;
  version: number;
  initial_status_id: string;
  layout: Record<string, unknown>;
  nodes: CanvasNode[];
  transitions: CanvasTransition[];
  transition_sources: { transition_id: string; from_node_id: string }[];
  decision_branches: never[];
}

/** Mirrors `createFromStatuses`' grid so a migrated canvas opens looking like a native one. */
function statusPosition(index: number): {
  position_x: number;
  position_y: number;
} {
  return {
    position_x: 240 + (index % 4) * 220,
    position_y: 160 + Math.floor(index / 4) * 140,
  };
}

/**
 * @param statuses  Migrated statuses, target-side ids. Must be non-empty.
 * @param transitions `null` → all-to-all (Server); otherwise a faithful graph (Cloud).
 * @param version   Expected workflow version for the RPC's optimistic-concurrency check (1 for a
 *                  freshly created workflow).
 * @param onDropped Called once per edge dropped for referencing a status outside this workflow.
 *                  Silent drops are how fidelity loss hides — the stage should log these.
 */
export function buildWorkflowCanvas(
  statuses: CanvasStatusInput[],
  transitions: CanvasTransitionInput[] | null,
  version = 1,
  onDropped?: (reason: string) => void,
  /**
   * TARGET-side status id new issues should start on, when the source graph reveals it (a status
   * with outgoing edges and no incoming ones). Falls back to the first-non-done heuristic when
   * absent or not in this workflow's status set — a bad hint must degrade, not throw.
   */
  initialStatusId?: string | null,
): BuiltCanvas {
  if (statuses.length === 0)
    throw new Error('Cannot build a workflow canvas with no statuses');

  const ordered = [...statuses].sort((a, b) => a.sortOrder - b.sortOrder);

  // The source-derived entry point wins when usable; otherwise the native builder's rule — the
  // first non-done status is where new work starts.
  const hinted = initialStatusId
    ? ordered.find((s) => s.statusId === initialStatusId)
    : undefined;
  const initial = hinted ?? ordered.find((s) => !s.isCompleted) ?? ordered[0];

  const nodeIdByStatus = new Map<string, string>();

  for (const s of ordered) nodeIdByStatus.set(s.statusId, randomUUID());

  const startId = randomUUID();

  const nodes: CanvasNode[] = [
    {
      id: startId,
      kind: 'start',
      status_id: null,
      label: null,
      position_x: 40,
      position_y: 40,
      properties: {},
    },
    ...ordered.map((s, i) => ({
      id: nodeIdByStatus.get(s.statusId)!,
      kind: 'status' as const,
      status_id: s.statusId,
      label: null,
      ...statusPosition(i),
      properties: {},
    })),
  ];

  // The initial transition needs no source row — `kind:'initial'` implies the start node.
  const built: CanvasTransition[] = [
    {
      id: randomUUID(),
      name: 'Create',
      kind: 'initial',
      to_node_id: nodeIdByStatus.get(initial.statusId)!,
      screen_field_group_id: null,
      conditions: [],
      validators: [],
      post_functions: [],
      triggers: [],
      properties: {},
      sort_order: 0,
    },
  ];

  const sources: { transition_id: string; from_node_id: string }[] = [];

  if (transitions === null) {
    ordered.forEach((s, i) => {
      built.push({
        id: randomUUID(),
        name: `To ${s.name}`,
        kind: 'global',
        to_node_id: nodeIdByStatus.get(s.statusId)!,
        screen_field_group_id: null,
        conditions: [],
        validators: [],
        post_functions: [],
        triggers: [],
        properties: {},
        sort_order: i + 1,
      });
    });
  } else {
    transitions.forEach((t, i) => {
      const toNode = nodeIdByStatus.get(t.toStatusId);

      // A transition into a status this workflow doesn't own can't be drawn — dropping the edge
      // keeps the canvas valid, where emitting it would fail the whole save.
      if (!toNode) {
        onDropped?.(
          `transition "${t.name}": to-status ${t.toStatusId} is not in this workflow's status set`,
        );

        return;
      }

      const id = randomUUID();
      const isGlobal = t.fromStatusId === null;
      const isSelfLoop = !isGlobal && t.fromStatusId === t.toStatusId;
      const fromNode = isGlobal ? null : nodeIdByStatus.get(t.fromStatusId!);

      // An edge leaving a status this workflow doesn't own can't be drawn. Dropping it keeps the
      // canvas valid where emitting it would fail the whole save — but it is a real fidelity loss,
      // so it must never happen silently for a reason the caller could have fixed (e.g. handing us
      // a source-side id). `onDropped` lets the stage log it to migration_logs.
      if (!isGlobal && !fromNode) {
        onDropped?.(
          `transition "${t.name}" → status ${t.toStatusId}: from-status ${t.fromStatusId} is not in this workflow's status set`,
        );

        return;
      }

      built.push({
        id,
        // `workflow_transitions.name` is varchar(120); a longer source name must truncate here
        // rather than fail the whole canvas save.
        name: t.name.slice(0, 120),
        // `self_loop` is a first-class kind (save-canvas.dto.ts `@IsIn` accepts it, and
        // `upsert_workflow_canvas` does no from/to validation) — real workflows use loops for
        // "update notes"-style transitions that re-enter their own status.
        kind: isGlobal ? 'global' : isSelfLoop ? 'self_loop' : 'regular',
        to_node_id: toNode,
        screen_field_group_id: null,
        conditions: [],
        validators: [],
        post_functions: [],
        triggers: [],
        properties: {},
        sort_order: i + 1,
      });

      if (fromNode) sources.push({ transition_id: id, from_node_id: fromNode });
    });
  }

  return {
    initialStatusId: initial.statusId,
    version,
    initial_status_id: initial.statusId,
    layout: {},
    nodes,
    transitions: built,
    transition_sources: sources,
    decision_branches: [],
  };
}
