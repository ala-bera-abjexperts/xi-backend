/**
 * @fileoverview Unit tests for the workflow-health checks — each has a
 * fixture that triggers it and one that does not.
 * @module src/workflow-health/checks.spec
 * @author Rajbha Manek
 */
import {
  DanglingFieldGroupRefCheck,
  DanglingFieldRefCheck,
  DanglingGroupRoleRefCheck,
  DanglingResolutionRefCheck,
  DanglingUserRefCheck,
  DecisionNoElseCheck,
  DecisionNoOutgoingCheck,
  DoneStatusNoResolutionSetCheck,
  DuplicateTransitionNameCheck,
  InitialStatusMissingCheck,
  ReopenNoResolutionClearCheck,
  ShadowedGlobalTransitionCheck,
  StatusWithNoOutgoingCheck,
  UnreachableStatusCheck,
  ValidatorReferencesFieldNotOnScreenCheck,
  WorkflowEmptyCheck,
} from './checks';
import type {
  GraphNode,
  GraphTransition,
  LinterContext,
} from './workflow-health.types';
import type { IRuleReference } from '../workflow-engine/handlers/handler.types';

const node = (p: Partial<GraphNode> & { id: string }): GraphNode => ({
  kind: 'status',
  status_id: p.id + '-status',
  label: null,
  ...p,
});

const tx = (
  p: Partial<GraphTransition> & { id: string; to_node_id: string },
): GraphTransition => ({
  name: 'T',
  kind: 'regular',
  screen_field_group_id: null,
  conditions: [],
  validators: [],
  post_functions: [],
  triggers: [],
  sort_order: 0,
  ...p,
});

function makeCtx(p: Partial<LinterContext>): LinterContext {
  const nodes = p.nodes ?? [];
  const transitions = p.transitions ?? [];

  return {
    workflow: p.workflow ?? {
      id: 'wf',
      organization_id: 'org',
      initial_status_id: null,
    },
    nodes,
    nodeById: p.nodeById ?? new Map(nodes.map((n) => [n.id, n])),
    transitions,
    sourcesByTransition: p.sourcesByTransition ?? new Map<string, string[]>(),
    branches: p.branches ?? [],
    refsByTransition: p.refsByTransition ?? new Map<string, IRuleReference[]>(),
    validatorRefsByTransition:
      p.validatorRefsByTransition ?? new Map<string, IRuleReference[]>(),
    validRefIds: p.validRefIds ?? {},
    doneStatusIds: p.doneStatusIds ?? new Set(),
    screenFieldsByTransition:
      p.screenFieldsByTransition ?? new Map<string, Set<string>>(),
  };
}

describe('WorkflowEmptyCheck', () => {
  it('triggers when there are no status nodes', () => {
    expect(WorkflowEmptyCheck.run(makeCtx({ nodes: [] }))).toHaveLength(1);
  });
  it('passes with a status node', () => {
    expect(
      WorkflowEmptyCheck.run(makeCtx({ nodes: [node({ id: 'n1' })] })),
    ).toHaveLength(0);
  });
});

describe('InitialStatusMissingCheck', () => {
  it('triggers when initial_status_id is null', () => {
    expect(
      InitialStatusMissingCheck.run(makeCtx({ nodes: [node({ id: 'n1' })] })),
    ).toHaveLength(1);
  });
  it('passes when a status node matches the initial status', () => {
    const n = node({ id: 'n1', status_id: 's1' });

    expect(
      InitialStatusMissingCheck.run(
        makeCtx({
          nodes: [n],
          workflow: {
            id: 'wf',
            organization_id: 'org',
            initial_status_id: 's1',
          },
        }),
      ),
    ).toHaveLength(0);
  });
});

describe('DecisionNoOutgoingCheck', () => {
  const dec = node({
    id: 'd1',
    kind: 'decision',
    status_id: null,
    label: 'Sev?',
  });

  it('triggers for a decision with no branch', () => {
    expect(
      DecisionNoOutgoingCheck.run(makeCtx({ nodes: [dec], branches: [] })),
    ).toHaveLength(1);
  });
  it('passes when the decision has a branch', () => {
    expect(
      DecisionNoOutgoingCheck.run(
        makeCtx({
          nodes: [dec],
          branches: [
            {
              id: 'b1',
              decision_node_id: 'd1',
              to_node_id: 'n2',
              expression: null,
              label: null,
            },
          ],
        }),
      ),
    ).toHaveLength(0);
  });
});

describe('DecisionNoElseCheck', () => {
  const dec = node({
    id: 'd1',
    kind: 'decision',
    status_id: null,
    label: 'Sev?',
  });

  it('triggers when branches exist but none is else', () => {
    expect(
      DecisionNoElseCheck.run(
        makeCtx({
          nodes: [dec],
          branches: [
            {
              id: 'b1',
              decision_node_id: 'd1',
              to_node_id: 'n2',
              expression: { kind: 'field_equals' },
              label: null,
            },
          ],
        }),
      ),
    ).toHaveLength(1);
  });
  it('passes when an else branch exists', () => {
    expect(
      DecisionNoElseCheck.run(
        makeCtx({
          nodes: [dec],
          branches: [
            {
              id: 'b1',
              decision_node_id: 'd1',
              to_node_id: 'n2',
              expression: { kind: 'else' },
              label: null,
            },
          ],
        }),
      ),
    ).toHaveLength(0);
  });
});

describe('UnreachableStatusCheck', () => {
  it('triggers for a non-initial status with no incoming transition', () => {
    const a = node({ id: 'a', status_id: 'sa' });
    const b = node({ id: 'b', status_id: 'sb' });

    expect(
      UnreachableStatusCheck.run(
        makeCtx({
          nodes: [a, b],
          workflow: {
            id: 'wf',
            organization_id: 'org',
            initial_status_id: 'sa',
          },
          transitions: [],
        }),
      ).map((i) => i.node_id),
    ).toEqual(['b']);
  });
  it('passes when every non-initial status has an incoming transition', () => {
    const a = node({ id: 'a', status_id: 'sa' });
    const b = node({ id: 'b', status_id: 'sb' });

    expect(
      UnreachableStatusCheck.run(
        makeCtx({
          nodes: [a, b],
          workflow: {
            id: 'wf',
            organization_id: 'org',
            initial_status_id: 'sa',
          },
          transitions: [tx({ id: 't1', to_node_id: 'b' })],
        }),
      ),
    ).toHaveLength(0);
  });
});

describe('StatusWithNoOutgoingCheck', () => {
  it('triggers for a status with no outgoing and no global escape', () => {
    const a = node({ id: 'a', status_id: 'sa' });

    expect(
      StatusWithNoOutgoingCheck.run(makeCtx({ nodes: [a], transitions: [] })),
    ).toHaveLength(1);
  });
  it('passes when a global transition provides an escape', () => {
    const a = node({ id: 'a', status_id: 'sa' });

    expect(
      StatusWithNoOutgoingCheck.run(
        makeCtx({
          nodes: [a],
          transitions: [tx({ id: 'g', to_node_id: 'a', kind: 'global' })],
        }),
      ),
    ).toHaveLength(0);
  });
});

describe('Dangling reference checks', () => {
  const refs = (...r: IRuleReference[]) => new Map([['t1', r]]);
  const baseTx = [tx({ id: 't1', to_node_id: 'n2', name: 'Go' })];

  it('DanglingFieldRefCheck triggers when a field id is absent (error)', () => {
    const out = DanglingFieldRefCheck.run(
      makeCtx({
        transitions: baseTx,
        refsByTransition: refs({ kind: 'field', id: 'f-gone' }),
        validRefIds: { field: new Set() },
      }),
    );

    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('error');
  });
  it('DanglingFieldRefCheck passes when the field exists', () => {
    expect(
      DanglingFieldRefCheck.run(
        makeCtx({
          transitions: baseTx,
          refsByTransition: refs({ kind: 'field', id: 'f1' }),
          validRefIds: { field: new Set(['f1']) },
        }),
      ),
    ).toHaveLength(0);
  });
  it('DanglingFieldGroupRefCheck triggers when a field group id is absent (warning)', () => {
    const out = DanglingFieldGroupRefCheck.run(
      makeCtx({
        transitions: baseTx,
        refsByTransition: refs({ kind: 'field_group', id: 'fg-gone' }),
        validRefIds: { field_group: new Set() },
      }),
    );

    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('warning');
  });
  it('DanglingUserRefCheck triggers on a missing user (warning)', () => {
    const out = DanglingUserRefCheck.run(
      makeCtx({
        transitions: baseTx,
        refsByTransition: refs({ kind: 'user', id: 'u-gone' }),
        validRefIds: { user: new Set() },
      }),
    );

    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('warning');
  });
  it('DanglingGroupRoleRefCheck triggers on missing group or role', () => {
    expect(
      DanglingGroupRoleRefCheck.run(
        makeCtx({
          transitions: baseTx,
          refsByTransition: refs(
            { kind: 'group', id: 'g-gone' },
            { kind: 'role', id: 'r1' },
          ),
          validRefIds: { group: new Set(), role: new Set(['r1']) },
        }),
      ),
    ).toHaveLength(1);
  });
  it('DanglingResolutionRefCheck triggers on a missing resolution', () => {
    expect(
      DanglingResolutionRefCheck.run(
        makeCtx({
          transitions: baseTx,
          refsByTransition: refs({ kind: 'resolution', id: 'res-gone' }),
          validRefIds: { resolution: new Set() },
        }),
      ),
    ).toHaveLength(1);
  });
});

describe('DoneStatusNoResolutionSetCheck', () => {
  it('triggers landing in a done status without set_resolution', () => {
    const done = node({ id: 'done', status_id: 'sdone' });

    expect(
      DoneStatusNoResolutionSetCheck.run(
        makeCtx({
          nodes: [done],
          transitions: [tx({ id: 't1', to_node_id: 'done', name: 'Close' })],
          doneStatusIds: new Set(['sdone']),
        }),
      ),
    ).toHaveLength(1);
  });
  it('passes when set_resolution is present', () => {
    const done = node({ id: 'done', status_id: 'sdone' });

    expect(
      DoneStatusNoResolutionSetCheck.run(
        makeCtx({
          nodes: [done],
          transitions: [
            tx({
              id: 't1',
              to_node_id: 'done',
              name: 'Close',
              post_functions: [{ type: 'set_resolution', resolution_id: 'r1' }],
            }),
          ],
          doneStatusIds: new Set(['sdone']),
        }),
      ),
    ).toHaveLength(0);
  });

  it('ignores global self-loops because they keep the current task status', () => {
    const done = node({ id: 'done', status_id: 'sdone' });

    expect(
      DoneStatusNoResolutionSetCheck.run(
        makeCtx({
          nodes: [done],
          transitions: [
            tx({
              id: 't1',
              kind: 'global_loop',
              to_node_id: 'done',
              name: 'Update Done',
            }),
          ],
          doneStatusIds: new Set(['sdone']),
        }),
      ),
    ).toHaveLength(0);
  });
});

describe('ReopenNoResolutionClearCheck', () => {
  it('triggers leaving a done status to a non-done status without clear_resolution', () => {
    const doneNode = node({ id: 'done', status_id: 'sdone' });
    const openNode = node({ id: 'open', status_id: 'sopen' });
    const t = tx({ id: 't1', to_node_id: 'open', name: 'Reopen' });

    expect(
      ReopenNoResolutionClearCheck.run(
        makeCtx({
          nodes: [doneNode, openNode],
          transitions: [t],
          sourcesByTransition: new Map([['t1', ['done']]]),
          doneStatusIds: new Set(['sdone']),
        }),
      ),
    ).toHaveLength(1);
  });
  it('passes when clear_resolution is present', () => {
    const doneNode = node({ id: 'done', status_id: 'sdone' });
    const openNode = node({ id: 'open', status_id: 'sopen' });
    const t = tx({
      id: 't1',
      to_node_id: 'open',
      name: 'Reopen',
      post_functions: [{ type: 'clear_resolution' }],
    });

    expect(
      ReopenNoResolutionClearCheck.run(
        makeCtx({
          nodes: [doneNode, openNode],
          transitions: [t],
          sourcesByTransition: new Map([['t1', ['done']]]),
          doneStatusIds: new Set(['sdone']),
        }),
      ),
    ).toHaveLength(0);
  });

  it('triggers for a global transition to a non-done status because it can leave Done', () => {
    const openNode = node({ id: 'open', status_id: 'sopen' });
    const t = tx({
      id: 't1',
      kind: 'global',
      to_node_id: 'open',
      name: 'Reopen anywhere',
    });

    expect(
      ReopenNoResolutionClearCheck.run(
        makeCtx({
          nodes: [openNode],
          transitions: [t],
          doneStatusIds: new Set(['sdone']),
        }),
      ),
    ).toHaveLength(1);
  });

  it('passes for a global transition to a non-done status when clear_resolution is present', () => {
    const openNode = node({ id: 'open', status_id: 'sopen' });
    const t = tx({
      id: 't1',
      kind: 'global',
      to_node_id: 'open',
      name: 'Reopen anywhere',
      post_functions: [{ type: 'clear_resolution' }],
    });

    expect(
      ReopenNoResolutionClearCheck.run(
        makeCtx({
          nodes: [openNode],
          transitions: [t],
          doneStatusIds: new Set(['sdone']),
        }),
      ),
    ).toHaveLength(0);
  });

  it('ignores global self-loops because they do not leave the current status', () => {
    const doneNode = node({ id: 'done', status_id: 'sdone' });
    const openNode = node({ id: 'open', status_id: 'sopen' });
    const t = tx({
      id: 't1',
      kind: 'global_loop',
      to_node_id: 'open',
      name: 'Any Update',
    });

    expect(
      ReopenNoResolutionClearCheck.run(
        makeCtx({
          nodes: [doneNode, openNode],
          transitions: [t],
          sourcesByTransition: new Map([['t1', ['done']]]),
          doneStatusIds: new Set(['sdone']),
        }),
      ),
    ).toHaveLength(0);
  });
});

describe('ShadowedGlobalTransitionCheck', () => {
  it('triggers when a specific transition shares a global transition name', () => {
    expect(
      ShadowedGlobalTransitionCheck.run(
        makeCtx({
          transitions: [
            tx({ id: 'g', to_node_id: 'n', kind: 'global', name: 'Close' }),
            tx({ id: 's', to_node_id: 'n', kind: 'regular', name: 'Close' }),
          ],
        }),
      ),
    ).toHaveLength(1);
  });
  it('passes when names are distinct', () => {
    expect(
      ShadowedGlobalTransitionCheck.run(
        makeCtx({
          transitions: [
            tx({ id: 'g', to_node_id: 'n', kind: 'global', name: 'Close' }),
            tx({ id: 's', to_node_id: 'n', kind: 'regular', name: 'Start' }),
          ],
        }),
      ),
    ).toHaveLength(0);
  });
});

describe('DuplicateTransitionNameCheck', () => {
  it('triggers on duplicate names', () => {
    expect(
      DuplicateTransitionNameCheck.run(
        makeCtx({
          transitions: [
            tx({ id: 'a', to_node_id: 'n', name: 'Approve' }),
            tx({ id: 'b', to_node_id: 'n', name: 'Approve' }),
          ],
        }),
      ),
    ).toHaveLength(1);
  });
  it('passes on unique names', () => {
    expect(
      DuplicateTransitionNameCheck.run(
        makeCtx({
          transitions: [
            tx({ id: 'a', to_node_id: 'n', name: 'Approve' }),
            tx({ id: 'b', to_node_id: 'n', name: 'Reject' }),
          ],
        }),
      ),
    ).toHaveLength(0);
  });
});

describe('ValidatorReferencesFieldNotOnScreenCheck', () => {
  it('triggers when a validator field is not on the screen', () => {
    const t = tx({ id: 't1', to_node_id: 'n', screen_field_group_id: 'g1' });

    expect(
      ValidatorReferencesFieldNotOnScreenCheck.run(
        makeCtx({
          transitions: [t],
          validatorRefsByTransition: new Map([
            ['t1', [{ kind: 'field', id: 'f-missing' }]],
          ]),
          screenFieldsByTransition: new Map([['t1', new Set(['f-other'])]]),
        }),
      ),
    ).toHaveLength(1);
  });
  it('passes when the validator field is on the screen', () => {
    const t = tx({ id: 't1', to_node_id: 'n', screen_field_group_id: 'g1' });

    expect(
      ValidatorReferencesFieldNotOnScreenCheck.run(
        makeCtx({
          transitions: [t],
          validatorRefsByTransition: new Map([
            ['t1', [{ kind: 'field', id: 'f1' }]],
          ]),
          screenFieldsByTransition: new Map([['t1', new Set(['f1'])]]),
        }),
      ),
    ).toHaveLength(0);
  });
  it('passes when the transition has no screen', () => {
    const t = tx({ id: 't1', to_node_id: 'n', screen_field_group_id: null });

    expect(
      ValidatorReferencesFieldNotOnScreenCheck.run(
        makeCtx({
          transitions: [t],
          validatorRefsByTransition: new Map([
            ['t1', [{ kind: 'field', id: 'f-missing' }]],
          ]),
        }),
      ),
    ).toHaveLength(0);
  });
});
