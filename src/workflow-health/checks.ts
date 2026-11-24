/**
 * @fileoverview Workflow-health checks. Each is a pure, synchronous
 * IWorkflowHealthCheck over the pre-resolved LinterContext. `ALL_CHECKS` is the
 * ordered registry the service runs. Errors block publish; warnings/info don't.
 * @module src/workflow-health/checks
 * @author Rajbha Manek
 */
import type {
  GraphTransition,
  HealthIssueDraft,
  IWorkflowHealthCheck,
  LinterContext,
} from './workflow-health.types';

// ── helpers ────────────────────────────────────────────────────────────────
const isGlobalKind = (k: string): boolean =>
  k === 'global' || k === 'global_loop';

const statusNodes = (ctx: LinterContext) =>
  ctx.nodes.filter((n) => n.kind === 'status');

const decisionNodes = (ctx: LinterContext) =>
  ctx.nodes.filter((n) => n.kind === 'decision');

const hasGlobalEscape = (ctx: LinterContext): boolean =>
  ctx.transitions.some((t) => isGlobalKind(t.kind) && t.kind !== 'initial');

const sourcesOf = (ctx: LinterContext, t: GraphTransition): string[] =>
  ctx.sourcesByTransition.get(t.id) ?? [];

const postFnTypes = (t: GraphTransition): string[] =>
  (t.post_functions ?? [])
    .map((p) =>
      p && typeof p === 'object' ? (p as { type?: string }).type : undefined,
    )
    .filter((x): x is string => typeof x === 'string');

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const ruleType = (rule: unknown): string | undefined => {
  if (!isRecord(rule)) return undefined;
  if (typeof rule.type === 'string') return rule.type;
  if (isRecord(rule.config) && typeof rule.config.type === 'string') {
    return rule.config.type;
  }

  return undefined;
};

const setResolutionId = (rule: unknown): unknown => {
  if (!isRecord(rule)) return undefined;
  if ('resolution_id' in rule) return rule.resolution_id;
  if (isRecord(rule.config)) return rule.config.resolution_id;

  return undefined;
};

// ── structural checks ───────────────────────────────────────────────────────
export const WorkflowEmptyCheck: IWorkflowHealthCheck = {
  code: 'workflow_empty',
  severity: 'error',
  run(ctx) {
    if (statusNodes(ctx).length > 0) return [];

    return [
      {
        code: this.code,
        severity: this.severity,
        message: 'Workflow has no status nodes. Add at least one status.',
      },
    ];
  },
};

export const InitialStatusMissingCheck: IWorkflowHealthCheck = {
  code: 'initial_status_missing',
  severity: 'error',
  run(ctx) {
    const initial = ctx.workflow.initial_status_id;
    const ok =
      !!initial && statusNodes(ctx).some((n) => n.status_id === initial);

    if (ok) return [];

    return [
      {
        code: this.code,
        severity: this.severity,
        message: initial
          ? 'The workflow’s initial status is not a status node on the canvas.'
          : 'Workflow has no initial status. Set one before publishing.',
      },
    ];
  },
};

export const DecisionNoOutgoingCheck: IWorkflowHealthCheck = {
  code: 'decision_no_outgoing',
  severity: 'error',
  run(ctx) {
    const issues: HealthIssueDraft[] = [];

    for (const d of decisionNodes(ctx)) {
      const hasBranch = ctx.branches.some(
        (b) => b.decision_node_id === d.id && b.to_node_id,
      );

      if (!hasBranch) {
        issues.push({
          code: this.code,
          severity: this.severity,
          node_id: d.id,
          message: `Decision "${d.label ?? 'decision'}" has no outgoing branch — issues would be swallowed.`,
        });
      }
    }

    return issues;
  },
};

export const DecisionNoElseCheck: IWorkflowHealthCheck = {
  code: 'decision_no_else',
  severity: 'warning',
  run(ctx) {
    const issues: HealthIssueDraft[] = [];

    for (const d of decisionNodes(ctx)) {
      const branches = ctx.branches.filter((b) => b.decision_node_id === d.id);

      if (branches.length === 0) continue; // covered by decision_no_outgoing
      const hasElse = branches.some(
        (b) => (b.expression as { kind?: string } | null)?.kind === 'else',
      );

      if (!hasElse) {
        issues.push({
          code: this.code,
          severity: this.severity,
          node_id: d.id,
          message: `Decision "${d.label ?? 'decision'}" has no else branch — unmatched issues abort the transition.`,
        });
      }
    }

    return issues;
  },
};

export const DecisionIncompleteBranchCheck: IWorkflowHealthCheck = {
  code: 'decision_incomplete_branch',
  severity: 'error',
  run(ctx) {
    const issues: HealthIssueDraft[] = [];

    for (const d of decisionNodes(ctx)) {
      const branches = ctx.branches.filter((b) => b.decision_node_id === d.id);

      for (const b of branches) {
        const expr = isRecord(b.expression) ? b.expression : null;
        const kind = typeof expr?.kind === 'string' ? expr.kind : undefined;

        // `else` / `always` need no field/value — always valid.
        if (kind === 'else' || kind === 'always') continue;

        const fieldId = expr?.field_id;
        const hasField = typeof fieldId === 'string' && fieldId.length > 0;
        const hasValue =
          expr?.value !== undefined &&
          expr?.value !== null &&
          expr?.value !== '';

        let complete = false;

        if (kind === 'field_equals') {
          complete = hasField && hasValue;
        } else if (kind === 'field_comparison') {
          const hasOp = typeof expr?.op === 'string' && expr.op.length > 0;

          complete = hasField && hasOp && hasValue;
        } else if (kind === 'field_in_set') {
          const values = expr?.values;

          complete = hasField && Array.isArray(values) && values.length > 0;
        } else if (kind === 'condition_group') {
          const children = expr?.children;

          complete = Array.isArray(children) && children.length > 0;
        }
        // Unknown/kindless (e.g. the half-drawn `{}` branch) stays incomplete.

        if (!complete) {
          issues.push({
            code: this.code,
            severity: this.severity,
            node_id: d.id,
            details: { branch_id: b.id },
            message: `Decision "${d.label ?? 'decision'}" has an unconfigured branch — set its condition (field + value) or remove it before publishing.`,
          });
        }
      }
    }

    return issues;
  },
};

export const UnreachableStatusCheck: IWorkflowHealthCheck = {
  code: 'unreachable_status',
  severity: 'warning',
  run(ctx) {
    const issues: HealthIssueDraft[] = [];
    const initial = ctx.workflow.initial_status_id;
    // A node is reachable if it is the initial status, or a non-loop transition
    // or a decision branch targets it.
    const incomingNodeIds = new Set<string>();

    for (const t of ctx.transitions) {
      if (t.kind === 'self_loop' || t.kind === 'global_loop') continue;
      incomingNodeIds.add(t.to_node_id);
    }
    for (const b of ctx.branches) {
      if (b.to_node_id) incomingNodeIds.add(b.to_node_id);
    }

    for (const n of statusNodes(ctx)) {
      const isInitial = !!initial && n.status_id === initial;

      if (isInitial) continue;
      if (!incomingNodeIds.has(n.id)) {
        issues.push({
          code: this.code,
          severity: this.severity,
          node_id: n.id,
          message:
            'Status has no incoming transition — no issue can ever reach it.',
        });
      }
    }

    return issues;
  },
};

export const StatusWithNoOutgoingCheck: IWorkflowHealthCheck = {
  code: 'status_no_outgoing',
  severity: 'warning',
  run(ctx) {
    if (hasGlobalEscape(ctx)) return []; // a global transition escapes any status
    const issues: HealthIssueDraft[] = [];
    const sourceNodeIds = new Set<string>();

    for (const t of ctx.transitions) {
      for (const s of sourcesOf(ctx, t)) sourceNodeIds.add(s);
    }

    for (const n of statusNodes(ctx)) {
      if (!sourceNodeIds.has(n.id)) {
        issues.push({
          code: this.code,
          severity: this.severity,
          node_id: n.id,
          message:
            'Status has no outgoing transition and no global transition can move issues out. They will be stuck. Add a transition (e.g. Reopen).',
        });
      }
    }

    return issues;
  },
};

// ── dangling reference checks ────────────────────────────────────────────────
function danglingCheck(
  code: string,
  severity: 'error' | 'warning',
  kinds: string[],
  label: string,
): IWorkflowHealthCheck {
  return {
    code,
    severity,
    run(ctx) {
      const issues: HealthIssueDraft[] = [];

      for (const t of ctx.transitions) {
        const refs = ctx.refsByTransition.get(t.id) ?? [];

        for (const ref of refs) {
          if (!kinds.includes(ref.kind)) continue;
          const valid = ctx.validRefIds[ref.kind];

          if (valid && !valid.has(ref.id)) {
            issues.push({
              code,
              severity,
              transition_id: t.id,
              message: `Transition "${t.name}" references a ${label} that no longer exists.`,
              details: { ref_kind: ref.kind, missing_id: ref.id },
            });
          }
        }
      }

      return issues;
    },
  };
}

export const DanglingFieldRefCheck = danglingCheck(
  'dangling_field_ref',
  'error',
  ['field'],
  'custom field',
);
export const DanglingFieldGroupRefCheck = danglingCheck(
  'dangling_field_group_ref',
  'warning',
  ['field_group'],
  'field group',
);
export const DanglingUserRefCheck = danglingCheck(
  'dangling_user_ref',
  'warning',
  ['user'],
  'user',
);
export const DanglingGroupRoleRefCheck = danglingCheck(
  'dangling_group_role_ref',
  'warning',
  ['group', 'role'],
  'group or role',
);
export const DanglingResolutionRefCheck = danglingCheck(
  'dangling_resolution_ref',
  'warning',
  ['resolution'],
  'resolution',
);

export const InvalidSetResolutionConfigCheck: IWorkflowHealthCheck = {
  code: 'invalid_set_resolution_config',
  severity: 'error',
  run(ctx) {
    const issues: HealthIssueDraft[] = [];

    for (const t of ctx.transitions) {
      for (const postFn of t.post_functions ?? []) {
        if (ruleType(postFn) !== 'set_resolution') continue;
        const resolutionId = setResolutionId(postFn);

        if (typeof resolutionId === 'string' && UUID_RE.test(resolutionId)) {
          continue;
        }

        issues.push({
          code: this.code,
          severity: this.severity,
          transition_id: t.id,
          message: `Transition "${t.name}" has a set_resolution post-function with an invalid resolution_id. Choose an active resolution or remove the post-function.`,
          details: {
            resolution_id:
              typeof resolutionId === 'string' ? resolutionId : null,
          },
        });
      }
    }

    return issues;
  },
};

// ── resolution-hygiene (info) ────────────────────────────────────────────────
export const DoneStatusNoResolutionSetCheck: IWorkflowHealthCheck = {
  code: 'done_status_no_resolution_set',
  severity: 'info',
  run(ctx) {
    const issues: HealthIssueDraft[] = [];

    for (const t of ctx.transitions) {
      if (t.kind === 'initial' || t.kind === 'global_loop') continue;
      const toNode = ctx.nodeById.get(t.to_node_id);

      if (!toNode || toNode.kind !== 'status' || !toNode.status_id) continue;
      if (!ctx.doneStatusIds.has(toNode.status_id)) continue;
      if (!postFnTypes(t).includes('set_resolution')) {
        issues.push({
          code: this.code,
          severity: this.severity,
          transition_id: t.id,
          message: `Transition "${t.name}" lands in a Done-category status but doesn’t set a resolution. Add a set_resolution post-function?`,
        });
      }
    }

    return issues;
  },
};

export const ReopenNoResolutionClearCheck: IWorkflowHealthCheck = {
  code: 'reopen_no_resolution_clear',
  severity: 'info',
  run(ctx) {
    const issues: HealthIssueDraft[] = [];

    for (const t of ctx.transitions) {
      if (t.kind === 'initial' || t.kind === 'global_loop') continue;
      const toNode = ctx.nodeById.get(t.to_node_id);

      if (!toNode || toNode.kind !== 'status' || !toNode.status_id) continue;
      if (ctx.doneStatusIds.has(toNode.status_id)) continue; // landing in done: not a reopen
      const fromDone =
        t.kind === 'global'
          ? ctx.doneStatusIds.size > 0
          : sourcesOf(ctx, t).some((nid) => {
              const sn = ctx.nodeById.get(nid);

              return !!sn?.status_id && ctx.doneStatusIds.has(sn.status_id);
            });

      if (fromDone && !postFnTypes(t).includes('clear_resolution')) {
        issues.push({
          code: this.code,
          severity: this.severity,
          transition_id: t.id,
          message: `Transition "${t.name}" leaves a Done-category status but doesn’t clear resolution. Add a clear_resolution post-function?`,
        });
      }
    }

    return issues;
  },
};

// ── name / shadowing (info) ───────────────────────────────────────────────────
export const ShadowedGlobalTransitionCheck: IWorkflowHealthCheck = {
  code: 'shadowed_global_transition',
  severity: 'info',
  run(ctx) {
    const issues: HealthIssueDraft[] = [];
    const specificNames = new Set(
      ctx.transitions
        .filter((t) => !isGlobalKind(t.kind) && t.kind !== 'initial')
        .map((t) => t.name),
    );

    for (const g of ctx.transitions.filter((t) => isGlobalKind(t.kind))) {
      if (specificNames.has(g.name)) {
        issues.push({
          code: this.code,
          severity: this.severity,
          transition_id: g.id,
          message: `Global transition "${g.name}" is shadowed by a more specific transition with the same name.`,
        });
      }
    }

    return issues;
  },
};

export const DuplicateTransitionNameCheck: IWorkflowHealthCheck = {
  code: 'duplicate_transition_name',
  severity: 'info',
  run(ctx) {
    const byName = new Map<string, GraphTransition[]>();

    for (const t of ctx.transitions) {
      if (t.kind === 'initial') continue;
      const arr = byName.get(t.name) ?? [];

      arr.push(t);
      byName.set(t.name, arr);
    }
    const issues: HealthIssueDraft[] = [];

    for (const [name, arr] of byName) {
      if (arr.length > 1) {
        issues.push({
          code: this.code,
          severity: this.severity,
          message: `${arr.length} transitions are named "${name}" — consider disambiguating.`,
          details: { name, transition_ids: arr.map((t) => t.id) },
        });
      }
    }

    return issues;
  },
};

// ── validator references a field not on the screen (warning) ──────────────────
export const ValidatorReferencesFieldNotOnScreenCheck: IWorkflowHealthCheck = {
  code: 'validator_field_not_on_screen',
  severity: 'warning',
  run(ctx) {
    const issues: HealthIssueDraft[] = [];

    for (const t of ctx.transitions) {
      if (!t.screen_field_group_id) continue; // no screen → validator reads task state, fine
      const screenFields =
        ctx.screenFieldsByTransition.get(t.id) ?? new Set<string>();
      const refs = ctx.validatorRefsByTransition.get(t.id) ?? [];

      for (const ref of refs) {
        if (ref.kind !== 'field') continue;
        if (!screenFields.has(ref.id)) {
          issues.push({
            code: this.code,
            severity: this.severity,
            transition_id: t.id,
            message: `Transition "${t.name}" has a validator on a field that isn’t on its screen — the user can’t satisfy it.`,
            details: { missing_field_id: ref.id },
          });
        }
      }
    }

    return issues;
  },
};

/** Ordered registry of every check the linter runs. */
export const ALL_CHECKS: IWorkflowHealthCheck[] = [
  WorkflowEmptyCheck,
  InitialStatusMissingCheck,
  DecisionNoOutgoingCheck,
  DecisionNoElseCheck,
  DecisionIncompleteBranchCheck,
  UnreachableStatusCheck,
  StatusWithNoOutgoingCheck,
  DanglingFieldRefCheck,
  DanglingFieldGroupRefCheck,
  DanglingUserRefCheck,
  DanglingGroupRoleRefCheck,
  DanglingResolutionRefCheck,
  InvalidSetResolutionConfigCheck,
  DoneStatusNoResolutionSetCheck,
  ReopenNoResolutionClearCheck,
  ShadowedGlobalTransitionCheck,
  DuplicateTransitionNameCheck,
  ValidatorReferencesFieldNotOnScreenCheck,
];
