/**
 * @fileoverview Workflow health linter — runs structural + reference checks
 * over a workflow graph, persists results to workflow_health_issues
 * (idempotently), and answers the publish gate.
 * @module src/workflow-health/workflow-health.service
 * @author Rajbha Manek
 */
import { Injectable, Logger } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { HandlerRegistryService } from '../workflow-engine/handlers/handler-registry.service';
import type { IRuleReference } from '../workflow-engine/handlers/handler.types';
import { ALL_CHECKS } from './checks';
import type {
  GraphBranch,
  GraphNode,
  GraphTransition,
  HealthIssueDraft,
  LinterContext,
} from './workflow-health.types';

export interface WorkflowHealthIssueRow {
  id: string;
  organization_id: string;
  workflow_id: string;
  transition_id: string | null;
  node_id: string | null;
  severity: string;
  code: string;
  message: string;
  details: Record<string, unknown> | null;
  detected_at: string;
  resolved_at: string | null;
}

// Maps an IRuleReference.kind to the table whose `id` proves it still exists.
const REF_KIND_TABLE: Record<string, string> = {
  field: 'custom_fields',
  field_group: 'field_groups',
  user: 'users',
  group: 'user_groups',
  role: 'custom_roles',
  resolution: 'resolutions',
  category: 'status_categories',
};
// Tables that carry organization_id (users is global → keyed by id only).
const ORG_SCOPED_REF_TABLES = new Set([
  'custom_fields',
  'field_groups',
  'user_groups',
  'custom_roles',
  'resolutions',
  'status_categories',
]);
// Tables that soft-delete rather than hard-delete. A soft-deleted row keeps its
// `id`, so without this filter a rule pointing at one still resolves as "exists"
// and the dangling-ref checks report clean on a workflow that can never satisfy
// them. The remaining REF_KIND_TABLE tables have no `is_deleted` column at all,
// so the filter must stay scoped to this set or the query 400s.
const SOFT_DELETE_REF_TABLES = new Set([
  'custom_fields',
  'field_groups',
  'user_groups',
  'custom_roles',
]);

@Injectable()
export class WorkflowHealthService {
  private static readonly ISSUES_TABLE = 'workflow_health_issues';
  private readonly logger = new Logger(WorkflowHealthService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly registry: HandlerRegistryService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Run every check against the workflow, reconcile the unresolved issue rows
   * (delete-then-insert so fixed issues vanish and re-runs don't duplicate),
   * and return the fresh issue rows.
   */
  async runLinter(
    workflowId: string,
    organizationId: string,
  ): Promise<WorkflowHealthIssueRow[]> {
    const ctx = await this.buildContext(workflowId, organizationId);

    if (!ctx) return [];

    const drafts: HealthIssueDraft[] = [];

    for (const check of ALL_CHECKS) {
      try {
        drafts.push(...check.run(ctx));
      } catch (e) {
        this.logger.warn(
          `Check ${check.code} threw for workflow ${workflowId}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }

    return this.reconcile(workflowId, organizationId, drafts);
  }

  /** Current unresolved issues for a workflow (read-only). */
  async getIssues(
    workflowId: string,
    organizationId: string,
  ): Promise<WorkflowHealthIssueRow[]> {
    const r = await this.client
      .from(WorkflowHealthService.ISSUES_TABLE)
      .select('*')
      .eq('workflow_id', workflowId)
      .eq('organization_id', organizationId)
      .is('resolved_at', null)
      .order('severity', { ascending: true });

    return (r.data ?? []) as WorkflowHealthIssueRow[];
  }

  /**
   * Publish gate: re-lint the (draft) workflow and report blocking errors.
   * Uses a fresh run so a just-fixed workflow can publish.
   */
  async hasBlockingErrors(
    workflowId: string,
    organizationId: string,
  ): Promise<{ blocked: boolean; errors: WorkflowHealthIssueRow[] }> {
    const issues = await this.runLinter(workflowId, organizationId);
    const errors = issues.filter((i) => i.severity === 'error');

    return { blocked: errors.length > 0, errors };
  }

  /**
   * Re-lint every non-archived workflow in the org. Fire-and-forget hook for
   * entity deletes (custom field / user / group / role / resolution / status).
   * Scale is <100 workflows per org.
   */
  async relintWorkflowsForOrg(organizationId: string): Promise<void> {
    const r = await this.client
      .from('workflows')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('is_archived', false);
    const ids = ((r.data ?? []) as { id: string }[]).map((w) => w.id);

    for (const id of ids) {
      try {
        await this.runLinter(id, organizationId);
      } catch (e) {
        this.logger.warn(
          `relint failed for workflow ${id}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async reconcile(
    workflowId: string,
    organizationId: string,
    drafts: HealthIssueDraft[],
  ): Promise<WorkflowHealthIssueRow[]> {
    // Clear the previous unresolved set so fixed issues disappear and the
    // dedupe partial index never trips on a re-run.
    await this.client
      .from(WorkflowHealthService.ISSUES_TABLE)
      .delete()
      .eq('workflow_id', workflowId)
      .eq('organization_id', organizationId)
      .is('resolved_at', null);

    if (drafts.length === 0) return [];

    const rows = drafts.map((d) => ({
      organization_id: organizationId,
      workflow_id: workflowId,
      transition_id: d.transition_id ?? null,
      node_id: d.node_id ?? null,
      severity: d.severity,
      code: d.code,
      message: d.message,
      details: d.details ?? null,
    }));
    const ins = await this.client
      .from(WorkflowHealthService.ISSUES_TABLE)
      .insert(rows)
      .select();

    if (ins.error) {
      this.logger.warn(
        `Failed to persist health issues for ${workflowId}: ${ins.error.message}`,
      );

      return [];
    }

    return (ins.data ?? []) as WorkflowHealthIssueRow[];
  }

  private async buildContext(
    workflowId: string,
    organizationId: string,
  ): Promise<LinterContext | null> {
    const wfR = await this.client
      .from('workflows')
      .select('id, organization_id, initial_status_id')
      .eq('id', workflowId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (wfR.error || !wfR.data) return null;
    const workflow = wfR.data as LinterContext['workflow'];

    const [nodesR, transitionsR] = await Promise.all([
      this.client
        .from('workflow_nodes')
        .select('id, kind, status_id, label')
        .eq('workflow_id', workflowId),
      this.client
        .from('workflow_transitions')
        .select(
          'id, name, kind, to_node_id, screen_field_group_id, conditions, validators, post_functions, triggers, sort_order',
        )
        .eq('workflow_id', workflowId),
    ]);
    const nodes = (nodesR.data ?? []) as GraphNode[];
    const transitions = (transitionsR.data ?? []) as GraphTransition[];
    const transitionIds = transitions.map((t) => t.id);
    const decisionIds = nodes
      .filter((n) => n.kind === 'decision')
      .map((n) => n.id);

    const [sourcesR, branchesR] = await Promise.all([
      transitionIds.length
        ? this.client
            .from('workflow_transition_sources')
            .select('transition_id, from_node_id')
            .in('transition_id', transitionIds)
        : Promise.resolve({
            data: [] as { transition_id: string; from_node_id: string }[],
          }),
      decisionIds.length
        ? this.client
            .from('workflow_decision_branches')
            .select('id, decision_node_id, to_node_id, expression, label')
            .in('decision_node_id', decisionIds)
        : Promise.resolve({ data: [] as GraphBranch[] }),
    ]);

    const sourcesByTransition = new Map<string, string[]>();

    for (const s of (sourcesR.data ?? []) as {
      transition_id: string;
      from_node_id: string;
    }[]) {
      const arr = sourcesByTransition.get(s.transition_id) ?? [];

      arr.push(s.from_node_id);
      sourcesByTransition.set(s.transition_id, arr);
    }

    const nodeById = new Map(nodes.map((n) => [n.id, n]));

    const refsByTransition = new Map<string, IRuleReference[]>();
    const validatorRefsByTransition = new Map<string, IRuleReference[]>();

    for (const t of transitions) {
      refsByTransition.set(
        t.id,
        this.registry.collectReferences({
          conditions: t.conditions ?? [],
          validators: t.validators ?? [],
          post_functions: t.post_functions ?? [],
          triggers: t.triggers ?? [],
        }),
      );
      validatorRefsByTransition.set(
        t.id,
        this.registry.collectReferences({
          conditions: [],
          validators: t.validators ?? [],
          post_functions: [],
          triggers: [],
        }),
      );
    }

    const validRefIds = await this.resolveValidRefs(
      organizationId,
      [...refsByTransition.values()].flat(),
    );
    const doneStatusIds = await this.resolveDoneStatusIds(
      organizationId,
      nodes,
    );
    const screenFieldsByTransition =
      await this.resolveScreenFields(transitions);

    return {
      workflow,
      nodes,
      nodeById,
      transitions,
      sourcesByTransition,
      branches: (branchesR.data ?? []) as GraphBranch[],
      refsByTransition,
      validatorRefsByTransition,
      validRefIds,
      doneStatusIds,
      screenFieldsByTransition,
    };
  }

  /** For each ref kind, the set of ids that still exist. */
  private async resolveValidRefs(
    organizationId: string,
    refs: IRuleReference[],
  ): Promise<Record<string, Set<string>>> {
    const byKind = new Map<string, Set<string>>();

    for (const r of refs) {
      if (!REF_KIND_TABLE[r.kind]) continue;
      const set = byKind.get(r.kind) ?? new Set<string>();

      set.add(r.id);
      byKind.set(r.kind, set);
    }

    const out: Record<string, Set<string>> = {};

    for (const [kind, ids] of byKind) {
      const table = REF_KIND_TABLE[kind];
      let q = this.client
        .from(table)
        .select('id')
        .in('id', [...ids]);

      if (ORG_SCOPED_REF_TABLES.has(table)) {
        q = q.eq('organization_id', organizationId);
      }

      // `is_deleted` is nullable, so match the house idiom rather than
      // `.eq(false)` — a NULL row under `.eq(false)` would drop out and be
      // reported as dangling, blocking a workflow that is actually valid.
      if (SOFT_DELETE_REF_TABLES.has(table)) {
        q = q.or('is_deleted.is.null,is_deleted.eq.false');
      }
      const r = await q;

      out[kind] = new Set(
        ((r.data ?? []) as { id: string }[]).map((x) => x.id),
      );
    }

    return out;
  }

  /** Status ids (used by this workflow's nodes) whose category is done-like. */
  private async resolveDoneStatusIds(
    organizationId: string,
    nodes: GraphNode[],
  ): Promise<Set<string>> {
    const statusIds = nodes
      .filter((n) => n.kind === 'status' && n.status_id)
      .map((n) => n.status_id as string);

    if (statusIds.length === 0) return new Set();

    const stR = await this.client
      .from('task_statuses')
      .select('id, category_id')
      .in('id', statusIds);
    const rows = (stR.data ?? []) as {
      id: string;
      category_id: string | null;
    }[];
    const catIds = [
      ...new Set(
        rows.map((r) => r.category_id).filter((c): c is string => !!c),
      ),
    ];

    if (catIds.length === 0) return new Set();

    const catR = await this.client
      .from('status_categories')
      .select('id, is_done_like')
      .eq('organization_id', organizationId)
      .in('id', catIds);
    const doneCatIds = new Set(
      ((catR.data ?? []) as { id: string; is_done_like: boolean }[])
        .filter((c) => c.is_done_like)
        .map((c) => c.id),
    );

    return new Set(
      rows
        .filter((r) => r.category_id && doneCatIds.has(r.category_id))
        .map((r) => r.id),
    );
  }

  /** transition id → set of custom_field_ids on its screen field group. */
  private async resolveScreenFields(
    transitions: GraphTransition[],
  ): Promise<Map<string, Set<string>>> {
    const groupIds = [
      ...new Set(
        transitions
          .map((t) => t.screen_field_group_id)
          .filter((g): g is string => !!g),
      ),
    ];
    const out = new Map<string, Set<string>>();

    if (groupIds.length === 0) return out;

    const r = await this.client
      .from('field_group_fields')
      .select('field_group_id, custom_field_id')
      .in('field_group_id', groupIds);
    const byGroup = new Map<string, Set<string>>();

    for (const row of (r.data ?? []) as {
      field_group_id: string;
      custom_field_id: string;
    }[]) {
      const set = byGroup.get(row.field_group_id) ?? new Set<string>();

      set.add(row.custom_field_id);
      byGroup.set(row.field_group_id, set);
    }

    for (const t of transitions) {
      if (t.screen_field_group_id) {
        out.set(t.id, byGroup.get(t.screen_field_group_id) ?? new Set());
      }
    }

    return out;
  }
}
