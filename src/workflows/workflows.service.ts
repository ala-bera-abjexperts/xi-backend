/**
 * @fileoverview Service for workflow CRUD — named diagrams with nodes and transitions.
 * @module src/workflows/workflows.service
 * @author Rajbha Manek
 */
import { randomUUID } from 'crypto';
import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { WorkflowHealthService } from '../workflow-health/workflow-health.service';
import { HandlerRegistryService } from '../workflow-engine/handlers/handler-registry.service';
import type {
  IRuleReference,
  RulePhase,
} from '../workflow-engine/handlers/handler.types';
import { assertRuleReferencesInOrganization } from '../workflow-engine/handlers/rule-reference-validation';
import {
  isSystemFieldId,
  isValidRuleFieldId,
} from '../workflow-engine/handlers/system-fields';
import type { CreateWorkflowDto } from './dto/create-workflow.dto';
import type { UpdateWorkflowDto } from './dto/update-workflow.dto';
import type { SaveCanvasDto } from './dto/save-canvas.dto';

// Strict parse of an optional 'true'/'false' query-string boolean.
// Returns null for missing OR malformed values so callers can apply
// their own default instead of silently treating typos as `false`.
function parseBoolParam(v: string | undefined): boolean | null {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

// Best-effort UUID scrape from a PostgreSQL RAISE EXCEPTION message —
// publish_workflow_atomic emits 'Cannot publish: missing migration mapping
// for status(es) {uuid1,uuid2,...}' on 23514. We use this to surface the
// missing ids in the 409 payload so the dialog can pre-fill the migration
// map without a second preview round trip. Returns [] on any parse miss
// so the caller falls through gracefully.
//
// Pattern is intentionally version-agnostic (any hex segments matching the
// `8-4-4-4-12` shape): Postgres-generated ids may be v4 OR — for legacy
// rows — any other UUID variant, and we'd rather echo back a permissive
// match than drop the array entirely.
const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function parseUuidArrayFromMessage(message: string): string[] {
  if (!message) return [];
  const matches = message.match(UUID_PATTERN);

  return matches ? Array.from(new Set(matches)) : [];
}

export interface Workflow {
  id: string;
  organization_id: string;
  space_id: string | null;
  name: string;
  description: string | null;
  is_active: boolean;
  is_draft: boolean;
  parent_workflow_id: string | null;
  is_archived: boolean;
  archived_at: string | null;
  initial_status_id: string | null;
  layout: Record<string, unknown>;
  version: number;
  lock_token: string | null;
  lock_user_id: string | null;
  lock_acquired_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkflowDetail extends Workflow {
  nodes: unknown[];
  transitions: unknown[];
  sources: unknown[];
  branches: unknown[];
}

export interface WorkflowListFilters {
  spaceId?: string;
  isArchived?: string;
  isDraft?: string;
}

/**
 * Camel-cased workflow trigger event as returned by
 * {@link WorkflowsService.listTriggerEvents}. `workflowName` is joined from the
 * owning workflow via a PostgREST embed and is null when the workflow_id is
 * null or the workflow has since been deleted (FK ON DELETE SET NULL).
 */
export interface IWorkflowTriggerEventDto {
  id: string;
  triggerType: string;
  outcome: string;
  workflowId: string | null;
  workflowName: string | null;
  transitionId: string | null;
  subjectTaskId: string | null;
  // Human-readable task reference resolved from subjectTaskId within the org.
  // Both null when there is no subject task or the task no longer exists.
  subjectTaskKey: string | null;
  subjectTaskName: string | null;
  message: string | null;
  context: unknown;
  createdAt: string;
}

/**
 * Raw `workflow_trigger_events` row shape with the PostgREST `workflows(name)`
 * embed. The workflow_id → workflows FK is many-to-one, so the embed resolves
 * to a single object (or null when workflow_id is null / the workflow is gone).
 */
interface WorkflowTriggerEventRow {
  id: string;
  trigger_type: string;
  outcome: string;
  workflow_id: string | null;
  transition_id: string | null;
  subject_task_id: string | null;
  message: string | null;
  context: unknown;
  created_at: string;
  workflows: { name: string | null } | null;
}

/** A decision branch row as returned in {@link WorkflowDetail.branches}. */
interface BranchRow {
  decision_node_id: string;
  to_node_id?: string | null;
  expression?: unknown;
  label?: string | null;
  sort_order?: number | null;
}

/** Stable JSON stringify — sorts object keys so key-order jitter isn't a diff. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;

  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

/**
 * Fingerprint each decision node's ORDERED branch set (target node key +
 * expression + label), keyed by the node's stable clone-boundary key. Used by
 * the publish-preview diff so decision-branch edits register as real changes.
 */
function branchFingerprintByDecision(
  branches: BranchRow[],
  keyByNode: Map<string, string>,
): Map<string, string> {
  const byDecision = new Map<string, BranchRow[]>();

  for (const b of branches) {
    const decisionKey = keyByNode.get(b.decision_node_id);

    if (!decisionKey) continue;
    const list = byDecision.get(decisionKey) ?? [];

    list.push(b);
    byDecision.set(decisionKey, list);
  }

  const fp = new Map<string, string>();

  for (const [decisionKey, list] of byDecision) {
    const ordered = [...list]
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((b) => ({
        to: b.to_node_id ? (keyByNode.get(b.to_node_id) ?? b.to_node_id) : '',
        expression: b.expression ?? null,
        label: b.label ?? null,
      }));

    fp.set(decisionKey, stableStringify(ordered));
  }

  return fp;
}

@Injectable()
export class WorkflowsService {
  private static readonly TABLE = 'workflows';
  private static readonly NODES_TABLE = 'workflow_nodes';
  private static readonly TRANSITIONS_TABLE = 'workflow_transitions';
  private static readonly SOURCES_TABLE = 'workflow_transition_sources';
  private static readonly BRANCHES_TABLE = 'workflow_decision_branches';
  private static readonly ASSIGNMENTS_TABLE = 'workflow_assignments';

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    @Optional() private readonly auditLogsService?: AuditLogsService,
    // EventEmitter is optional so existing tests that instantiate
    // WorkflowsService with just (supa) keep working unchanged. When
    // wired in the live app, the emitter feeds the trigger-registry
    // cache rebuild on canvas changes to non-draft workflows.
    @Optional() private readonly eventEmitter?: EventEmitter2,
    // Optional so existing unit tests construct WorkflowsService with fewer
    // args. When wired, the linter re-runs after canvas saves and gates publish.
    @Optional() private readonly health?: WorkflowHealthService,
    // Optional for legacy unit construction; production module imports
    // WorkflowEngineModule, so the registry is always available there.
    @Optional() private readonly registry?: HandlerRegistryService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async getAll(
    organizationId: string,
    filters?: WorkflowListFilters,
  ): Promise<
    (Workflow & {
      nodes_count: number;
      transitions_count: number;
      assignments_count: number;
      health_error_count: number;
      health_warning_count: number;
    })[]
  > {
    let query = this.client
      .from(WorkflowsService.TABLE)
      .select('*')
      .eq('organization_id', organizationId);

    if (filters?.spaceId) {
      query = query.or(`space_id.is.null,space_id.eq.${filters.spaceId}`);
    }
    // I6: accept only explicit 'true'/'false' for boolean query params.
    // Anything else falls back to the unfiltered default (omit the filter
    // entirely so a typo doesn't silently apply `= false`).
    const isArchivedParam = parseBoolParam(filters?.isArchived);

    if (isArchivedParam !== null) {
      query = query.eq('is_archived', isArchivedParam);
    } else {
      query = query.eq('is_archived', false);
    }

    const isDraftParam = parseBoolParam(filters?.isDraft);

    if (isDraftParam !== null) {
      query = query.eq('is_draft', isDraftParam);
    } else {
      query = query.eq('is_draft', false);
    }

    const r = await query.order('name', { ascending: true });

    if (r.error) throw new BadRequestException(r.error.message);
    const workflows = (r.data ?? []) as Workflow[];

    if (workflows.length === 0) {
      return [];
    }
    const ids = workflows.map((w) => w.id);

    // PostgREST has no GROUP BY — fetch workflow_id columns in parallel and tally in JS.
    // Note: .in('workflow_id', ids) serializes ids into the URL query string.
    // PostgREST + default proxy limits cap this around ~500-1000 ids before
    // hitting URL-length errors. Acceptable for current scale (<100 workflows
    // per org). If we ever exceed that, chunk ids into batches and merge tallies.
    const [nodeRows, transitionRows, assignmentRows, healthRows] =
      await Promise.all([
        this.client
          .from(WorkflowsService.NODES_TABLE)
          .select('workflow_id')
          .in('workflow_id', ids),
        this.client
          .from(WorkflowsService.TRANSITIONS_TABLE)
          .select('workflow_id')
          .in('workflow_id', ids),
        this.client
          .from(WorkflowsService.ASSIGNMENTS_TABLE)
          .select('workflow_id')
          // defense-in-depth: scope cross-org even though workflow_id is already org-scoped via workflows FK
          .eq('organization_id', organizationId)
          .in('workflow_id', ids),
        // Prompt 10: unresolved health issues per workflow, for the list chip.
        this.client
          .from('workflow_health_issues')
          .select('workflow_id, severity')
          .eq('organization_id', organizationId)
          .is('resolved_at', null)
          .in('workflow_id', ids),
      ]);

    if (nodeRows.error) throw new BadRequestException(nodeRows.error.message);
    if (transitionRows.error)
      throw new BadRequestException(transitionRows.error.message);
    if (assignmentRows.error)
      throw new BadRequestException(assignmentRows.error.message);

    const nodeCounts = WorkflowsService.tally(
      nodeRows.data as { workflow_id: string }[] | null,
    );
    const transitionCounts = WorkflowsService.tally(
      transitionRows.data as { workflow_id: string }[] | null,
    );
    const assignmentCounts = WorkflowsService.tally(
      assignmentRows.data as { workflow_id: string }[] | null,
    );

    // Health is advisory — tolerate a query error by treating it as no issues.
    const healthData = (healthRows.data ?? []) as {
      workflow_id: string;
      severity: string;
    }[];
    const healthErrorCounts: Record<string, number> = {};
    const healthWarningCounts: Record<string, number> = {};

    for (const h of healthData) {
      if (h.severity === 'error') {
        healthErrorCounts[h.workflow_id] =
          (healthErrorCounts[h.workflow_id] ?? 0) + 1;
      } else if (h.severity === 'warning') {
        healthWarningCounts[h.workflow_id] =
          (healthWarningCounts[h.workflow_id] ?? 0) + 1;
      }
    }

    return workflows.map((w) => ({
      ...w,
      nodes_count: nodeCounts[w.id] ?? 0,
      transitions_count: transitionCounts[w.id] ?? 0,
      assignments_count: assignmentCounts[w.id] ?? 0,
      health_error_count: healthErrorCounts[w.id] ?? 0,
      health_warning_count: healthWarningCounts[w.id] ?? 0,
    }));
  }

  /**
   * List the 50 most recent workflow trigger events for an organization,
   * newest first. Read-only feed backing the trigger-activity panel; the owning
   * workflow's name is joined via a PostgREST `workflows(name)` embed so the UI
   * can render a label without a second round trip.
   *
   * @param organizationId - calling org
   * @param workflowId - optional; when set, scope the feed to a single workflow
   *   (the editor passes the PUBLISHED workflow id so a draft still shows its
   *   parent's history). Omitted → org-wide feed (unchanged behavior).
   * @returns camel-cased trigger-event DTOs, most recent first
   * @throws InternalServerErrorException on any query failure
   */
  async listTriggerEvents(
    organizationId: string,
    workflowId?: string,
  ): Promise<IWorkflowTriggerEventDto[]> {
    let query = this.client
      .from('workflow_trigger_events')
      .select(
        'id, trigger_type, outcome, workflow_id, transition_id, subject_task_id, message, context, created_at, workflows(name)',
      )
      .eq('organization_id', organizationId);

    if (workflowId) {
      query = query.eq('workflow_id', workflowId);
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('Failed to list workflow trigger events:', error);
      throw new InternalServerErrorException(
        'Failed to list workflow trigger events',
      );
    }

    const rows = (data ?? []) as unknown as WorkflowTriggerEventRow[];

    // Resolve human-readable task references (key + summary) from the subject
    // task ids, org-scoped. Single batched lookup (no N+1); best-effort so a
    // failure leaves names null rather than dropping the whole feed.
    const taskIds = Array.from(
      new Set(
        rows.map((r) => r.subject_task_id).filter((id): id is string => !!id),
      ),
    );

    const taskById = new Map<string, { key: string; summary: string | null }>();

    if (taskIds.length) {
      const { data: taskRows, error: taskErr } = await this.client
        .from('tasks')
        .select('id, key, summary')
        .eq('organization_id', organizationId)
        .in('id', taskIds);

      if (taskErr) {
        console.error(
          'Failed to resolve trigger-event task names:',
          taskErr.message,
        );
      } else {
        for (const t of (taskRows ?? []) as Array<{
          id: string;
          key: string;
          summary: string | null;
        }>) {
          taskById.set(t.id, { key: t.key, summary: t.summary ?? null });
        }
      }
    }

    return rows.map((r) => {
      const task = r.subject_task_id ? taskById.get(r.subject_task_id) : null;

      return {
        id: r.id,
        triggerType: r.trigger_type,
        outcome: r.outcome,
        workflowId: r.workflow_id,
        workflowName: r.workflows?.name ?? null,
        transitionId: r.transition_id,
        subjectTaskId: r.subject_task_id,
        subjectTaskKey: task?.key ?? null,
        subjectTaskName: task?.summary ?? null,
        message: r.message,
        context: r.context,
        createdAt: r.created_at,
      };
    });
  }

  async getById(id: string, organizationId: string): Promise<Workflow> {
    const r = await this.client
      .from(WorkflowsService.TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (r.error) throw new BadRequestException(r.error.message);
    if (!r.data) throw new NotFoundException('Workflow not found');
    return r.data as Workflow;
  }

  async getDetail(id: string, organizationId: string): Promise<WorkflowDetail> {
    const workflow = await this.getById(id, organizationId);

    // M4: sub-table queries scoped by workflow_id (org already verified by getById above)
    const [nodesR, transitionsR] = await Promise.all([
      this.client
        .from(WorkflowsService.NODES_TABLE)
        .select('*')
        .eq('workflow_id', id),
      this.client
        .from(WorkflowsService.TRANSITIONS_TABLE)
        .select('*')
        .eq('workflow_id', id)
        .order('sort_order', { ascending: true }),
    ]);

    if (nodesR.error) throw new BadRequestException(nodesR.error.message);
    if (transitionsR.error)
      throw new BadRequestException(transitionsR.error.message);

    const nodeIds = (nodesR.data ?? []).map((n: { id: string }) => n.id);
    const transitionIds = (transitionsR.data ?? []).map(
      (t: { id: string }) => t.id,
    );

    let sources: unknown[] = [];
    let branches: unknown[] = [];

    if (transitionIds.length > 0) {
      const sourcesR = await this.client
        .from(WorkflowsService.SOURCES_TABLE)
        .select('*')
        .in('transition_id', transitionIds);

      if (sourcesR.error) throw new BadRequestException(sourcesR.error.message);
      sources = sourcesR.data ?? [];
    }

    if (nodeIds.length > 0) {
      const branchesR = await this.client
        .from(WorkflowsService.BRANCHES_TABLE)
        .select('*')
        .in('decision_node_id', nodeIds)
        .order('sort_order', { ascending: true });

      if (branchesR.error)
        throw new BadRequestException(branchesR.error.message);
      branches = branchesR.data ?? [];
    }

    return {
      ...workflow,
      nodes: nodesR.data ?? [],
      transitions: transitionsR.data ?? [],
      sources,
      branches,
    };
  }

  async create(
    organizationId: string,
    dto: CreateWorkflowDto,
    actorUserId?: string | null,
  ): Promise<Workflow> {
    // H3: Validate space_id belongs to this org before inserting
    if (dto.space_id) {
      const spaceR = await this.client
        .from('spaces')
        .select('id')
        .eq('id', dto.space_id)
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (spaceR.error) throw new BadRequestException(spaceR.error.message);
      if (!spaceR.data) throw new NotFoundException('Space not found');
    }

    const row = {
      organization_id: organizationId,
      space_id: dto.space_id ?? null,
      name: dto.name,
      description: dto.description ?? null,
      initial_status_id: dto.initial_status_id ?? null,
      created_by: actorUserId ?? null,
      updated_by: actorUserId ?? null,
    };
    const r = await this.client
      .from(WorkflowsService.TABLE)
      .insert(row)
      .select()
      .single();

    if (r.error) {
      if (r.error.code === '23505')
        throw new ConflictException(
          `A workflow named '${dto.name}' already exists in this scope`,
        );
      throw new BadRequestException(r.error.message);
    }
    const created = r.data as Workflow;

    // Prompt 1: every new workflow gets exactly one START node — the canvas
    // entry point the initial transition originates from. Created here so a
    // workflow is editable immediately (the DB enforces one start per workflow
    // via a partial unique index). position defaults handle layout.
    const startNode = await this.client
      .from(WorkflowsService.NODES_TABLE)
      .insert({
        workflow_id: created.id,
        kind: 'start',
        position_x: 250,
        position_y: 40,
      });

    if (startNode.error) throw new BadRequestException(startNode.error.message);

    this.logAudit(organizationId, actorUserId, created.id, 'create', {
      name: created.name,
    });
    return created;
  }

  async update(
    id: string,
    organizationId: string,
    dto: UpdateWorkflowDto,
    actorUserId?: string | null,
  ): Promise<Workflow> {
    const existing = await this.getById(id, organizationId);
    const patch: Record<string, unknown> = {};

    if (dto.name !== undefined) patch['name'] = dto.name;
    if (dto.description !== undefined) patch['description'] = dto.description;
    if (dto.is_archived === true) {
      // H2: Block archiving active workflows via the update path too
      if (existing.is_active) {
        throw new ConflictException(
          'Cannot archive an active workflow. Remove all assignments first.',
        );
      }
      patch['is_archived'] = true;
      patch['archived_at'] = new Date().toISOString();
    } else if (dto.is_archived === false) {
      patch['is_archived'] = false;
      patch['archived_at'] = null;
    }
    patch['updated_by'] = actorUserId ?? null;

    if (Object.keys(patch).length === 1)
      throw new BadRequestException(
        'At least one field must be provided for update',
      );

    const r = await this.client
      .from(WorkflowsService.TABLE)
      .update(patch)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (r.error) throw new BadRequestException(r.error.message);

    // I2: archive/restore must be auditable as distinct actions from a
    // regular metadata edit, so downstream "who archived X" queries can
    // find them. Mirrors archive()'s `delete`/`action:'archive'` shape.
    if (dto.is_archived === true) {
      this.logAudit(organizationId, actorUserId, id, 'delete', {
        name: existing.name,
        action: 'archive',
      });
    } else if (dto.is_archived === false) {
      this.logAudit(organizationId, actorUserId, id, 'delete', {
        name: existing.name,
        action: 'restore',
      });
    } else {
      this.logAudit(organizationId, actorUserId, id, 'update', patch);
    }

    return r.data as Workflow;
  }

  async archive(
    id: string,
    organizationId: string,
    actorUserId?: string | null,
  ): Promise<void> {
    const existing = await this.getById(id, organizationId);

    if (existing.is_active) {
      throw new ConflictException(
        'Cannot archive an active workflow. Remove all assignments first.',
      );
    }
    const r = await this.client
      .from(WorkflowsService.TABLE)
      .update({
        is_archived: true,
        archived_at: new Date().toISOString(),
        updated_by: actorUserId ?? null,
      })
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (r.error) throw new BadRequestException(r.error.message);
    this.logAudit(organizationId, actorUserId, id, 'delete', {
      name: existing.name,
      action: 'archive',
    });
  }

  async saveCanvas(
    id: string,
    organizationId: string,
    dto: SaveCanvasDto,
    actorUserId?: string | null,
  ): Promise<unknown> {
    const existing = await this.getById(id, organizationId);

    if (existing.is_archived) {
      throw new ConflictException(
        'Cannot save canvas to an archived workflow.',
      );
    }

    // C4: pre-guard active/non-draft workflows. The RPC also rejects this with
    // RAISE EXCEPTION (no errcode → P0001, which would fall through to a
    // generic 400 in the client). Surface as 409 with the current detail so
    // the client's ConflictDialog opens.
    if (existing.is_active && !existing.is_draft) {
      const current = await this.getDetail(id, organizationId);

      throw new ConflictException({
        message:
          'Cannot save canvas to an active workflow; create a draft first.',
        data: { current },
      });
    }

    // Pre-RPC guards the RPC doesn't cover.

    // 1) Duplicate IDs in payload — surface a clean 400 instead of relying
    //    on the RPC's eventual 23505.
    const dupe = (arr: { id: string }[]): string | null => {
      const seen = new Set<string>();

      for (const x of arr) {
        if (seen.has(x.id)) return x.id;
        seen.add(x.id);
      }

      return null;
    };
    const dupeNode = dupe(dto.nodes);
    const dupeTransition = dupe(dto.transitions);
    const dupeBranch = dupe(dto.decision_branches);

    if (dupeNode || dupeTransition || dupeBranch) {
      throw new BadRequestException(
        `Duplicate id in payload: ${dupeNode ?? dupeTransition ?? dupeBranch}`,
      );
    }

    // C5: workflow_transition_sources has composite PK (transition_id,
    // from_node_id). Catch duplicate pairs before they surface as a raw
    // sqlstate 23505 with the constraint name leaking.
    const srcSeen = new Set<string>();

    for (const s of dto.transition_sources) {
      const key = `${s.transition_id}:${s.from_node_id}`;

      if (srcSeen.has(key)) {
        throw new BadRequestException(
          `Duplicate transition source pair: ${key}`,
        );
      }
      srcSeen.add(key);
    }

    // 2) Every status node's status_id must belong to a status visible from
    //    the workflow's space — either an org-level status or a status whose
    //    space_id matches the workflow's space_id. RPC does not enforce this.
    const statusIds = dto.nodes
      .filter((n) => n.kind === 'status' && n.status_id)
      .map((n) => n.status_id as string);

    if (statusIds.length > 0) {
      const q = this.client
        .from('task_statuses')
        .select('id, space_id')
        .eq('organization_id', organizationId)
        .in('id', statusIds);
      const r = await q;

      if (r.error) throw new BadRequestException(r.error.message);
      const validIds = new Set(
        (r.data ?? [])
          .map((x: { id: string; space_id: string | null }) => {
            // org-level (null) always valid; space-level valid only if workflow's space matches
            if (x.space_id === null) return x.id;
            if (existing.space_id && existing.space_id === x.space_id)
              return x.id;

            return null;
          })
          .filter(Boolean) as string[],
      );
      const missing = statusIds.filter((sid) => !validIds.has(sid));

      if (missing.length > 0) {
        throw new BadRequestException(
          `status_id(s) not visible from this workflow's scope: ${missing.join(', ')}`,
        );
      }
    }

    // Validate canvas rules before persisting — checks handler schemas and
    // cross-org reference integrity. Throws 422 on the first rule issue so
    // the editor can surface actionable messages before touching the DB.
    await this.validateCanvasRules(organizationId, dto);

    // Call the atomic RPC.
    const rpc = await this.client.rpc('upsert_workflow_canvas', {
      p_workflow_id: id,
      p_organization_id: organizationId,
      p_expected_version: dto.version,
      p_initial_status_id: dto.initial_status_id ?? null,
      p_layout: dto.layout ?? {},
      p_nodes: dto.nodes,
      p_transitions: dto.transitions,
      p_transition_sources: dto.transition_sources,
      p_decision_branches: dto.decision_branches,
      p_user_id: actorUserId ?? null,
    });

    if (rpc.error) {
      const code = (rpc.error as { code?: string }).code;

      if (code === '40001') {
        const current = await this.getDetail(id, organizationId);

        throw new ConflictException({
          message: 'Workflow was modified by another session',
          data: { current },
        });
      }
      if (code === '23514') {
        // active-workflow guard, FK violation, etc — propagate as 409 with a clearer message.
        throw new ConflictException(rpc.error.message);
      }
      if (code === '42501') {
        throw new ForbiddenException(rpc.error.message);
      }
      if (code === '23505') {
        throw new BadRequestException(
          `Duplicate key violation: ${rpc.error.message}`,
        );
      }
      if (code === '23503') {
        throw new BadRequestException(
          `Invalid reference: ${rpc.error.message}`,
        );
      }
      throw new BadRequestException(rpc.error.message);
    }

    this.logAudit(organizationId, actorUserId, id, 'update', {
      action: 'save_canvas',
      version_from: dto.version,
    });

    // B3 fix — feed the workflow-trigger registry's cache rebuild. Only
    // emit when the saved workflow is NOT a draft: saving a draft just
    // updates an editor scratchpad whose transitions aren't yet live, so
    // there's nothing for trigger registry to do. A non-draft save (today
    // limited to inactive workflows by the C4 guard above; future Prompt 8
    // publish path will also reach this point) materializes new triggers
    // that the registry must pick up.
    if (!existing.is_draft && this.eventEmitter) {
      this.eventEmitter.emit('workflow.published', {
        workflowId: id,
        organizationId,
      });
    }

    // Prompt 10: re-lint after the canvas commits. Fire-and-forget — health
    // reporting is advisory and must never fail or delay the save.
    if (this.health) {
      void this.health.runLinter(id, organizationId).catch(() => undefined);
    }

    // Return the full updated detail (nodes/transitions/sources/branches) so the
    // client's hydrateFromServer() can rebuild the canvas + refresh version. The
    // RPC only returns the workflows row (to_jsonb(v_workflow)), which lacks `nodes`.
    return this.getDetail(id, organizationId);
  }

  /**
   * Validate every rule (conditions / validators / post-functions / triggers)
   * on every transition in the canvas payload.
   *
   * Two checks run in sequence:
   *   1. Schema validation via HandlerRegistryService.validateRule — catches
   *      missing required fields, wrong value types, etc.
   *   2. Cross-org reference check via assertRuleReferencesInOrganization —
   *      ensures every referenced UUID (field, user, group, etc.) belongs to
   *      the same organization, preventing cross-tenant data leaks.
   *
   * @throws BadRequestException when the registry is unavailable.
   * @throws UnprocessableEntityException with `{issues}` on schema failure,
   *         or with `{missing}` on cross-org reference failure.
   */
  private async validateCanvasRules(
    organizationId: string,
    dto: SaveCanvasDto,
  ): Promise<void> {
    if (!this.registry) {
      throw new BadRequestException(
        'Workflow rule registry is unavailable; cannot verify save safety',
      );
    }

    const phases: Array<{
      phase: RulePhase;
      key: 'conditions' | 'validators' | 'post_functions' | 'triggers';
    }> = [
      { phase: 'condition', key: 'conditions' },
      { phase: 'validator', key: 'validators' },
      { phase: 'post_function', key: 'post_functions' },
      { phase: 'trigger', key: 'triggers' },
    ];
    const issues: Array<{
      transition_id: string;
      transition_name: string;
      phase: RulePhase;
      index: number;
      type?: string;
      path?: (string | number)[];
      message: string;
    }> = [];

    for (const transition of dto.transitions) {
      for (const { phase, key } of phases) {
        const rules = transition[key] ?? [];

        rules.forEach((rule, index) => {
          const ruleIssues = this.registry!.validateRule(phase, index, rule);

          issues.push(
            ...ruleIssues.map((issue) => ({
              transition_id: transition.id,
              transition_name: transition.name,
              phase: issue.phase,
              index: issue.index,
              type: issue.type,
              path: issue.path,
              message: issue.message,
            })),
          );
        });
      }
    }

    if (issues.length > 0) {
      throw new UnprocessableEntityException({
        message: 'Rule validation failed',
        data: { issues },
      });
    }

    const refs: IRuleReference[] = [];

    for (const transition of dto.transitions) {
      refs.push(
        ...this.registry.collectReferences({
          conditions: transition.conditions ?? [],
          validators: transition.validators ?? [],
          post_functions: transition.post_functions ?? [],
          triggers: transition.triggers ?? [],
        }),
      );
    }

    // B4: fold decision-branch custom-field references into the SAME cross-org
    // safety check. Only complete custom-field UUIDs are collected; `sys:`
    // system fields and non-field expression kinds are skipped. We deliberately
    // do NOT reject incomplete/empty branch expressions on save — save stays
    // permissive so existing and mid-edit workflows remain savable; branch
    // completeness is enforced at PUBLISH by DecisionIncompleteBranchCheck.
    for (const branch of dto.decision_branches ?? []) {
      this.collectDecisionBranchFieldRefs(branch.expression, refs);
    }

    await assertRuleReferencesInOrganization(this.client, organizationId, refs);
  }

  /**
   * Walk a decision-branch `expression` (recursing into `condition_group`
   * children) and append a `field` reference for every custom-field UUID it
   * targets. `sys:` system fields and malformed/empty ids are skipped so save
   * validation only guards against genuine cross-tenant custom-field refs.
   */
  private collectDecisionBranchFieldRefs(
    expr: unknown,
    out: IRuleReference[],
  ): void {
    if (!expr || typeof expr !== 'object') return;
    const e = expr as Record<string, unknown>;
    const fieldId = e.field_id;

    if (
      typeof fieldId === 'string' &&
      isValidRuleFieldId(fieldId) &&
      !isSystemFieldId(fieldId)
    ) {
      out.push({ kind: 'field', id: fieldId });
    }

    const children = e.children;

    if (Array.isArray(children)) {
      for (const child of children) {
        this.collectDecisionBranchFieldRefs(child, out);
      }
    }
  }

  async duplicate(
    id: string,
    organizationId: string,
    newName: string,
    actorUserId?: string | null,
  ): Promise<WorkflowDetail> {
    const source = await this.getDetail(id, organizationId);

    // Create new workflow row
    const workflowRow = {
      organization_id: organizationId,
      space_id: source.space_id,
      name: newName,
      description: source.description,
      initial_status_id: source.initial_status_id,
      is_active: false,
      is_draft: false,
      version: 1,
      created_by: actorUserId ?? null,
      updated_by: actorUserId ?? null,
    };
    const wfR = await this.client
      .from(WorkflowsService.TABLE)
      .insert(workflowRow)
      .select()
      .single();

    if (wfR.error) {
      if (wfR.error.code === '23505')
        throw new ConflictException(
          `A workflow named '${newName}' already exists in this scope`,
        );
      throw new BadRequestException(wfR.error.message);
    }
    const newWorkflow = wfR.data as Workflow;

    // C2: All canvas inserts wrapped in try/catch — on any failure the new workflow
    // row is deleted (cascade removes all child records) to avoid orphaned state.
    try {
      await this.deepCopyCanvas(source, newWorkflow.id);
    } catch (error) {
      // Best-effort cleanup — cascade deletes nodes, transitions, sources, branches
      await this.client
        .from(WorkflowsService.TABLE)
        .delete()
        .eq('id', newWorkflow.id)
        .eq('organization_id', organizationId);
      throw error;
    }

    this.logAudit(organizationId, actorUserId, newWorkflow.id, 'create', {
      name: newName,
      duplicated_from: id,
    });
    return this.getDetail(newWorkflow.id, organizationId);
  }

  /**
   * Copy nodes / transitions / transition sources / decision branches from
   * `srcDetail` into `targetWorkflowId`.
   *
   * Child IDs are always re-randomised: both `duplicate()` and `createDraft()`
   * need fresh UUIDs because the source and the target rows coexist in the
   * same table at the same time. (For drafts in particular, the publish RPC
   * later copies the draft's child IDs verbatim into the parent — at which
   * point the original parent rows have already been deleted, so there's no
   * collision risk on publish either.) `status_id` references on status
   * nodes are preserved as-is so the new workflow still points at the org/
   * space-scoped `task_statuses` rows the source did.
   *
   * Caller owns the new workflow row + cleanup-on-failure semantics. This
   * helper is best-effort idempotent: it throws if any child insert fails
   * so the caller can cascade-delete the workflow row to avoid orphans.
   *
   * @param srcDetail - source workflow detail with nodes/transitions/sources/branches
   * @param targetWorkflowId - id of the (already-inserted) destination workflow row
   * @throws BadRequestException on any child insert failure
   */
  private async deepCopyCanvas(
    srcDetail: WorkflowDetail,
    targetWorkflowId: string,
  ): Promise<void> {
    // Build UUID remap — L5: randomUUID is now a static top-level import
    const idMap = new Map<string, string>();

    const nodes = srcDetail.nodes as Array<{
      id: string;
      [k: string]: unknown;
    }>;

    for (const n of nodes) {
      idMap.set(n.id, randomUUID());
    }
    const transitions = srcDetail.transitions as Array<{
      id: string;
      [k: string]: unknown;
    }>;

    for (const t of transitions) {
      idMap.set(t.id, randomUUID());
    }
    const branches = srcDetail.branches as Array<{
      id: string;
      [k: string]: unknown;
    }>;

    for (const b of branches) {
      idMap.set(b.id, randomUUID());
    }

    const remap = (val: unknown): string =>
      typeof val === 'string' && idMap.has(val)
        ? idMap.get(val)!
        : (val as string);

    // Insert nodes — M2: strip old timestamps; DB DEFAULT now() applies
    if (nodes.length > 0) {
      const newNodes = nodes.map((n) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { id: _id, created_at: _ca, ...rest } = n;

        return { ...rest, id: idMap.get(n.id)!, workflow_id: targetWorkflowId };
      });
      const nR = await this.client
        .from(WorkflowsService.NODES_TABLE)
        .insert(newNodes);

      if (nR.error) throw new BadRequestException(nR.error.message);
    }

    // Insert transitions — M2: strip old timestamps
    if (transitions.length > 0) {
      const newTransitions = transitions.map((t) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { id: _id, created_at: _ca, updated_at: _ua, ...rest } = t;

        return {
          ...rest,
          id: idMap.get(t.id)!,
          workflow_id: targetWorkflowId,
          to_node_id: remap(t.to_node_id),
        };
      });
      const tR = await this.client
        .from(WorkflowsService.TRANSITIONS_TABLE)
        .insert(newTransitions);

      if (tR.error) throw new BadRequestException(tR.error.message);
    }

    // Insert sources
    const sources = srcDetail.sources as Array<{
      transition_id: string;
      from_node_id: string;
    }>;

    if (sources.length > 0) {
      const newSources = sources.map((s) => ({
        transition_id: remap(s.transition_id),
        from_node_id: remap(s.from_node_id),
      }));
      const sR = await this.client
        .from(WorkflowsService.SOURCES_TABLE)
        .insert(newSources);

      if (sR.error) throw new BadRequestException(sR.error.message);
    }

    // Insert branches — M2: strip old timestamps
    if (branches.length > 0) {
      const newBranches = branches.map((b) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { id: _id, created_at: _ca, ...rest } = b;

        return {
          ...rest,
          id: idMap.get(b.id)!,
          decision_node_id: remap(b.decision_node_id),
          to_node_id: remap(b.to_node_id),
        };
      });
      const bR = await this.client
        .from(WorkflowsService.BRANCHES_TABLE)
        .insert(newBranches);

      if (bR.error) throw new BadRequestException(bR.error.message);
    }

    // Remap layout.edgeHandles onto the new ids. The caller inserts the target
    // row with the source layout verbatim, but edgeHandles keys embed child ids
    // (`tx:<transitionId>:<nodeId>` / `br:<branchId>:<nodeId>`). Without this the
    // copied keys point at the source's ids, match nothing on the target, and the
    // canvas drops the saved handle sides — so edges silently re-route on a draft.
    const srcLayout = srcDetail.layout as
      | { edgeHandles?: Record<string, unknown> }
      | null
      | undefined;
    const srcEdgeHandles = srcLayout?.edgeHandles;

    if (srcEdgeHandles && typeof srcEdgeHandles === 'object') {
      const remappedEdgeHandles: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(srcEdgeHandles)) {
        const remappedKey = key.split(':').map(remap).join(':');

        remappedEdgeHandles[remappedKey] = value;
      }
      const newLayout = {
        ...(srcLayout as object),
        edgeHandles: remappedEdgeHandles,
      };
      const lR = await this.client
        .from(WorkflowsService.TABLE)
        .update({ layout: newLayout })
        .eq('id', targetWorkflowId);

      if (lR.error) throw new BadRequestException(lR.error.message);
    }
  }

  // ===========================================================================
  // P8 — Draft + publish lifecycle (D1, D7, D11)
  // ---------------------------------------------------------------------------
  // createDraft / discardDraft / getPublishPreview / publishDraft together
  // implement the "edit an active workflow safely" loop:
  //   1. createDraft snapshots the parent into a fresh row with is_draft=true.
  //   2. The editor saves changes into that draft via existing saveCanvas.
  //   3. getPublishPreview diffs the draft vs the parent and surfaces orphan
  //      statuses + suggested mappings.
  //   4. publishDraft hands off to the publish_workflow_atomic RPC which
  //      migrates affected tasks, replaces the parent's canvas, and deletes
  //      the draft row in one transaction.
  // ===========================================================================

  /**
   * Snapshot an active non-draft workflow into a fresh draft row.
   *
   * Idempotent (D7): on a 23505 from the `workflows_one_draft_per_parent`
   * partial unique index — i.e. another admin clicked Edit at the same
   * instant — re-SELECTs the existing draft and returns it instead of
   * raising a 409. Returns 200 in both fresh-create and idempotent paths.
   *
   * @param parentId - workflow to edit (must be active and not already a draft)
   * @param organizationId - calling org
   * @param actorUserId - public.users.id of the editor (audit + created_by)
   * @returns the new (or existing) draft's full detail
   * @throws ConflictException when the parent is archived or itself a draft
   */
  async createDraft(
    parentId: string,
    organizationId: string,
    actorUserId?: string | null,
  ): Promise<WorkflowDetail> {
    const parent = await this.getDetail(parentId, organizationId);

    if (!parent.is_active || parent.is_draft) {
      throw new ConflictException(
        'Only active non-draft workflows can be edited as drafts',
      );
    }

    // 1. Insert the draft row. The partial unique index
    // `workflows_one_draft_per_parent` enforces at-most-one draft per
    // parent — race winner inserts, loser gets 23505 and we re-SELECT.
    const draftRow = {
      organization_id: organizationId,
      space_id: parent.space_id,
      name: parent.name,
      description: parent.description,
      initial_status_id: parent.initial_status_id,
      is_active: false,
      is_draft: true,
      parent_workflow_id: parent.id,
      layout: parent.layout,
      version: 1,
      created_by: actorUserId ?? null,
      updated_by: actorUserId ?? null,
    };
    const ins = await this.client
      .from(WorkflowsService.TABLE)
      .insert(draftRow)
      .select()
      .single();

    if (ins.error) {
      if (ins.error.code === '23505') {
        // D7: idempotent path — return the existing draft. Scoped by
        // organization_id as defence-in-depth; the partial index is
        // already global on parent_workflow_id WHERE is_draft=true.
        const existing = await this.client
          .from(WorkflowsService.TABLE)
          .select('id')
          .eq('parent_workflow_id', parent.id)
          .eq('organization_id', organizationId)
          .eq('is_draft', true)
          .maybeSingle();

        if (existing.error)
          throw new BadRequestException(existing.error.message);
        if (!existing.data) {
          // Shouldn't happen — the 23505 just told us a draft exists — but
          // if the index says yes and the SELECT says no, surface clearly
          // instead of returning undefined.
          throw new ConflictException(
            'Draft conflict reported by index but no draft row found',
          );
        }
        return this.getDetail(
          (existing.data as { id: string }).id,
          organizationId,
        );
      }
      throw new BadRequestException(ins.error.message);
    }
    const newDraft = ins.data as Workflow;

    // 2. Copy parent canvas into the new draft. Mirrors duplicate()'s
    // cleanup-on-failure: on any failure delete the just-inserted draft
    // row so FK cascade clears nodes/transitions/sources/branches.
    try {
      await this.deepCopyCanvas(parent, newDraft.id);
    } catch (error) {
      await this.client
        .from(WorkflowsService.TABLE)
        .delete()
        .eq('id', newDraft.id)
        .eq('organization_id', organizationId);
      throw error;
    }

    // 3. Audit — entity is the new draft row, payload references the parent.
    if (actorUserId && this.auditLogsService) {
      void this.auditLogsService.logAction(
        organizationId,
        actorUserId,
        'workflow',
        newDraft.id,
        'workflow.draft.created',
        {
          parent_workflow_id: parent.id,
          parent_name: parent.name,
        },
      );
    }

    return this.getDetail(newDraft.id, organizationId);
  }

  /**
   * Delete a draft workflow.
   *
   * FK cascade on workflow_nodes/transitions/sources/branches clears the
   * canvas automatically. The audit row is written against the PARENT
   * workflow (not the draft) so the parent's history shows that a pending
   * edit was abandoned.
   *
   * @param draftId - id of the draft row (must satisfy is_draft=true)
   * @param organizationId - calling org
   * @param actorUserId - public.users.id of the discarder
   * @throws BadRequestException when the target row is not a draft
   */
  async discardDraft(
    draftId: string,
    organizationId: string,
    actorUserId?: string | null,
  ): Promise<void> {
    const draft = await this.getById(draftId, organizationId);

    if (!draft.is_draft) {
      throw new BadRequestException('Not a draft workflow');
    }

    const r = await this.client
      .from(WorkflowsService.TABLE)
      .delete()
      .eq('id', draftId)
      .eq('organization_id', organizationId);

    if (r.error) throw new BadRequestException(r.error.message);

    // Audit against the parent so the parent's history reflects the abandoned edit.
    if (actorUserId && draft.parent_workflow_id && this.auditLogsService) {
      void this.auditLogsService.logAction(
        organizationId,
        actorUserId,
        'workflow',
        draft.parent_workflow_id,
        'workflow.draft.discarded',
        {
          draft_id: draftId,
          draft_name: draft.name,
        },
      );
    }
  }

  /**
   * READ-ONLY diff between a draft and its parent.
   *
   * Mirrors the publish_workflow_atomic RPC's orphan-detection block but
   * runs outside a transaction — the returned numbers are an estimate;
   * concurrent edits between preview and publish are documented in the
   * P8 concurrency contract.
   *
   * @param draftId - draft to preview
   * @param organizationId - calling org
   * @returns added/removed status diffs, orphan list, affected task count,
   *   and suggested mappings for each orphan (same algorithm as
   *   workflow-assignments.service.ts:469).
   * @throws BadRequestException when the row is not a draft or has no parent
   */
  async getPublishPreview(
    draftId: string,
    organizationId: string,
  ): Promise<{
    added_statuses: Array<{ id: string; name: string }>;
    removed_statuses: Array<{ id: string; name: string }>;
    changed_transitions_count: number;
    changed_branches_count: number;
    affected_count: number;
    orphan_statuses: string[];
    suggested_mappings: Record<string, string | null>;
  }> {
    const draft = await this.getDetail(draftId, organizationId);

    if (!draft.is_draft) {
      throw new BadRequestException('Not a draft workflow');
    }
    if (!draft.parent_workflow_id) {
      throw new BadRequestException('Draft has no parent workflow');
    }
    const parent = await this.getDetail(
      draft.parent_workflow_id,
      organizationId,
    );

    // 1. Diff status node sets — only `kind='status'` nodes carry status_id.
    interface StatusNode {
      kind: string;
      status_id?: string | null;
    }
    const draftStatusIds = new Set(
      (draft.nodes as StatusNode[])
        .filter((n) => n.kind === 'status' && n.status_id)
        .map((n) => n.status_id as string),
    );
    const parentStatusIds = new Set(
      (parent.nodes as StatusNode[])
        .filter((n) => n.kind === 'status' && n.status_id)
        .map((n) => n.status_id as string),
    );
    const addedIds = [...draftStatusIds].filter(
      (id) => !parentStatusIds.has(id),
    );
    const removedIds = [...parentStatusIds].filter(
      (id) => !draftStatusIds.has(id),
    );

    // 2. Fetch human names for the added/removed sets so the preview UI
    //    can render labels without a second client-side round trip.
    const allStatusIds = Array.from(new Set([...addedIds, ...removedIds]));
    const nameById = new Map<string, string>();

    if (allStatusIds.length > 0) {
      const nameR = await this.client
        .from('task_statuses')
        .select('id, name')
        .eq('organization_id', organizationId)
        .in('id', allStatusIds);

      if (nameR.error) throw new BadRequestException(nameR.error.message);
      for (const row of (nameR.data ?? []) as Array<{
        id: string;
        name: string;
      }>) {
        nameById.set(row.id, row.name);
      }
    }

    const added_statuses = addedIds.map((id) => ({
      id,
      name: nameById.get(id) ?? id,
    }));
    const removed_statuses = removedIds.map((id) => ({
      id,
      name: nameById.get(id) ?? id,
    }));

    // 3. Changed transitions. Draft cloning regenerates every node/transition
    //    id (PKs are unique per table), so the parent and draft never share
    //    transition ids — matching by id would always miss, silently dropping
    //    transition-only edits (rename, rule/screen changes) from the diff and
    //    leaving the publish dialog convinced the draft is "identical". Instead
    //    we match transitions by a STABLE semantic key built from the status
    //    ids of their endpoints (status nodes carry a stable status_id; start
    //    and decision nodes fall back to kind+label). A matched pair is
    //    "changed" when any body field differs; a transition present on only
    //    one side counts as a change too (added or removed).
    interface NodeRow {
      id: string;
      kind: string;
      status_id?: string | null;
      label?: string | null;
    }
    interface SourceRow {
      transition_id: string;
      from_node_id: string;
    }
    interface Transition {
      id: string;
      kind?: string | null;
      name?: string | null;
      to_node_id?: string | null;
      screen_field_group_id?: string | null;
      screen_form_id?: string | null;
      conditions?: unknown;
      validators?: unknown;
      post_functions?: unknown;
      triggers?: unknown;
      properties?: unknown;
    }

    // Stable identity for a node across the parent/draft clone boundary.
    const nodeKeyMap = (nodes: NodeRow[]) => {
      const byId = new Map<string, string>();

      for (const n of nodes) {
        const key =
          n.kind === 'status' && n.status_id
            ? `s:${n.status_id}`
            : n.kind === 'start'
              ? 'start'
              : `${n.kind}:${n.label ?? n.id}`;

        byId.set(n.id, key);
      }

      return byId;
    };

    // Semantic key for a transition: kind + endpoint node keys (sources sorted).
    const transitionKey = (
      t: Transition,
      keyByNode: Map<string, string>,
      sources: SourceRow[],
    ) => {
      const from = sources
        .filter((s) => s.transition_id === t.id)
        .map((s) => keyByNode.get(s.from_node_id) ?? s.from_node_id)
        .sort();
      const to = t.to_node_id
        ? (keyByNode.get(t.to_node_id) ?? t.to_node_id)
        : '';

      return `${t.kind ?? 'regular'}|${to}|${from.join(',')}`;
    };

    // Body fingerprint — excludes ids/endpoints (encoded in the key above).
    const bodyFingerprint = (t: Transition) =>
      JSON.stringify({
        name: t.name ?? null,
        screen: t.screen_field_group_id ?? null,
        screenForm: t.screen_form_id ?? null,
        conditions: t.conditions ?? null,
        validators: t.validators ?? null,
        post_functions: t.post_functions ?? null,
        triggers: t.triggers ?? null,
        properties: t.properties ?? null,
      });

    const draftNodeKeys = nodeKeyMap(draft.nodes as NodeRow[]);
    const parentNodeKeys = nodeKeyMap(parent.nodes as NodeRow[]);
    const draftSources = draft.sources as SourceRow[];
    const parentSources = parent.sources as SourceRow[];

    const parentTxByKey = new Map<string, Transition>();

    for (const pt of parent.transitions as Transition[]) {
      parentTxByKey.set(transitionKey(pt, parentNodeKeys, parentSources), pt);
    }

    const draftKeys = new Set<string>();
    let changed_transitions_count = 0;

    for (const dt of draft.transitions as Transition[]) {
      const key = transitionKey(dt, draftNodeKeys, draftSources);

      draftKeys.add(key);
      const pt = parentTxByKey.get(key);

      // Structurally new transition, or an existing one whose body changed.
      if (!pt || bodyFingerprint(pt) !== bodyFingerprint(dt)) {
        changed_transitions_count += 1;
      }
    }

    // Transitions present in the parent but removed from the draft.
    for (const key of parentTxByKey.keys()) {
      if (!draftKeys.has(key)) changed_transitions_count += 1;
    }

    //  Changed decision branches. Branches live in workflow_decision_branches
    //     (NOT transitions), so the transition diff above never sees them —
    //     editing a decision node's branches would otherwise read as "identical"
    //     and hide the Publish button. Match decision nodes across the clone
    //     boundary by the same node key, and compare each node's ordered branch
    //     set (target node key + expression + label).
    const draftBranchFp = branchFingerprintByDecision(
      (draft.branches ?? []) as BranchRow[],
      draftNodeKeys,
    );
    const parentBranchFp = branchFingerprintByDecision(
      (parent.branches ?? []) as BranchRow[],
      parentNodeKeys,
    );

    let changed_branches_count = 0;

    for (const [key, fp] of draftBranchFp) {
      if (parentBranchFp.get(key) !== fp) changed_branches_count += 1;
    }
    for (const key of parentBranchFp.keys()) {
      if (!draftBranchFp.has(key)) changed_branches_count += 1;
    }

    // 4. Affected tasks: count tasks scoped by workflow_assignments for the
    //    parent (mirror publish_workflow_atomic's space scoping at L60-65).
    let affected_count = 0;

    if (removedIds.length > 0) {
      // Resolve the parent's assignment space scope first.
      const asgnR = await this.client
        .from(WorkflowsService.ASSIGNMENTS_TABLE)
        .select('space_id')
        .eq('organization_id', organizationId)
        .eq('workflow_id', parent.id);

      if (asgnR.error) throw new BadRequestException(asgnR.error.message);
      const spaceIds = Array.from(
        new Set(
          (asgnR.data ?? [])
            .map((r: { space_id: string | null }) => r.space_id)
            .filter((s): s is string => Boolean(s)),
        ),
      );

      if (spaceIds.length > 0) {
        const taskR = await this.client
          .from('tasks')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', organizationId)
          .in('space_id', spaceIds)
          .in('status_id', removedIds);

        if (taskR.error) throw new BadRequestException(taskR.error.message);
        affected_count = taskR.count ?? 0;
      }
    }

    // 5. Suggested mappings — same algorithm as
    //    workflow-assignments.service.ts:469 (suggestMapping). Duplicated
    //    here rather than promoting to a shared util to keep this prompt
    //    contained; the two implementations should evolve together.
    const suggested_mappings = await this.suggestStatusMapping(
      removedIds,
      draft.id,
      organizationId,
    );

    return {
      added_statuses,
      removed_statuses,
      changed_transitions_count,
      changed_branches_count,
      affected_count,
      orphan_statuses: removedIds,
      suggested_mappings,
    };
  }

  /**
   * Publish a draft over its parent via `publish_workflow_atomic`.
   *
   * Concurrency / failure semantics:
   * - INSERTs a `workflow_publish_jobs` row with status='running' BEFORE
   *   the RPC (D6). Post-Migration-16 the FK to draft_id is ON DELETE SET
   *   NULL so the row survives the RPC's internal DELETE of the draft.
   * - On success UPDATEs the row to 'succeeded' with migrated_count +
   *   affected_count + finished_at; on RPC failure UPDATEs to 'failed'
   *   with the error message and finished_at. Either way the row carries
   *   an audit trail for ops queries.
   * - Maps RPC errors to typed Nest exceptions:
   *   - `23514` (missing migration) → 409 with structured payload so the
   *     dialog can re-open StatusMigrationDialog with the missing ids.
   *   - `42501` (cross-org target) → 403.
   *   - `P0001` 'Draft workflow ... not found' (no errcode) → 404 with
   *     code `DRAFT_ALREADY_PUBLISHED` so the UI can redirect to parent.
   *   - anything else → 400 with the RPC's message preserved.
   *
   * @param draftId - draft to publish
   * @param organizationId - calling org
   * @param migrationMap - orphan status UUID → target status UUID; empty
   *   when the draft removes no statuses
   * @param actorUserId - public.users.id of the publisher (audit + RPC)
   * @returns updated parent detail + tasks_migrated + orphan_count
   */
  async publishDraft(
    draftId: string,
    organizationId: string,
    migrationMap: Record<string, string>,
    actorUserId?: string | null,
  ): Promise<{
    workflow: WorkflowDetail;
    tasks_migrated: number;
    orphan_count: number;
  }> {
    const draft = await this.getById(draftId, organizationId);

    if (!draft.is_draft) {
      throw new BadRequestException('Not a draft workflow');
    }
    if (!draft.parent_workflow_id) {
      throw new BadRequestException('Draft has no parent workflow');
    }
    const parentId = draft.parent_workflow_id;

    // Prompt 10: publish gate — refuse if the draft has unresolved ERROR-level
    // health issues. Uses a fresh lint so a just-fixed workflow can publish.
    // SVC-M2: the health service is @Optional() for DI flexibility, but the
    // gate must NOT be silently skipped — if it's unavailable we fail loud
    // rather than publishing an unvalidated workflow.
    if (!this.health) {
      throw new BadRequestException(
        'Workflow health service is unavailable; cannot verify publish safety',
      );
    }

    const { blocked, errors } = await this.health.hasBlockingErrors(
      draftId,
      organizationId,
    );

    if (blocked) {
      throw new ConflictException({
        message:
          'Cannot publish: workflow has unresolved errors. Fix them before publishing.',
        data: { blockers: errors },
      });
    }

    // D6: insert the publish-job audit row BEFORE the RPC. Post-Migration-16
    // the row survives even after the RPC deletes the draft (FK SET NULL).
    const jobIns = await this.client
      .from('workflow_publish_jobs')
      .insert({
        organization_id: organizationId,
        draft_id: draftId,
        target_id: parentId,
        migration_map: migrationMap,
        status: 'running',
        started_at: new Date().toISOString(),
        initiated_by: actorUserId ?? null,
      })
      .select('id')
      .single();

    if (jobIns.error) {
      throw new BadRequestException(jobIns.error.message);
    }
    const jobId = (jobIns.data as { id: string }).id;

    // Call the atomic RPC.
    const rpc = await this.client.rpc('publish_workflow_atomic', {
      p_draft_id: draftId,
      p_organization_id: organizationId,
      p_migration_map: migrationMap,
      p_user_id: actorUserId ?? null,
    });

    if (rpc.error) {
      // Mark the job failed BEFORE re-throwing. Best-effort: we ignore
      // any UPDATE error here so the original RPC error reaches the
      // caller — the row is still useful even if status stays 'running'.
      await this.client
        .from('workflow_publish_jobs')
        .update({
          status: 'failed',
          error: rpc.error.message,
          finished_at: new Date().toISOString(),
        })
        .eq('id', jobId);

      const code = (rpc.error as { code?: string }).code;
      const message = rpc.error.message ?? 'Publish failed';

      if (code === '23514') {
        // RPC raised "Cannot publish: missing migration mapping for status(es) {...}".
        // Best-effort parse the missing-id array out of the message so the
        // dialog can pre-fill StatusMigrationDialog without a second preview.
        const orphan_statuses_missing = parseUuidArrayFromMessage(message);

        throw new ConflictException({
          message: 'Cannot publish: missing migration mapping for statuses',
          data: { orphan_statuses_missing },
        });
      }
      if (code === '42501') {
        throw new ForbiddenException(message);
      }
      // P0001 / no-errcode path: the RPC raises 'Draft workflow % not found'
      // without setting an explicit ERRCODE. Match by message substring.
      if (/Draft workflow .* not found/i.test(message)) {
        throw new NotFoundException({
          message,
          code: 'DRAFT_ALREADY_PUBLISHED',
        });
      }
      // R1: a Postgres serialization failure during a concurrent publish is
      // retryable — surface 409, not a permanent 400. Mirrors the assignment
      // service's SVC-H2 mapping.
      if (code === '40001') {
        throw new ConflictException({
          message: 'Concurrent publish in progress; please retry',
          data: { retryable: true },
        });
      }
      throw new BadRequestException(message);
    }

    const payload = (rpc.data ?? {}) as {
      workflow?: Workflow;
      tasks_migrated?: number;
      orphan_count?: number;
    };
    const tasks_migrated = payload.tasks_migrated ?? 0;
    const orphan_count = payload.orphan_count ?? 0;

    // Mark the job succeeded. Best-effort — a stale 'running' here is
    // recoverable by ops; we don't want to fail the user's publish on it.
    await this.client
      .from('workflow_publish_jobs')
      .update({
        status: 'succeeded',
        migrated_count: tasks_migrated,
        affected_count: orphan_count,
        finished_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    // Audit — entity is the parent (the draft is gone by this point).
    if (actorUserId && this.auditLogsService) {
      void this.auditLogsService.logAction(
        organizationId,
        actorUserId,
        'workflow',
        parentId,
        'workflow.published',
        {
          draft_id: draftId,
          tasks_migrated,
          orphan_count,
        },
      );
    }

    // Trigger registry rebuild for the parent (mirror saveCanvas's emit).
    if (this.eventEmitter) {
      this.eventEmitter.emit('workflow.published', {
        workflowId: parentId,
        organizationId,
      });
    }

    return {
      workflow: await this.getDetail(parentId, organizationId),
      tasks_migrated,
      orphan_count,
    };
  }

  /**
   * Suggested mapping from removed (orphan) statuses → a target status in
   * the draft's set. Algorithm mirrors
   * `WorkflowAssignmentsService.suggestMapping`:
   *
   *   1. Exact `task_statuses.key` match within the target set.
   *   2. Same `category_id`, lowest sort_order, then alphabetic name.
   *   3. First available target by sort_order, then name.
   *   4. null when the target set is empty.
   *
   * Kept private to avoid widening the surface area; if a third caller
   * appears, lift to `src/utils/workflow-status-suggestion.ts` then.
   */
  private async suggestStatusMapping(
    orphanIds: string[],
    targetWorkflowId: string,
    organizationId: string,
  ): Promise<Record<string, string | null>> {
    if (orphanIds.length === 0) return {};

    const targetNodesR = await this.client
      .from(WorkflowsService.NODES_TABLE)
      .select('status_id')
      .eq('workflow_id', targetWorkflowId)
      .eq('kind', 'status')
      .not('status_id', 'is', null);

    if (targetNodesR.error)
      throw new BadRequestException(targetNodesR.error.message);

    const targetStatusIds = (targetNodesR.data ?? [])
      .map((n: { status_id: string }) => n.status_id)
      .filter((s): s is string => Boolean(s));

    if (targetStatusIds.length === 0) {
      return Object.fromEntries(orphanIds.map((id) => [id, null]));
    }

    const allStatusIds = Array.from(
      new Set([...orphanIds, ...targetStatusIds]),
    );
    const statusesR = await this.client
      .from('task_statuses')
      .select('id, key, name, category_id, sort_order')
      .in('id', allStatusIds)
      .eq('organization_id', organizationId);

    if (statusesR.error) throw new BadRequestException(statusesR.error.message);

    interface TaskStatusRow {
      id: string;
      key: string | null;
      name: string | null;
      category_id: string | null;
      sort_order: number | null;
    }
    const statuses = (statusesR.data ?? []) as TaskStatusRow[];
    const byId = new Map<string, TaskStatusRow>(statuses.map((s) => [s.id, s]));
    const targetSet = new Set(targetStatusIds);
    const targets = statuses.filter((s) => targetSet.has(s.id));

    const orderedTargets = [...targets].sort((a, b) => {
      const aOrder = a.sort_order ?? Number.MAX_SAFE_INTEGER;
      const bOrder = b.sort_order ?? Number.MAX_SAFE_INTEGER;

      if (aOrder !== bOrder) return aOrder - bOrder;

      return (a.name ?? '').localeCompare(b.name ?? '');
    });

    const result: Record<string, string | null> = {};

    for (const orphanId of orphanIds) {
      const orphan = byId.get(orphanId);

      if (!orphan) {
        result[orphanId] = null;
        continue;
      }
      if (orphan.key) {
        const exact = orderedTargets.find((t) => t.key === orphan.key);

        if (exact) {
          result[orphanId] = exact.id;
          continue;
        }
      }
      if (orphan.category_id) {
        const sameCategory = orderedTargets.find(
          (t) => t.category_id === orphan.category_id,
        );

        if (sameCategory) {
          result[orphanId] = sameCategory.id;
          continue;
        }
      }
      result[orphanId] = orderedTargets[0]?.id ?? null;
    }

    return result;
  }

  private static tally(
    rows: { workflow_id: string }[] | null,
  ): Record<string, number> {
    const m: Record<string, number> = {};

    for (const row of rows ?? []) {
      m[row.workflow_id] = (m[row.workflow_id] ?? 0) + 1;
    }

    return m;
  }

  private logAudit(
    organizationId: string,
    actorUserId: string | null | undefined,
    entityId: string | null | undefined,
    action: 'create' | 'update' | 'delete',
    changes?: Record<string, unknown>,
  ): void {
    if (!actorUserId || !entityId || !this.auditLogsService) return;
    void this.auditLogsService.logAction(
      organizationId,
      actorUserId,
      'workflow',
      entityId,
      action,
      changes,
    );
  }
}
