/**
 * @fileoverview Post-function: updates a task linked to the current one by a
 * known relation. v1 resolves `parent` and `child` via the `tasks.parent_task_id`
 * column; the directional relations (`blocks`, `blocked_by`, `relates_to`)
 * resolve through the `task_relationships` join table. The user must supply at
 * least one of `set_field_id` or `set_status_id`.
 *
 * Cross-org safety: the linked task is filtered by `organization_id = ctx.organizationId`
 * during the lookup, so a workflow cloned from another tenant cannot reach
 * tasks outside the current org.
 *
 * Recursion safety (design Part 2.18): when `set_status_id` is supplied, the
 * status change is routed through the workflow engine with
 * `transition_depth = (ctx.transition_depth ?? 0) + 1`. The engine refuses
 * `transition_depth > 1`, so a chain like parent → update_linked_task(child)
 * → parent_transitioned(grandparent) → update_linked_task(...) is rejected at
 * the second hop. Field-only updates (no status change) keep using the
 * direct UPDATE path because no transition is involved.
 * @module src/workflow-engine/handlers/post-functions/update-linked-task.post
 * @author Rajbha Manek
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { z } from 'zod';

import { WorkflowEngineService } from '../../workflow-engine.service';
import type {
  IPostFunctionHandler,
  IEvaluationContext,
  IRuleReference,
} from '../handler.types';
import type { RequestUser } from '../../../auth/interfaces/request-user.interface';

const cfgSchema = z
  .object({
    type: z.literal('update_linked_task'),
    relation: z.enum(['parent', 'child', 'blocks', 'blocked_by', 'relates_to']),
    set_field_id: z.string().uuid().optional(),
    set_field_value: z.unknown().optional(),
    set_status_id: z.string().uuid().optional(),
  })
  .refine(
    (c) => c.set_field_id !== undefined || c.set_status_id !== undefined,
    { message: 'Specify set_field_id or set_status_id' },
  );

export type UpdateLinkedTaskConfig = z.infer<typeof cfgSchema>;

/** Names of the seeded relation_types per `seed_default_relation_types`. */
const RELATION_NAME_FOR_KIND: Record<
  'blocks' | 'blocked_by' | 'relates_to',
  string
> = {
  blocks: 'Blocks',
  blocked_by: 'Blocks',
  relates_to: 'Relates',
};

@Injectable()
export class UpdateLinkedTaskPostFunction implements IPostFunctionHandler<UpdateLinkedTaskConfig> {
  readonly type = 'update_linked_task';
  readonly phase = 'post_function' as const;
  readonly schema = cfgSchema;

  private readonly logger = new Logger(UpdateLinkedTaskPostFunction.name);

  constructor(private readonly moduleRef: ModuleRef) {}

  private getEngine(): WorkflowEngineService {
    return this.moduleRef.get(WorkflowEngineService, { strict: false });
  }

  /**
   * Resolve a custom field's slug (`field_key`) from its UUID. The linked task's
   * `custom_field_values` are keyed by `field_key` (matching the task's own field
   * editor), NOT by the field UUID — writing under the UUID orphans the value so
   * the linked task never displays it.
   */
  private async resolveFieldKey(
    ctx: IEvaluationContext,
    fieldId: string,
  ): Promise<string | null> {
    const res = await ctx
      .txn!.from('custom_fields')
      .select('field_key')
      .eq('id', fieldId)
      .eq('organization_id', ctx.organizationId)
      .maybeSingle();

    if (res.error) {
      throw new BadRequestException(
        `update_linked_task field lookup failed: ${res.error.message}`,
      );
    }

    return (res.data as { field_key?: string } | null)?.field_key ?? null;
  }

  /**
   * Resolve a status's key + completion flag from its UUID, so the direct
   * fallback can write the denormalized `status` text (and `completed_at`)
   * alongside `status_id` — matching the engine's own status write. Writing only
   * `status_id` leaves the task's visible status (the `status` text) stale.
   */
  private async resolveStatusMeta(
    ctx: IEvaluationContext,
    statusId: string,
  ): Promise<{ key: string; is_completed: boolean } | null> {
    const res = await ctx
      .txn!.from('task_statuses')
      .select('key, is_completed')
      .eq('id', statusId)
      .eq('organization_id', ctx.organizationId)
      .maybeSingle();

    if (res.error) {
      throw new BadRequestException(
        `update_linked_task status lookup failed: ${res.error.message}`,
      );
    }

    return res.data as { key: string; is_completed: boolean } | null;
  }

  async run(
    cfg: UpdateLinkedTaskConfig,
    ctx: IEvaluationContext,
  ): Promise<void> {
    if (!ctx.txn) {
      throw new BadRequestException('update_linked_task requires ctx.txn');
    }
    if (!ctx.taskId) {
      throw new BadRequestException('update_linked_task requires ctx.taskId');
    }

    const linkedIds = await this.resolveLinkedTaskIds(cfg, ctx);

    if (linkedIds.length === 0) {
      this.logger.warn(
        `update_linked_task: no ${cfg.relation} task found for ${ctx.taskId} — skipping`,
      );

      return;
    }

    // Apply to every resolved peer (child → all children; blocks / blocked_by /
    // relates_to → all linked tasks). Per-peer logic is unchanged.
    for (const linkedId of linkedIds) {
      await this.applyToLinkedTask(cfg, ctx, linkedId);
    }
  }

  /**
   * Fetch one linked task (with a cross-org guard) and apply the field/status
   * update. Extracted so `run` can apply to every resolved peer.
   */
  private async applyToLinkedTask(
    cfg: UpdateLinkedTaskConfig,
    ctx: IEvaluationContext,
    linkedId: string,
  ): Promise<void> {
    // Cross-org safety + read current custom_field_values for the
    // field-only fallback path.
    const fetchRes = await ctx
      .txn!.from('tasks')
      .select('id, organization_id, custom_field_values')
      .eq('id', linkedId)
      .maybeSingle();

    if (fetchRes.error) {
      throw new BadRequestException(
        `update_linked_task lookup failed: ${fetchRes.error.message}`,
      );
    }
    const linked = fetchRes.data as {
      id: string;
      organization_id: string;
      custom_field_values: Record<string, unknown> | null;
    } | null;

    if (!linked) {
      throw new BadRequestException(
        `update_linked_task: linked task ${linkedId} not found`,
      );
    }
    if (linked.organization_id !== ctx.organizationId) {
      throw new BadRequestException(
        `update_linked_task: linked task ${linkedId} is outside org ${ctx.organizationId}`,
      );
    }

    // Branch on whether the rule moves status.
    if (cfg.set_status_id !== undefined) {
      await this.applyStatusChange(
        cfg,
        ctx,
        linkedId,
        linked.custom_field_values ?? {},
      );

      return;
    }

    // Field-only path: legacy direct UPDATE preserved for tasks without a
    // workflow OR rules that don't move status.
    await this.applyFieldOnlyUpdate(
      cfg,
      ctx,
      linkedId,
      linked.custom_field_values ?? {},
    );
  }

  /**
   * Route the status change through {@link WorkflowEngineService.executeTransition}
   * so the linked task's own validators + post-functions fire and recursion is
   * bounded by transition_depth. Falls back to direct UPDATE when the linked
   * task has no workflow assignment, no resolvable path, or ambiguous paths —
   * a rule author may legitimately want to set a status on a task whose
   * workflow doesn't expose a transition between the current and target
   * statuses; the legacy direct path keeps that behavior working.
   */
  private async applyStatusChange(
    cfg: UpdateLinkedTaskConfig,
    ctx: IEvaluationContext,
    linkedId: string,
    currentFieldValues: Record<string, unknown>,
  ): Promise<void> {
    const user = this.buildUser(ctx);
    const targetStatusId = cfg.set_status_id!;

    let resolution: Awaited<
      ReturnType<WorkflowEngineService['resolveTransitionByStatusChange']>
    >;
    const engine = this.getEngine();

    try {
      resolution = await engine.resolveTransitionByStatusChange(
        linkedId,
        targetStatusId,
        user,
      );
    } catch (e) {
      // resolveTransitionByStatusChange throws when the linked task has no
      // workflow assignment OR no active workflow at all. Fall back to
      // direct UPDATE so admins can still drive status changes for tasks
      // not bound to a workflow.
      this.logger.warn(
        `update_linked_task: engine resolution failed for ${linkedId} (${(e as Error).message}); falling back to direct UPDATE`,
      );
      await this.applyDirectStatusUpdate(
        cfg,
        ctx,
        linkedId,
        currentFieldValues,
      );

      return;
    }

    if ('error' in resolution) {
      if (resolution.error === 'no_path') {
        this.logger.warn(
          `update_linked_task: no workflow path from current → ${targetStatusId} for ${linkedId}; falling back to direct UPDATE`,
        );
      } else if (resolution.error === 'condition_failed') {
        // A transition exists but a condition blocked it. This post-function
        // runs INSIDE another transition and already force-writes on no_path /
        // multiple_paths, so keep that behaviour rather than aborting the
        // in-flight parent transition.
        this.logger.warn(
          `update_linked_task: transition to ${targetStatusId} for ${linkedId} blocked by a condition; falling back to direct UPDATE`,
        );
      } else {
        this.logger.warn(
          `update_linked_task: ambiguous paths to ${targetStatusId} for ${linkedId} (${resolution.candidates.length} candidates); falling back to direct UPDATE`,
        );
      }
      await this.applyDirectStatusUpdate(
        cfg,
        ctx,
        linkedId,
        currentFieldValues,
      );

      return;
    }

    // Engine path: pre-apply any field change so the linked task's
    // validators see the fresh value during their own transition. Two
    // writes (field then status); accepted under v1 relaxed-atomicity.
    if (cfg.set_field_id !== undefined) {
      await this.writeFieldOnly(
        ctx,
        linkedId,
        currentFieldValues,
        cfg.set_field_id,
        cfg.set_field_value,
      );
    }

    const nextDepth = (ctx.transition_depth ?? 0) + 1;

    await engine.executeTransition({
      taskId: linkedId,
      transitionId: resolution.transition.id,
      screenInput: {},
      user,
      transitionDepth: nextDepth,
    });
  }

  /**
   * Field-only fallback path. Same shape as the original handler — no engine
   * involvement because no status transition is required.
   */
  private async applyFieldOnlyUpdate(
    cfg: UpdateLinkedTaskConfig,
    ctx: IEvaluationContext,
    linkedId: string,
    currentFieldValues: Record<string, unknown>,
  ): Promise<void> {
    if (cfg.set_field_id === undefined) return;
    await this.writeFieldOnly(
      ctx,
      linkedId,
      currentFieldValues,
      cfg.set_field_id,
      cfg.set_field_value,
    );
  }

  private async writeFieldOnly(
    ctx: IEvaluationContext,
    linkedId: string,
    currentFieldValues: Record<string, unknown>,
    fieldId: string,
    fieldValue: unknown,
  ): Promise<void> {
    const fieldKey = await this.resolveFieldKey(ctx, fieldId);

    if (!fieldKey) {
      this.logger.warn(
        `update_linked_task: field ${fieldId} not found — skipping field write on task ${linkedId}`,
      );

      return;
    }

    const updRes = await ctx
      .txn!.from('tasks')
      .update({
        custom_field_values: { ...currentFieldValues, [fieldKey]: fieldValue },
      })
      .eq('id', linkedId)
      .eq('organization_id', ctx.organizationId);

    if (updRes.error) {
      throw new BadRequestException(
        `update_linked_task field write failed: ${updRes.error.message}`,
      );
    }
  }

  /**
   * Direct UPDATE fallback used when the engine cannot resolve a transition.
   * Carries both status and field updates if both were requested.
   */
  private async applyDirectStatusUpdate(
    cfg: UpdateLinkedTaskConfig,
    ctx: IEvaluationContext,
    linkedId: string,
    currentFieldValues: Record<string, unknown>,
  ): Promise<void> {
    const patch: Record<string, unknown> = { status_id: cfg.set_status_id };

    // Write the denormalized `status` text (+ completed_at) alongside status_id —
    // the task UI reads the `status` text, so setting only status_id leaves the
    // status looking unchanged. Mirrors the engine's own status write.
    const statusMeta = await this.resolveStatusMeta(ctx, cfg.set_status_id!);

    if (statusMeta) {
      patch.status = statusMeta.key;
      patch.completed_at = statusMeta.is_completed
        ? new Date().toISOString()
        : null;
    } else {
      this.logger.warn(
        `update_linked_task: status ${cfg.set_status_id} not found — setting status_id only on task ${linkedId}`,
      );
    }

    if (cfg.set_field_id !== undefined) {
      const fieldKey = await this.resolveFieldKey(ctx, cfg.set_field_id);

      if (fieldKey) {
        patch.custom_field_values = {
          ...currentFieldValues,
          [fieldKey]: cfg.set_field_value,
        };
      } else {
        this.logger.warn(
          `update_linked_task: field ${cfg.set_field_id} not found — skipping field write on task ${linkedId}`,
        );
      }
    }

    const updRes = await ctx
      .txn!.from('tasks')
      .update(patch)
      .eq('id', linkedId)
      .eq('organization_id', ctx.organizationId);

    if (updRes.error) {
      throw new BadRequestException(
        `update_linked_task fallback UPDATE failed: ${updRes.error.message}`,
      );
    }
  }

  /**
   * Build a minimal RequestUser from the evaluation context. The engine
   * reads `userId` + `organizationId`; `authUserId` and `email` are
   * placeholder fields preserved for type compatibility. See the parallel
   * shim in `tasks.service.ts.buildEngineUser()` — H1 widens that one to
   * load real email; this handler does not need real email because the
   * engine doesn't propagate it back into anything user-visible from a
   * post-function context.
   */
  private buildUser(ctx: IEvaluationContext): RequestUser {
    return {
      userId: ctx.userId ?? '',
      organizationId: ctx.organizationId,
      authUserId: ctx.userId ?? '',
      email: '',
    } as RequestUser;
  }

  /**
   * Resolve ALL linked task ids for the configured relation (deduped, excluding
   * the current task). `parent` → 0 or 1; `child` → every child (ordered by
   * sort_order); `blocks` (task = source) / `blocked_by` (task = target) → every
   * matching peer; `relates_to` → every peer, matched **bidirectionally** (the
   * current task may be on either side of the symmetric relation).
   */
  private async resolveLinkedTaskIds(
    cfg: UpdateLinkedTaskConfig,
    ctx: IEvaluationContext,
  ): Promise<string[]> {
    if (cfg.relation === 'parent') {
      const parentId = (ctx.task as { parent_task_id?: string | null } | null)
        ?.parent_task_id;

      return this.dedupePeers([parentId], ctx);
    }

    if (cfg.relation === 'child') {
      // Every child, ordered by sort_order (then created_at) for determinism.
      const res = await ctx
        .txn!.from('tasks')
        .select('id')
        .eq('parent_task_id', ctx.taskId!)
        .eq('organization_id', ctx.organizationId)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true });

      if (res.error) {
        throw new BadRequestException(
          `update_linked_task child lookup failed: ${res.error.message}`,
        );
      }

      return this.dedupePeers(
        ((res.data as { id: string }[] | null) ?? []).map((r) => r.id),
        ctx,
      );
    }

    // task_relationships path: blocks / blocked_by / relates_to.
    const relationName = RELATION_NAME_FOR_KIND[cfg.relation];
    const typeRes = await ctx
      .txn!.from('relation_types')
      .select('id')
      .eq('name', relationName)
      .eq('organization_id', ctx.organizationId)
      .limit(1)
      .maybeSingle();

    if (typeRes.error) {
      throw new BadRequestException(
        `update_linked_task relation_type lookup failed: ${typeRes.error.message}`,
      );
    }
    const relationTypeId = (typeRes.data as { id?: string } | null)?.id;

    if (!relationTypeId) {
      this.logger.warn(
        `update_linked_task: relation_type '${relationName}' not found in org ${ctx.organizationId}`,
      );

      return [];
    }

    let query = ctx
      .txn!.from('task_relationships')
      .select('source_id, target_id, source_type, target_type')
      .eq('organization_id', ctx.organizationId)
      .eq('relation_type_id', relationTypeId);

    if (cfg.relation === 'relates_to') {
      // `Relates` is symmetric — match rows where the current task is EITHER side.
      query = query.or(
        `source_id.eq.${ctx.taskId!},target_id.eq.${ctx.taskId!}`,
      );
    } else if (cfg.relation === 'blocked_by') {
      query = query.eq('target_id', ctx.taskId!);
    } else {
      // blocks: the current task is the source.
      query = query.eq('source_id', ctx.taskId!);
    }

    const relRes = await query;

    if (relRes.error) {
      throw new BadRequestException(
        `update_linked_task relationship lookup failed: ${relRes.error.message}`,
      );
    }

    const rows =
      (relRes.data as Array<{
        source_id: string;
        target_id: string;
        source_type: string;
        target_type: string;
      }> | null) ?? [];

    // Only task-to-task links; take the side that isn't the current task.
    const peerIds = rows
      .filter((r) => r.source_type === 'task' && r.target_type === 'task')
      .map((r) => (r.source_id === ctx.taskId ? r.target_id : r.source_id));

    return this.dedupePeers(peerIds, ctx);
  }

  /** Dedupe peer ids, dropping empties and the current task itself. */
  private dedupePeers(
    ids: Array<string | null | undefined>,
    ctx: IEvaluationContext,
  ): string[] {
    const seen = new Set<string>();
    const out: string[] = [];

    for (const id of ids) {
      if (!id || id === ctx.taskId || seen.has(id)) continue;

      seen.add(id);
      out.push(id);
    }

    return out;
  }

  findReferences(cfg: UpdateLinkedTaskConfig): IRuleReference[] {
    const refs: IRuleReference[] = [];

    if (cfg.set_field_id !== undefined) {
      refs.push({ kind: 'field', id: cfg.set_field_id });
    }
    if (cfg.set_status_id !== undefined) {
      refs.push({ kind: 'status', id: cfg.set_status_id });
    }

    return refs;
  }
}
