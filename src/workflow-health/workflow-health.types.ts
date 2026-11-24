/**
 * @fileoverview Shared types for the workflow health linter — the check
 * contract and the pre-resolved context every check receives.
 * @module src/workflow-health/workflow-health.types
 * @author Rajbha Manek
 */
import type { IRuleReference } from '../workflow-engine/handlers/handler.types';

export type HealthSeverity = 'info' | 'warning' | 'error';

/** A detected issue, before it is persisted to workflow_health_issues. */
export interface HealthIssueDraft {
  code: string;
  severity: HealthSeverity;
  message: string;
  /** The transition this issue is attached to, if any. */
  transition_id?: string | null;
  /** The node this issue is attached to, if any. */
  node_id?: string | null;
  details?: Record<string, unknown>;
}

export interface GraphNode {
  id: string;
  kind: 'status' | 'decision' | 'start';
  status_id: string | null;
  label: string | null;
}

export interface GraphTransition {
  id: string;
  name: string;
  kind: string; // regular | common | global | self_loop | global_loop | initial
  to_node_id: string;
  screen_field_group_id: string | null;
  conditions: unknown[];
  validators: unknown[];
  post_functions: unknown[];
  triggers: unknown[];
  sort_order: number;
}

export interface GraphBranch {
  id: string;
  decision_node_id: string;
  to_node_id: string | null;
  expression: Record<string, unknown> | null;
  label: string | null;
}

export interface GraphWorkflow {
  id: string;
  organization_id: string;
  initial_status_id: string | null;
}

/**
 * Everything a check needs, pre-resolved ONCE by the service so individual
 * checks stay pure + synchronous (no DB calls inside a check).
 */
export interface LinterContext {
  workflow: GraphWorkflow;
  nodes: GraphNode[];
  /** node id → node, for O(1) lookups. */
  nodeById: Map<string, GraphNode>;
  transitions: GraphTransition[];
  /** transition id → from_node_ids[]. */
  sourcesByTransition: Map<string, string[]>;
  branches: GraphBranch[];
  /** transition id → all rule references it makes (via the handler registry). */
  refsByTransition: Map<string, IRuleReference[]>;
  /** transition id → references from its VALIDATORS only (for the screen-field check). */
  validatorRefsByTransition: Map<string, IRuleReference[]>;
  /** Existing id sets per ref kind — anything referenced but absent is dangling. */
  validRefIds: Record<string, Set<string>>;
  /** status ids whose category is done-like. */
  doneStatusIds: Set<string>;
  /** transition id → set of custom_field_ids on its screen field group. */
  screenFieldsByTransition: Map<string, Set<string>>;
}

export interface IWorkflowHealthCheck {
  readonly code: string;
  readonly severity: HealthSeverity;
  // Explicit `this` binding so check implementations can reference this.code/this.severity type-safely.
  run(this: IWorkflowHealthCheck, ctx: LinterContext): HealthIssueDraft[];
}
