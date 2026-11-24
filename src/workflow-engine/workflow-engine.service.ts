/**
 * @fileoverview Runtime workflow engine. Owns the 15-step executeTransition
 * pipeline (lock → guards → rules → decision resolution → status mutation →
 * post-functions → audit → event), `getAvailableTransitions` for UI button
 * gating, `resolveTransitionByStatusChange` for legacy-status-drag callers,
 * and `runInitialPostFunctions` for new-task creation flows.
 *
 * The engine deliberately uses a "relaxed atomicity" model in v1: async
 * side-effects (notifications, webhooks, fired events) enqueue into the
 * workflow_outbox and never roll the status back on failure. Sync
 * post-functions (assign_to / set_field_value / set_resolution / etc.) fail
 * the transition and trigger a compensation revert of `status_id` back to
 * the pre-transition value.
 *
 * @module src/workflow-engine/workflow-engine.service
 * @author Rajbha Manek
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { SupabaseClient } from '@supabase/supabase-js';

import { toLegacyStatusText } from '../tasks/legacy-status.util';
import { WatchersService } from '../watchers/watchers.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  AutomationEventOutboxService,
  type TaskStatusChangedSnapshot,
} from '../automations/automation-event-outbox.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { PermissionsService } from '../permissions/permissions.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { WorkflowAssignmentsService } from '../workflow-assignments/workflow-assignments.service';
import { WorkflowOutboxService } from '../workflow-outbox/workflow-outbox.service';
import { resolveDecision } from './decision-resolver';
import { HandlerRegistryService } from './handlers/handler-registry.service';
import type {
  IConditionHandler,
  IEvaluationContext,
  IPostFunctionHandler,
  IValidatorHandler,
} from './handlers/handler.types';
import { normalizeRuleConfig } from './handlers/rule-config';
import { isSystemFieldId, systemFieldLabel } from './handlers/system-fields';
import { TemplatingService } from './templating/expand';

/** Output row for {@link WorkflowEngineService.getAvailableTransitions}. */
export interface IAvailableTransition {
  transition: {
    id: string;
    name: string;
    kind: string;
    to_node_id: string;
    /** Destination status id; null when the to_node is a decision node. */
    to_status_id: string | null;
    screen_field_group_id: string | null;
    screen_form_id: string | null;
    screen_form_space_id: string | null;
    sort_order: number;
  };
  has_screen: boolean;
  has_conditions: boolean;
  has_validators: boolean;
  has_post_functions: boolean;
  /** The task's current status id (the "from" of this transition). */
  from_status_id: string | null;
  /**
   * Whether the caller may execute this transition right now. `false` when a
   * condition on the transition is not met — the transition is still returned
   * (so the UI shows it disabled with a reason) rather than hidden.
   */
  can_execute: boolean;
  /**
   * Why the transition is currently blocked (`can_execute:false`) — the engine's
   * condition-failure message (`Condition failed: <type> [field: <name>]`), which
   * the UI renders through the shared reason formatter. Null when executable.
   */
  blocked_reason: string | null;
  /**
   * Pre-resolved final status UUID when the transition targets a Decision node
   * and the outcome could be determined from the current task state. Null for
   * direct status-to-status transitions or when Decision resolution failed.
   * This is a UI preview hint only — the authoritative routing happens inside
   * executeTransition at execution time.
   */
  resolved_to_status_id: string | null;
}

/** Result of {@link WorkflowEngineService.getAvailableTransitions}. */
export interface IAvailableTransitionsResult {
  /**
   * True when the task's type has an active workflow assignment. Lets the UI
   * distinguish "no workflow (show legacy dropdown)" from "workflow assigned
   * but no transitions available (stranded — show a recovery notice)".
   */
  workflow_assigned: boolean;
  transitions: IAvailableTransition[];
}

/** Input for {@link WorkflowEngineService.executeTransition}. */
export interface IExecuteTransitionInput {
  taskId: string;
  transitionId: string;
  screenInput?: Record<string, unknown>;
  user: RequestUser;
  executionId?: string;
  expectedVersion?: number;
  transitionDepth?: number;
  notifyWatchers?: boolean;
}

/** Result of {@link WorkflowEngineService.resolveTransitionByStatusChange}. */
export type TransitionResolution =
  | { transition: { id: string; name: string } }
  | { error: 'no_path' }
  | {
      // A source→target transition exists but its condition(s) blocked it.
      // Distinct from `no_path` so callers can BLOCK the status change instead
      // of falling back to a direct write (which would bypass the condition).
      error: 'condition_failed';
      blockedTransition: { id: string; name: string };
    }
  | {
      error: 'multiple_paths';
      candidates: Array<{ id: string; name: string }>;
    };

interface ITaskRow {
  id: string;
  organization_id: string;
  space_id: string | null;
  key: string;
  summary: string;
  status: string | null;
  status_id: string | null;
  priority: string | null;
  assigned_to: string | null;
  task_type_id: string | null;
  version: number;
  updated_at: string;
  completed_at?: string | null;
  custom_field_values: Record<string, unknown> | null;
  /**
   * Computed attachment count (legacy `task_attachments` + central
   * `file_attachments`). NOT a column on `tasks` — the engine enriches it after
   * load so the has_attachments condition can read it. See {@link WorkflowEngineService.getAttachmentCount}.
   */
  attachment_count?: number;
  /**
   * Computed status fields (NOT columns on `tasks`) enriched by the engine so
   * conditions can read them. See {@link WorkflowEngineService.enrichStatusFields}.
   * `parent_status_ids` = all status ids sharing the parent's status key (org-wide
   * + space-scoped duplicates), for key-tolerant `parent_status_is` matching.
   */
  status_category_id?: string | null;
  /**
   * Real `task_statuses.key` of the task's own status. Differs from the legacy
   * `status` text column, which buckets custom keys (e.g. abgelehnt → done).
   */
  status_key?: string | null;
  parent_status_id?: string | null;
  parent_status_category_id?: string | null;
  parent_status_ids?: string[];
  [key: string]: unknown;
}

interface IWorkflowRow {
  id: string;
  organization_id: string;
  space_id: string | null;
  name: string;
  version: number;
  initial_status_id: string | null;
  is_active: boolean | null;
  is_draft: boolean | null;
}

interface INodeRow {
  id: string;
  workflow_id: string;
  kind: 'status' | 'decision' | 'start';
  status_id: string | null;
  label?: string | null;
  /**
   * The `task_statuses.key` for this node's `status_id`, loaded alongside the
   * graph. Lets source-matching fall back to key equality when a task carries a
   * space-scoped status whose org-wide duplicate (same key) is what the node
   * references — see {@link WorkflowEngineService.transitionMatchesSource}.
   */
  status_key?: string | null;
}

interface ITransitionRow {
  id: string;
  workflow_id: string;
  name: string;
  kind: string;
  to_node_id: string;
  screen_field_group_id: string | null;
  screen_form_id: string | null;
  // PostgREST types a to-one embed as an array even though it returns a single object at runtime,
  // so accept both shapes and normalise at the use site.
  screen_form?:
    | { space_id: string | null }
    | Array<{ space_id: string | null }>
    | null;
  conditions: Array<Record<string, unknown>> | null;
  validators: Array<Record<string, unknown>> | null;
  post_functions: Array<Record<string, unknown>> | null;
  triggers: Array<Record<string, unknown>> | null;
  sort_order: number;
}

interface ISourceRow {
  transition_id: string;
  from_node_id: string;
}

interface IRuleTraceEntry {
  phase: 'condition' | 'validator' | 'post_function' | 'decision';
  type: string;
  ok?: boolean;
  result?: string;
  error?: string;
}

interface IWorkflowGraph {
  workflow: IWorkflowRow;
  nodes: Record<string, INodeRow>;
  transitions: ITransitionRow[];
  sources: Record<string, string[]>; // transition_id → from_node_ids[]
}

interface ITaskStatusMetadata {
  key: string;
  is_completed: boolean | null;
  status_categories?: { key?: string } | { key?: string }[] | null;
}

@Injectable()
export class WorkflowEngineService {
  private readonly logger = new Logger(WorkflowEngineService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly registry: HandlerRegistryService,

    private readonly templating: TemplatingService,
    private readonly outbox: WorkflowOutboxService,
    private readonly automationOutbox: AutomationEventOutboxService,
    private readonly assignments: WorkflowAssignmentsService,
    private readonly auditLogs: AuditLogsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly permissionsService: PermissionsService,
    @Optional() private readonly watchersService?: WatchersService,
  ) {}

  private get client(): SupabaseClient {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Build a human-readable "Condition failed" message that names the specific
   * field for field_equals / field_compare (a system-field label, or the custom
   * field's name), so trigger logs show WHICH field wasn't met. Best-effort and
   * never throws: any failure falls back to the plain `Condition failed: <type>`.
   * The `Condition failed:` prefix is preserved on purpose — three runtime no-op
   * classifiers (git / cron / general trigger runtimes) key off it.
   */
  private async describeConditionFailure(
    condConfig: unknown,
    condType: string,
  ): Promise<string> {
    const base = `Condition failed: ${condType}`;

    try {
      if (condType !== 'field_equals' && condType !== 'field_compare') {
        return base;
      }

      const fieldId = (condConfig as { field_id?: unknown }).field_id;

      if (typeof fieldId !== 'string' || !fieldId) {
        return base;
      }

      let label: string | null = null;

      if (isSystemFieldId(fieldId)) {
        label = systemFieldLabel(fieldId);
      } else {
        const res = await this.client
          .from('custom_fields')
          .select('name')
          .eq('id', fieldId)
          .maybeSingle();

        label = (res.data as { name?: string } | null)?.name ?? null;
      }

      // Fall back to the raw id so the message still identifies the field.
      return `${base} [field: ${label ?? fieldId}]`;
    } catch {
      return base;
    }
  }

  // ---------------------------------------------------------------------
  // PUBLIC API
  // ---------------------------------------------------------------------

  /**
   * Return the transitions the caller may currently invoke on the task.
   * Filters by source-match (per transition kind) and runs every condition
   * — only transitions whose conditions all return `true` are surfaced.
   * Unknown condition types fail closed (excluded from output).
   *
   * @param taskId - id of the task to inspect
   * @param user - authenticated requester
   * @returns array of available transitions with `has_screen` hint
   */
  async getAvailableTransitions(
    taskId: string,
    user: RequestUser,
  ): Promise<IAvailableTransitionsResult> {
    const task = await this.loadTask(taskId, user.organizationId);

    if (!task) {
      throw new NotFoundException('Task not found');
    }

    const assignment = await this.assignments.findActiveAssignmentForType(
      user.organizationId,
      task.space_id ?? '',
      task.task_type_id ?? '*',
    );

    if (!assignment) return { workflow_assigned: false, transitions: [] };

    const graph = await this.loadWorkflowGraph(
      assignment.workflow_id,
      user.organizationId,
    );

    // Assigned but the workflow couldn't load (archived/deleted mid-flight):
    // report assigned-with-no-transitions so the UI shows a recovery notice
    // rather than silently falling back to the legacy dropdown.
    if (!graph) return { workflow_assigned: true, transitions: [] };

    // Filter to transitions whose source is the current status (or whose
    // kind allows any source). `initial` is excluded — it only fires once
    // at create time via runInitialPostFunctions.
    const candidates = graph.transitions.filter((t) =>
      this.transitionMatchesSource(
        t,
        task.status_id,
        this.currentStatusKey(task),
        graph,
      ),
    );

    const result: IAvailableTransition[] = [];

    // Load the org's custom-field id↔slug map once so field conditions read
    // tasks.custom_field_values (slug-keyed) by the rule's field_id.
    const fieldIdToSlug = await this.loadFieldIdSlugMap(user.organizationId);

    for (const t of candidates) {
      // Decision-resolved targets have no predictable to_status_id at this
      // point — we leave it undefined so condition handlers that read it
      // are forced into a defensive branch.
      const toNode = graph.nodes[t.to_node_id];
      const toStatusId =
        t.kind === 'global_loop'
          ? (task.status_id ?? undefined)
          : toNode && toNode.kind === 'status'
            ? (toNode.status_id ?? undefined)
            : undefined;

      const ctx = this.buildContext(
        task,
        t,
        graph.workflow,
        user,
        {
          from_status_id: task.status_id ?? null,
          to_status_id: toStatusId,
        },
        fieldIdToSlug,
      );
      await this.enrichContextWithUserAccess(ctx, user);

      // A failing condition no longer hides the transition — it is returned with
      // can_execute:false + a reason so the UI can show it disabled with an
      // explanation instead of the task looking like it has no transitions.
      const failingCondition = await this.firstFailingCondition(t, ctx);

      const blockedReason = failingCondition
        ? await this.describeConditionFailure(
            failingCondition.config,
            failingCondition.type,
          )
        : null;

      // Pre-resolve Decision outcome for UI preview (uses the same ctx already built above).
      // Wrapped in try/catch so incomplete Decision configs (no else branch, cycles) degrade
      // gracefully to null without aborting the transition listing.
      let resolvedToStatusId: string | null = null;

      if (!failingCondition && toNode && toNode.kind === 'decision') {
        try {
          resolvedToStatusId = await resolveDecision(
            toNode.id,
            ctx,
            this.registry,
            this.client,
            0,
          );
        } catch {
          // Leave null — Decision may not be resolvable from the current task state
        }
      }

      result.push({
        transition: {
          id: t.id,
          name: t.name,
          kind: t.kind,
          to_node_id: t.to_node_id,
          to_status_id: toStatusId ?? null,
          screen_field_group_id: t.screen_field_group_id,
          screen_form_id: t.screen_form_id ?? null,
          screen_form_space_id: Array.isArray(t.screen_form)
            ? (t.screen_form[0]?.space_id ?? null)
            : (t.screen_form?.space_id ?? null),
          sort_order: t.sort_order ?? 0,
        },

        // Either screen source must open the dialog — gating on the field group alone would let a
        // form-backed transition execute immediately, silently skipping its form.
        has_screen:
          t.screen_field_group_id !== null ||
          (t.screen_form_id ?? null) !== null,
        has_conditions: (t.conditions?.length ?? 0) > 0,
        has_validators: (t.validators?.length ?? 0) > 0,
        has_post_functions: (t.post_functions?.length ?? 0) > 0,
        from_status_id: task.status_id ?? null,
        can_execute: !failingCondition,
        blocked_reason: blockedReason,
        resolved_to_status_id: resolvedToStatusId,
      });
    }

    // ENG-M1 (design edge 2.14): when a specific transition (regular / common /
    // self_loop) and a global transition both reach the SAME destination
    // status, the specific one shadows the global one — surface only the
    // specific button. Transitions with no resolved to_status_id (decision
    // targets) are never deduped.
    // Compare destinations by status KEY (tolerant of org-wide vs space-scoped
    // duplicate status rows), so a global_loop that loops to the current status
    // is shadowed by a specific self_loop even when their status_ids differ by
    // scope. Build a status_id → key map from the graph's status nodes plus the
    // task's own status (its real key — see currentStatusKey).
    const statusKeyById = new Map<string, string>();

    for (const n of Object.values(graph.nodes)) {
      if (n.status_id && n.status_key)
        statusKeyById.set(n.status_id, n.status_key);
    }
    const ownStatusKey = this.currentStatusKey(task);

    if (task.status_id && ownStatusKey)
      statusKeyById.set(task.status_id, ownStatusKey);

    const keyOf = (statusId: string | null): string | null =>
      statusId ? (statusKeyById.get(statusId) ?? null) : null;

    const specificTargets = result.filter(
      (r) =>
        r.transition.to_status_id !== null &&
        r.transition.kind !== 'global' &&
        r.transition.kind !== 'global_loop',
    );
    // Original id-based set (unchanged fallback) PLUS a key-based set — shadow a
    // global when it matches a specific target by EITHER id or key, so the fix
    // never regresses if node status_keys weren't loaded.
    const specificStatusTargets = new Set(
      specificTargets.map((r) => r.transition.to_status_id as string),
    );
    const specificStatusKeys = new Set(
      specificTargets
        .map((r) => keyOf(r.transition.to_status_id))
        .filter((k): k is string => k !== null),
    );

    const deduped = result.filter((r) => {
      const isGlobal =
        r.transition.kind === 'global' || r.transition.kind === 'global_loop';
      const id = r.transition.to_status_id;
      const key = keyOf(id);

      if (
        isGlobal &&
        ((id !== null && specificStatusTargets.has(id)) ||
          (key !== null && specificStatusKeys.has(key)))
      ) {
        return false;
      }

      return true;
    });

    // Stable order for the UI: by sort_order, then name.
    deduped.sort(
      (a, b) =>
        a.transition.sort_order - b.transition.sort_order ||
        a.transition.name.localeCompare(b.transition.name),
    );

    return { workflow_assigned: true, transitions: deduped };
  }

  /**
   * Execute the 15-step transition pipeline end-to-end. See the file-level
   * JSDoc for the relaxed-atomicity contract. Returns the updated task row.
   *
   * @throws NotFoundException - task missing or transition not in workflow
   * @throws ConflictException - version mismatch / compensation race
   * @throws BadRequestException - bad source / invalid to_node / no workflow
   * @throws ForbiddenException - condition denied / unknown condition type
   * @throws UnprocessableEntityException - one or more validators failed
   */
  async executeTransition(
    input: IExecuteTransitionInput,
  ): Promise<Record<string, unknown>> {
    const rulesEvaluated: IRuleTraceEntry[] = [];

    // ----------------------- Step 1: Open atomic transition -----------------------
    // Locks the task row (FOR UPDATE) and returns the snapshot we operate on.
    const lockRes = await this.client.rpc('begin_atomic_transition', {
      p_task_id: input.taskId,
      p_organization_id: input.user.organizationId,
    });

    if (lockRes.error) {
      // P0002 is "task not found" from the RPC; treat it as 404.
      if ((lockRes.error as { code?: string }).code === 'P0002') {
        throw new NotFoundException('Task not found');
      }
      throw new BadRequestException(lockRes.error.message);
    }

    const lockedTask = this.unwrapRpcRow<ITaskRow>(lockRes.data);

    if (!lockedTask) {
      throw new NotFoundException('Task not found');
    }

    // The has_attachments condition reads ctx.task.attachment_count, which the
    // locked `tasks` snapshot does not carry — enrich it before conditions run.
    lockedTask.attachment_count = await this.getAttachmentCount(
      input.taskId,
      input.user.organizationId,
    );
    await this.enrichStatusFields(lockedTask, input.user.organizationId);

    // ----------------------- Step 2: Concurrency + idempotency + recursion -----------------------
    if (
      input.expectedVersion !== undefined &&
      lockedTask.version !== input.expectedVersion
    ) {
      throw new ConflictException({
        message: 'Task version mismatch',
        data: { current_version: lockedTask.version },
      });
    }

    const depth = input.transitionDepth ?? 0;

    if (depth > 1) {
      throw new BadRequestException('Recursive transition depth exceeded');
    }

    if (input.executionId) {
      const cached = await this.findCachedExecution(
        input.user.organizationId,
        input.taskId,
        input.executionId,
      );

      if (cached) {
        // Return the latest task row so the caller sees the post-cache state.
        const refreshed = await this.loadTask(
          input.taskId,
          input.user.organizationId,
        );

        return (refreshed ?? lockedTask) as Record<string, unknown>;
      }
    }

    // ----------------------- Step 3: Resolve workflow + transition -----------------------
    const assignment = await this.assignments.findActiveAssignmentForType(
      input.user.organizationId,
      lockedTask.space_id ?? '',
      lockedTask.task_type_id ?? '*',
    );

    if (!assignment) {
      throw new BadRequestException('Task has no workflow assignment');
    }

    const graph = await this.loadWorkflowGraph(
      assignment.workflow_id,
      input.user.organizationId,
    );

    if (!graph) {
      throw new BadRequestException('Workflow not found for assignment');
    }

    const transition = graph.transitions.find(
      (t) => t.id === input.transitionId,
    );

    if (!transition) {
      throw new NotFoundException('Transition not found in workflow');
    }

    // ----------------------- Step 4: Permission gate -----------------------
    // Controller enforces `can_edit_tasks` via @RequirePermissions before
    // we get here; engine does not re-check. The trade-off is documented
    // in the design doc.

    // ----------------------- Step 5: Source validity -----------------------
    if (
      !this.transitionMatchesSource(
        transition,
        lockedTask.status_id,
        this.currentStatusKey(lockedTask),
        graph,
      ) &&
      transition.kind !== 'initial'
    ) {
      throw new BadRequestException(
        'Transition not available from current status',
      );
    }

    // Load the org's custom-field id↔slug map once for this execution so field
    // rules read tasks.custom_field_values (slug-keyed) by the rule's field_id
    // and screen-input writes stay slug-keyed.
    const computedFieldIds = new Set<string>();
    const fieldIdToSlug = await this.loadFieldIdSlugMap(
      input.user.organizationId, computedFieldIds,
    );

    // Build the per-transition context — passed to every condition,
    // validator, and post-function handler from here on.
    const ctx = this.buildContext(
      lockedTask,
      transition,
      graph.workflow,
      input.user,
      {
        from_status_id: lockedTask.status_id ?? null,
        execution_id: input.executionId,
        transition_depth: depth + 1,
      },
      fieldIdToSlug,
    );
    await this.enrichContextWithUserAccess(ctx, input.user);

    // ----------------------- Step 6: Conditions loop -----------------------
    for (const cond of transition.conditions ?? []) {
      const condConfig = normalizeRuleConfig(cond);
      const condType = (condConfig as { type?: string }).type ?? 'unknown';
      const handler = this.registry.get<unknown>('condition', condType) as
        | IConditionHandler<unknown>
        | undefined;

      if (!handler) {
        throw new ForbiddenException(
          'Unknown condition type — denying for safety',
        );
      }

      const ok = await handler.evaluate(condConfig, ctx);

      rulesEvaluated.push({ phase: 'condition', type: condType, ok });

      if (!ok) {
        throw new ForbiddenException(
          await this.describeConditionFailure(condConfig, condType),
        );
      }
    }

    const allowedFieldIds = transition.screen_field_group_id
      ? await this.loadAllowedFieldIds(transition.screen_field_group_id)
      : null;
    const customFieldUpdates = this.buildCustomFieldUpdates(
      lockedTask,
      Object.fromEntries(Object.entries(input.screenInput ?? {}).filter(([key]) => !computedFieldIds.has(key))),
      allowedFieldIds,
      fieldIdToSlug,
    );

    // ----------------------- Step 7: Screen input + validators -----------------------
    ctx.screen_input = input.screenInput ?? {};
    ctx.transition = {
      ...(ctx.transition ?? {}),
      payload: input.screenInput ?? {},
      required_field_ids: allowedFieldIds ? Array.from(allowedFieldIds) : [],
    };
    ctx.customFieldValues =
      customFieldUpdates ?? lockedTask.custom_field_values ?? {};
    ctx.customFieldValuesById = this.rekeyToFieldId(
      ctx.customFieldValues,
      fieldIdToSlug,
    );
    const validatorErrors: Array<{
      type: string;
      message?: string;
      field?: string;
    }> = [];

    for (const val of transition.validators ?? []) {
      const valConfig = normalizeRuleConfig(val);
      const valType = (valConfig as { type?: string }).type ?? 'unknown';
      if (valType === 'field_required' && computedFieldIds.has(String((valConfig as {field_id?: string}).field_id))) continue;
      const handler = this.registry.get<unknown>('validator', valType) as
        | IValidatorHandler<unknown>
        | undefined;

      if (!handler) {
        // H2 fix — fail closed on unknown validator types (design Part 2.43).
        // Matches the condition-loop behavior: an unknown rule type is a
        // server-config problem, not user input, so we throw immediately
        // rather than collecting it alongside real validator failures.
        // The audit trace still records the miss so operators can identify
        // and remove the orphan rule.
        rulesEvaluated.push({ phase: 'validator', type: valType, ok: false });
        throw new UnprocessableEntityException({
          message: 'Validation failed',
          data: {
            errors: [
              {
                type: valType,
                message: 'Unknown validator type — transition rejected',
              },
            ],
          },
        });
      }

      const result = await handler.validate(valConfig, ctx);

      rulesEvaluated.push({
        phase: 'validator',
        type: valType,
        ok: result.ok,
      });

      if (!result.ok) {
        validatorErrors.push({
          type: valType,
          message: result.message,
          field: result.fieldPath,
        });
      }
    }

    if (validatorErrors.length > 0) {
      throw new UnprocessableEntityException({
        message: 'Validation failed',
        data: { errors: validatorErrors },
      });
    }

    // ----------------------- Step 8: Decision-chain resolution -----------------------
    const toNode = graph.nodes[transition.to_node_id];

    if (!toNode) {
      throw new BadRequestException(
        `Transition target node ${transition.to_node_id} not found`,
      );
    }

    let finalStatusId: string;

    if (transition.kind === 'global_loop') {
      if (!lockedTask.status_id) {
        throw new BadRequestException(
          'Global loop transition requires the task to have a current status',
        );
      }
      finalStatusId = lockedTask.status_id;
    } else if (toNode.kind === 'decision') {
      const resolved = await resolveDecision(
        toNode.id,
        ctx,
        this.registry,
        this.client,
        0,
      );

      if (resolved === null) {
        // No branch matched and no else. Abort BEFORE the status write (Step 10)
        // and post-functions (Step 11+) so the task stays on its current status
        // with no side-effects / no version bump — a soft 422 instead of a 400
        // or 500. Author-time health checks (DecisionIncompleteBranchCheck)
        // stop such a diamond from being published in the first place.
        throw new UnprocessableEntityException(
          "This decision can't route the task with its current field values (no matching branch and no else).",
        );
      }

      finalStatusId = resolved;
      rulesEvaluated.push({
        phase: 'decision',
        type: 'resolve',
        result: finalStatusId,
      });
    } else if (toNode.kind === 'status') {
      if (!toNode.status_id) {
        throw new BadRequestException(
          `Status node ${toNode.id} missing status_id`,
        );
      }
      finalStatusId = toNode.status_id;
    } else {
      throw new BadRequestException(`Invalid to_node kind: ${toNode.kind}`);
    }

    ctx.to_status_id = finalStatusId;

    const finalStatus = await this.loadStatusMetadata(
      finalStatusId,
      input.user.organizationId,
    );

    // ----------------------- Step 9: Apply screen field values -----------------------
    // Bundle the screen-input keys that correspond to custom fields into the
    // status update so a single write commits the new status + field values.
    //
    // B4 fix — when the transition declares a screen_field_group_id, only the
    // fields defined in that group are allowed to land. Any extra keys posted
    // by a buggy or malicious client are dropped (logged at debug level).
    // When screen_field_group_id is null, accept all keys for backward
    // compatibility with admin-driven field updates that pre-date the
    // screen-group binding.
    // ----------------------- Step 10: Status update (engine's primary write) -----------------------
    const updatePatch: Record<string, unknown> = {
      status: toLegacyStatusText(
        finalStatus.key,
        finalStatus.is_completed ?? undefined,
        (Array.isArray(finalStatus.status_categories)
          ? finalStatus.status_categories[0]?.key
          : finalStatus.status_categories?.key) ?? null,
      ),
      status_id: finalStatusId,
      completed_at: finalStatus.is_completed ? new Date().toISOString() : null,
      // log_task_history credits NEW.updated_by. sla_write_workflow_task
      // populates the row from the patch, so omitting this would re-write the
      // previous editor's id and attribute the transition to them.
      updated_by: input.user.userId,
    };

    if (customFieldUpdates !== null) {
      updatePatch.custom_field_values = customFieldUpdates;
    }

    const operation = await this.client.rpc('sla_begin_workflow', {
      p_task_id: input.taskId,
      p_organization_id: input.user.organizationId,
      p_expected_version: lockedTask.version,
      p_expected_updated_at: lockedTask.updated_at,
    });
    const operationRow = Array.isArray(operation.data) ? operation.data[0] : operation.data;
    if (operation.error || !operationRow?.token) {
      throw new ConflictException(operation.error?.message ?? 'Task transition is busy; retry');
    }
    ctx.workflowToken = operationRow.token as string;
    const updRes = await this.client.rpc('sla_write_workflow_task', {
      p_task_id: input.taskId, p_token: ctx.workflowToken, p_patch: updatePatch,
    });

    if (updRes.error && updRes.error.code !== 'PGRST116') {
      this.logger.error(
        `Task status write failed for ${input.taskId}: ${updRes.error.code ?? 'unknown database error'}`,
      );
      throw new InternalServerErrorException('Failed to update task status', {
        cause: updRes.error,
      });
    }

    if (updRes.error || !updRes.data) {
      await this.finishSlaWorkflow(input.taskId, ctx.workflowToken, true);
      throw new ConflictException(
        'Optimistic concurrency lost; refresh and retry',
      );
    }

    const updatedTask = updRes.data as ITaskRow;

    // ----------------------- Step 11: User post-functions -----------------------
    ctx.txn = this.client;
    // Reflect the freshly-committed state in the context for post-functions.
    ctx.task = updatedTask as unknown as Record<string, unknown>;
    ctx.customFieldValues = updatedTask.custom_field_values ?? {};
    ctx.customFieldValuesById = this.rekeyToFieldId(
      ctx.customFieldValues,
      fieldIdToSlug,
    );

    let postFunctionError: Error | null = null;

    for (const pf of transition.post_functions ?? []) {
      const pfConfig = normalizeRuleConfig(pf);
      const pfType = (pfConfig as { type?: string }).type ?? 'unknown';
      const failureMode = (pfConfig as { failure_mode?: string }).failure_mode;
      const bestEffort =
        pfType === 'send_notification' ||
        pfType === 'trigger_webhook' ||
        pfType === 'fire_event' ||
        failureMode === 'best_effort';

      const handler = this.registry.get<unknown>('post_function', pfType) as
        | IPostFunctionHandler<unknown>
        | undefined;

      if (!handler) {
        // ENG-H1: never silently drop an unknown post-function. The status
        // change has already committed, so we don't abort — but we record an
        // ERROR-severity health issue so operators see the orphaned rule.
        rulesEvaluated.push({
          phase: 'post_function',
          type: pfType,
          result: 'unknown_skipped',
        });
        this.logger.error(
          `Unknown post-function type '${pfType}' on transition ${transition.id} — skipped (rule will never run)`,
        );
        void this.recordHealthIssue({
          organization_id: input.user.organizationId,
          workflow_id: transition.workflow_id,
          transition_id: transition.id,
          severity: 'error',
          code: 'unknown_post_function',
          message: `Post-function type '${pfType}' has no registered handler and was skipped`,
          details: { rule_type: pfType, task_id: input.taskId },
        });
        continue;
      }

      try {
        // Validate config against the handler's schema at runtime. The save
        // endpoint calls validatePayload() but data can enter the DB via other
        // paths; a bad config must surface as a clear 400, not a raw Postgres error.
        const parsedCfg = handler.schema.safeParse(pfConfig);

        if (!parsedCfg.success) {
          throw new BadRequestException(
            `Post-function '${pfType}' has invalid configuration: ` +
              parsedCfg.error.issues
                .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
                .join('; '),
          );
        }

        await handler.run(parsedCfg.data, ctx);
        rulesEvaluated.push({
          phase: 'post_function',
          type: pfType,
          result: 'succeeded',
        });
      } catch (err) {
        const msg = (err as Error).message;

        if (bestEffort) {
          rulesEvaluated.push({
            phase: 'post_function',
            type: pfType,
            result: 'failed_best_effort',
            error: msg,
          });
          this.logger.warn(
            `Best-effort post-function ${pfType} failed on task ${input.taskId}: ${msg}`,
          );
          // Prompt 6: the status change has already committed, so a failed
          // best-effort side effect must surface in the workflow health report
          // rather than abort the transition. Fire-and-forget — the helper
          // swallows ALL errors so health reporting can never break a
          // committed transition.
          void this.recordHealthIssue({
            organization_id: input.user.organizationId,
            workflow_id: transition.workflow_id,
            transition_id: transition.id,
            severity: 'warning',
            code: 'post_function_failed',
            message: `Best-effort post-function '${pfType}' failed: ${msg}`,
            details: { rule_type: pfType, task_id: input.taskId },
          });
          continue;
        }

        rulesEvaluated.push({
          phase: 'post_function',
          type: pfType,
          result: 'failed',
          error: msg,
        });
        postFunctionError = err as Error;
        break;
      }
    }

    if (postFunctionError) {
      // Compensation and the final timing event commit together under the fence.
      await this.finishSlaWorkflow(input.taskId, ctx.workflowToken, true);

      throw postFunctionError;
    }

    await this.finishSlaWorkflow(input.taskId, ctx.workflowToken, false);

    const finalTask = await this.loadTaskAfterPostFunctions(
      input.taskId,
      input.user.organizationId,
      updatedTask,
    );

    // The durable automation event is emitted only after all post-functions
    // succeed and the final task state has been refreshed.
    this.automationOutbox.emitTaskStatusChanged(
      input.user.organizationId,
      lockedTask,
      finalTask as TaskStatusChangedSnapshot,
      input.user.userId,
    );
    if (input.notifyWatchers !== false) {
      void this.watchersService?.notifyTaskWatchers({
        organizationId: input.user.organizationId,
        spaceId: finalTask['space_id'],
        taskId: input.taskId,
        actorUserId: input.user.userId,
        taskKey: finalTask['key'] ?? lockedTask.key,
        title: finalTask['summary'] ?? lockedTask.summary,
        changeKind: 'workflow_transition',
      });
    }

    // Workflow-scoped arrival event, for automations that care that the WORKFLOW moved the task
    // rather than that its status changed by any means.
    //
    // Guarded on the status actually changing: a `global` transition can be re-run against the
    // status a task already holds, and "reached" should mean arriving somewhere new. `finalStatusId`
    // is the resolved destination (it accounts for decision-node and global-loop resolution) and is
    // the same value Step 13 records as `to_status_id`, so the event and the audit row agree.
    if (finalStatusId !== lockedTask.status_id) {
      this.automationOutbox.emitWorkflowStatusReached({
        organizationId: input.user.organizationId,
        before: lockedTask,
        after: finalTask as TaskStatusChangedSnapshot,
        workflow: { id: graph.workflow.id, name: graph.workflow.name },
        transition: {
          id: transition.id,
          name: transition.name,
          to_node_id: transition.to_node_id,
        },
        newStatusId: finalStatusId,
        userId: input.user.userId,
      });
    }

    // ----------------------- Step 12: (Version already bumped in Step 10.) -----------------------

    // ----------------------- Step 13: Audit log -----------------------
    // ENG-H2: the status change has already committed, so an audit-write
    // failure must NOT fail the transition or abort the event. Best-effort
    // with a health-issue fallback; the event still fires afterwards.
    try {
      await this.auditLogs.logAction(
        input.user.organizationId,
        input.user.userId,
        'task',
        input.taskId,
        'workflow.transition.executed',
        {
          workflow_id: graph.workflow.id,
          workflow_version: graph.workflow.version,
          transition_id: transition.id,
          transition_name: transition.name,
          from_status_id: lockedTask.status_id,
          to_status_id: finalStatusId,
          screen_input: input.screenInput ?? null,
          execution_id: input.executionId ?? null,
          rules_evaluated: rulesEvaluated,
        },
      );
    } catch (auditErr) {
      this.logger.error(
        `Audit log failed for transition ${transition.id} on task ${input.taskId}: ${
          (auditErr as Error).message
        }`,
      );
      void this.recordHealthIssue({
        organization_id: input.user.organizationId,
        workflow_id: transition.workflow_id,
        transition_id: transition.id,
        severity: 'warning',
        code: 'audit_log_failed',
        message: `Audit log write failed for an executed transition: ${(auditErr as Error).message}`,
        details: {
          task_id: input.taskId,
          execution_id: input.executionId ?? null,
        },
      });
    }

    // ----------------------- Step 14: Emit task.transitioned event -----------------------
    // ENG-H3: carry the depth this transition ran at, +1. Trigger-fired child
    // transitions execute at this depth; the engine refuses depth > 1, so a
    // parent→child→grandchild cascade is bounded instead of unbounded.
    this.eventEmitter.emit('task.transitioned', {
      task: finalTask,
      fromStatusId: lockedTask.status_id,
      toStatusId: finalStatusId,
      transition,
      user: input.user,
      depth: depth + 1,
    });

    // ----------------------- Step 15: Return updated task -----------------------
    return finalTask as unknown as Record<string, unknown>;
  }

  /**
   * Record a workflow_health_issues row. Best-effort and fully defensive:
   * swallows every error (including a synchronous throw from a mocked client)
   * so health reporting can never break an already-committed transition.
   */
  private async recordHealthIssue(row: {
    organization_id: string;
    workflow_id: string;
    transition_id: string | null;
    severity: 'info' | 'warning' | 'error';
    code: string;
    message: string;
    details?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.client.from('workflow_health_issues').insert(row);
    } catch (e) {
      this.logger.warn(
        `Failed to record workflow_health_issue: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /**
   * Resolve a transition that drives `from -> targetStatus` directly (i.e.
   * the to_node is a status node and equals targetStatusId). Used by legacy
   * "drag status" callers that don't know transition ids. Decision-resolved
   * targets are intentionally excluded in v1.
   */
  async resolveTransitionByStatusChange(
    taskId: string,
    targetStatusId: string,
    user: RequestUser,
  ): Promise<TransitionResolution> {
    const task = await this.loadTask(taskId, user.organizationId);

    if (!task) {
      throw new NotFoundException('Task not found');
    }

    const assignment = await this.assignments.findActiveAssignmentForType(
      user.organizationId,
      task.space_id ?? '',
      task.task_type_id ?? '*',
    );

    if (!assignment) {
      return { error: 'no_path' };
    }

    const graph = await this.loadWorkflowGraph(
      assignment.workflow_id,
      user.organizationId,
    );

    if (!graph) {
      return { error: 'no_path' };
    }

    // Resolve the target status's KEY so the source→target match tolerates the
    // org-wide vs space-scoped status duplication (same key, different id) on
    // BOTH ends — the task's current status and the caller's target status.
    let targetStatusKey: string | null = null;

    try {
      targetStatusKey = (
        await this.loadStatusMetadata(targetStatusId, user.organizationId)
      ).key;
    } catch {
      targetStatusKey = null;
    }

    const sourceMatches = graph.transitions.filter((t) => {
      if (
        !this.transitionMatchesSource(
          t,
          task.status_id,
          this.currentStatusKey(task),
          graph,
        )
      )
        return false;
      if (t.kind === 'initial') return false;
      const toNode = graph.nodes[t.to_node_id];

      if (!toNode || toNode.kind !== 'status') return false;

      return (
        toNode.status_id === targetStatusId ||
        (!!targetStatusKey && toNode.status_key === targetStatusKey)
      );
    });

    // Load the org's custom-field id↔slug map once so field conditions/decisions
    // read tasks.custom_field_values (slug-keyed) by the rule's field_id.
    const fieldIdToSlug = await this.loadFieldIdSlugMap(user.organizationId);

    // ENG-M2: only offer transitions whose conditions currently pass, so a
    // board drag never resolves to a transition that would 403 on execute.
    const matches: ITransitionRow[] = [];

    for (const t of sourceMatches) {
      const ctx = this.buildContext(
        task,
        t,
        graph.workflow,
        user,
        {
          from_status_id: task.status_id ?? null,
          to_status_id: targetStatusId,
        },
        fieldIdToSlug,
      );
      await this.enrichContextWithUserAccess(ctx, user);

      if (await this.runConditions(t, ctx)) matches.push(t);
    }

    // B2: fallback-only diamond reachability. When NO direct status transition
    // reaches targetStatusId, also consider transitions that route THROUGH a
    // decision node and, given the task's current field values, resolve to
    // targetStatusId. This makes diamonds reachable from board-drag / status
    // dropdown / bulk / linked-task without touching any path that already
    // resolves directly — so no previously-clean move becomes multiple_paths.
    if (matches.length === 0) {
      const decisionCandidates = graph.transitions.filter((t) => {
        if (
          !this.transitionMatchesSource(
            t,
            task.status_id,
            this.currentStatusKey(task),
            graph,
          )
        )
          return false;
        if (t.kind === 'initial') return false;
        const toNode = graph.nodes[t.to_node_id];

        return !!toNode && toNode.kind === 'decision';
      });

      for (const t of decisionCandidates) {
        const ctx = this.buildContext(
          task,
          t,
          graph.workflow,
          user,
          {
            from_status_id: task.status_id ?? null,
            to_status_id: undefined,
          },
          fieldIdToSlug,
        );
        await this.enrichContextWithUserAccess(ctx, user);

        if (!(await this.runConditions(t, ctx))) continue;

        let resolved: string | null = null;

        try {
          resolved = await resolveDecision(
            t.to_node_id,
            ctx,
            this.registry,
            this.client,
            0,
          );
        } catch {
          // Broken/cyclic diamond — skip this candidate, never fail resolution.
          resolved = null;
        }

        if (resolved !== null && resolved === targetStatusId) {
          matches.push(t);
        } else if (resolved !== null && targetStatusKey) {
          // Key-tolerant: the diamond may resolve to the org-wide status while
          // targetStatusId is its space-scoped duplicate (same key). Compare by
          // key so a valid diamond route isn't wrongly reported as no_path.
          try {
            const resolvedKey = (
              await this.loadStatusMetadata(resolved, user.organizationId)
            ).key;

            if (resolvedKey === targetStatusKey) matches.push(t);
          } catch {
            // Unresolvable status — treat as a non-match.
          }
        }
      }
    }

    if (matches.length === 0) {
      // Distinguish a genuine no-path from a condition block. `sourceMatches`
      // are the direct source→target transitions collected BEFORE the
      // condition filter (`runConditions`). If any existed but none survived,
      // the move was blocked by a condition — callers (bulk especially) must
      // NOT fall back to a direct status write, or the condition is silently
      // bypassed.
      if (sourceMatches.length > 0) {
        return {
          error: 'condition_failed',
          blockedTransition: {
            id: sourceMatches[0].id,
            name: sourceMatches[0].name,
          },
        };
      }

      return { error: 'no_path' };
    }

    if (matches.length === 1) {
      return {
        transition: { id: matches[0].id, name: matches[0].name },
      };
    }

    return {
      error: 'multiple_paths',
      candidates: matches.map((m) => ({ id: m.id, name: m.name })),
    };
  }

  /**
   * Run the initial transition's post-functions after task creation. Called
   * by `TasksService.create()` for tasks under a workflow-assigned type.
   * Skips no rule classes (defensive — admins may still author conditions or
   * validators on the initial transition; we run them but never abort on a
   * miss, just like a status transition's first kick).
   *
   * Returns void — the caller already has the created task row.
   */
  async runInitialPostFunctions(
    taskId: string,
    transitionId: string,
    user: RequestUser,
  ): Promise<void> {
    const rulesEvaluated: IRuleTraceEntry[] = [];
    const task = await this.loadTask(taskId, user.organizationId);

    if (!task) {
      throw new NotFoundException('Task not found');
    }

    const assignment = await this.assignments.findActiveAssignmentForType(
      user.organizationId,
      task.space_id ?? '',
      task.task_type_id ?? '*',
    );

    if (!assignment) {
      throw new BadRequestException('Task has no workflow assignment');
    }

    const graph = await this.loadWorkflowGraph(
      assignment.workflow_id,
      user.organizationId,
    );

    if (!graph) {
      throw new BadRequestException('Workflow not found for assignment');
    }

    const transition = graph.transitions.find((t) => t.id === transitionId);

    if (!transition) {
      throw new NotFoundException('Transition not found in workflow');
    }

    if (transition.kind !== 'initial') {
      throw new BadRequestException(
        'runInitialPostFunctions called for non-initial transition',
      );
    }

    const fieldIdToSlug = await this.loadFieldIdSlugMap(user.organizationId);

    const ctx = this.buildContext(
      task,
      transition,
      graph.workflow,
      user,
      {
        from_status_id: null,
        to_status_id: task.status_id ?? undefined,
      },
      fieldIdToSlug,
    );
    await this.enrichContextWithUserAccess(ctx, user);

    ctx.txn = this.client;

    // Defensive: run conditions + validators but never throw on a miss for
    // the initial transition. The "Create" button is non-interactive, so
    // there's no UX path to recover from a rule failure.
    for (const cond of transition.conditions ?? []) {
      const condConfig = normalizeRuleConfig(cond);
      const condType = (condConfig as { type?: string }).type ?? 'unknown';
      const handler = this.registry.get<unknown>('condition', condType) as
        | IConditionHandler<unknown>
        | undefined;

      if (!handler) {
        rulesEvaluated.push({
          phase: 'condition',
          type: condType,
          result: 'unknown_skipped',
        });
        continue;
      }
      try {
        const ok = await handler.evaluate(condConfig, ctx);

        rulesEvaluated.push({ phase: 'condition', type: condType, ok });
      } catch (err) {
        rulesEvaluated.push({
          phase: 'condition',
          type: condType,
          result: 'errored',
          error: (err as Error).message,
        });
      }
    }

    for (const val of transition.validators ?? []) {
      const valConfig = normalizeRuleConfig(val);
      const valType = (valConfig as { type?: string }).type ?? 'unknown';
      const handler = this.registry.get<unknown>('validator', valType) as
        | IValidatorHandler<unknown>
        | undefined;

      if (!handler) {
        rulesEvaluated.push({
          phase: 'validator',
          type: valType,
          result: 'unknown_skipped',
        });
        continue;
      }
      try {
        const result = await handler.validate(valConfig, ctx);

        rulesEvaluated.push({
          phase: 'validator',
          type: valType,
          ok: result.ok,
        });
      } catch (err) {
        rulesEvaluated.push({
          phase: 'validator',
          type: valType,
          result: 'errored',
          error: (err as Error).message,
        });
      }
    }

    // Post-functions — run all in order; best-effort handlers swallow errors
    // exactly like Step 11 of executeTransition.
    for (const pf of transition.post_functions ?? []) {
      const pfConfig = normalizeRuleConfig(pf);
      const pfType = (pfConfig as { type?: string }).type ?? 'unknown';
      const failureMode = (pfConfig as { failure_mode?: string }).failure_mode;
      const bestEffort =
        pfType === 'send_notification' ||
        pfType === 'trigger_webhook' ||
        pfType === 'fire_event' ||
        failureMode === 'best_effort';
      const handler = this.registry.get<unknown>('post_function', pfType) as
        | IPostFunctionHandler<unknown>
        | undefined;

      if (!handler) {
        rulesEvaluated.push({
          phase: 'post_function',
          type: pfType,
          result: 'unknown_skipped',
        });
        continue;
      }
      try {
        const parsedCfg = handler.schema.safeParse(pfConfig);

        if (!parsedCfg.success) {
          throw new BadRequestException(
            `Post-function '${pfType}' has invalid configuration: ` +
              parsedCfg.error.issues
                .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
                .join('; '),
          );
        }

        await handler.run(parsedCfg.data, ctx);
        rulesEvaluated.push({
          phase: 'post_function',
          type: pfType,
          result: 'succeeded',
        });
      } catch (err) {
        const msg = (err as Error).message;

        rulesEvaluated.push({
          phase: 'post_function',
          type: pfType,
          result: bestEffort ? 'failed_best_effort' : 'failed',
          error: msg,
        });
        this.logger.warn(
          `Initial post-function ${pfType} failed on task ${taskId}: ${msg}`,
        );
      }
    }

    // Audit + event so observers can hook the "task created via workflow"
    // path identically to a regular transition.
    await this.auditLogs.logAction(
      user.organizationId,
      user.userId,
      'task',
      taskId,
      'workflow.transition.executed',
      {
        workflow_id: graph.workflow.id,
        workflow_version: graph.workflow.version,
        transition_id: transition.id,
        transition_name: transition.name,
        from_status_id: null,
        to_status_id: task.status_id ?? null,
        screen_input: null,
        execution_id: null,
        rules_evaluated: rulesEvaluated,
        initial: true,
      },
    );

    this.eventEmitter.emit('task.transitioned', {
      task,
      fromStatusId: null,
      toStatusId: task.status_id ?? null,
      transition,
      user,
      initial: true,
      depth: 1,
    });
  }

  // ---------------------------------------------------------------------
  // INTERNAL HELPERS
  // ---------------------------------------------------------------------

  /** Single-row task fetch scoped by org. Returns null on miss. */
  private async loadTask(
    taskId: string,
    organizationId: string,
  ): Promise<ITaskRow | null> {
    const res = await this.client
      .from('tasks')
      .select('*')
      .eq('id', taskId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (res.error) {
      throw new BadRequestException(res.error.message);
    }

    const task = (res.data as ITaskRow | null) ?? null;

    if (task) {
      task.attachment_count = await this.getAttachmentCount(
        taskId,
        organizationId,
      );
      await this.enrichStatusFields(task, organizationId);
    }

    return task;
  }

  /**
   * Count a task's attachments (legacy `task_attachments` + central
   * `file_attachments`), mirroring TasksService.getTaskCounts. The
   * has_attachments condition reads `ctx.task.attachment_count`, which the plain
   * `tasks` row does not carry, so the engine enriches it before conditions run.
   * Fail-closed (returns 0) on any error so a flaky count query can never break
   * task loading.
   */
  private async getAttachmentCount(
    taskId: string,
    organizationId: string,
  ): Promise<number> {
    try {
      const [legacy, central] = await Promise.all([
        this.client
          .from('task_attachments')
          .select('id', { count: 'exact', head: true })
          .eq('task_id', taskId)
          .eq('organization_id', organizationId),
        this.client
          .from('file_attachments')
          .select('id', { count: 'exact', head: true })
          .eq('entity_type', 'task')
          .eq('entity_id', taskId)
          .eq('organization_id', organizationId)
          // Not cosmetic here: a workflow rule such as "an attachment is
          // required before this transition" would otherwise be satisfied by a
          // failed upload, letting a task advance with no file behind it.
          .not('current_version_id', 'is', null),
      ]);

      return (legacy.count ?? 0) + (central.count ?? 0);
    } catch (error) {
      this.logger.warn(
        `Failed to count attachments for task ${taskId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return 0;
    }
  }

  /**
   * Enrich the loaded task with computed status fields that some conditions read
   * but the plain `tasks` row does not carry:
   *  - `status_category_id`        — category of the task's own status
   *    (`status_in_category`).
   *  - `parent_status_id` / `parent_status_category_id` — the parent task's
   *    status and its category (`parent_status_is`).
   *  - `parent_status_ids`         — all status ids sharing the parent's status
   *    KEY (org-wide + space-scoped duplicates), so `parent_status_is` (by status)
   *    matches whichever scope the rule stored.
   * Fail-closed (leaves fields unset + logs) so a flaky query can never break task
   * loading. The two independent lookups run in parallel; only the parent chain is
   * sequential (it needs the parent's `status_id` first).
   */
  private async enrichStatusFields(
    task: ITaskRow,
    organizationId: string,
  ): Promise<void> {
    try {
      const [ownRes, parentRes] = await Promise.all([
        task.status_id
          ? this.client
              .from('task_statuses')
              .select('key, category_id')
              .eq('id', task.status_id)
              .maybeSingle()
          : Promise.resolve(null),
        task.parent_task_id
          ? this.client
              .from('tasks')
              .select('status_id')
              .eq('id', task.parent_task_id)
              .eq('organization_id', organizationId)
              .maybeSingle()
          : Promise.resolve(null),
      ]);

      task.status_category_id =
        (ownRes?.data?.category_id as string | null | undefined) ?? null;
      task.status_key =
        (ownRes?.data?.key as string | null | undefined) ?? null;

      const parentStatusId =
        (parentRes?.data?.status_id as string | null | undefined) ?? null;

      task.parent_status_id = parentStatusId;
      task.parent_status_category_id = null;
      task.parent_status_ids = [];

      if (parentStatusId) {
        const parentStatus = await this.client
          .from('task_statuses')
          .select('key, category_id')
          .eq('id', parentStatusId)
          .maybeSingle();

        task.parent_status_category_id =
          (parentStatus.data?.category_id as string | null | undefined) ?? null;

        const parentKey =
          (parentStatus.data?.key as string | null | undefined) ?? null;

        if (parentKey) {
          const equivalents = await this.client
            .from('task_statuses')
            .select('id')
            .eq('key', parentKey)
            .eq('organization_id', organizationId);

          task.parent_status_ids = (
            (equivalents.data ?? []) as { id: string }[]
          ).map((r) => r.id);
        }
      }
    } catch (error) {
      this.logger.warn(
        `Failed to enrich status fields for task ${task.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Reload the task after post-functions, falling back to the status-update row if the read fails. */
  private async loadTaskAfterPostFunctions(
    taskId: string,
    organizationId: string,
    fallback: ITaskRow,
  ): Promise<ITaskRow> {
    try {
      const refreshed = await this.loadTask(taskId, organizationId);

      return refreshed ?? fallback;
    } catch (error) {
      this.logger.warn(
        `Failed to reload task ${taskId} after workflow post-functions: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return fallback;
    }
  }

  /**
   * Load the legacy status key/completion flag for a status id before writing
   * `tasks.status_id`. The workflow engine is now the status-change gateway, so
   * it must keep the old text column and completion timestamp in sync for list,
   * board, and saved-filter surfaces that still read those columns.
   */
  private async loadStatusMetadata(
    statusId: string,
    organizationId: string,
  ): Promise<ITaskStatusMetadata> {
    const res = await this.client
      .from('task_statuses')
      .select('key, is_completed, status_categories(key)')
      .eq('id', statusId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (res.error) {
      throw new BadRequestException(res.error.message);
    }

    const row = (res.data as ITaskStatusMetadata | null) ?? null;

    if (!row?.key) {
      throw new BadRequestException(
        'Workflow transition targets an invalid status',
      );
    }

    return row;
  }

  /**
   * Load the active, non-draft workflow plus its nodes/transitions/sources
   * in three queries. We index nodes and sources by id/transition_id so the
   * runtime helpers can look them up in O(1).
   */
  private async loadWorkflowGraph(
    workflowId: string,
    organizationId: string,
  ): Promise<IWorkflowGraph | null> {
    const wfRes = await this.client
      .from('workflows')
      .select(
        'id, organization_id, space_id, name, version, initial_status_id, is_active, is_draft',
      )
      .eq('id', workflowId)
      .eq('organization_id', organizationId)
      .eq('is_active', true)
      .eq('is_draft', false)
      .maybeSingle();

    if (wfRes.error) {
      throw new BadRequestException(wfRes.error.message);
    }
    if (!wfRes.data) return null;

    const workflow = wfRes.data as IWorkflowRow;

    const [nodesRes, transitionsRes] = await Promise.all([
      this.client
        .from('workflow_nodes')
        .select('id, workflow_id, kind, status_id, label')
        .eq('workflow_id', workflowId),
      this.client
        .from('workflow_transitions')
        .select(
          // The form's own space is embedded because an org-level workflow can point at a form in a
          // different space than the task, and the dialog must load it from the form's space.
          'id, workflow_id, name, kind, to_node_id, screen_field_group_id, screen_form_id, screen_form:form_builder!screen_form_id(space_id), conditions, validators, post_functions, triggers, sort_order',
        )
        .eq('workflow_id', workflowId)
        .order('sort_order', { ascending: true }),
    ]);

    if (nodesRes.error) {
      throw new BadRequestException(nodesRes.error.message);
    }
    if (transitionsRes.error) {
      throw new BadRequestException(transitionsRes.error.message);
    }

    const nodes: Record<string, INodeRow> = {};

    for (const n of (nodesRes.data ?? []) as INodeRow[]) {
      nodes[n.id] = n;
    }

    // Attach each status node's KEY so source-matching can fall back to key
    // equality: a task may carry a space-scoped status_id whose org-wide
    // duplicate (identical key) is what the workflow node references (or vice
    // versa). One batched read; keys of non-status nodes stay undefined.
    const nodeStatusIds = Object.values(nodes)
      .map((n) => n.status_id)
      .filter((id): id is string => !!id);

    if (nodeStatusIds.length > 0) {
      const statusKeysRes = await this.client
        .from('task_statuses')
        .select('id, key')
        .in('id', nodeStatusIds);

      if (statusKeysRes.error) {
        throw new BadRequestException(statusKeysRes.error.message);
      }

      const keyById = new Map<string, string>();

      for (const s of (statusKeysRes.data ?? []) as Array<{
        id: string;
        key: string;
      }>) {
        keyById.set(s.id, s.key);
      }

      for (const n of Object.values(nodes)) {
        if (n.status_id) n.status_key = keyById.get(n.status_id) ?? null;
      }
    }

    const transitions = (transitionsRes.data ?? []) as ITransitionRow[];
    const transitionIds = transitions.map((t) => t.id);
    const sources: Record<string, string[]> = {};

    // ENG-H4: workflow_transition_sources has no workflow_id column; bound the
    // read to THIS workflow's transition ids instead of scanning the whole
    // table across every org/workflow. Skip the query entirely when there are
    // no transitions.
    if (transitionIds.length > 0) {
      const sourcesRes = await this.client
        .from('workflow_transition_sources')
        .select('transition_id, from_node_id')
        .in('transition_id', transitionIds);

      if (sourcesRes.error) {
        throw new BadRequestException(sourcesRes.error.message);
      }

      for (const s of (sourcesRes.data ?? []) as ISourceRow[]) {
        const list = sources[s.transition_id] ?? [];

        list.push(s.from_node_id);
        sources[s.transition_id] = list;
      }
    }

    return { workflow, nodes, transitions, sources };
  }

  /**
   * The task's status key for source matching: the real `task_statuses.key`
   * (enriched as `status_key`) whenever `status_id` is set. The legacy `status`
   * text is only a fallback for rows with no `status_id` — it buckets custom
   * keys (abgelehnt → done), so trusting it would match another status's node.
   */
  private currentStatusKey(task: ITaskRow): string | null {
    return task.status_id ? (task.status_key ?? null) : (task.status ?? null);
  }

  /**
   * True when the given transition can fire from the current `status_id`,
   * factoring in the transition kind. Source lookup goes through the
   * `workflow_transition_sources` rows for explicit-source kinds and is
   * always true for global / global_loop. `initial` is excluded; it only
   * fires from `runInitialPostFunctions`.
   */
  private transitionMatchesSource(
    transition: ITransitionRow,
    currentStatusId: string | null,
    currentStatusKey: string | null,
    graph: IWorkflowGraph,
  ): boolean {
    switch (transition.kind) {
      case 'global':
      case 'global_loop':
        return true;
      case 'initial':
        return false;
      case 'regular':
      case 'common':
      case 'self_loop': {
        const fromNodeIds = graph.sources[transition.id] ?? [];

        if (fromNodeIds.length === 0) return false;

        // Match the source node to the task's current status by exact status_id
        // first. Then by status KEY so a space-scoped task status matches the
        // org-wide node status of the same key — and vice versa. The key must be
        // the real task_statuses key (see currentStatusKey); the legacy `status`
        // text is passed only when the task has no status_id.
        for (const nodeId of fromNodeIds) {
          const node = graph.nodes[nodeId];

          if (!node || node.kind !== 'status') continue;
          if (node.status_id === currentStatusId) return true;
          if (currentStatusKey && node.status_key === currentStatusKey) {
            return true;
          }
        }

        return false;
      }
      default:
        return false;
    }
  }

  /**
   * Run every condition on the transition. Returns false on the first miss
   * (or on an unknown condition type — fail-closed). No exceptions.
   */
  private async runConditions(
    transition: ITransitionRow,
    ctx: IEvaluationContext,
  ): Promise<boolean> {
    for (const cond of transition.conditions ?? []) {
      const condConfig = normalizeRuleConfig(cond);
      const condType = (condConfig as { type?: string }).type ?? 'unknown';
      const handler = this.registry.get<unknown>('condition', condType) as
        | IConditionHandler<unknown>
        | undefined;

      if (!handler) return false;
      try {
        const ok = await handler.evaluate(condConfig, ctx);

        if (!ok) return false;
      } catch {
        return false;
      }
    }

    return true;
  }

  /**
   * First condition on the transition that does NOT pass for `ctx` (its normalized
   * config + type), or null when all pass. Mirrors {@link runConditions} but
   * surfaces which condition blocked, so getAvailableTransitions can explain a
   * disabled transition instead of hiding it. A missing handler or a thrown
   * evaluator counts as a (fail-closed) block, matching runConditions.
   */
  private async firstFailingCondition(
    transition: ITransitionRow,
    ctx: IEvaluationContext,
  ): Promise<{ config: unknown; type: string } | null> {
    for (const cond of transition.conditions ?? []) {
      const condConfig = normalizeRuleConfig(cond);
      const condType = (condConfig as { type?: string }).type ?? 'unknown';
      const handler = this.registry.get<unknown>('condition', condType) as
        | IConditionHandler<unknown>
        | undefined;

      if (!handler) return { config: condConfig, type: condType };

      try {
        const ok = await handler.evaluate(condConfig, ctx);

        if (!ok) return { config: condConfig, type: condType };
      } catch {
        return { config: condConfig, type: condType };
      }
    }

    return null;
  }

  private async enrichContextWithUserAccess(
    ctx: IEvaluationContext,
    user: RequestUser,
  ): Promise<void> {
    try {
      const effective =
        await this.permissionsService.getUserEffectivePermissions(
          user.userId,
          user.organizationId,
        );

      const permissionMap: Record<string, boolean> = {
        ...(effective.effective_permissions as Record<string, boolean>),
      };

      if (ctx.spaceId) {
        const spacePermissions =
          await this.permissionsService.getUserSpacePermissions(
            user.userId,
            user.organizationId,
            ctx.spaceId,
          );

        for (const [key, value] of Object.entries(
          spacePermissions.permissions,
        )) {
          permissionMap[key] = value;
          permissionMap[key.startsWith('can_') ? key : `can_${key}`] = value;
        }
      }

      ctx.userRoles = (effective.custom_roles ?? [])
        .map((role) => role.id)
        .filter((id): id is string => Boolean(id));
      ctx.userGroups = (effective.groups ?? [])
        .map((group) => group.id)
        .filter((id): id is string => Boolean(id));
      ctx.user = {
        ...(ctx.user ?? {}),
        permissions: permissionMap,
      };
    } catch (err) {
      this.logger.warn(
        `Failed to enrich workflow rule context for user ${user.userId}: ${
          (err as Error)?.message ?? err
        }`,
      );
    }
  }

  /**
   * Load the org's custom-field id → field_key (slug) map. tasks.custom_field_values
   * is persisted keyed by slug, but rules address fields by UUID (field_id); this
   * map lets the engine expose a UUID-keyed view for reads and keep screen-input
   * writes slug-keyed. Degrades to an empty map on any error so a lookup failure
   * falls back to prior behavior rather than failing the transition.
   */
  private async loadFieldIdSlugMap(
    organizationId: string,
    computedFieldIds?: Set<string>,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();

    try {
      const res = await this.client
        .from('custom_fields')
        .select('id, field_key, field_type')
        .eq('organization_id', organizationId);

      if (res.error) {
        this.logger.warn(
          `Failed to load custom_fields id/field_key map for org ${organizationId}: ${res.error.message} — field rules fall back to slug-keyed reads`,
        );

        return map;
      }
      const rows = (res.data ?? []) as Array<{
        id?: string;
        field_key?: string;
        field_type?: string;
      }>;

      for (const r of rows) {
        if (r.field_type === 'sla_time') {
          if (r.id) computedFieldIds?.add(r.id);
          if (r.field_key) computedFieldIds?.add(r.field_key);
        }
        if (r.id && r.field_key) map.set(r.id, r.field_key);
      }
    } catch (err) {
      this.logger.warn(
        `custom_fields id/field_key map lookup threw for org ${organizationId}: ${
          (err as Error)?.message ?? err
        } — field rules fall back to slug-keyed reads`,
      );
    }

    return map;
  }

  /**
   * Re-key a slug-keyed custom-field blob so its values are ALSO addressable by
   * field UUID. Lossless: every original key is preserved (legacy already-UUID
   * keys and unknown keys survive), and a UUID alias is added for each key that
   * matches a known field slug. An empty map yields a plain copy.
   */
  private rekeyToFieldId(
    slugKeyed: Record<string, unknown>,
    idToSlug: Map<string, string>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { ...slugKeyed };

    for (const [id, slug] of idToSlug) {
      if (Object.prototype.hasOwnProperty.call(slugKeyed, slug)) {
        out[id] = slugKeyed[slug];
      }
    }

    return out;
  }

  /**
   * Construct an {@link IEvaluationContext} keyed off the task + transition
   * + workflow + user. The extension fields (screen_input, txn, etc.) are
   * filled in by the caller as the pipeline progresses.
   *
   * `idToSlug` (when provided) is the org's field id→slug map, used to derive the
   * UUID-keyed `customFieldValuesById` view from the slug-keyed blob.
   */
  private buildContext(
    task: ITaskRow,
    transition: ITransitionRow,
    workflow: IWorkflowRow,
    user: RequestUser,
    extras: {
      from_status_id?: string | null;
      to_status_id?: string;
      execution_id?: string;
      transition_depth?: number;
    },
    idToSlug?: Map<string, string>,
  ): IEvaluationContext {
    const customFieldValues = task.custom_field_values ?? {};

    return {
      organizationId: user.organizationId,
      spaceId: task.space_id,
      taskId: task.id,
      task: task as unknown as Record<string, unknown>,
      transitionId: transition.id,
      transition: transition as unknown as Record<string, unknown>,
      userId: user.userId,
      user: user as unknown as Record<string, unknown>,
      userRoles: [],
      userGroups: [],
      customFieldValues,
      customFieldValuesById: this.rekeyToFieldId(
        customFieldValues,
        idToSlug ?? new Map<string, string>(),
      ),
      from_status_id: extras.from_status_id,
      to_status_id: extras.to_status_id,
      workflow: workflow as unknown as Record<string, unknown>,
      execution_id: extras.execution_id,
      transition_depth: extras.transition_depth,
    };
  }

  /**
   * Merge any custom-field values from the screen input into the task's
   * existing `custom_field_values` JSONB. Returns null when there are no
   * keys to merge so the caller can skip the column entirely.
   *
   * @param allowedFieldIds - When non-null, screenInput keys are filtered to
   *   this allow-set (design Part 2.16 — only fields declared by the
   *   transition's screen_field_group can land). When null, all keys are
   *   merged (legacy compat for transitions without an explicit screen).
   */
  private buildCustomFieldUpdates(
    task: ITaskRow,
    screenInput: Record<string, unknown> | undefined,
    allowedFieldIds: Set<string> | null,
    idToSlug: Map<string, string>,
  ): Record<string, unknown> | null {
    if (!screenInput || Object.keys(screenInput).length === 0) return null;

    let filtered: Record<string, unknown>;

    if (allowedFieldIds) {
      filtered = {};
      const dropped: string[] = [];

      for (const [k, v] of Object.entries(screenInput)) {
        if (allowedFieldIds.has(k)) filtered[k] = v;
        else dropped.push(k);
      }
      if (dropped.length > 0) {
        this.logger.debug(
          `Dropped ${dropped.length} unknown screen_input key(s) not in screen_field_group: ${dropped.join(', ')}`,
        );
      }
      if (Object.keys(filtered).length === 0) return null;
    } else {
      filtered = screenInput;
    }

    // screen_input is keyed by field UUID (the transition dialog posts field.id),
    // but tasks.custom_field_values is persisted keyed by field slug (field_key)
    // — the task editor reads it back by slug. Convert known UUIDs to their slug
    // before merging so the stored blob never mixes key namespaces. Keys with no
    // known field (already-slug or unknown) pass through unchanged.
    const slugKeyed: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(filtered)) {
      const slug = idToSlug.get(k);

      slugKeyed[slug ?? k] = v;
    }

    return {
      ...(task.custom_field_values ?? {}),
      ...slugKeyed,
    };
  }

  /**
   * Look up the custom_field_ids permitted by a screen_field_group. Returns
   * an empty set when the group has no members (admin saved an empty group)
   * so the engine drops every screen_input key — safer than accepting
   * everything.
   */
  private async loadAllowedFieldIds(
    fieldGroupId: string,
  ): Promise<Set<string>> {
    const res = await this.client
      .from('field_group_fields')
      .select('custom_field_id')
      .eq('field_group_id', fieldGroupId);

    if (res.error) {
      this.logger.warn(
        `Failed to load screen_field_group ${fieldGroupId}: ${res.error.message} — falling back to "no fields allowed"`,
      );

      return new Set();
    }
    const rows = (res.data ?? []) as Array<{ custom_field_id: string }>;

    const ids = rows.map((r) => r.custom_field_id);

    if (ids.length === 0) return new Set();

    const activeRes = await this.client
      .from('custom_fields')
      .select('id, field_type')
      .in('id', ids)
      .eq('is_active', true)
      .eq('is_deleted', false);

    if (activeRes.error) {
      this.logger.warn(
        `Failed to filter active screen fields for group ${fieldGroupId}: ${activeRes.error.message} — falling back to "no fields allowed"`,
      );

      return new Set();
    }

    return new Set(
      ((activeRes.data ?? []) as Array<{ id: string; field_type?: string }>).filter((r) => r.field_type !== 'sla_time').map((r) => r.id),
    );
  }

  /**
   * Look up an audit row matching the supplied execution_id. Used as the
   * idempotency check — when present the caller returns the cached task
   * without re-running rules.
   */
  private async findCachedExecution(
    organizationId: string,
    taskId: string,
    executionId: string,
  ): Promise<boolean> {
    const res = await this.client
      .from('audit_logs')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('entity_id', taskId)
      .eq('entity_type', 'task')
      .eq('action', 'workflow.transition.executed')
      .eq('changes->>execution_id', executionId)
      .limit(1)
      .maybeSingle();

    if (res.error) {
      // Treat a lookup error as "not cached" — a duplicate run is safer than
      // a missed run, since the engine is idempotent on version anyway.
      this.logger.warn(
        `Idempotency lookup failed for execution_id=${executionId}: ${res.error.message}`,
      );

      return false;
    }

    return Boolean(res.data);
  }

  private async finishSlaWorkflow(taskId: string, token: string, compensated: boolean): Promise<void> {
    const result = await this.client.rpc('sla_finish_workflow', {
      p_task_id: taskId, p_token: token, p_compensated: compensated,
    });
    if (result.error || result.data !== true) {
      throw new ConflictException(result.error?.message ?? 'Transition recovery is pending; retry after recovery');
    }
  }

  /**
   * `begin_atomic_transition` returns either a single jsonb row or an array
   * of rows depending on the runtime path. Collapse both shapes to the
   * first row (the locked task).
   */
  private unwrapRpcRow<T>(data: unknown): T | null {
    if (!data) return null;
    if (Array.isArray(data)) {
      return (data[0] ?? null) as T | null;
    }

    return data as T;
  }
}
