/**
 * @fileoverview Walk a workflow decision-node chain to its terminal status.
 * Each decision node has a sort_order-ordered list of `workflow_decision_branches`
 * whose `expression` JSON describes a branch predicate (always / else /
 * field_equals / field_comparison / field_in_set / condition_group). The
 * resolver evaluates branches in order, follows the first match (recursing
 * into nested decision targets up to {@link MAX_DECISION_DEPTH}), and returns
 * the terminal status_id. Throws on cycles, deep chains, or no-match-no-else.
 * @module src/workflow-engine/decision-resolver
 * @author Rajbha Manek
 */

import { BadRequestException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { HandlerRegistryService } from './handlers/handler-registry.service';
import type { IEvaluationContext } from './handlers/handler.types';
import {
  coerceOrderable,
  getSystemField,
  resolveFieldValue,
  valuesEqual,
} from './handlers/system-fields';

/**
 * Hard cap on chained decision nodes the resolver will traverse before
 * aborting with a "Decision chain too deep" error. Matches design Part 2.51.
 */
export const MAX_DECISION_DEPTH = 5;

interface IBranchRow {
  id: string;
  decision_node_id: string;
  to_node_id: string;
  expression: Record<string, unknown>;
  label: string | null;
  sort_order: number;
}

interface INodeRow {
  id: string;
  kind: 'status' | 'decision' | 'start';
  status_id: string | null;
}

type ExpressionKind =
  | 'always'
  | 'else'
  | 'field_equals'
  | 'field_comparison'
  | 'field_in_set'
  | 'condition_group';

/**
 * Resolve a decision node to a terminal status_id by walking the branches
 * down the tree. Each recursion checks the depth guard first; cycles back to
 * an earlier decision in the chain are caught at the depth cap, which keeps
 * the implementation simple without a visited-set.
 *
 * @param decisionNodeId - id of a `workflow_nodes` row with kind='decision'
 * @param ctx - evaluation context for field/expression lookups
 * @param registry - handler registry (reserved for condition_group dispatch)
 * @param supabase - admin client used to load branches + linked nodes
 * @param depth - current recursion depth; callers pass 0 from the top
 * @returns the terminal `status_id` (uuid) reached by the matching branch, or
 *   `null` when no branch matches and there is no else branch (a "no route"
 *   signal so callers keep the task on its current status instead of 500ing)
 * @throws BadRequestException with `'Decision chain too deep'` past the cap
 * @throws BadRequestException on a cycle, a missing target node, or an invalid
 *   target kind (genuine faults — distinct from the benign no-route `null`)
 */
export async function resolveDecision(
  decisionNodeId: string,
  ctx: IEvaluationContext,
  registry: HandlerRegistryService,
  supabase: SupabaseClient,
  depth: number = 0,
  visited: Set<string> = new Set(),
): Promise<string | null> {
  // ENG-M3: enforce AT MOST MAX_DECISION_DEPTH levels (depths 0..MAX-1).
  if (depth >= MAX_DECISION_DEPTH) {
    throw new BadRequestException('Decision chain too deep');
  }

  // ENG-M3: detect a true cycle immediately rather than burning the whole
  // depth budget first.
  if (visited.has(decisionNodeId)) {
    throw new BadRequestException('Decision cycle detected');
  }

  visited.add(decisionNodeId);

  // R2: workflow scope is MANDATORY. Every node/branch load below is bounded to
  // this workflow so a decision can never resolve to a node in another workflow
  // (or tenant), regardless of how decisionNodeId was supplied.
  const workflowId = (ctx.workflow as { id?: string } | undefined)?.id;

  if (!workflowId) {
    throw new BadRequestException(
      'Decision resolution requires workflow context',
    );
  }

  const branchesRes = await supabase
    .from('workflow_decision_branches')
    .select('id, decision_node_id, to_node_id, expression, label, sort_order')
    .eq('decision_node_id', decisionNodeId)
    .order('sort_order', { ascending: true });

  if (branchesRes.error) {
    throw new BadRequestException(branchesRes.error.message);
  }

  const branches = (branchesRes.data ?? []) as IBranchRow[];
  // Split branches into a sorted "non-else" list and a single "else" target.
  // The contract is: evaluate non-else in order, fall back to else.
  const elseBranch = branches.find(
    (b) => (b.expression as { kind?: string }).kind === 'else',
  );
  const nonElseBranches = branches.filter(
    (b) => (b.expression as { kind?: string }).kind !== 'else',
  );

  let matched: IBranchRow | null = null;

  for (const branch of nonElseBranches) {
    const ok = evaluateBranchExpression(branch.expression, ctx);

    if (ok) {
      matched = branch;
      break;
    }
  }

  if (!matched && elseBranch) {
    matched = elseBranch;
  }

  if (!matched) {
    // No non-else branch matched and there is no else branch. Signal "no route"
    // (null) rather than aborting the whole transition with a 400. Callers keep
    // the task on its current status: the status-change/drag resolver treats
    // this as a non-match, and executeTransition surfaces a soft 422 without
    // writing status or running post-functions. Author-time health checks
    // (DecisionIncompleteBranchCheck) prevent shipping such a diamond.
    return null;
  }

  // Load the matched branch's target node to learn whether it's another
  // decision (recurse) or a terminal status (return). Always scoped by
  // workflow_id so a branch can never point at a node in another workflow.
  const nodeRes = await supabase
    .from('workflow_nodes')
    .select('id, kind, status_id')
    .eq('id', matched.to_node_id)
    .eq('workflow_id', workflowId)
    .maybeSingle();

  if (nodeRes.error) {
    throw new BadRequestException(nodeRes.error.message);
  }

  const target = nodeRes.data as INodeRow | null;

  if (!target) {
    throw new BadRequestException(
      `Decision branch target node ${matched.to_node_id} not found`,
    );
  }

  if (target.kind === 'decision') {
    return resolveDecision(
      target.id,
      ctx,
      registry,
      supabase,
      depth + 1,
      visited,
    );
  }

  if (target.kind === 'status') {
    if (!target.status_id) {
      throw new BadRequestException(
        `Status node ${target.id} is missing status_id`,
      );
    }

    return target.status_id;
  }

  throw new BadRequestException(`Invalid decision target kind: ${target.kind}`);
}

/**
 * Evaluate one branch expression against the context. Self-contained — does
 * NOT recurse into handler classes (the registry is reserved for future
 * extension; today we cover the documented expression kinds inline).
 *
 * @param expr - parsed expression JSON; see {@link ExpressionKind}
 * @param ctx - evaluation context (custom_field_values come from here)
 * @returns true when the branch matches; false otherwise
 */
export function evaluateBranchExpression(
  expr: Record<string, unknown>,
  ctx: IEvaluationContext,
): boolean {
  if (!expr || typeof expr !== 'object') return false;
  const kind = expr.kind as ExpressionKind | undefined;

  switch (kind) {
    case 'always':
      return true;
    case 'else':
      // Caller orchestrates else explicitly — treat as "do not match here".
      return false;
    case 'field_equals':
      return evalFieldEquals(expr, ctx);
    case 'field_comparison':
      return evalFieldComparison(expr, ctx);
    case 'field_in_set':
      return evalFieldInSet(expr, ctx);
    case 'condition_group':
      return evalConditionGroup(expr, ctx);
    default:
      // Unknown expression kind — fail closed so misconfigured branches
      // never silently match.
      return false;
  }
}

function evalFieldEquals(
  expr: Record<string, unknown>,
  ctx: IEvaluationContext,
): boolean {
  const fieldId = expr.field_id as string | undefined;

  if (!fieldId) return false;
  const current = resolveFieldValue(fieldId, ctx);
  const valueType = getSystemField(fieldId)?.valueType;

  return valuesEqual(current, expr.value, valueType);
}

function evalFieldComparison(
  expr: Record<string, unknown>,
  ctx: IEvaluationContext,
): boolean {
  const fieldId = expr.field_id as string | undefined;
  const op = expr.op as string | undefined;
  const target = expr.value;

  if (!fieldId || !op) return false;
  const current = resolveFieldValue(fieldId, ctx);

  if (current === undefined || current === null) return false;
  // Coerce both sides to numbers when feasible — the comparison operators
  // are only meaningful for numeric or temporal scalars (custom numeric
  // fields, or system date fields coerced to epoch ms).
  const a = coerceOrderable(current);
  const b = coerceOrderable(target);

  if (Number.isNaN(a) || Number.isNaN(b)) return false;

  switch (op) {
    case '>':
      return a > b;
    case '>=':
      return a >= b;
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '!=':
      return a !== b;
    case '==':
      return a === b;
    default:
      return false;
  }
}

function evalFieldInSet(
  expr: Record<string, unknown>,
  ctx: IEvaluationContext,
): boolean {
  const fieldId = expr.field_id as string | undefined;
  const values = expr.values;

  if (!fieldId || !Array.isArray(values)) return false;
  const current = resolveFieldValue(fieldId, ctx);
  const valueType = getSystemField(fieldId)?.valueType;

  return values.some((v) => valuesEqual(current, v, valueType));
}

function evalConditionGroup(
  expr: Record<string, unknown>,
  ctx: IEvaluationContext,
): boolean {
  const op = expr.op as 'all' | 'any' | undefined;
  const children = expr.children;

  if (!Array.isArray(children) || children.length === 0) {
    // Empty group — AND-over-empty is vacuously true; OR-over-empty is false.
    return op === 'all';
  }

  if (op === 'any') {
    for (const child of children) {
      if (typeof child === 'object' && child !== null) {
        if (evaluateBranchExpression(child as Record<string, unknown>, ctx)) {
          return true;
        }
      }
    }

    return false;
  }

  // Default to 'all'
  for (const child of children) {
    if (typeof child !== 'object' || child === null) return false;
    if (!evaluateBranchExpression(child as Record<string, unknown>, ctx)) {
      return false;
    }
  }

  return true;
}
