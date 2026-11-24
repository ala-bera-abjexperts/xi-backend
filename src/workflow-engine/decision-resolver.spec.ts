/**
 * @fileoverview Unit tests for the workflow decision-resolver. Covers every
 * branch expression kind, type-aware equality coercion, the else-fallback
 * path, the no-match-no-else null (no-route) return, the depth-cap throw, and
 * nested-decision recursion. Direct tests on the resolver in isolation — the
 * engine integration tests cover the resolver indirectly when a transition's
 * to_node is a decision.
 * @module src/workflow-engine/decision-resolver.spec
 * @author Rajbha Manek
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  MAX_DECISION_DEPTH,
  evaluateBranchExpression,
  resolveDecision,
} from './decision-resolver';
import type { HandlerRegistryService } from './handlers/handler-registry.service';
import type { IEvaluationContext } from './handlers/handler.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ctx(
  customFieldValues: Record<string, unknown> = {},
): IEvaluationContext {
  return {
    organizationId: 'org-1',
    spaceId: null,
    taskId: 'task-1',
    task: null,
    transitionId: 'tx-1',
    transition: null,
    userId: 'user-1',
    user: null,
    userRoles: [],
    userGroups: [],
    customFieldValues,
    // R2: resolveDecision now requires workflow context (mandatory scoping).
    workflow: { id: 'wf-1' },
  };
}

interface IBranchSeed {
  id: string;
  decision_node_id: string;
  to_node_id: string;
  expression: Record<string, unknown>;
  sort_order: number;
  label?: string | null;
}

interface INodeSeed {
  id: string;
  kind: 'status' | 'decision' | 'start';
  status_id: string | null;
}

/**
 * Build a Supabase client mock pre-seeded with two tables:
 *   - workflow_decision_branches: returns branches for the queried decision id
 *   - workflow_nodes: returns the node matching the requested id
 */
function buildMockClient(opts: {
  branchesByDecision: Record<string, IBranchSeed[]>;
  nodesById: Record<string, INodeSeed>;
}): SupabaseClient {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};

    if (table === 'workflow_decision_branches') {
      let pendingId = '';
      chain.select = () => chain;
      chain.eq = (col: string, val: string) => {
        if (col === 'decision_node_id') pendingId = val;

        return chain;
      };
      chain.order = () =>
        Promise.resolve({
          data: opts.branchesByDecision[pendingId] ?? [],
          error: null,
        });

      return chain;
    }
    if (table === 'workflow_nodes') {
      let pendingId = '';
      chain.select = () => chain;
      chain.eq = (col: string, val: string) => {
        if (col === 'id') pendingId = val;

        return chain;
      };
      chain.maybeSingle = () =>
        Promise.resolve({
          data: opts.nodesById[pendingId] ?? null,
          error: null,
        });

      return chain;
    }
    throw new Error(`Unexpected from(${table})`);
  };

  return { from } as unknown as SupabaseClient;
}

const fakeRegistry = {} as unknown as HandlerRegistryService;

// ---------------------------------------------------------------------------
// evaluateBranchExpression
// ---------------------------------------------------------------------------

describe('evaluateBranchExpression', () => {
  it('always → true', () => {
    expect(evaluateBranchExpression({ kind: 'always' }, ctx())).toBe(true);
  });

  it('else → false (caller orchestrates else explicitly)', () => {
    expect(evaluateBranchExpression({ kind: 'else' }, ctx())).toBe(false);
  });

  it('field_equals: matches when current === target', () => {
    const result = evaluateBranchExpression(
      { kind: 'field_equals', field_id: 'f1', value: 'high' },
      ctx({ f1: 'high' }),
    );

    expect(result).toBe(true);
  });

  it('field_equals: mismatches when current !== target', () => {
    expect(
      evaluateBranchExpression(
        { kind: 'field_equals', field_id: 'f1', value: 'high' },
        ctx({ f1: 'low' }),
      ),
    ).toBe(false);
  });

  it('field_equals: undefined field → false', () => {
    expect(
      evaluateBranchExpression(
        { kind: 'field_equals', field_id: 'missing', value: 'x' },
        ctx(),
      ),
    ).toBe(false);
  });

  it('field_comparison: > and <', () => {
    const c = ctx({ score: 7 });

    expect(
      evaluateBranchExpression(
        { kind: 'field_comparison', field_id: 'score', op: '>', value: 5 },
        c,
      ),
    ).toBe(true);
    expect(
      evaluateBranchExpression(
        { kind: 'field_comparison', field_id: 'score', op: '<', value: 5 },
        c,
      ),
    ).toBe(false);
  });

  it('field_comparison: coerces stringy numbers', () => {
    expect(
      evaluateBranchExpression(
        { kind: 'field_comparison', field_id: 'score', op: '>=', value: 5 },
        ctx({ score: '5' }),
      ),
    ).toBe(true);
  });

  it('field_comparison: NaN comparand → false', () => {
    expect(
      evaluateBranchExpression(
        { kind: 'field_comparison', field_id: 'score', op: '>', value: 5 },
        ctx({ score: 'not-a-number' }),
      ),
    ).toBe(false);
  });

  it('field_in_set: matches when current is in array', () => {
    expect(
      evaluateBranchExpression(
        {
          kind: 'field_in_set',
          field_id: 'severity',
          values: ['low', 'medium', 'high'],
        },
        ctx({ severity: 'medium' }),
      ),
    ).toBe(true);
  });

  it('field_in_set: returns false when values is not an array', () => {
    expect(
      evaluateBranchExpression(
        { kind: 'field_in_set', field_id: 'x', values: 'oops' },
        ctx({ x: 'oops' }),
      ),
    ).toBe(false);
  });

  it('condition_group/all: AND semantics', () => {
    const expr = {
      kind: 'condition_group',
      op: 'all',
      children: [
        { kind: 'always' },
        { kind: 'field_equals', field_id: 'f1', value: 'a' },
      ],
    };

    expect(evaluateBranchExpression(expr, ctx({ f1: 'a' }))).toBe(true);
    expect(evaluateBranchExpression(expr, ctx({ f1: 'b' }))).toBe(false);
  });

  it('condition_group/any: OR semantics', () => {
    const expr = {
      kind: 'condition_group',
      op: 'any',
      children: [
        { kind: 'field_equals', field_id: 'f1', value: 'a' },
        { kind: 'field_equals', field_id: 'f1', value: 'b' },
      ],
    };

    expect(evaluateBranchExpression(expr, ctx({ f1: 'a' }))).toBe(true);
    expect(evaluateBranchExpression(expr, ctx({ f1: 'b' }))).toBe(true);
    expect(evaluateBranchExpression(expr, ctx({ f1: 'c' }))).toBe(false);
  });

  it('condition_group with empty children: all → true (vacuous), any → false', () => {
    expect(
      evaluateBranchExpression(
        { kind: 'condition_group', op: 'all', children: [] },
        ctx(),
      ),
    ).toBe(true);
    expect(
      evaluateBranchExpression(
        { kind: 'condition_group', op: 'any', children: [] },
        ctx(),
      ),
    ).toBe(false);
  });

  it('unknown kind → false (fail closed)', () => {
    expect(
      evaluateBranchExpression(
        { kind: 'sql_injection_lol' } as Record<string, unknown>,
        ctx(),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Type-aware equality (B1) — field_equals / field_in_set coercion
// ---------------------------------------------------------------------------

describe('evaluateBranchExpression — type-aware equality (B1)', () => {
  it('field_equals: numeric custom field vs string target coerces', () => {
    expect(
      evaluateBranchExpression(
        { kind: 'field_equals', field_id: 'score', value: '5' },
        ctx({ score: 5 }),
      ),
    ).toBe(true);
    expect(
      evaluateBranchExpression(
        { kind: 'field_equals', field_id: 'score', value: '6' },
        ctx({ score: 5 }),
      ),
    ).toBe(false);
  });

  it('field_equals: boolean custom field vs "true"/"false" coerces', () => {
    expect(
      evaluateBranchExpression(
        { kind: 'field_equals', field_id: 'flag', value: 'true' },
        ctx({ flag: true }),
      ),
    ).toBe(true);
    expect(
      evaluateBranchExpression(
        { kind: 'field_equals', field_id: 'flag', value: 'false' },
        ctx({ flag: true }),
      ),
    ).toBe(false);
  });

  it('field_equals: text field does NOT numeric-coerce ("007" ≠ "7")', () => {
    expect(
      evaluateBranchExpression(
        { kind: 'field_equals', field_id: 'code', value: '7' },
        ctx({ code: '007' }),
      ),
    ).toBe(false);
  });

  it('field_equals: reference id (string) still exact-matches unchanged', () => {
    expect(
      evaluateBranchExpression(
        {
          kind: 'field_equals',
          field_id: 'sys:priority_id',
          value: 'uuid-high',
        },
        { ...ctx(), task: { priority_id: 'uuid-high' } },
      ),
    ).toBe(true);
  });

  it('field_equals: sys date matches by yyyy-MM-dd prefix vs timestamptz', () => {
    expect(
      evaluateBranchExpression(
        { kind: 'field_equals', field_id: 'sys:due_date', value: '2026-07-10' },
        { ...ctx(), task: { due_date: '2026-07-10T22:00:00+00:00' } },
      ),
    ).toBe(true);
    expect(
      evaluateBranchExpression(
        { kind: 'field_equals', field_id: 'sys:due_date', value: '2026-07-11' },
        { ...ctx(), task: { due_date: '2026-07-10T22:00:00+00:00' } },
      ),
    ).toBe(false);
  });

  it('field_in_set: numeric membership coerces per element', () => {
    expect(
      evaluateBranchExpression(
        { kind: 'field_in_set', field_id: 'n', values: ['1', '2', '3'] },
        ctx({ n: 2 }),
      ),
    ).toBe(true);
    expect(
      evaluateBranchExpression(
        { kind: 'field_in_set', field_id: 'n', values: ['1', '3'] },
        ctx({ n: 2 }),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveDecision
// ---------------------------------------------------------------------------

describe('resolveDecision', () => {
  it('first branch matches → returns terminal status_id', async () => {
    const client = buildMockClient({
      branchesByDecision: {
        'dec-1': [
          {
            id: 'b1',
            decision_node_id: 'dec-1',
            to_node_id: 'node-status-A',
            expression: { kind: 'field_equals', field_id: 'f1', value: 'a' },
            sort_order: 0,
          },
        ],
      },
      nodesById: {
        'node-status-A': {
          id: 'node-status-A',
          kind: 'status',
          status_id: 'status-A',
        },
      },
    });

    const result = await resolveDecision(
      'dec-1',
      ctx({ f1: 'a' }),
      fakeRegistry,
      client,
      0,
    );

    expect(result).toBe('status-A');
  });

  it('no non-else branch matches → falls back to else target', async () => {
    const client = buildMockClient({
      branchesByDecision: {
        'dec-1': [
          {
            id: 'b1',
            decision_node_id: 'dec-1',
            to_node_id: 'node-A',
            expression: { kind: 'field_equals', field_id: 'f1', value: 'a' },
            sort_order: 0,
          },
          {
            id: 'b2',
            decision_node_id: 'dec-1',
            to_node_id: 'node-else',
            expression: { kind: 'else' },
            sort_order: 1,
          },
        ],
      },
      nodesById: {
        'node-else': {
          id: 'node-else',
          kind: 'status',
          status_id: 'status-else',
        },
      },
    });

    const result = await resolveDecision(
      'dec-1',
      ctx({ f1: 'unmatched' }),
      fakeRegistry,
      client,
      0,
    );

    expect(result).toBe('status-else');
  });

  it('no match + no else → returns null (no route; caller keeps current status)', async () => {
    const client = buildMockClient({
      branchesByDecision: {
        'dec-1': [
          {
            id: 'b1',
            decision_node_id: 'dec-1',
            to_node_id: 'node-A',
            expression: { kind: 'field_equals', field_id: 'f1', value: 'a' },
            sort_order: 0,
          },
        ],
      },
      nodesById: {},
    });

    await expect(
      resolveDecision('dec-1', ctx({ f1: 'b' }), fakeRegistry, client, 0),
    ).resolves.toBeNull();
  });

  it('null (no route) propagates through a nested decision', async () => {
    const client = buildMockClient({
      branchesByDecision: {
        'dec-outer': [
          {
            id: 'b1',
            decision_node_id: 'dec-outer',
            to_node_id: 'dec-inner',
            expression: { kind: 'always' },
            sort_order: 0,
          },
        ],
        // inner has a non-matching branch and no else → null
        'dec-inner': [
          {
            id: 'b2',
            decision_node_id: 'dec-inner',
            to_node_id: 'node-A',
            expression: { kind: 'field_equals', field_id: 'f1', value: 'a' },
            sort_order: 0,
          },
        ],
      },
      nodesById: {
        'dec-inner': { id: 'dec-inner', kind: 'decision', status_id: null },
      },
    });

    await expect(
      resolveDecision('dec-outer', ctx({ f1: 'b' }), fakeRegistry, client, 0),
    ).resolves.toBeNull();
  });

  it('depth > MAX_DECISION_DEPTH → throws "Decision chain too deep"', async () => {
    const client = buildMockClient({
      branchesByDecision: {},
      nodesById: {},
    });

    await expect(
      resolveDecision(
        'dec-1',
        ctx(),
        fakeRegistry,
        client,
        MAX_DECISION_DEPTH + 1,
      ),
    ).rejects.toThrow(/too deep/);
  });

  it('nested decisions → resolver recurses correctly', async () => {
    const client = buildMockClient({
      branchesByDecision: {
        'dec-outer': [
          {
            id: 'b1',
            decision_node_id: 'dec-outer',
            to_node_id: 'dec-inner', // target is another decision
            expression: { kind: 'always' },
            sort_order: 0,
          },
        ],
        'dec-inner': [
          {
            id: 'b2',
            decision_node_id: 'dec-inner',
            to_node_id: 'node-final',
            expression: { kind: 'always' },
            sort_order: 0,
          },
        ],
      },
      nodesById: {
        'dec-inner': { id: 'dec-inner', kind: 'decision', status_id: null },
        'node-final': {
          id: 'node-final',
          kind: 'status',
          status_id: 'status-final',
        },
      },
    });

    const result = await resolveDecision(
      'dec-outer',
      ctx(),
      fakeRegistry,
      client,
      0,
    );

    expect(result).toBe('status-final');
  });

  it('matched target is status node without status_id → throws', async () => {
    const client = buildMockClient({
      branchesByDecision: {
        'dec-1': [
          {
            id: 'b1',
            decision_node_id: 'dec-1',
            to_node_id: 'node-broken',
            expression: { kind: 'always' },
            sort_order: 0,
          },
        ],
      },
      nodesById: {
        // Malformed: status kind but null status_id
        'node-broken': {
          id: 'node-broken',
          kind: 'status',
          status_id: null,
        },
      },
    });

    await expect(
      resolveDecision('dec-1', ctx(), fakeRegistry, client, 0),
    ).rejects.toThrow(/missing status_id/);
  });

  it('matched target is `start` kind → throws (invalid)', async () => {
    const client = buildMockClient({
      branchesByDecision: {
        'dec-1': [
          {
            id: 'b1',
            decision_node_id: 'dec-1',
            to_node_id: 'node-start',
            expression: { kind: 'always' },
            sort_order: 0,
          },
        ],
      },
      nodesById: {
        'node-start': { id: 'node-start', kind: 'start', status_id: null },
      },
    });

    await expect(
      resolveDecision('dec-1', ctx(), fakeRegistry, client, 0),
    ).rejects.toThrow(/Invalid decision target kind/);
  });

  it('matched target node not found → throws', async () => {
    const client = buildMockClient({
      branchesByDecision: {
        'dec-1': [
          {
            id: 'b1',
            decision_node_id: 'dec-1',
            to_node_id: 'node-deleted',
            expression: { kind: 'always' },
            sort_order: 0,
          },
        ],
      },
      nodesById: {}, // node-deleted is missing
    });

    await expect(
      resolveDecision('dec-1', ctx(), fakeRegistry, client, 0),
    ).rejects.toThrow(/not found/);
  });
});
