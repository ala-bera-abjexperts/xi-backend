/**
 * @fileoverview Centralised registry that listens for task.transitioned
 * events emitted by the workflow engine and fires parent_transitioned
 * triggers on matching child tasks. Builds an in-memory cache of active
 * parent_transitioned trigger configs on module init and on
 * workflow.published; for each matching event it looks up the
 * transitioning task's children and invokes engine.executeTransition with
 * transitionDepth=1 so the engine refuses any further recursion.
 *
 * The corresponding ParentTransitionedTrigger handler keeps its v1
 * subscribe()/unsubscribe() stubs — runtime delivery is owned here so
 * we don't need per-trigger event-listener bookkeeping.
 *
 * @module src/workflow-engine/workflow-trigger-registry.service
 * @author Rajbha Manek
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';

import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { normalizeRuleConfig } from './handlers/rule-config';
import { WorkflowEngineService } from './workflow-engine.service';

/** Payload shape for the `task.transitioned` event emitted by the engine. */
interface ITaskTransitionedEvent {
  task: Record<string, unknown>;
  fromStatusId: string | null;
  toStatusId: string;
  transition: Record<string, unknown>;
  user: RequestUser;
  /**
   * Recursion depth the originating transition ran at, +1. The engine refuses
   * depth > 1, so propagating this bounds parent→child→grandchild cascades.
   * Defaults to 1 for events emitted before this field existed.
   */
  depth?: number;
}

/**
 * One row in the in-memory cache. Each represents a single
 * `parent_transitioned` trigger object from a transition's `triggers`
 * JSONB array (a transition may have multiple — they all become
 * separate entries here).
 */
interface IParentTriggerEntry {
  organization_id: string;
  workflow_id: string;
  transition_id: string;
  parent_status_id?: string;

  // Resolved `task_statuses.key` for parent_status_id (best-effort, set in
  // rebuildCache). Lets matching tolerate the org-wide vs space-scoped status
  // duplication (same key, different UUID). null/undefined → raw-id match only.
  parent_status_key?: string | null;
  parent_workflow_id?: string;
  // When set, move each child to THIS status via the child's own workflow
  // (resolved at fire-time). When absent, re-run `transition_id` on the child.
  child_target_status_id?: string;
}

/** Raw shape of a row returned by the cache-rebuild SQL. */
interface ITriggerRow {
  id: string;
  workflow_id: string;
  triggers: Array<Record<string, unknown>> | null;
  workflows: {
    id: string;
    organization_id: string;
    is_active: boolean;
    is_draft: boolean;
  } | null;
}

/** Minimal shape of a child task id row used by the children lookup. */
interface IChildTaskRow {
  id: string;
  space_id: string | null;
}

@Injectable()
export class WorkflowTriggerRegistryService implements OnModuleInit {
  private readonly logger = new Logger(WorkflowTriggerRegistryService.name);

  private cache: IParentTriggerEntry[] = [];
  private cacheLoaded = false;
  private periodicRebuild: Promise<void> | null = null;

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    @Inject(forwardRef(() => WorkflowEngineService))
    private readonly engine: WorkflowEngineService,
  ) {}

  /**
   * Nest lifecycle hook — build the cache once the module is wired up so
   * the first `task.transitioned` event we observe already has a hot
   * cache.
   */
  async onModuleInit(): Promise<void> {
    await this.rebuildCache();
  }

  /**
   * Re-scan all active, non-draft workflows for parent_transitioned
   * trigger configs and atomically replace the in-memory cache.
   *
   * Called on init and on `workflow.published`. One transition can
   * carry multiple parent_transitioned entries inside its `triggers`
   * JSONB array; each becomes its own cache row so matching stays a
   * simple linear scan.
   */
  async rebuildCache(): Promise<void> {
    const client = this.supabaseAdmin.getClient();

    // Pull every transition whose `triggers` JSONB contains at least one
    // parent_transitioned entry. NOTE: supabase-js `.contains()` with a JS
    // array serializes to a Postgres array literal `{...}`, which PostgREST
    // feeds to the jsonb `cs` operator and Postgres rejects as
    // "invalid input syntax for type json". Use `.filter(..,'cs',<json string>)`
    // so a valid JSON document is sent instead.
    const res = await client
      .from('workflow_transitions')
      .select(
        'id, workflow_id, triggers, workflows!inner(id, organization_id, is_active, is_draft)',
      )
      .filter('triggers', 'cs', '[{"type":"parent_transitioned"}]')
      .eq('workflows.is_active', true)
      .eq('workflows.is_draft', false);

    if (res.error) {
      this.logger.error(
        `Failed to rebuild parent_transitioned trigger cache: ${res.error.message}`,
      );
      this.cache = [];
      this.cacheLoaded = true;

      return;
    }

    const next: IParentTriggerEntry[] = [];

    for (const row of (res.data ?? []) as unknown as ITriggerRow[]) {
      const wf = row.workflows;

      if (!wf) continue;
      if (!Array.isArray(row.triggers)) continue;

      // Flatten every parent_transitioned config on this transition
      // into its own cache entry.
      for (const t of row.triggers) {
        const cfg = normalizeRuleConfig(t) as {
          type?: string;
          parent_status_id?: string;
          parent_workflow_id?: string;
          child_target_status_id?: string;
        };

        if (!cfg || cfg.type !== 'parent_transitioned') {
          continue;
        }

        next.push({
          organization_id: wf.organization_id,
          workflow_id: row.workflow_id,
          transition_id: row.id,
          parent_status_id: cfg.parent_status_id,
          parent_workflow_id: cfg.parent_workflow_id,
          child_target_status_id: cfg.child_target_status_id,
        });
      }
    }

    // Resolve each entry's parent_status_id → task_statuses.key so matching
    // tolerates the org-wide vs space-scoped status duplication. Best-effort:
    // a lookup failure leaves keys unset and matching falls back to raw id.
    await this.attachParentStatusKeys(next);

    // Atomic replace — assignment is single-step; no partial state.
    this.cache = next;
    this.cacheLoaded = true;

    this.logger.log(
      `parent_transitioned cache rebuilt: ${this.cache.length} entries`,
    );
  }

  /**
   * Best-effort resolve `parent_status_id → task_statuses.key` for every entry in
   * ONE batched query, so `onTaskTransitioned` can match a configured parent
   * status against the parent's landed status even when they are the same logical
   * status but different-scoped UUIDs (org-wide vs space-scoped). NEVER throws —
   * on any error the entries keep `parent_status_key` unset (raw-id match only).
   */
  private async attachParentStatusKeys(
    entries: IParentTriggerEntry[],
  ): Promise<void> {
    const ids = Array.from(
      new Set(
        entries
          .map((e) => e.parent_status_id)
          .filter((id): id is string => !!id),
      ),
    );

    if (ids.length === 0) return;

    try {
      const res = await this.supabaseAdmin
        .getClient()
        .from('task_statuses')
        .select('id, key')
        .in('id', ids);

      if (res.error) return;

      const keyById = new Map(
        ((res.data ?? []) as Array<{ id: string; key: string | null }>).map(
          (r) => [r.id, r.key] as const,
        ),
      );

      for (const e of entries) {
        if (e.parent_status_id) {
          e.parent_status_key = keyById.get(e.parent_status_id) ?? null;
        }
      }
    } catch (err) {
      this.logger.warn(
        `parent_transitioned: failed to resolve status keys: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Resolve a single `task_statuses.id → key`, org-scoped. NEVER throws — returns
   * null on any error/no-row so the caller falls back to raw-id matching.
   */
  private async resolveStatusKey(
    statusId: string,
    organizationId: string,
  ): Promise<string | null> {
    try {
      const res = await this.supabaseAdmin
        .getClient()
        .from('task_statuses')
        .select('key')
        .eq('id', statusId)
        .eq('organization_id', organizationId)
        .maybeSingle();

      return (res.data as { key: string | null } | null)?.key ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Listen for `task.transitioned` events. For each transition, find
   * cached parent_transitioned trigger configs that match
   * (parent_status_id or parent_workflow_id), look up the child tasks
   * of the transitioning parent, and fire engine.executeTransition for
   * each match with transitionDepth=1 so the engine refuses any further
   * recursion.
   *
   * A failure on one child is logged and swallowed — siblings still run.
   */
  @OnEvent('task.transitioned')
  async onTaskTransitioned(event: ITaskTransitionedEvent): Promise<void> {
    if (!this.cacheLoaded) {
      // Initial rebuild hasn't completed yet — drop this event. Anything
      // that fires before onModuleInit() runs would be a rare bootstrap
      // race we don't try to backfill.
      return;
    }

    const parentTask = event.task;
    const parentTaskId =
      typeof parentTask.id === 'string' ? parentTask.id : null;
    const parentOrgId =
      typeof parentTask.organization_id === 'string'
        ? parentTask.organization_id
        : null;
    const parentWorkflowId =
      typeof parentTask.workflow_id === 'string'
        ? parentTask.workflow_id
        : null;
    const parentSpaceId =
      typeof parentTask.space_id === 'string' ? parentTask.space_id : null;

    if (!parentTaskId || !parentOrgId) {
      return;
    }

    // Resolve the landed status's key ONCE (only when a status-configured entry
    // exists for this org) so matching tolerates the org-wide vs space-scoped
    // status duplication — a configured parent_status_id and the parent's actual
    // toStatusId can be the same logical status but different-scoped UUIDs.
    // Resolved unconditionally of raw match so key-only entries aren't missed
    // when a sibling entry matches by raw id. Defensive: null → raw-id match only.
    const hasStatusEntry = this.cache.some(
      (e) => e.organization_id === parentOrgId && !!e.parent_status_id,
    );
    const toStatusKey = hasStatusEntry
      ? await this.resolveStatusKey(event.toStatusId, parentOrgId)
      : null;

    // Filter cache to entries whose configured fields match this event.
    const matching = this.cache.filter((entry) => {
      // Cross-org isolation — never fire a trigger from another tenant.
      if (entry.organization_id !== parentOrgId) return false;

      const wantStatus = entry.parent_status_id;
      const wantWorkflow = entry.parent_workflow_id;

      if (!wantStatus && !wantWorkflow) {
        // Schema requires at least one to be set; if we ever observe
        // this it implies a config row drifted from the schema. Log
        // and skip — matching "any transition" would be too broad.
        this.logger.warn(
          `parent_transitioned entry on transition ${entry.transition_id} has neither parent_status_id nor parent_workflow_id — skipping`,
        );

        return false;
      }

      // Key-tolerant: match by raw id OR by resolved status key (org-wide vs
      // space-scoped duplicate of the same logical status).
      if (
        wantStatus &&
        wantStatus !== event.toStatusId &&
        !(
          entry.parent_status_key &&
          toStatusKey &&
          entry.parent_status_key === toStatusKey
        )
      ) {
        return false;
      }

      if (wantWorkflow && wantWorkflow !== parentWorkflowId) return false;

      return true;
    });

    if (matching.length === 0) {
      return;
    }

    // Look up the children of the transitioning parent once, then fan
    // out per matching trigger entry.
    const client = this.supabaseAdmin.getClient();
    const childrenRes = await client
      .from('tasks')
      .select('id, space_id')
      .eq('parent_task_id', parentTaskId)
      .eq('organization_id', parentOrgId);

    if (childrenRes.error) {
      this.logger.error(
        `Failed to load child tasks of ${parentTaskId}: ${childrenRes.error.message}`,
      );

      return;
    }

    const children = (childrenRes.data ?? []) as IChildTaskRow[];

    if (children.length === 0) {
      // The trigger matched and fired, but the parent has no children to act
      // on right now (e.g. the parent reached the target status before any
      // child was created). Record a no_op per matched entry so the feed shows
      // the trigger DID evaluate — otherwise this branch is silent and the
      // trigger looks like it never fired.
      for (const entry of matching) {
        this.logTriggerEvent({
          organizationId: parentOrgId,
          spaceId: parentSpaceId,
          workflowId: entry.workflow_id,
          transitionId: entry.transition_id,
          triggerType: 'parent_transitioned',
          subjectTaskId: null,
          outcome: 'no_op',
          message: 'Parent has no child tasks',
          context: { parentTaskId, parentStatusId: event.toStatusId },
        });
      }

      return;
    }

    for (const entry of matching) {
      for (const child of children) {
        // Shared identity for the fired / skipped / errored rows; only
        // `outcome` differs between the branches.
        const base = {
          organizationId: parentOrgId,
          spaceId: child.space_id,
          workflowId: entry.workflow_id,
          transitionId: entry.transition_id,
          triggerType: 'parent_transitioned',
          subjectTaskId: child.id,
          context: { parentTaskId, parentStatusId: event.toStatusId },
        };

        // Choose which transition runs on the child. With a configured target
        // status, resolve the CHILD's OWN transition to that status — so it
        // moves from whatever status it is in, using its own workflow, and
        // tolerant of org-wide vs space-scoped status ids. Without a target,
        // re-run the parent's transition on the child (legacy behaviour).
        let childTransitionId: string;

        if (entry.child_target_status_id) {
          const resolution = await this.engine.resolveTransitionByStatusChange(
            child.id,
            entry.child_target_status_id,
            event.user,
          );

          if ('error' in resolution) {
            // The child cannot cleanly move to the target (already there / no
            // route / ambiguous / blocked by a condition) — a benign no_op.
            this.logTriggerEvent({
              ...base,
              outcome: 'no_op',
              message: this.describeResolutionMiss(resolution.error),
            });

            continue;
          }

          childTransitionId = resolution.transition.id;
        } else {
          childTransitionId = entry.transition_id;
        }

        try {
          await this.engine.executeTransition({
            taskId: child.id,
            transitionId: childTransitionId,
            screenInput: {},
            user: event.user,
            // ENG-H3: inherit the parent event's depth so a multi-generation
            // cascade is bounded. depth>1 throws BadRequest in the engine, so
            // grandchild transitions are refused.
            transitionDepth: event.depth ?? 1,
          });

          this.logTriggerEvent({ ...base, outcome: 'fired' });
        } catch (err) {
          // One failing child must not block its siblings — record the outcome
          // and continue. A child that legitimately can't take the transition
          // (wrong status, different/no workflow, condition/validator/depth) is
          // a benign no_op (skip); only unexpected failures are errors.
          this.logTriggerEvent({
            ...base,
            outcome: this.classifyRejection(err),
            message: (err as Error).message,
          });
          this.logger.warn(
            `parent_transitioned: executeTransition failed for child ${child.id} via transition ${entry.transition_id}: ${(err as Error).message}`,
          );
        }
      }
    }
  }

  /**
   * Human-readable reason a `resolveTransitionByStatusChange` miss produced a
   * no_op, used for the trigger-event message when a configured
   * `child_target_status_id` couldn't be reached.
   */
  private describeResolutionMiss(error: string): string {
    switch (error) {
      case 'no_path':
        return 'No transition to the target status';
      case 'multiple_paths':
        return 'Multiple transitions to the target status (ambiguous)';
      case 'condition_failed':
        return 'A condition blocked the transition to the target status';
      default:
        return 'Cannot move the child to the target status';
    }
  }

  /**
   * Classify an executeTransition rejection for the trigger-event log. A child
   * that legitimately can't take the transition — wrong from-status, a
   * different or missing workflow, a condition / validator / concurrency guard,
   * or the cascade depth bound — is a benign `no_op` (skip), NOT an `error`.
   * Only genuinely unexpected failures are `error`, so the feed never shows a
   * wrong "Error" for an expected skip.
   */
  private classifyRejection(err: unknown): 'no_op' | 'error' {
    const message = (
      (err as { message?: string })?.message ?? ''
    ).toLowerCase();

    if (err instanceof NotFoundException) {
      // 'Transition not found in workflow' → child on a different workflow
      // (skip). A genuinely missing task (won't occur — children were just
      // loaded) → error.
      return message.includes('transition') ? 'no_op' : 'error';
    }

    if (err instanceof BadRequestException) {
      if (
        message.includes('not available') ||
        message.includes('not firable') ||
        message.includes('no workflow assignment') ||
        message.includes('recursive transition depth')
      ) {
        return 'no_op';
      }

      return 'error';
    }

    if (err instanceof ForbiddenException) {
      return 'no_op';
    }

    if (err instanceof UnprocessableEntityException) {
      return 'no_op';
    }

    if (err instanceof ConflictException) {
      return 'no_op';
    }

    return 'error';
  }

  /**
   * Persist the outcome of a single trigger evaluation to
   * `workflow_trigger_events`. Fire-and-forget: a logging failure must never
   * block or fail the transition that produced it, so the insert is detached
   * and its rejection is only warned about.
   */
  private logTriggerEvent(row: {
    organizationId: string;
    spaceId: string | null;
    workflowId: string | null;
    transitionId: string | null;
    triggerType: string;
    subjectTaskId: string | null;
    outcome: 'fired' | 'no_op' | 'error';
    message?: string;
    context?: Record<string, unknown>;
  }): void {
    void Promise.resolve(
      this.supabaseAdmin
        .getClient()
        .from('workflow_trigger_events')
        .insert({
          organization_id: row.organizationId,
          space_id: row.spaceId,
          workflow_id: row.workflowId,
          transition_id: row.transitionId,
          trigger_type: row.triggerType,
          outcome: row.outcome,
          subject_task_id: row.subjectTaskId,
          message: row.message ?? null,
          context: row.context ?? null,
        }),
    ).catch((e: unknown) =>
      this.logger.warn(`trigger-event log failed: ${(e as Error).message}`),
    );
  }

  /**
   * `workflow.published` is an in-process event, so with several replicas only the pod that
   * handled the publish rebuilds. Every pod re-scans once a minute so the others converge.
   */
  @Interval(60_000)
  async refreshCachePeriodically(): Promise<void> {
    if (this.periodicRebuild) return;
    this.periodicRebuild = this.rebuildCache()
      .catch((err: unknown) =>
        this.logger.error(
          `periodic parent_transitioned cache rebuild failed: ${(err as Error).message}`,
        ),
      )
      .finally(() => {
        this.periodicRebuild = null;
      });
    await this.periodicRebuild;
  }

  /**
   * Rebuild the cache when a workflow is published. Re-published
   * workflows can add, remove, or modify parent_transitioned configs,
   * so a full rebuild is the simplest correct response.
   */
  @OnEvent('workflow.published')
  async onWorkflowPublished(): Promise<void> {
    this.logger.log(
      'workflow.published received — rebuilding parent_transitioned cache',
    );
    await this.rebuildCache();
  }
}
