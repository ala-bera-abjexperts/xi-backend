/**
 * @fileoverview Workflow portability — export a workflow to self-contained JSON
 * (no DB ids; references by stable key/name; volatile user/group/role rule
 * params stripped), a two-step import (dry-run → confirm), and a one-shot
 * migration helper that builds a workflow from legacy task_status_transitions.
 * @module src/workflows/workflows-import-export.service
 * @author Rajbha Manek
 */
import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { HandlerRegistryService } from '../workflow-engine/handlers/handler-registry.service';
import { WorkflowsService } from './workflows.service';

export const WORKFLOW_EXPORT_VERSION = 1 as const;

export interface ExportedNode {
  local_id: string;
  kind: 'status' | 'decision' | 'start';
  status_key: string | null;
  status_name: string | null;
  status_category_key: string | null;
  label: string | null;
  position_x: number;
  position_y: number;
  properties: Record<string, unknown>;
}

export interface ExportedTransition {
  name: string;
  kind: string;
  to_node_local_id: string;
  from_node_local_ids: string[];
  screen_field_group_name: string | null;
  conditions: unknown[];
  validators: unknown[];
  post_functions: unknown[];
  triggers: unknown[];
  properties: Record<string, unknown>;
  sort_order: number;
  _unresolved: { phase: string; type: string; kinds: string[] }[];
}

export interface ExportedBranch {
  decision_node_local_id: string;
  to_node_local_id: string | null;
  expression: Record<string, unknown> | null;
  label: string | null;
  sort_order: number;
}

export interface ExportedCategory {
  key: string;
  name: string;
  color: string;
  is_done_like: boolean;
}

export interface WorkflowExportDoc {
  export_version: number;
  name: string;
  description: string | null;
  initial_status_key: string | null;
  layout: Record<string, unknown>;
  categories: ExportedCategory[];
  nodes: ExportedNode[];
  transitions: ExportedTransition[];
  decision_branches: ExportedBranch[];
}

export interface ImportDryRunReport {
  name_conflict: boolean;
  categories: { key: string; exists: boolean }[];
  statuses: { key: string; exists: boolean; category_key: string | null }[];
  field_groups: { name: string; matched_id: string | null }[];
  unresolved: { phase: string; type: string; kinds: string[] }[];
}

export interface ImportResolution {
  name: string;
  space_id?: string | null;
  auto_create_statuses?: boolean;
  /** field group name → existing field_group id (or null to leave no screen). */
  field_group_map?: Record<string, string | null>;
}

const VOLATILE_KINDS = new Set(['user', 'group', 'role']);

@Injectable()
export class WorkflowsImportExportService {
  private static readonly RULE_PHASES = [
    'conditions',
    'validators',
    'post_functions',
    'triggers',
  ] as const;

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly registry: HandlerRegistryService,
    private readonly workflows: WorkflowsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // ===========================================================================
  // EXPORT
  // ===========================================================================

  async exportWorkflow(
    id: string,
    organizationId: string,
  ): Promise<WorkflowExportDoc> {
    const detail = await this.workflows.getDetail(id, organizationId);

    if (!detail) throw new NotFoundException('Workflow not found');

    const nodes = (detail.nodes ?? []) as RawNode[];
    const transitions = (detail.transitions ?? []) as RawTransition[];
    const sources = (detail.sources ?? []) as RawSource[];
    const branches = (detail.branches ?? []) as RawBranch[];

    const statusIds = nodes
      .filter((n) => n.kind === 'status' && n.status_id)
      .map((n) => n.status_id as string);

    if (detail.initial_status_id) statusIds.push(detail.initial_status_id);
    const statusMeta = await this.loadStatusMeta([...new Set(statusIds)]);
    const categoryMeta = await this.loadCategoryMeta(
      [...new Set([...statusMeta.values()].map((s) => s.category_id))].filter(
        (c): c is string => !!c,
      ),
    );

    const groupIds = [
      ...new Set(
        transitions
          .map((t) => t.screen_field_group_id)
          .filter((g): g is string => !!g),
      ),
    ];
    const groupNameById = await this.mapFieldGroupNames(groupIds);

    const exportedNodes: ExportedNode[] = nodes.map((n) => {
      const meta = n.status_id ? statusMeta.get(n.status_id) : undefined;

      return {
        local_id: n.id,
        kind: n.kind,
        status_key: meta?.key ?? null,
        status_name: meta?.name ?? null,
        status_category_key: meta?.category_id
          ? (categoryMeta.get(meta.category_id)?.key ?? null)
          : null,
        label: n.label ?? null,
        position_x: n.position_x ?? 0,
        position_y: n.position_y ?? 0,
        properties: n.properties ?? {},
      };
    });

    const sourcesByTransition = new Map<string, string[]>();

    for (const s of sources) {
      const arr = sourcesByTransition.get(s.transition_id) ?? [];

      arr.push(s.from_node_id);
      sourcesByTransition.set(s.transition_id, arr);
    }

    const exportedTransitions: ExportedTransition[] = transitions.map((t) => {
      const stripped = this.stripVolatile({
        conditions: t.conditions ?? [],
        validators: t.validators ?? [],
        post_functions: t.post_functions ?? [],
        triggers: t.triggers ?? [],
      });

      return {
        name: t.name,
        kind: t.kind,
        to_node_local_id: t.to_node_id,
        from_node_local_ids: sourcesByTransition.get(t.id) ?? [],
        screen_field_group_name: t.screen_field_group_id
          ? (groupNameById.get(t.screen_field_group_id) ?? null)
          : null,
        conditions: stripped.conditions,
        validators: stripped.validators,
        post_functions: stripped.post_functions,
        triggers: stripped.triggers,
        properties: t.properties ?? {},
        sort_order: t.sort_order ?? 0,
        _unresolved: stripped.unresolved,
      };
    });

    const categories: ExportedCategory[] = [...categoryMeta.values()].map(
      (c) => ({
        key: c.key,
        name: c.name,
        color: c.color,
        is_done_like: c.is_done_like,
      }),
    );

    return {
      export_version: WORKFLOW_EXPORT_VERSION,
      name: detail.name,
      description: detail.description ?? null,
      initial_status_key: detail.initial_status_id
        ? (statusMeta.get(detail.initial_status_id)?.key ?? null)
        : null,
      layout: detail.layout ?? {},
      categories,
      nodes: exportedNodes,
      transitions: exportedTransitions,
      decision_branches: branches.map((b) => ({
        decision_node_local_id: b.decision_node_id,
        to_node_local_id: b.to_node_id ?? null,
        expression: b.expression ?? null,
        label: b.label ?? null,
        sort_order: b.sort_order ?? 0,
      })),
    };
  }

  // ===========================================================================
  // IMPORT — dry-run
  // ===========================================================================

  async importDryRun(
    doc: WorkflowExportDoc,
    organizationId: string,
    spaceId: string | null,
  ): Promise<ImportDryRunReport> {
    this.assertDoc(doc);

    const statusKeys = [
      ...new Set(
        doc.nodes
          .filter((n) => n.kind === 'status' && n.status_key)
          .map((n) => n.status_key as string),
      ),
    ];
    const categoryKeys = [...new Set(doc.categories.map((c) => c.key))];
    const groupNames = [
      ...new Set(
        doc.transitions
          .map((t) => t.screen_field_group_name)
          .filter((g): g is string => !!g),
      ),
    ];

    const [existingStatusKeys, existingCategoryKeys, groupIdByName] =
      await Promise.all([
        this.existingKeys('task_statuses', statusKeys, organizationId, spaceId),
        this.existingKeys(
          'status_categories',
          categoryKeys,
          organizationId,
          spaceId,
        ),
        this.matchFieldGroupNames(groupNames, organizationId, spaceId),
      ]);

    const statusCategoryKeyByStatusKey = new Map<string, string | null>();

    for (const n of doc.nodes) {
      if (n.kind === 'status' && n.status_key) {
        statusCategoryKeyByStatusKey.set(n.status_key, n.status_category_key);
      }
    }

    const nameConflict = await this.workflowNameExists(
      doc.name,
      organizationId,
      spaceId,
    );

    return {
      name_conflict: nameConflict,
      categories: categoryKeys.map((key) => ({
        key,
        exists: existingCategoryKeys.has(key),
      })),
      statuses: statusKeys.map((key) => ({
        key,
        exists: existingStatusKeys.has(key),
        category_key: statusCategoryKeyByStatusKey.get(key) ?? null,
      })),
      field_groups: groupNames.map((name) => ({
        name,
        matched_id: groupIdByName.get(name) ?? null,
      })),
      unresolved: doc.transitions.flatMap((t) => t._unresolved ?? []),
    };
  }

  // ===========================================================================
  // IMPORT — confirm
  // ===========================================================================

  async confirmImport(
    doc: WorkflowExportDoc,
    organizationId: string,
    userId: string,
    resolution: ImportResolution,
  ): Promise<unknown> {
    this.assertDoc(doc);
    const spaceId = resolution.space_id ?? null;

    if (
      await this.workflowNameExists(resolution.name, organizationId, spaceId)
    ) {
      throw new ConflictException(
        `A workflow named '${resolution.name}' already exists in this scope`,
      );
    }

    // 1. Resolve / auto-create categories, then statuses.
    const categoryIdByKey = await this.resolveCategories(
      doc,
      organizationId,
      spaceId,
      resolution.auto_create_statuses ?? false,
      userId,
    );
    const statusIdByKey = await this.resolveStatuses(
      doc,
      organizationId,
      spaceId,
      resolution.auto_create_statuses ?? false,
      categoryIdByKey,
      userId,
    );

    // 2. Resolve field group names → ids.
    const groupNames = [
      ...new Set(
        doc.transitions
          .map((t) => t.screen_field_group_name)
          .filter((g): g is string => !!g),
      ),
    ];
    const matched = await this.matchFieldGroupNames(
      groupNames,
      organizationId,
      spaceId,
    );
    const groupIdByName = new Map(matched);

    for (const [name, id] of Object.entries(resolution.field_group_map ?? {})) {
      groupIdByName.set(name, id ?? undefined);
    }

    // 3. Fresh node ids; remap everything.
    const newNodeId = new Map<string, string>();

    for (const n of doc.nodes) newNodeId.set(n.local_id, randomUUID());

    const initialStatusId = doc.initial_status_key
      ? (statusIdByKey.get(doc.initial_status_key) ?? null)
      : null;

    // 4. Create the workflow row, then save the remapped canvas.
    const created = (await this.workflows.create(
      organizationId,
      {
        name: resolution.name,
        description: doc.description ?? undefined,
        space_id: spaceId,
        initial_status_id: initialStatusId ?? undefined,
      } as never,
      userId,
    )) as { id: string };

    const canvas = {
      version: 1,
      initial_status_id: initialStatusId,
      layout: doc.layout ?? {},
      nodes: doc.nodes.map((n) => ({
        id: newNodeId.get(n.local_id) as string,
        kind: n.kind,
        status_id:
          n.kind === 'status' && n.status_key
            ? (statusIdByKey.get(n.status_key) ?? null)
            : null,
        label: n.label ?? null,
        position_x: n.position_x ?? 0,
        position_y: n.position_y ?? 0,
        properties: n.properties ?? {},
      })),
      transitions: doc.transitions.map((t) => ({
        id: randomUUID(),
        name: t.name,
        kind: t.kind,
        to_node_id: newNodeId.get(t.to_node_local_id) as string,
        screen_field_group_id: t.screen_field_group_name
          ? (groupIdByName.get(t.screen_field_group_name) ?? null)
          : null,
        conditions: t.conditions ?? [],
        validators: t.validators ?? [],
        post_functions: t.post_functions ?? [],
        triggers: t.triggers ?? [],
        properties: t.properties ?? {},
        sort_order: t.sort_order ?? 0,
        _from: t.from_node_local_ids,
      })),
      transition_sources: [] as {
        transition_id: string;
        from_node_id: string;
      }[],
      // B7: a decision branch MUST target a node (workflow_decision_branches
      // .to_node_id is NOT NULL). Drop any branch whose target/owner can't be
      // resolved rather than 400ing the whole import; the resulting incomplete
      // decision is surfaced by DecisionIncompleteBranchCheck at publish.
      // `sys:` fields in the expression import as-is (task-column refs, org
      // agnostic); custom-field ids are validated cross-org by saveCanvas,
      // exactly like transition rule refs.
      decision_branches: doc.decision_branches.flatMap((b) => {
        const decisionNodeId = newNodeId.get(b.decision_node_local_id);
        const toNodeId = b.to_node_local_id
          ? newNodeId.get(b.to_node_local_id)
          : undefined;

        if (!decisionNodeId || !toNodeId) return [];

        return [
          {
            id: randomUUID(),
            decision_node_id: decisionNodeId,
            to_node_id: toNodeId,
            expression: b.expression ?? {},
            label: b.label ?? null,
            sort_order: b.sort_order ?? 0,
          },
        ];
      }),
    };
    // Build sources from each transition's from_node_local_ids.
    for (const t of canvas.transitions) {
      for (const localFrom of t._from) {
        const fromId = newNodeId.get(localFrom);

        if (fromId) {
          canvas.transition_sources.push({
            transition_id: t.id,
            from_node_id: fromId,
          });
        }
      }
      delete (t as { _from?: unknown })._from;
    }

    await this.workflows.saveCanvas(
      created.id,
      organizationId,
      canvas as never,
      userId,
    );

    return this.workflows.getDetail(created.id, organizationId);
  }

  // ===========================================================================
  // MIGRATION HELPER — build a workflow from task_status_transitions
  // ===========================================================================

  async createFromStatuses(
    organizationId: string,
    spaceId: string,
    name: string,
    userId: string,
  ): Promise<unknown> {
    if (await this.workflowNameExists(name, organizationId, spaceId)) {
      throw new ConflictException(
        `A workflow named '${name}' already exists in this scope`,
      );
    }

    const statusesR = await this.client
      .from('task_statuses')
      .select('id, name, key, is_completed, sort_order')
      .eq('organization_id', organizationId)
      .or(`space_id.is.null,space_id.eq.${spaceId}`)
      .order('sort_order', { ascending: true });
    const statuses = (statusesR.data ?? []) as {
      id: string;
      name: string;
      is_completed: boolean;
      sort_order: number;
    }[];

    if (statuses.length === 0) {
      throw new BadRequestException(
        'No statuses found in this space to build a workflow from.',
      );
    }

    const transR = await this.client
      .from('task_status_transitions')
      .select('from_status_id, to_status_id')
      .eq('organization_id', organizationId)
      .or(`space_id.is.null,space_id.eq.${spaceId}`);
    const pairs = (transR.data ?? []) as {
      from_status_id: string;
      to_status_id: string;
    }[];

    // initial = first non-completed by sort_order, else first.
    const initial = statuses.find((s) => !s.is_completed) ?? statuses[0];

    const nodeIdByStatus = new Map<string, string>();

    for (const s of statuses) nodeIdByStatus.set(s.id, randomUUID());
    const startId = randomUUID();

    const canvasNodes = [
      {
        id: startId,
        kind: 'start',
        status_id: null,
        label: null,
        position_x: 40,
        position_y: 40,
        properties: {},
      },
      ...statuses.map((s, i) => ({
        id: nodeIdByStatus.get(s.id) as string,
        kind: 'status',
        status_id: s.id,
        label: null,
        position_x: 240 + (i % 4) * 220,
        position_y: 160 + Math.floor(i / 4) * 140,
        properties: {},
      })),
    ];

    const nameByStatus = new Map(statuses.map((s) => [s.id, s.name]));
    const initialTxId = randomUUID();
    const canvasTransitions = [
      {
        id: initialTxId,
        name: 'Create',
        kind: 'initial',
        to_node_id: nodeIdByStatus.get(initial.id) as string,
        screen_field_group_id: null,
        conditions: [],
        validators: [],
        post_functions: [],
        triggers: [],
        properties: {},
        sort_order: 0,
      },
      ...pairs
        .filter(
          (p) =>
            nodeIdByStatus.has(p.from_status_id) &&
            nodeIdByStatus.has(p.to_status_id),
        )
        .map((p, i) => ({
          id: randomUUID(),
          name: `To ${nameByStatus.get(p.to_status_id) ?? 'status'}`,
          kind: 'regular',
          to_node_id: nodeIdByStatus.get(p.to_status_id) as string,
          screen_field_group_id: null,
          conditions: [],
          validators: [],
          post_functions: [],
          triggers: [],
          properties: {},
          sort_order: i + 1,
          _from: [p.from_status_id],
        })),
    ];

    const sources: { transition_id: string; from_node_id: string }[] = [];

    for (const t of canvasTransitions) {
      const from = (t as { _from?: string[] })._from;

      if (from) {
        for (const sid of from) {
          const nid = nodeIdByStatus.get(sid);

          if (nid) sources.push({ transition_id: t.id, from_node_id: nid });
        }
      }
      delete (t as { _from?: unknown })._from;
    }

    const created = (await this.workflows.create(
      organizationId,
      {
        name,
        space_id: spaceId,
        initial_status_id: initial.id,
      } as never,
      userId,
    )) as { id: string };

    await this.workflows.saveCanvas(
      created.id,
      organizationId,
      {
        version: 1,
        initial_status_id: initial.id,
        layout: {},
        nodes: canvasNodes,
        transitions: canvasTransitions,
        transition_sources: sources,
        decision_branches: [],
      } as never,
      userId,
    );

    return this.workflows.getDetail(created.id, organizationId);
  }

  // ===========================================================================
  // internals
  // ===========================================================================

  private assertDoc(doc: WorkflowExportDoc): void {
    if (
      !doc ||
      typeof doc !== 'object' ||
      !Array.isArray(doc.nodes) ||
      !Array.isArray(doc.transitions)
    ) {
      throw new BadRequestException('Invalid workflow export document');
    }
  }

  private async resolveCategories(
    doc: WorkflowExportDoc,
    organizationId: string,
    spaceId: string | null,
    autoCreate: boolean,
    userId: string,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const existing = await this.client
      .from('status_categories')
      .select('id, key')
      .eq('organization_id', organizationId)
      .in(
        'key',
        doc.categories.map((c) => c.key),
      );

    for (const c of (existing.data ?? []) as { id: string; key: string }[]) {
      out.set(c.key, c.id);
    }

    for (const c of doc.categories) {
      if (out.has(c.key)) continue;
      if (!autoCreate) continue;
      const ins = await this.client
        .from('status_categories')
        .insert({
          organization_id: organizationId,
          space_id: spaceId,
          key: c.key,
          name: c.name,
          color: c.color || '#6B7280',
          is_done_like: c.is_done_like ?? false,
          created_by: userId,
        })
        .select('id')
        .single();

      if (!ins.error && ins.data)
        out.set(c.key, (ins.data as { id: string }).id);
    }

    return out;
  }

  private async resolveStatuses(
    doc: WorkflowExportDoc,
    organizationId: string,
    spaceId: string | null,
    autoCreate: boolean,
    categoryIdByKey: Map<string, string>,
    userId: string,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const statusNodes = doc.nodes.filter(
      (n) => n.kind === 'status' && n.status_key,
    );
    const keys = [...new Set(statusNodes.map((n) => n.status_key as string))];

    if (keys.length === 0) return out;
    const existing = await this.client
      .from('task_statuses')
      .select('id, key')
      .eq('organization_id', organizationId)
      .in('key', keys);

    for (const s of (existing.data ?? []) as { id: string; key: string }[]) {
      out.set(s.key, s.id);
    }

    for (const n of statusNodes) {
      const key = n.status_key as string;

      if (out.has(key)) continue;
      if (!autoCreate) continue;
      const categoryId = n.status_category_key
        ? categoryIdByKey.get(n.status_category_key)
        : undefined;
      const ins = await this.client
        .from('task_statuses')
        .insert({
          organization_id: organizationId,
          space_id: spaceId,
          key,
          name: n.status_name ?? key,
          category_id: categoryId ?? null,
          created_by: userId,
        })
        .select('id')
        .single();

      if (!ins.error && ins.data) out.set(key, (ins.data as { id: string }).id);
    }

    return out;
  }

  private async existingKeys(
    table: string,
    keys: string[],
    organizationId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- reserved for future space scoping
    _spaceId: string | null,
  ): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const r = await this.client
      .from(table)
      .select('key')
      .eq('organization_id', organizationId)
      .in('key', keys);

    return new Set(((r.data ?? []) as { key: string }[]).map((x) => x.key));
  }

  private async matchFieldGroupNames(
    names: string[],
    organizationId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- reserved for future space scoping
    _spaceId: string | null,
  ): Promise<Map<string, string | undefined>> {
    const out = new Map<string, string | undefined>();

    if (names.length === 0) return out;
    const r = await this.client
      .from('field_groups')
      .select('id, name')
      .eq('organization_id', organizationId)
      .in('name', names);
    const byName = new Map(
      ((r.data ?? []) as { id: string; name: string }[]).map((g) => [
        g.name,
        g.id,
      ]),
    );

    for (const n of names) out.set(n, byName.get(n));

    return out;
  }

  private async workflowNameExists(
    name: string,
    organizationId: string,
    spaceId: string | null,
  ): Promise<boolean> {
    let q = this.client
      .from('workflows')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('name', name)
      .eq('is_archived', false)
      .eq('is_draft', false);

    q = spaceId ? q.eq('space_id', spaceId) : q.is('space_id', null);
    const r = await q.limit(1);

    return ((r.data ?? []) as unknown[]).length > 0;
  }

  private async loadStatusMeta(
    ids: string[],
  ): Promise<
    Map<string, { key: string; name: string; category_id: string | null }>
  > {
    if (ids.length === 0) return new Map();
    const r = await this.client
      .from('task_statuses')
      .select('id, key, name, category_id')
      .in('id', ids);

    return new Map(
      (
        (r.data ?? []) as {
          id: string;
          key: string;
          name: string;
          category_id: string | null;
        }[]
      ).map((s) => [
        s.id,
        { key: s.key, name: s.name, category_id: s.category_id },
      ]),
    );
  }

  private async loadCategoryMeta(
    ids: string[],
  ): Promise<
    Map<
      string,
      { key: string; name: string; color: string; is_done_like: boolean }
    >
  > {
    if (ids.length === 0) return new Map();
    const r = await this.client
      .from('status_categories')
      .select('id, key, name, color, is_done_like')
      .in('id', ids);

    return new Map(
      (
        (r.data ?? []) as {
          id: string;
          key: string;
          name: string;
          color: string;
          is_done_like: boolean;
        }[]
      ).map((c) => [
        c.id,
        {
          key: c.key,
          name: c.name,
          color: c.color,
          is_done_like: c.is_done_like,
        },
      ]),
    );
  }

  private async mapFieldGroupNames(
    ids: string[],
  ): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const r = await this.client
      .from('field_groups')
      .select('id, name')
      .in('id', ids);

    return new Map(
      ((r.data ?? []) as { id: string; name: string }[]).map((g) => [
        g.id,
        g.name,
      ]),
    );
  }

  private stripVolatile(rules: {
    conditions: unknown[];
    validators: unknown[];
    post_functions: unknown[];
    triggers: unknown[];
  }): {
    conditions: unknown[];
    validators: unknown[];
    post_functions: unknown[];
    triggers: unknown[];
    unresolved: { phase: string; type: string; kinds: string[] }[];
  } {
    const unresolved: { phase: string; type: string; kinds: string[] }[] = [];
    const phaseMap: Record<string, string> = {
      conditions: 'condition',
      validators: 'validator',
      post_functions: 'post_function',
      triggers: 'trigger',
    };
    const out: Record<string, unknown[]> = {};

    for (const phaseKey of WorkflowsImportExportService.RULE_PHASES) {
      const phase = phaseMap[phaseKey];
      const list = rules[phaseKey] ?? [];

      out[phaseKey] = list.map((rule) => {
        if (!rule || typeof rule !== 'object') return rule;
        const type = (rule as { type?: string }).type;

        if (!type) return rule;
        const handler = this.registry.get(phase as never, type);

        if (!handler) return rule;
        let refs: { kind: string; id: string }[] = [];

        try {
          refs = handler.findReferences(rule as never);
        } catch {
          refs = [];
        }
        const volatile = refs.filter((r) => VOLATILE_KINDS.has(r.kind));
        const volatileIds = new Set(volatile.map((r) => r.id));

        if (volatileIds.size === 0) return rule;
        unresolved.push({
          phase,
          type,
          kinds: [...new Set(volatile.map((r) => r.kind))],
        });

        return this.deepNullIds(rule, volatileIds);
      });
    }

    return {
      conditions: out.conditions,
      validators: out.validators,
      post_functions: out.post_functions,
      triggers: out.triggers,
      unresolved,
    };
  }

  private deepNullIds(value: unknown, volatileIds: Set<string>): unknown {
    if (typeof value === 'string') {
      return volatileIds.has(value) ? null : value;
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.deepNullIds(v, volatileIds));
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};

      for (const [k, v] of Object.entries(value)) {
        out[k] = this.deepNullIds(v, volatileIds);
      }

      return out;
    }

    return value;
  }
}

interface RawNode {
  id: string;
  kind: 'status' | 'decision' | 'start';
  status_id: string | null;
  label: string | null;
  position_x: number;
  position_y: number;
  properties: Record<string, unknown> | null;
}
interface RawTransition {
  id: string;
  name: string;
  kind: string;
  to_node_id: string;
  screen_field_group_id: string | null;
  conditions: unknown[] | null;
  validators: unknown[] | null;
  post_functions: unknown[] | null;
  triggers: unknown[] | null;
  properties: Record<string, unknown> | null;
  sort_order: number;
}
interface RawSource {
  transition_id: string;
  from_node_id: string;
}
interface RawBranch {
  decision_node_id: string;
  to_node_id: string | null;
  expression: Record<string, unknown> | null;
  label: string | null;
  sort_order: number;
}
